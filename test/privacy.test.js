import { test } from "node:test";
import assert from "node:assert/strict";
import { detectPII, maskPII } from "../lib/privacy.js";

test("detects emails", () => {
  const spans = detectPII("Contact me at jane.doe@example.com please");
  assert.equal(spans.length, 1);
  assert.equal(spans[0].label, "EMAIL");
  assert.equal(spans[0].match, "jane.doe@example.com");
});

test("detects phone numbers", () => {
  const spans = detectPII("Call (555) 013-2244 before Friday.");
  assert.ok(spans.some((s) => s.label === "PHONE"));
});

test("detects SSN-shaped IDs", () => {
  const spans = detectPII("SSN: 123-45-6789.");
  assert.ok(spans.some((s) => s.label === "SSN"));
});

test("detects card numbers only when Luhn-valid", () => {
  const valid = detectPII("Card: 4111 1111 1111 1111");
  assert.ok(valid.some((s) => s.label === "CARD"));
  const invalid = detectPII("Order total was 4111 1111 1111 1112 units");
  assert.ok(!invalid.some((s) => s.label === "CARD"));
});

test("leaves ordinary text and small numbers alone", () => {
  assert.equal(detectPII("Take 2 capsules 3 times a day for 10 days.").length, 0);
  assert.equal(detectPII("Room 401, deadline May 3, 2026.").length, 0);
});

test("maskPII replaces with numbered placeholders and is reversible", () => {
  const text = "Email a@b.co or c@d.co, phone +1 555 013 2244.";
  const { masked, replacements } = maskPII(text);
  assert.ok(masked.includes("[EMAIL-1]"));
  assert.ok(masked.includes("[EMAIL-2]"));
  assert.ok(masked.includes("[PHONE-1]"));
  assert.ok(!masked.includes("a@b.co"));

  let restored = masked;
  for (const [ph, orig] of Object.entries(replacements)) {
    restored = restored.split(ph).join(orig);
  }
  assert.equal(restored, text);
});

test("maskPII is a no-op on clean text", () => {
  const { masked, replacements } = maskPII("Nothing sensitive here.");
  assert.equal(masked, "Nothing sensitive here.");
  assert.deepEqual(replacements, {});
});
