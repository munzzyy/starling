// A Cloudflare-D1-shaped shim backed by node:sqlite, so relay tests run the
// real SQL from relay/schema.sql instead of a hand-rolled mock.
//
// The point is that relay.test.mjs exercises the shipped statements: the same
// CREATE TABLEs the deploy runs, the same conditional INSERT that enforces
// MEMBER_CAP, the same trail prune and TTL sweep. A mock that answered these
// from a Map would pass while the real query was wrong, which is the failure
// mode this exists to avoid.
//
// What is modelled: prepare().bind().first()/.all()/.run(), meta.changes, and
// batch() as one transaction that rolls back entirely if any statement fails.
// What is not: D1's network errors, its result metadata beyond changes, and
// concurrency beyond what a single-writer SQLite gives (which is what D1 is).
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA = fs.readFileSync(path.join(HERE, "..", "relay", "schema.sql"), "utf8");

function runResult(stmt, norm) {
  const r = stmt.run(...norm);
  return { success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
}

// node:sqlite hands back null-prototype rows; D1 hands back plain objects, and
// code that spreads or iterates a row should behave the same either way.
const plain = (row) => (row ? { ...row } : row);

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
            _bound: true,
            async first() { return plain(stmt.get(...norm)) ?? null; },
            async all() { return { results: stmt.all(...norm).map(plain) }; },
            async run() { return runResult(stmt, norm); },
            // Used only by batch(): runs synchronously inside the shared transaction.
            _runSync() { return runResult(stmt, norm); },
          };
        },
      };
    },
    // D1's batch() runs all statements inside one implicit transaction: if any
    // statement fails (a UNIQUE constraint, say) the whole batch rolls back and
    // none of the writes apply. The relay leans on that for the member cap and
    // for the points primary key backstopping the replay rule, so it is
    // modelled here rather than approximated.
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
    _raw: db,
  };
}
