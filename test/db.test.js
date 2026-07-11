import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../lib/db.js";

function entry(overrides = {}) {
  return {
    mode: "rewrite", level: "easy", language: "English", format: "bullets",
    sourceMasked: "Contact [EMAIL-1] by May 3.",
    output: "- Email [EMAIL-1] before **May 3**.",
    gradeBefore: 14.2, gradeAfter: 4.1, wordsBefore: 120, wordsAfter: 60,
    ...overrides,
  };
}

test("save, list, get round-trip", () => {
  const db = openDb(":memory:");
  const id = db.save("owner-a", entry());
  const items = db.list("owner-a");
  assert.equal(items.length, 1);
  assert.equal(items[0].id, id);
  assert.equal(items[0].mode, "rewrite");
  assert.equal(items[0].grade_after, 4.1);

  const row = db.get("owner-a", id);
  assert.equal(row.source_masked, "Contact [EMAIL-1] by May 3.");
  db.close();
});

test("owners are isolated from each other", () => {
  const db = openDb(":memory:");
  const id = db.save("owner-a", entry());
  assert.equal(db.list("owner-b").length, 0);
  assert.equal(db.get("owner-b", id), null);
  assert.equal(db.remove("owner-b", id), false);
  assert.equal(db.get("owner-a", id) !== null, true);
  db.close();
});

test("delete one and delete all", () => {
  const db = openDb(":memory:");
  const id1 = db.save("o", entry());
  db.save("o", entry({ mode: "explain" }));
  assert.equal(db.remove("o", id1), true);
  assert.equal(db.list("o").length, 1);
  assert.equal(db.removeAll("o"), 1);
  assert.equal(db.list("o").length, 0);
  db.close();
});

test("history is capped per owner", () => {
  const db = openDb(":memory:");
  for (let i = 0; i < 110; i++) db.save("o", entry());
  assert.ok(db.list("o").length <= 50); // list caps at 50; table caps at 100
  db.close();
});
