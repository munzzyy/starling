// The outbox's whole contract: retries until it lands, re-sends through the
// injected send() so sealing stays fresh, dies on clear(), and can never
// touch storage because it was never given any.
import test from "node:test";
import assert from "node:assert/strict";

import { createOutbox } from "../app/js/outbox.js";

const tick = (ms) => new Promise((r) => setTimeout(r, ms));

test("a failed send retries on the backoff schedule until it lands", async () => {
  let calls = 0;
  const box = createOutbox({
    send: async () => {
      calls += 1;
      if (calls < 3) throw new Error("offline");
    },
    backoff: [10, 10, 10],
  });
  const first = await box.enqueue("bye");
  assert.equal(first, false, "first attempt failed");
  assert.deepEqual(box.pending(), ["bye"]);
  await tick(60);
  assert.equal(calls, 3, "kept retrying until success");
  assert.deepEqual(box.pending(), [], "delivered and forgotten");
});

test("every retry goes through send() again: sealing is the caller's, fresh each time", async () => {
  const seen = [];
  let fail = 2;
  const box = createOutbox({
    send: async (type) => {
      seen.push(type);
      if (fail-- > 0) throw new Error("offline");
    },
    backoff: [5],
  });
  await box.enqueue("checkin");
  await tick(30);
  assert.deepEqual(seen, ["checkin", "checkin", "checkin"]);
});

test("flush retries immediately, clear kills the line dead", async () => {
  let calls = 0;
  const box = createOutbox({
    send: async () => {
      calls += 1;
      throw new Error("offline");
    },
    backoff: [10_000],
  });
  await box.enqueue("bye");
  assert.equal(calls, 1);
  box.flush();
  await tick(5);
  assert.equal(calls, 2, "flush tried now, not in ten seconds");
  box.clear();
  await tick(30);
  assert.equal(calls, 2, "cleared line never fires again");
  assert.deepEqual(box.pending(), []);
});

test("onSettle reports failure then success", async () => {
  const events = [];
  let fail = 1;
  const box = createOutbox({
    send: async () => {
      if (fail-- > 0) throw new Error("offline");
    },
    onSettle: (type, ok) => events.push([type, ok]),
    backoff: [5],
  });
  await box.enqueue("checkin");
  await tick(30);
  assert.deepEqual(events, [
    ["checkin", false],
    ["checkin", true],
  ]);
});

test("negative control: the module cannot reach storage, only the injected send", async () => {
  // The fail-closed invariant, held structurally: if anything in outbox.js
  // ever grows a storage call, this global spy trips. dbSet in the app is an
  // import, but a module that wanted storage in a test environment would
  // have to reach through globals; both routes stay provably silent here.
  const touched = [];
  globalThis.__outboxSpyDb = () => touched.push("db");
  const src = await import("node:fs").then((fs) => fs.readFileSync("app/js/outbox.js", "utf8"));
  assert.ok(!/store\.js|dbSet|dbGet|indexedDB|localStorage/i.test(src), "outbox.js references no storage");
  const box = createOutbox({ send: async () => {}, backoff: [5] });
  await box.enqueue("bye");
  await tick(10);
  assert.deepEqual(touched, []);
  delete globalThis.__outboxSpyDb;
});

test("a newer enqueue of the same type replaces the older schedule", async () => {
  let calls = 0;
  const box = createOutbox({
    send: async () => {
      calls += 1;
      throw new Error("offline");
    },
    backoff: [10_000],
  });
  await box.enqueue("bye");
  await box.enqueue("bye");
  assert.equal(calls, 2, "each enqueue tried once");
  assert.deepEqual(box.pending(), ["bye"], "one slot, not two");
  box.clear();
});
