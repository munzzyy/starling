// The at-rest, lock and destruct decisions, checked without a page.
//
// This cluster produced a critical defect in three review rounds running, and
// every one of them lived inside an async function that also talks to the DOM:
// reaching the decision at all meant standing up a fake browser and driving a
// boot. Nothing here needs one. The verdicts are pure, so the rule and the
// check of it sit next to each other, and the two source-reading tests at the
// bottom bind what main.js actually does to what the plan says it does.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { atRestForm, bootVerdict, destructPlan, slotsVerdict, unlockVerdict } from "../app/js/atrest.js";

const key = () => {
  const k = new Uint8Array(32);
  k[0] = 7;
  return k;
};

// ------------------------------------------- may this be written, and under what

test("no lock means plaintext, and plaintext is always allowed", () => {
  for (const lock of [null, undefined, {}, { enabled: false, vaultKey: key() }]) {
    const form = atRestForm(lock);
    assert.equal(form.ok, true);
    assert.equal(form.sealed, false);
    assert.equal(form.vaultKey, null, "an unlocked device seals nothing, so it is handed no key");
  }
});

test("a lock with a live key seals, under that key", () => {
  const k = key();
  const form = atRestForm({ enabled: true, vaultKey: k });
  assert.equal(form.ok, true);
  assert.equal(form.sealed, true);
  assert.equal(form.vaultKey, k);
});

test("a key that was zeroed in place is not a key", () => {
  // The round-four shape. zero() is bytes.fill(0): it empties the buffer and
  // leaves every reference to it alive, so a lock context captured before the
  // app locked still carries a vaultKey field afterwards. A check that only
  // asks whether the field is set seals the crown jewel under 32 zero bytes.
  const k = key();
  const live = atRestForm({ enabled: true, vaultKey: k });
  assert.equal(live.ok, true);
  k.fill(0);
  const dead = atRestForm({ enabled: true, vaultKey: k });
  assert.equal(dead.ok, false, "the same context, after an autolock, may write nothing");
  assert.equal(dead.sealed, true, "the form is still sealed: there is no honest plaintext fallback here");
  assert.equal(dead.vaultKey, null, "and no key is handed back to seal with");
});

test("a lock with nothing usable in the key field writes nothing at all", () => {
  const wrong = [null, undefined, "0".repeat(32), new Uint8Array(31), new Uint8Array(33), [1, 2, 3]];
  for (const vaultKey of wrong) {
    const form = atRestForm({ enabled: true, vaultKey });
    assert.equal(form.ok, false, `${String(vaultKey)} is not a vault key`);
    assert.equal(form.reason, "no-vault-key");
  }
});

// --------------------------------------------------- what an unlock attempt found

test("the sealed chain key is the verifier, and nothing else changes that answer", () => {
  assert.equal(unlockVerdict({ sealed: true, opened: true }).kind, "open-circle");
  assert.equal(unlockVerdict({ sealed: true, opened: false }).kind, "wrong-passcode");
  // A destroy mark on disk does not excuse a passcode that did not open the
  // record sitting beside it.
  assert.equal(
    unlockVerdict({ sealed: true, opened: false, destroyed: true, plainSecret: 1, plainIdentity: 1 }).kind,
    "wrong-passcode",
  );
});

test("a device that destroyed itself is resumed, not repaired", () => {
  // Round five's critical. The repair below this branch is written for a leave
  // the person asked for: it deletes the lock record and rewrites every circle
  // in plaintext. A self-destruct leaves the same empty shape and nobody asked
  // for it, so one phone in a drawer for a month plus one correct passcode
  // silently cost the app lock.
  const v = unlockVerdict({ sealed: false, opened: false, destroyed: true });
  assert.equal(v.kind, "resume-destroyed");
  // And it stays that answer whatever else is lying around: a build whose
  // destruct only erased the chain key left the rest of the circle behind.
  assert.equal(
    unlockVerdict({ sealed: false, destroyed: true, plainSecret: 1, plainIdentity: 1, circles: 3 }).kind,
    "resume-destroyed",
  );
});

test("a plaintext circle with no mark is an interrupted leave, and the plaintext wins", () => {
  const v = unlockVerdict({ sealed: false, destroyed: false, plainSecret: 1, plainIdentity: 1 });
  assert.equal(v.kind, "restore-plaintext");
  // The recovery writes plaintext before it deletes the lock record, so its
  // last crash window is a fully restored circle that needs the stale record
  // cleared. Checking the sealed array first would put that device through
  // onboarding instead.
  assert.equal(
    unlockVerdict({ sealed: false, plainSecret: 1, plainIdentity: 1, circles: 2 }).kind,
    "restore-plaintext",
  );
});

