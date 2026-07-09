import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTaskBlock, CORE_SYSTEM_PROMPT } from "../lib/prompt.js";

test("core prompt states the no-invention rule", () => {
  assert.match(CORE_SYSTEM_PROMPT, /Never invent details/);
  assert.match(CORE_SYSTEM_PROMPT, /\[unclear/);
});

test("builds a task block for rewrite", () => {
  const block = buildTaskBlock({ mode: "rewrite", level: "easy", language: "", format: "bullets" });
  assert.match(block, /Rewrite/);
  assert.match(block, /7-9 years old/);
  assert.match(block, /bulleted list/);
});

test("translate requires a target language", () => {
  assert.throws(
    () => buildTaskBlock({ mode: "translate", level: "plain", language: "", format: "prose" }),
    /target language/
  );
  const block = buildTaskBlock({ mode: "translate", level: "plain", language: "Hindi", format: "prose" });
  assert.match(block, /Target language: Hindi/);
});

test("non-English output language is honored outside translate mode", () => {
  const block = buildTaskBlock({ mode: "explain", level: "simple", language: "Spanish", format: "steps" });
  assert.match(block, /Output language: Spanish/);
});

test("rejects unknown options", () => {
  assert.throws(() => buildTaskBlock({ mode: "hack", level: "plain", language: "", format: "prose" }));
  assert.throws(() => buildTaskBlock({ mode: "rewrite", level: "phd", language: "", format: "prose" }));
});
