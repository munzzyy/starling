// A tiny Cloudflare-D1-shaped shim backed by node:sqlite, so relay tests run
// the real SQL from relay/schema.sql instead of a hand-rolled mock.
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA = fs.readFileSync(path.join(HERE, "..", "relay", "schema.sql"), "utf8");

function runResult(stmt, norm) {
  const r = stmt.run(...norm);
  return { success: true, meta: { changes: r.changes, last_row_id: r.lastInsertRowid } };
}

export function makeD1() {
  const db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
  return {
    prepare(sql) {
      const stmt = db.prepare(sql);
      return {
        bind(...args) {
          const norm = args.map((a) => (a === undefined ? null : a));
          return {
            async first() { return stmt.get(...norm) ?? null; },
            async all() { return { results: stmt.all(...norm) }; },
            async run() { return runResult(stmt, norm); },
            // Used only by batch(): runs synchronously inside the shared transaction.
            _runSync() { return runResult(stmt, norm); },
          };
        },
      };
    },
    // D1's batch() runs all statements inside one implicit transaction: if any
    // statement fails (e.g. a UNIQUE constraint), the whole batch is rolled
    // back and none of the writes apply. Model that here with node:sqlite.
    async batch(stmts) {
      db.exec("BEGIN");
      try {
        const results = stmts.map((s) => s._runSync());
        db.exec("COMMIT");
        return results;
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    },
    _raw: db,
  };
}
