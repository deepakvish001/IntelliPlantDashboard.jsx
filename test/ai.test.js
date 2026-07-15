import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveProvider, createProvider } from "../lib/ai.js";

test("prefers Gemini when a Gemini key is present", () => {
  const p = resolveProvider({ GEMINI_API_KEY: "g-key" });
  assert.equal(p.name, "gemini");
  assert.equal(p.ok, true);
  assert.equal(p.model, "gemini-2.5-flash");
});

test("accepts GOOGLE_API_KEY and GOOGLE_GENAI_API_KEY as Gemini keys", () => {
  assert.equal(resolveProvider({ GOOGLE_API_KEY: "x" }).name, "gemini");
  assert.equal(resolveProvider({ GOOGLE_GENAI_API_KEY: "x" }).name, "gemini");
});

test("uses Claude when only an Anthropic key is present", () => {
  const p = resolveProvider({ ANTHROPIC_API_KEY: "a-key" });
  assert.equal(p.name, "claude");
  assert.equal(p.model, "claude-opus-4-8");
});

test("Gemini wins over Claude when both keys are present (auto)", () => {
  const p = resolveProvider({ GEMINI_API_KEY: "g", ANTHROPIC_API_KEY: "a" });
  assert.equal(p.name, "gemini");
});

test("AI_PROVIDER forces the backend regardless of which keys exist", () => {
  const claude = resolveProvider({ AI_PROVIDER: "claude", GEMINI_API_KEY: "g", ANTHROPIC_API_KEY: "a" });
  assert.equal(claude.name, "claude");
  const gemini = resolveProvider({ AI_PROVIDER: "gemini", ANTHROPIC_API_KEY: "a" });
  assert.equal(gemini.name, "gemini");
  assert.equal(gemini.ok, false); // forced Gemini but no Gemini key
});

test("custom model overrides are honored", () => {
  assert.equal(resolveProvider({ GEMINI_API_KEY: "g", GEMINI_MODEL: "gemini-2.5-pro" }).model, "gemini-2.5-pro");
  assert.equal(resolveProvider({ ANTHROPIC_API_KEY: "a", CLAUDE_MODEL: "claude-sonnet-5" }).model, "claude-sonnet-5");
});

test("reports 'none' when no key is configured", () => {
  const p = resolveProvider({});
  assert.equal(p.name, "none");
  assert.equal(p.ok, false);
  assert.throws(() => createProvider(p), /No AI provider/);
});

test("createProvider builds a labeled provider without making network calls", () => {
  const gemini = createProvider(resolveProvider({ GEMINI_API_KEY: "g" }));
  assert.match(gemini.label, /^Gemini \(gemini-2\.5-flash\)$/);
  assert.equal(typeof gemini.stream, "function");
  assert.equal(typeof gemini.friendlyError, "function");

  const claude = createProvider(resolveProvider({ ANTHROPIC_API_KEY: "a" }));
  assert.match(claude.label, /^Claude \(claude-opus-4-8\)$/);
});

test("Gemini friendlyError maps common failures to guidance", () => {
  const g = createProvider(resolveProvider({ GEMINI_API_KEY: "g" }));
  assert.match(g.friendlyError({ status: 401 }), /Gemini API key/);
  assert.match(g.friendlyError({ status: 429 }), /rate-limited|quota/i);
  assert.match(g.friendlyError({ message: "fetch failed" }), /Could not reach/);
});
