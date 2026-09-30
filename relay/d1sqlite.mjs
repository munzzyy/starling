// A Cloudflare-D1-shaped shim over node:sqlite, shared by the test suite (in-memory) and relay/server.mjs (file-backed).
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA = fs.readFileSync(path.join(HERE, "schema.sql"), "utf8");

function runResult(stmt, norm) {
  const r = stmt.run(...norm);
  return { success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
}

// node:sqlite hands back null-prototype rows; D1 hands back plain objects.
const plain = (row) => (row ? { ...row } : row);

export function makeD1(file = ":memory:") {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  if (file !== ":memory:") {
    db.exec("PRAGMA journal_mode = WAL"); // lets a reader run alongside the writer, both in this same process
    db.exec("PRAGMA busy_timeout = 5000"); // waits out a lock from another process (a backup tool) instead of erroring
  }
  db.exec(SCHEMA); // every statement is idempotent, so this is safe to run again on top of an existing database
  return {
    prepare(sql) {
      const stmt = db.prepare(sql);
      return {
        bind(...args) {
          const norm = args.map((a) => (a === undefined ? null : a));
          return {
            _bound: true,
            async first() { return plain(stmt.get(...norm)) ?? null; },
            async all() { return { results: stmt.all(...norm).map(plain) }; },
            async run() { return runResult(stmt, norm); },
            _runSync() { return runResult(stmt, norm); }, // used only by batch(), inside its own transaction
          };
        },
      };
    },
    async batch(stmts) {
      for (const s of stmts) {
        if (!s?._bound) throw new TypeError("batch takes bound statements: call .bind() even with no parameters");
      }
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
    close() { db.close(); },
    _raw: db,
  };
}