test("half a plaintext circle is not a plaintext circle", () => {
  assert.equal(unlockVerdict({ sealed: false, plainSecret: 1, plainIdentity: null }).kind, "read-circles");
  assert.equal(unlockVerdict({ sealed: false, plainSecret: null, plainIdentity: 1 }).kind, "read-circles");
});

test("an array nobody has read yet is not an empty array", () => {
  // Reading the sealed array quarantines an unreadable blob and tells the
  // person, so it cannot be read speculatively. Treating "not read yet" as
  // zero is the difference between promoting a circle and wiping the lock off
  // a device that still has one.
  assert.equal(unlockVerdict({ sealed: false }).kind, "read-circles");
  assert.equal(unlockVerdict({ sealed: false, circles: undefined }).kind, "read-circles");
  assert.equal(unlockVerdict({ sealed: false, circles: null }).kind, "read-circles");
  assert.equal(unlockVerdict({ sealed: false, circles: 0 }).kind, "abandoned");
  assert.equal(unlockVerdict({ sealed: false, circles: 1 }).kind, "promote-circles");
});

// ------------------------------------------------------------ what is in the slots

test("the slots hold a circle, a v1 install, or nothing to show", () => {
  assert.equal(slotsVerdict({ identity: { memberId: "m" }, meta: { g: 0 } }).kind, "circle");
  assert.equal(slotsVerdict({ identity: { memberId: "m" }, meta: null }).kind, "v1");
  assert.equal(slotsVerdict({ identity: null, meta: { g: 0 } }).kind, "no-identity");
  // No identity is asked first: there is nothing honest to show either way,
  // and half a circle is not entered over it.
  assert.equal(slotsVerdict({ identity: null, meta: null }).kind, "no-identity");
});

// ------------------------------------------------------------- what a launch found

const boot = (over) => bootVerdict({ lockEnabled: false, circles: null, destroyed: false, ...over });

test("a locked device with a sealed circle shows the lock screen", () => {
  assert.equal(boot({ lockEnabled: true, sealedSecret: 1, sealedGen: 1 }).kind, "locked");
  assert.equal(boot({ lockEnabled: true, sealedSecret: 1, sealedStaged: 1 }).kind, "locked");
});

test("a lock record with nothing behind it is stale, unless the chain destroyed itself", () => {
  const empty = { lockEnabled: true, sealedSecret: null, secret: null, sealedCircles: null, circles: null };
  assert.equal(boot({ ...empty }).kind, "stale-lock");
  // Rounds five and six both ended here: the destruct makes exactly the empty
  // shape a cut-short leave makes, the mark is the only thing on disk that
  // tells them apart, and leaving it out of this test deleted the app lock.
  assert.equal(boot({ ...empty, destroyed: true }).kind, "locked");
});

test("anything still worth protecting keeps the lock, in either form", () => {
  const empty = { lockEnabled: true, sealedSecret: null, secret: null, sealedCircles: null, circles: null };
  // Plaintext left by a crash mid lock-enable is the only copy there is.
  assert.equal(boot({ ...empty, secret: 1 }).kind, "locked");
  assert.equal(boot({ ...empty, sealedCircles: 1 }).kind, "locked");
  assert.equal(boot({ ...empty, circles: [{}] }).kind, "locked");
});

test("a sealed secret with no generation beside it is v1 storage, and needs no passcode to say so", () => {
  assert.equal(boot({ lockEnabled: true, sealedSecret: 1, sealedGen: null, sealedStaged: null }).kind, "v1");
  assert.equal(boot({ lockEnabled: true, sealedSecret: 1, sealedGen: null, sealedStaged: 1 }).kind, "locked");
});

test("an unlocked launch enters the circle it finds, promotes the one it can, or explains the empty", () => {
  assert.equal(boot({ secret: 1, identity: 1 }).kind, "active");
  assert.equal(boot({ secret: 1, identity: null, circles: [{}] }).kind, "promote");
  assert.equal(boot({ circles: [] }).kind, "onboarding");
  assert.equal(boot({}).kind, "onboarding");
});

test("the unlocked launch reads the mark too", () => {
  // The mark was written by the destruct and then read on the locked path
  // only, which is not the configuration the app ships with: the person who
  // never turned the lock on got no explanation for a circle that vanished.
  assert.equal(boot({ destroyed: true }).kind, "destroyed");
  // A circle still in the slots outranks it: the mark is spent by the card a
  // person dismisses, not by a launch that had something else to show.
  assert.equal(boot({ secret: 1, identity: 1, destroyed: true }).kind, "active");
  assert.equal(boot({ circles: [{}], destroyed: true }).kind, "promote");
});

// ------------------------------------------------------------ the destruct order

