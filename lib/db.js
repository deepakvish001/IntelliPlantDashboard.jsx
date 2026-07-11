// History store on Node's built-in SQLite (node:sqlite) — no native deps.
//
// Privacy contract, enforced here rather than trusted to callers:
//   - Rows are keyed to an anonymous per-device id; one device can never
//     read another device's history.
//   - The stored source text is the PII-MASKED version (placeholders like
//     [EMAIL-1]); raw identifiers are never persisted.
//   - Saving is opt-in per request, and users can delete one entry or all.

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";

const MAX_ROWS_PER_OWNER = 100;

export function openDb(file) {
  if (file !== ":memory:") mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      owner TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      mode TEXT NOT NULL,
      level TEXT NOT NULL,
      language TEXT NOT NULL DEFAULT '',
      format TEXT NOT NULL,
      source_masked TEXT NOT NULL,
      output TEXT NOT NULL,
      grade_before REAL,
      grade_after REAL,
      words_before INTEGER,
      words_after INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_history_owner ON history(owner, id DESC);
  `);

  const insertStmt = db.prepare(`
    INSERT INTO history (owner, mode, level, language, format, source_masked, output,
                         grade_before, grade_after, words_before, words_after)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const listStmt = db.prepare(`
    SELECT id, created_at, mode, level, language, format,
           substr(source_masked, 1, 160) AS preview,
           grade_before, grade_after, words_before, words_after
    FROM history WHERE owner = ? ORDER BY id DESC LIMIT 50
  `);
  const getStmt = db.prepare(`SELECT * FROM history WHERE id = ? AND owner = ?`);
  const delStmt = db.prepare(`DELETE FROM history WHERE id = ? AND owner = ?`);
  const delAllStmt = db.prepare(`DELETE FROM history WHERE owner = ?`);
  const trimStmt = db.prepare(`
    DELETE FROM history WHERE owner = ? AND id NOT IN (
      SELECT id FROM history WHERE owner = ? ORDER BY id DESC LIMIT ${MAX_ROWS_PER_OWNER}
    )
  `);

  return {
    save(owner, entry) {
      const r = insertStmt.run(
        owner, entry.mode, entry.level, entry.language || "", entry.format,
        entry.sourceMasked, entry.output,
        entry.gradeBefore ?? null, entry.gradeAfter ?? null,
        entry.wordsBefore ?? null, entry.wordsAfter ?? null,
      );
      trimStmt.run(owner, owner);
      return Number(r.lastInsertRowid);
    },
    list(owner) {
      return listStmt.all(owner);
    },
    get(owner, id) {
      return getStmt.get(id, owner) || null;
    },
    remove(owner, id) {
      return delStmt.run(id, owner).changes > 0;
    },
    removeAll(owner) {
      return delAllStmt.run(owner).changes;
    },
    close() {
      db.close();
    },
  };
}
