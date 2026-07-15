// AI provider abstraction.
//
// The app streams identical Server-Sent Events to the browser regardless of
// which model backs it, so the frontend never changes. Each provider exposes
// the same surface:
//
//   provider.label                          -> "Gemini (gemini-2.5-flash)"
//   provider.stream({ systemBlocks, userContent, onText }) -> { stopReason }
//   provider.friendlyError(err)             -> user-facing string
//
// `systemBlocks` is [{ text, cache? }]. Claude uses the array (with a prompt
// cache breakpoint on cached blocks); Gemini joins them into one system
// instruction. `stopReason` is normalized to "end_turn" | "refusal" |
// "max_tokens" | other so the server handles every backend the same way.

import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenAI } from "@google/genai";

const MAX_OUTPUT_TOKENS = 16000;

/**
 * Decide which provider to use from the environment. Precedence:
 *   1. AI_PROVIDER=gemini|claude (explicit override)
 *   2. a Gemini key present (GEMINI_API_KEY / GOOGLE_API_KEY / GOOGLE_GENAI_API_KEY)
 *   3. an Anthropic key present (ANTHROPIC_API_KEY)
 *   4. none
 */
export function resolveProvider(env = process.env) {
  const geminiKey = env.GEMINI_API_KEY || env.GOOGLE_API_KEY || env.GOOGLE_GENAI_API_KEY || "";
  const claudeKey = env.ANTHROPIC_API_KEY || "";
  const geminiModel = env.GEMINI_MODEL || "gemini-2.5-flash";
  const claudeModel = env.CLAUDE_MODEL || "claude-opus-4-8";
  const explicit = (env.AI_PROVIDER || "").toLowerCase();

  if (explicit === "gemini" || explicit === "google") {
    return { name: "gemini", ok: !!geminiKey, apiKey: geminiKey, model: geminiModel };
  }
  if (explicit === "claude" || explicit === "anthropic") {
    return { name: "claude", ok: !!claudeKey, apiKey: claudeKey, model: claudeModel };
  }
  if (geminiKey) return { name: "gemini", ok: true, apiKey: geminiKey, model: geminiModel };
  if (claudeKey) return { name: "claude", ok: true, apiKey: claudeKey, model: claudeModel };
  return { name: "none", ok: false, apiKey: "", model: null };
}

export function createProvider(cfg) {
  if (cfg.name === "gemini") return new GeminiProvider(cfg);
  if (cfg.name === "claude") return new ClaudeProvider(cfg);
  throw new Error("No AI provider configured");
}

// ---- Claude (Anthropic) ----

class ClaudeProvider {
  constructor(cfg) {
    this.model = cfg.model;
    this.client = new Anthropic({ apiKey: cfg.apiKey });
  }

  get label() {
    return `Claude (${this.model})`;
  }

  async stream({ systemBlocks, userContent, onText }) {
    const system = systemBlocks.map((b) => ({
      type: "text",
      text: b.text,
      ...(b.cache ? { cache_control: { type: "ephemeral" } } : {}),
    }));
    const stream = this.client.messages.stream({
      model: this.model,
      max_tokens: MAX_OUTPUT_TOKENS,
      thinking: { type: "adaptive" },
      system,
      messages: [{ role: "user", content: userContent }],
    });
    stream.on("text", (delta) => onText(delta));
    const final = await stream.finalMessage();
    return { stopReason: final.stop_reason };
  }

  friendlyError(err) {
    if (err instanceof Anthropic.AuthenticationError) {
      return "The server's Claude API key is missing or invalid. Set ANTHROPIC_API_KEY and restart, or start with MOCK_MODE=1 to demo without a key.";
    }
    if (err instanceof Anthropic.RateLimitError) {
      return "The Claude API is receiving too many requests right now. Wait a moment and try again.";
    }
    if (err instanceof Anthropic.APIConnectionError) {
      return "Could not reach the Claude API. Check the server's network connection and try again.";
    }
    if (err instanceof Anthropic.APIError) {
      return `The Claude API returned an error (${err.status ?? "unknown"}). Try again shortly.`;
    }
    console.error("Unexpected Claude error:", err);
    return "Something went wrong on the server. Try again.";
  }
}

// ---- Gemini (Google AI Studio) ----

class GeminiProvider {
  constructor(cfg) {
    this.model = cfg.model;
    this.ai = new GoogleGenAI({ apiKey: cfg.apiKey });
  }

  get label() {
    return `Gemini (${this.model})`;
  }

  async stream({ systemBlocks, userContent, onText }) {
    const systemInstruction = systemBlocks.map((b) => b.text).join("\n\n");
    const config = {
      systemInstruction,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
    };
    // On 2.5 Flash, disabling thinking keeps latency low and leaves the whole
    // output budget for the answer (this is a rewriting task, not a reasoning
    // one). thinkingBudget:0 is only valid on Flash-class models, so guard it.
    if (/flash/i.test(this.model)) {
      config.thinkingConfig = { thinkingBudget: 0 };
    }

    const stream = await this.ai.models.generateContentStream({
      model: this.model,
      contents: userContent,
      config,
    });

    let blocked = false;
    let finishReason = null;
    for await (const chunk of stream) {
      if (chunk.promptFeedback?.blockReason) blocked = true;
      const cand = chunk.candidates?.[0];
      if (cand?.finishReason) finishReason = cand.finishReason;
      const text = chunk.text; // getter — undefined on a pure safety/stop chunk
      if (text) onText(text);
    }

    // Normalize Gemini finish reasons to the shared vocabulary.
    const REFUSAL = new Set(["SAFETY", "PROHIBITED_CONTENT", "BLOCKLIST", "RECITATION", "SPII", "IMAGE_SAFETY"]);
    let stopReason = "end_turn";
    if (blocked || REFUSAL.has(finishReason)) stopReason = "refusal";
    else if (finishReason === "MAX_TOKENS") stopReason = "max_tokens";
    return { stopReason };
  }

  friendlyError(err) {
    const msg = String(err?.message || err);
    const status = err?.status ?? err?.code;
    if (status === 401 || status === 403 || /api[_ ]?key|permission|unauthenticated|invalid.*key/i.test(msg)) {
      return "The server's Gemini API key is missing or invalid. Set GEMINI_API_KEY (from Google AI Studio) and restart, or start with MOCK_MODE=1 to demo without a key.";
    }
    if (status === 429 || /quota|rate limit|resource.?exhausted/i.test(msg)) {
      return "The Gemini API is rate-limited or over quota right now. Wait a moment and try again.";
    }
    if (/fetch failed|network|ENOTFOUND|ECONNREFUSED|ETIMEDOUT/i.test(msg)) {
      return "Could not reach the Gemini API. Check the server's network connection and try again.";
    }
    if (status === 404 || /not found|is not supported|unknown model/i.test(msg)) {
      return "The configured Gemini model was not found. Check GEMINI_MODEL (e.g. gemini-2.5-flash).";
    }
    console.error("Unexpected Gemini error:", err);
    return "The Gemini API returned an error. Try again shortly.";
  }
}
