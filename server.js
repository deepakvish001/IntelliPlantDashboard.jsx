import express from "express";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import {
  CORE_SYSTEM_PROMPT, ASK_SYSTEM_PROMPT, buildTaskBlock, buildAskTaskBlock,
  MODES, READING_LEVELS, OUTPUT_FORMATS,
} from "./lib/prompt.js";
import { maskPII, detectPII } from "./lib/privacy.js";
import { score } from "./lib/readability.js";
import { openDb } from "./lib/db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const MOCK_MODE = process.env.MOCK_MODE === "1";
const MODEL = process.env.CLAUDE_MODEL || "claude-opus-4-8";
const DB_FILE = process.env.DB_FILE || path.join(__dirname, "data", "copilot.db");
const MAX_INPUT_CHARS = 60_000;

const db = openDb(DB_FILE);
const client = MOCK_MODE ? null : new Anthropic();

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));

// Security headers. CSP allows only same-origin assets — the frontend is
// fully self-contained (no CDNs), so this is strict without breaking anything.
app.use((req, res, next) => {
  res.set({
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy":
      "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'",
  });
  next();
});

app.use(express.static(path.join(__dirname, "public")));

// Content is processed in memory only — request bodies are never logged.
app.use((req, res, next) => {
  res.on("finish", () => {
    if (req.path.startsWith("/api/")) console.log(`${req.method} ${req.path} ${res.statusCode}`);
  });
  next();
});

// ---- Anonymous per-device identity (history isolation, no accounts) ----

app.use((req, res, next) => {
  const cookies = Object.fromEntries(
    (req.headers.cookie || "").split(";").map((c) => {
      const i = c.indexOf("=");
      return i === -1 ? [c.trim(), ""] : [c.slice(0, i).trim(), c.slice(i + 1).trim()];
    })
  );
  let owner = cookies.acid;
  if (!owner || !/^[a-f0-9]{32}$/.test(owner)) {
    owner = crypto.randomBytes(16).toString("hex");
    res.setHeader("Set-Cookie", `acid=${owner}; Path=/; Max-Age=31536000; SameSite=Lax; HttpOnly`);
  }
  req.owner = owner;
  next();
});

// ---- Rate limiting (in-memory sliding window per device) ----

const buckets = new Map();
function rateLimit(max, windowMs) {
  return (req, res, next) => {
    const key = `${req.owner}:${req.path}`;
    const now = Date.now();
    const hits = (buckets.get(key) || []).filter((t) => now - t < windowMs);
    if (hits.length >= max) {
      return res.status(429).json({ error: "Too many requests — wait a moment and try again." });
    }
    hits.push(now);
    buckets.set(key, hits);
    next();
  };
}
setInterval(() => {
  const now = Date.now();
  for (const [k, hits] of buckets) {
    const live = hits.filter((t) => now - t < 120_000);
    if (live.length === 0) buckets.delete(k);
    else buckets.set(k, live);
  }
}, 60_000).unref();

// ---- Basic endpoints ----

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    mode: MOCK_MODE ? "demo" : "live",
    model: MODEL,
    options: {
      modes: Object.fromEntries(Object.entries(MODES).map(([k, v]) => [k, v.name])),
      levels: Object.fromEntries(Object.entries(READING_LEVELS).map(([k, v]) => [k, v.name])),
      formats: Object.fromEntries(Object.entries(OUTPUT_FORMATS).map(([k, v]) => [k, v.name])),
    },
  });
});

app.post("/api/scan", rateLimit(60, 60_000), (req, res) => {
  const text = typeof req.body?.text === "string" ? req.body.text : "";
  if (text.length > MAX_INPUT_CHARS) return res.status(413).json({ error: "Input too long" });
  const spans = detectPII(text);
  res.json({ count: spans.length, labels: [...new Set(spans.map((s) => s.label))] });
});

// ---- History ----

app.get("/api/history", (req, res) => {
  res.json({ items: db.list(req.owner) });
});

app.get("/api/history/:id", (req, res) => {
  const row = db.get(req.owner, Number(req.params.id));
  if (!row) return res.status(404).json({ error: "Not found" });
  res.json(row);
});

app.delete("/api/history/:id", (req, res) => {
  const ok = db.remove(req.owner, Number(req.params.id));
  res.status(ok ? 200 : 404).json({ ok });
});

app.delete("/api/history", (req, res) => {
  res.json({ deleted: db.removeAll(req.owner) });
});

// ---- SSE helpers ----

