// A Cloudflare-D1-shaped shim backed by node:sqlite. Shared by the test suite
// (in-memory) and the plain-server relay (file-backed), so both run the exact
// same SQL from schema.sql through the exact same wrapper: prepare().bind().
// first()/all()/run(), meta.changes, and batch() as one transaction that rolls
// back entirely if any statement fails. See relay/server.mjs and
// test/d1shim.mjs.
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

// node:sqlite hands back null-prototype rows; D1 hands back plain objects, and
// code that spreads or iterates a row should behave the same either way.
const plain = (row) => (row ? { ...row } : row);

// file defaults to an in-memory database, same as the old test-only shim.
// A real path gets WAL: the server reads on every GET and writes on every
// POST from the same process, and WAL is what keeps a reader from blocking a
// writer under that. Journal mode is a database-level, persistent setting on
// disk, so this only has to run once, but it costs nothing to set it every
// open and it keeps a copied-in database file correct even if the copy was
// made without WAL on.
export function makeD1(file = ":memory:") {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  if (file !== ":memory:") db.exec("PRAGMA journal_mode = WAL");
  // schema.sql is written to run again on top of itself with nothing lost:
  // every CREATE is IF NOT EXISTS and the migration DROPs only the retired v1
  // and v2 tables, so applying it at every startup is how a file-backed
  // database picks up a schema change on update, the same as deploy.sh does
  // for D1.
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
    close() { db.close(); },
    _raw: db,
  };
}
