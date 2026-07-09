import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { CORE_SYSTEM_PROMPT, buildTaskBlock, MODES, READING_LEVELS, OUTPUT_FORMATS } from "./lib/prompt.js";
import { maskPII, detectPII } from "./lib/privacy.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const MOCK_MODE = process.env.MOCK_MODE === "1";
const MODEL = process.env.CLAUDE_MODEL || "claude-opus-4-8";
const MAX_INPUT_CHARS = 60_000;

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

// Content is processed in memory only — never write request bodies to logs.
// Request logging is therefore limited to method, path, and status.
app.use((req, res, next) => {
  res.on("finish", () => {
    if (req.path.startsWith("/api/")) {
      console.log(`${req.method} ${req.path} ${res.statusCode}`);
    }
  });
  next();
});

const client = MOCK_MODE ? null : new Anthropic();

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

// Detect PII without transforming — used by the UI to warn before sending.
app.post("/api/scan", (req, res) => {
  const text = typeof req.body?.text === "string" ? req.body.text : "";
  if (text.length > MAX_INPUT_CHARS) {
    return res.status(413).json({ error: "Input too long" });
  }
  const spans = detectPII(text);
  res.json({ count: spans.length, labels: [...new Set(spans.map((s) => s.label))] });
});

// Main endpoint. Streams the transformation as Server-Sent Events:
//   event: meta  -> {masked, replacements, piiCount}   (once, before text)
//   event: delta -> {text}                              (repeated)
//   event: done  -> {stopReason}
//   event: error -> {message}
app.post("/api/transform", async (req, res) => {
  const { text, mode = "rewrite", level = "plain", language = "", format = "prose", maskPii = true } = req.body || {};

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

  // Server-side masking backstop: even if the client didn't mask, honor the flag here
  // so raw identifiers never reach the model when masking is enabled.
  const { masked, replacements } = maskPii ? maskPII(text) : { masked: text, replacements: {} };

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const send = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  send("meta", { piiMasked: Object.keys(replacements).length, replacements });

  if (MOCK_MODE) {
    await streamMock(send, { mode, level, language, format, masked });
    res.end();
    return;
  }

  try {
    const stream = client.messages.stream({
      model: MODEL,
      max_tokens: 16000,
      thinking: { type: "adaptive" },
      system: [
        // Stable core first with a cache breakpoint; the small varying task block after it.
        { type: "text", text: CORE_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
        { type: "text", text: taskBlock },
      ],
      messages: [
        {
          role: "user",
          content: `<content_to_transform>\n${masked}\n</content_to_transform>`,
        },
      ],
    });

    stream.on("text", (delta) => send("delta", { text: delta }));

    const final = await stream.finalMessage();

    if (final.stop_reason === "refusal") {
      send("error", {
        message: "The model declined to transform this content for safety reasons. Nothing was changed or stored.",
      });
    } else if (final.stop_reason === "max_tokens") {
      send("error", {
        message: "The output was cut off because it exceeded the length limit. Try transforming the document in smaller parts.",
      });
    } else {
      send("done", { stopReason: final.stop_reason });
    }
  } catch (err) {
    send("error", { message: friendlyApiError(err) });
  }
  res.end();
});

function friendlyApiError(err) {
  if (err instanceof Anthropic.AuthenticationError) {
    return "The server is not authenticated with the Claude API. Set ANTHROPIC_API_KEY (or run `ant auth login`) and restart, or start with MOCK_MODE=1 to demo without a key.";
  }
  if (err instanceof Anthropic.RateLimitError) {
    return "The service is receiving too many requests right now. Wait a moment and try again.";
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

// Demo-mode stream: produces an honest canned response that exercises the full
// UI pipeline (streaming, markdown, placeholders, unclear flags) without an API key.
async function streamMock(send, { mode, level, language, format }) {
  const langNote = mode === "translate" ? ` into **${language || "the target language"}**` : "";
  const demo = [
    `_Demo mode — no API key configured. This canned output shows how a real ${MODES[mode]?.name?.toLowerCase() || mode} would look${langNote}._\n\n`,
    `## What this notice says\n\n`,
    `- You got this letter because your housing benefit is being reviewed.\n`,
    `- You must send two documents: proof of income and a copy of your lease.\n`,
    `- The deadline is **May 3, 2026**. If the office does not get your documents by then, your payments may stop.\n`,
    `- Send them to the address on the letter, or email [EMAIL-1].\n`,
    `- The part of the letter about "form 11-B" is flagged as [unclear: the source cut off mid-sentence].\n\n`,
    `> **Please note:** this is a demo response and is not based on your pasted text. `,
    `Start the server with a Claude API key for real transformations.\n`,
  ];
  for (const chunk of demo) {
    for (const word of chunk.split(/(?<= )/)) {
      send("delta", { text: word });
      await new Promise((r) => setTimeout(r, 8));
    }
  }
  send("done", { stopReason: "end_turn" });
}

app.listen(PORT, () => {
  console.log(`Accessibility Copilot running at http://localhost:${PORT} (${MOCK_MODE ? "DEMO mode — no API calls" : `live, model ${MODEL}`})`);
});