function openSSE(res) {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
  return (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function friendlyApiError(err) {
  if (err instanceof Anthropic.AuthenticationError) {
    return "The server is not authenticated with the Claude API. Set ANTHROPIC_API_KEY and restart, or start with MOCK_MODE=1 to demo without a key.";
  }
  if (err instanceof Anthropic.RateLimitError) {
    return "The AI service is receiving too many requests right now. Wait a moment and try again.";
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return "Could not reach the Claude API. Check the server's network connection and try again.";
  }
  if (err instanceof Anthropic.APIError) {
    return `The Claude API returned an error (${err.status ?? "unknown"}). Try again shortly.`;
  }
  console.error("Unexpected error:", err);
  return "Something went wrong on the server. Try again.";
}

async function streamClaude({ send, system, userContent, onDone }) {
  try {
    const stream = client.messages.stream({
      model: MODEL,
      max_tokens: 16000,
      thinking: { type: "adaptive" },
      system,
      messages: [{ role: "user", content: userContent }],
    });
    let full = "";
    stream.on("text", (delta) => {
      full += delta;
      send("delta", { text: delta });
    });
    const final = await stream.finalMessage();
    if (final.stop_reason === "refusal") {
      send("error", { message: "The model declined to process this content for safety reasons. Nothing was changed or stored." });
    } else if (final.stop_reason === "max_tokens") {
      send("error", { message: "The output was cut off at the length limit. Try a smaller part of the document." });
    } else {
      await onDone?.(full);
      send("done", { stopReason: final.stop_reason });
    }
  } catch (err) {
    send("error", { message: friendlyApiError(err) });
  }
}

// ---- Transform ----

app.post("/api/transform", rateLimit(20, 60_000), async (req, res) => {
  const {
    text, mode = "rewrite", level = "plain", language = "", format = "prose",
    maskPii = true, saveHistory = false,
  } = req.body || {};

  if (typeof text !== "string" || !text.trim()) {
    return res.status(400).json({ error: "Paste some content to transform first." });
  }
  if (text.length > MAX_INPUT_CHARS) {
    return res.status(413).json({
      error: `Input is too long (${text.length.toLocaleString()} characters; the limit is ${MAX_INPUT_CHARS.toLocaleString()}). Split the document and transform it in parts.`,
    });
  }

  let taskBlock;
  try {
    taskBlock = buildTaskBlock({ mode, level, language, format });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  // Server-side masking backstop: raw identifiers never reach the model when enabled.
  const { masked, replacements } = maskPii ? maskPII(text) : { masked: text, replacements: {} };
  const before = score(text);

  const send = openSSE(res);
  send("meta", { piiMasked: Object.keys(replacements).length, replacements, before });

  const finish = async (fullOutput) => {
    const after = score(fullOutput);
    let historyId = null;
    if (saveHistory) {
      // Only the MASKED source is ever persisted.
      historyId = db.save(req.owner, {
        mode, level, language, format,
        sourceMasked: masked,
        output: fullOutput,
        gradeBefore: before.gradeLevel,
        gradeAfter: after.gradeLevel,
        wordsBefore: before.words,
        wordsAfter: after.words,
      });
    }
    send("metrics", { before, after, historyId });
  };

  if (MOCK_MODE) {
    const full = await streamMockTransform(send, { mode, language });
    await finish(full);
    send("done", { stopReason: "end_turn" });
    res.end();
    return;
  }

  await streamClaude({
    send,
    system: [
      { type: "text", text: CORE_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
      { type: "text", text: taskBlock },
    ],
    userContent: `<content_to_transform>\n${masked}\n</content_to_transform>`,
    onDone: finish,
  });
  res.end();
});

// ---- Ask about this document ----

app.post("/api/ask", rateLimit(20, 60_000), async (req, res) => {
  const { text, question, language = "", maskPii = true } = req.body || {};
  if (typeof text !== "string" || !text.trim()) {
    return res.status(400).json({ error: "There is no document to ask about." });
  }
  if (typeof question !== "string" || !question.trim() || question.length > 1000) {
    return res.status(400).json({ error: "Type a question about the document." });
  }
  if (text.length > MAX_INPUT_CHARS) {
    return res.status(413).json({ error: "The document is too long." });
  }

  const { masked, replacements } = maskPii ? maskPII(text) : { masked: text, replacements: {} };
  const send = openSSE(res);
  send("meta", { piiMasked: Object.keys(replacements).length, replacements });

  if (MOCK_MODE) {
    await streamMockAsk(send, question);
    send("done", { stopReason: "end_turn" });
    res.end();
    return;
  }

  await streamClaude({
    send,
    system: [
      { type: "text", text: ASK_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
      { type: "text", text: buildAskTaskBlock(language) },
    ],
    userContent: `<document>\n${masked}\n</document>\n\n<reader_question>\n${question.trim()}\n</reader_question>`,
  });
  res.end();
});

// ---- Demo-mode streams ----

async function typeOut(send, chunks) {
  let full = "";
  for (const chunk of chunks) {
    for (const word of chunk.split(/(?<= )/)) {
      full += word;
      send("delta", { text: word });
      await new Promise((r) => setTimeout(r, 6));
    }
  }
  return full;
}

function streamMockTransform(send, { mode, language }) {
  const langNote = mode === "translate" ? ` into **${language || "the target language"}**` : "";
  return typeOut(send, [
    `*Demo mode — no API key configured. This canned output shows how a real ${MODES[mode]?.name?.toLowerCase() || mode} would look${langNote}.*\n\n`,
    `## What this notice says\n\n`,
    `- You got this letter because your housing benefit is being reviewed.\n`,
    `- You must send two documents: proof of income and a copy of your lease.\n`,
    `- The deadline is **May 3, 2026**. If the office does not get your documents by then, your payments may stop.\n`,
    `- Send them to the address on the letter, or email [EMAIL-1].\n`,
    `- The part of the letter about "form 11-B" is flagged as [unclear: the source cut off mid-sentence].\n\n`,
    `> **Please note:** this is a demo response and is not based on your pasted text. `,
    `Start the server with a Claude API key for real transformations.\n`,
  ]);
}

function streamMockAsk(send, question) {
  return typeOut(send, [
    `*Demo mode — canned answer.*\n\n`,
    `You asked: "${question.slice(0, 120)}"\n\n`,
    `The document says the deadline is **May 3, 2026** ("no later than May 3, 2026"). `,
    `The document does not say what happens if you send only one of the two required items — `,
    `contact the office listed in the letter to confirm.\n`,
  ]);
}

app.listen(PORT, () => {
  console.log(
    `Accessibility Copilot running at http://localhost:${PORT} ` +
    `(${MOCK_MODE ? "DEMO mode — no API calls" : `live, model ${MODEL}`}; history db: ${DB_FILE})`
  );
});