test("what erases goes first, and only bookkeeping is allowed to fail", () => {
  const plan = destructPlan();
  const erase = plan.findIndex((s) => s.erases);
  assert.ok(erase >= 0, "something in the plan actually erases");
  for (const [i, step] of plan.entries()) {
    if (step.erases) continue;
    // Round six's critical, stated: the mark used to be written before the
    // erase, so one rejected dbSet on a device with no quota left vetoed the
    // erase while the card on screen said the keys were gone.
    assert.ok(i > erase, `${step.step} is bookkeeping and must not come before the erase`);
  }
  assert.equal(plan[erase].mayFail, false, "the erase is the security action; it does not get shrugged off");
  assert.equal(plan.find((s) => s.step === "mark-destroyed").mayFail, true);
});

test("every step of the destruct says what it commits and what a failure does", () => {
  for (const step of destructPlan()) {
    for (const field of ["step", "does", "commits", "onFailure"]) {
      assert.equal(typeof step[field], "string", `${step.step}.${field}`);
      assert.ok(step[field].length > 0, `${step.step}.${field} is empty`);
    }
    assert.equal(typeof step.erases, "boolean");
    assert.equal(typeof step.mayFail, "boolean");
  }
});

test("the code destroys in the order the plan says it does", async () => {
  // A plan nothing checks is a comment wearing a function's clothes. This is
  // the technique test/joinflow.test.mjs uses on admissionPlan, for the same
  // reason: the ordering here was inverted once already, and every property
  // test of a literal array stayed green while it was.
  const at = (body, needle, from) => {
    const i = body.indexOf(needle, from);
    assert.notEqual(i, -1, `leaveDestroyedCircle still does ${needle}`);
    return i;
  };
  const src = await readFile(new URL("../app/js/main.js", import.meta.url), "utf8");
  const body = src.slice(
    src.indexOf("async function leaveDestroyedCircle"),
    src.indexOf("function showDestroyedNotice"),
  );
  assert.ok(body.length > 500, "found leaveDestroyedCircle's body to read");

  const marker = {
    "erase-circle": "leaveActive(",
    "mark-destroyed": "dbSet(DESTROYED_KEY",
    "adopt-promotion": "applyActive(",
  };
  let from = 0;
  const found = [];
  for (const { step } of destructPlan()) {
    from = at(body, marker[step], from);
    found.push(step);
  }
  assert.deepEqual(found, ["erase-circle", "mark-destroyed", "adopt-promotion"], "every step was located in order");

  // mayFail is not a note either: the mark is written inside a catch that
  // swallows, so a store with no quota left cannot take the erase down.
  const between = body.slice(body.indexOf("leaveActive("), body.indexOf("dbSet(DESTROYED_KEY"));
  assert.match(between, /try \{/, "the bookkeeping write is guarded, so its failure cannot unwind the erase");
});

test("nothing on the destruct path takes the app lock off", async () => {
  // The other half of round five. A leave the person asks for takes the lock
  // with it rather than leaving a lock screen no passcode can satisfy. A
  // self-destruct is not asked for and must never cost anybody their lock, and
  // both the destruct and the unlock that resumes one have deleted it before.
  const src = await readFile(new URL("../app/js/main.js", import.meta.url), "utf8");
  const destruct = src.slice(
    src.indexOf("async function leaveDestroyedCircle"),
    src.indexOf("function showDestroyedNotice"),
  );
  const resume = src.slice(
    src.indexOf('if (found.kind === "resume-destroyed")'),
    src.indexOf('if (found.kind === "restore-plaintext")'),
  );
  assert.ok(resume.length > 300, "found the resume branch of openVaultWith to read");
  for (const [name, body] of [
    ["the destruct", destruct],
    ["the unlock that resumes one", resume],
  ]) {
    assert.doesNotMatch(body, /dbDel\("lock"\)/, `${name} deletes the lock record`);
    assert.doesNotMatch(body, /state\.lock = null/, `${name} drops the lock from memory`);
    assert.doesNotMatch(body, /SEALED_KEYS/, `${name} purges the sealed slots the lock protects`);
  }
});

test("main.js asks one function whether it may write, and asks it nowhere else", async () => {
  // Every writer used to spell the fail-closed rule out for itself, and the
  // one that only asked whether the field was set is how a scrubbed key got
  // to seal the chain key under 32 zero bytes.
  const src = await readFile(new URL("../app/js/main.js", import.meta.url), "utf8");
  assert.equal(
    (src.match(/usableVaultKey/g) || []).length,
    0,
    "main.js checks the vault key itself again; that question has one home",
  );
  const write = src.slice(src.indexOf("async function writeChainKey"), src.indexOf("// The members this generation"));
  assert.match(write, /atRestForm\(lock\)/);
  assert.match(write, /if \(!form\.ok\) throw/, "the crown jewel is still refused rather than downgraded");
});
