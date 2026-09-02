// The roster and pinning decisions, checked without a page.
//
// These used to live inside main.js, which boots itself and talks to the DOM,
// so reaching them at all meant standing up a fake browser first. That is why
// they were reviewed six times and tested twice: the member cap was verified
// against a bare Map while the app passed a store with no size on it, and the
// agreement-key check was installed on one pinning path out of three. Nothing
// here needs a harness, so there is no gap left between the rule and the check
// of it.
import test from "node:test";
import assert from "node:assert/strict";

import {
  ROSTER_GRACE_MS,
  acceptedKeyChange,
  admitPinned,
  canonKey,
  canonPinned,
  describeKeyChange,
  genRosterFrom,
  keyChangeVerdict,
  pendingAfterRekey,
  pinnedFromRecipients,
  reconcileVerdict,
  rekeyRecipients,
  rosterAfterRekey,
  sameKey,
} from "../app/js/roster.js";
import { generateIdentity } from "../app/js/crypto.js";
import { MEMBER_CAP, b64uEncode, rosterHash } from "../app/js/wire.js";
import { rosterView } from "../app/js/membership.js";

// A member as a pinning path sees them: an identity, plus the record a relay
// or a welcome would carry for it.
async function member(name = "") {
  const id = await generateIdentity();
  return {
    id,
    memberId: id.memberId,
    rec: { memberId: id.memberId, alg: id.alg, pk: b64uEncode(id.pk), epk: b64uEncode(id.epk), name },
    pinned: {
      memberId: id.memberId,
      alg: id.alg,
      pk: b64uEncode(id.pk),
      epk: b64uEncode(id.epk),
      verified: false,
      name,
    },
  };
}

// The same key, spelled the other way. base64url leaves two unused bits in the
// last character of a 32 or 65 byte key, so this decodes to the identical
// bytes and is the exact thing that used to read as somebody else's key.
function respell(s) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const last = alphabet.indexOf(s[s.length - 1]);
  const other = alphabet[last ^ 1];
  assert.notEqual(other, s[s.length - 1]);
  return s.slice(0, -1) + other;
}

// The algorithm this key is not. Identities are Ed25519 wherever WebCrypto
// offers it and P-256 where it does not, so a test that lies about the field
// has to lie relative to the key it was handed.
const otherAlg = (alg) => (alg === "ed25519" ? "p256" : "ed25519");

// A 33 byte compressed P-256 key. It is a real key by every length and shape
// check the relay and the wire format make, and it is not something WebCrypto
// will import, so a member pinned on one is a member nobody else can wrap to.
async function compressedEcdhKey() {
  const kp = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
  const out = new Uint8Array(33);
  out[0] = 2 + (raw[64] & 1);
  out.set(raw.subarray(1, 33), 1);
  return out;
}

// ----------------------------------------------------------- key spelling

test("one key has one canonical spelling and compares equal in any of them", async () => {
  const a = await member();
  const other = respell(a.rec.pk);

  assert.notEqual(other, a.rec.pk, "the two spellings really are different text");
  assert.equal(canonKey(other), canonKey(a.rec.pk), "and they canonicalise to one");
  assert.ok(sameKey(other, a.rec.pk), "so comparing them by bytes says they are one key");
});

test("a record whose keys will not decode keeps the spelling it came with", () => {
  const rec = { memberId: "x", alg: "p256", pk: "!!!!", epk: "!!!!", verified: true };
  assert.deepEqual(canonPinned(rec), rec, "nothing is invented for a record nothing can wrap to");
});

test("canonPinned rewrites both keys and leaves everything else alone", async () => {
  const a = await member("Ada");
  const odd = { ...a.pinned, pk: respell(a.pinned.pk), epk: respell(a.pinned.epk), verified: true };
  const out = canonPinned(odd);

  assert.equal(out.pk, a.pinned.pk);
  assert.equal(out.epk, a.pinned.epk);
  assert.equal(out.verified, true, "the local verification bit survives being re-spelled");
  assert.equal(out.name, "Ada");
});

// -------------------------------------------------------- pinning a member

test("a member is pinned in the canonical spelling of the keys their id commits to", async () => {
  const a = await member("Ada");
  const pinned = new Map();
  const v = await admitPinned({ pinned, rec: { ...a.rec, pk: respell(a.rec.pk) } });

  assert.equal(v.ok, true);
  assert.equal(v.already, false);
  assert.equal(v.memberId, a.memberId, "the id is derived, not taken from the record");
  assert.equal(v.entry.pk, a.pinned.pk, "and the record pinned is the canonical one");
  assert.equal(v.entry.verified, false, "nothing arrives verified");
  assert.equal(pinned.size, 0, "the verdict is a verdict: it writes nothing itself");
});

test("a compressed agreement key is refused before it can be pinned", async () => {
  const a = await member();
  const comp = await compressedEcdhKey();
  const v = await admitPinned({ pinned: new Map(), rec: { ...a.rec, memberId: undefined, epk: b64uEncode(comp) } });

  assert.equal(v.ok, false);
  assert.equal(v.reason, "epk", "a member every other device would refuse never gets in");
});

test("the algorithm comes from the key, never from the record", async () => {
  const a = await member();
  const lie = otherAlg(a.id.alg);
  const v = await admitPinned({ pinned: new Map(), rec: { ...a.rec, alg: lie } });

  assert.equal(v.ok, true);
  assert.equal(v.entry.alg, a.id.alg, "the lie on the record is not what lands in the roster");
  assert.notEqual(v.entry.alg, lie);
});

test("a signing key of no known length is not a signing key", async () => {
  const a = await member();
  const v = await admitPinned({ pinned: new Map(), rec: { ...a.rec, memberId: undefined, pk: b64uEncode(new Uint8Array(40)) } });

  assert.equal(v.ok, false);
  assert.equal(v.reason, "alg");
});

test("a record claiming an id its keys do not derive to is refused", async () => {
  const a = await member();
  const b = await member();
  const v = await admitPinned({ pinned: new Map(), rec: { ...a.rec, memberId: b.memberId } });

  assert.equal(v.ok, false);
  assert.equal(v.reason, "id", "one member's id over another member's keys is not a member");
});

test("keys that will not decode at all are refused rather than thrown over", async () => {
  const a = await member();
  for (const rec of [null, { ...a.rec, pk: "!!!" }, { ...a.rec, epk: "!!!" }]) {
    const v = await admitPinned({ pinned: new Map(), rec });
    assert.equal(v.ok, false);
    assert.equal(v.reason, "unreadable");
  }
});

test("meeting a pinned member again returns the record already held, not a fresh one", async () => {
  const a = await member("Ada");
  const held = { ...a.pinned, verified: true, name: "Ada" };
  const pinned = new Map([[a.memberId, held]]);
  const v = await admitPinned({ pinned, rec: { ...a.rec, name: "not Ada" } });

  assert.equal(v.ok, true);
  assert.equal(v.already, true);
  assert.equal(v.entry, held, "a re-pin would drop what this person checked in person");
});

// The defect this is named for: the cap was measured against a bare Map in the
// test and against a duck-typed store in the app, and the store had no size on
// it, so `size >= MEMBER_CAP` compared undefined and was false forever.
test("the member cap is measured through whatever the caller passes, store or map", async () => {
  const full = new Map();
  for (let i = 0; i < MEMBER_CAP; i++) {
    const m = await member();
    full.set(m.memberId, m.pinned);
  }
  const store = { get: (id) => full.get(id), get size() { return full.size; } };
  const newcomer = await member();

  for (const pinned of [full, store]) {
    const v = await admitPinned({ pinned, rec: newcomer.rec });
    assert.equal(v.ok, false);
    assert.equal(v.reason, "cap", "a full circle takes nobody else");
  }

  const known = [...full.values()][0];
  const again = await admitPinned({ pinned: store, rec: { memberId: known.memberId, alg: known.alg, pk: known.pk, epk: known.epk } });
  assert.equal(again.ok, true, "and somebody already pinned takes no new slot");
  assert.equal(again.already, true);
});

test("a caller with no cap says so, and is the only one that gets none", async () => {
  const full = new Map();
  for (let i = 0; i < MEMBER_CAP; i++) {
    const m = await member();
    full.set(m.memberId, m.pinned);
  }
  const newcomer = await member();

  assert.equal((await admitPinned({ pinned: full, rec: newcomer.rec })).ok, false, "capped by default");
  assert.equal((await admitPinned({ pinned: full, rec: newcomer.rec, cap: Infinity })).ok, true, "uncapped only on request");
});

// ------------------------------------------------------------ key changes

test("the same keys spelled differently are not a key change", async () => {
  const a = await member();
  const presented = { alg: a.pinned.alg, pk: respell(a.pinned.pk), epk: respell(a.pinned.epk) };

  assert.equal(keyChangeVerdict(a.pinned, presented), "same", "nobody is pointed at a member who changed nothing");
});

test("different keys, or a different algorithm, are a key change", async () => {
  const a = await member();
  const b = await member();

  assert.equal(keyChangeVerdict(a.pinned, { ...a.pinned, pk: b.pinned.pk }), "change");
  assert.equal(keyChangeVerdict(a.pinned, { ...a.pinned, epk: b.pinned.epk }), "change");
  assert.equal(keyChangeVerdict(a.pinned, { ...a.pinned, alg: otherAlg(a.pinned.alg) }), "change");
  assert.equal(keyChangeVerdict(undefined, a.pinned), "change", "keys for somebody unpinned go to a human too");
});

test("a key change card carries both safety numbers", async () => {
  const a = await member("Ada");
  const b = await member();
  const presented = { alg: b.pinned.alg, pk: b.pinned.pk, epk: b.pinned.epk };
  const card = await describeKeyChange({ known: a.pinned, presented, now: 1234 });

  assert.equal(card.at, 1234);
  assert.deepEqual(card.was, { alg: a.pinned.alg, pk: a.pinned.pk, epk: a.pinned.epk });
  assert.match(card.oldSafety, /^\d{5}( \d{5}){5}$/);
  assert.match(card.newSafety, /^\d{5}( \d{5}){5}$/);
  assert.notEqual(card.oldSafety, card.newSafety, "there is something for a person to compare");
});

test("a key change card survives a key that will not decode", async () => {
  const card = await describeKeyChange({ known: null, presented: { alg: "p256", pk: "!!!", epk: "!!!" }, now: 7 });

  assert.equal(card.was, null, "nothing is claimed about a member that was never pinned");
  assert.equal(card.oldSafety, null);
  assert.equal(card.newSafety, null, "no safety number rather than no card at all");
});

test("accepting a key change re-checks the agreement key a human just approved", async () => {
  const a = await member("Ada");
  const comp = await compressedEcdhKey();
  const bad = await acceptedKeyChange({
    known: a.pinned,
    presented: { alg: a.pinned.alg, pk: a.pinned.pk, epk: b64uEncode(comp) },
  });

  assert.equal(bad, null, "a person tapping accept is not the way a bad point gets in");
});

test("accepted new keys are pinned canonically, unverified, under the name already given", async () => {
  const a = await member("Ada");
  const b = await member();
  const out = await acceptedKeyChange({
    known: { ...a.pinned, verified: true },
    presented: { memberId: a.memberId, alg: b.pinned.alg, pk: respell(b.pinned.pk), epk: respell(b.pinned.epk) },
  });

  assert.equal(out.pk, b.pinned.pk, "canonical, like every other pinning path");
  assert.equal(out.epk, b.pinned.epk);
  assert.equal(out.verified, false, "what was checked in person was checked against keys that are gone");
  assert.equal(out.name, "Ada", "the local name is not the thing that changed");
});

// ------------------------------------------------------- roster convergence

// One rotator's claim about the circle, as it is sealed inside a re-key wrap:
// the hash of everyone it wrapped to, which is the circle minus itself.
const claim = async (by, ids) => ({ by, rh: await rosterHash(ids), at: 0 });

test("no pending claim is not a disagreement", async () => {
  assert.equal(await reconcileVerdict({ pinned: [], self: "me", pending: null, now: 0 }), "none");
});

test("a roster that hashes to the rotator's claim converges", async () => {
  const me = "1".repeat(32);
  const rot = "2".repeat(32);
  const newcomer = "3".repeat(32);
  const pending = await claim(rot, [me, newcomer]);

  assert.equal(
    await reconcileVerdict({ pinned: [rot, newcomer], self: me, pending, now: 0 }),
    "converged",
    "the rotator named exactly these people, so the newcomer may re-key in turn",
  );
});

test("an admission is given its grace before anybody is alarmed", async () => {
  const me = "1".repeat(32);
  const rot = "2".repeat(32);
  const newcomer = "3".repeat(32);
  const pending = await claim(rot, [me, newcomer]);
  const args = { pinned: [rot], self: me, pending };

  assert.equal(
    await reconcileVerdict({ ...args, now: ROSTER_GRACE_MS - 1 }),
    "wait",
    "somebody joining must not read like somebody standing in for a member",
  );
  assert.equal(
    await reconcileVerdict({ ...args, now: ROSTER_GRACE_MS }),
    "mismatch",
    "a disagreement that never resolves is a real one",
  );
});

test("a roster that never hashes to the claim is a mismatch, whoever is in it", async () => {
  const me = "1".repeat(32);
  const rot = "2".repeat(32);
  const pending = await claim(rot, [me, "3".repeat(32)]);

  assert.equal(
    await reconcileVerdict({ pinned: [rot, "4".repeat(32)], self: me, pending, now: ROSTER_GRACE_MS }),
    "mismatch",
    "pinning somebody is not the same as pinning the somebody the rotator named",
  );
});

test("a claim with no hash on it converges nothing", async () => {
  const verdict = await reconcileVerdict({
    pinned: ["2".repeat(32)],
    self: "1".repeat(32),
    pending: { by: "2".repeat(32), rh: "", at: 0 },
    now: 0,
  });
  assert.equal(verdict, "wait", "an empty hash is not agreement");
});

test("a re-key's removals land in the roster and in the view hashed against it", async () => {
  const me = "1".repeat(32);
  const rot = "2".repeat(32);
  const gone = "3".repeat(32);
  const pinned = new Map([[rot, {}], [gone, {}], ["4".repeat(32), {}]]);
  const { pinned: next, view } = rosterAfterRekey({ pinned, removed: [gone], self: me, by: rot });

  assert.equal(next.has(gone), false, "the removed member is out of the roster");
  assert.equal(pinned.has(gone), true, "and the map handed in was not mutated under the caller");
  assert.deepEqual(view.slice().sort(), [me, "4".repeat(32)].sort(), "the view is our roster minus the rotator, plus us");
  assert.deepEqual(view, rosterView({ pinned: next.keys(), self: me, by: rot }), "one definition of that view, not two");
});

test("a re-key we agree with, or one that claims nothing, leaves nothing pending", async () => {
  assert.equal(pendingAfterRekey({ agrees: true, rh: "abc", by: "x", now: 5 }), null);
  assert.equal(pendingAfterRekey({ agrees: false, rh: "", by: "x", now: 5 }), null, "no claim, nothing to reconcile");
  assert.deepEqual(pendingAfterRekey({ agrees: false, rh: "abc", by: "x", now: 5 }), { by: "x", rh: "abc", at: 5 });
});

test("a generation with an empty roster written down is not a generation with none", () => {
  assert.deepEqual([...genRosterFrom({ genRoster: ["a"] }, ["b"])], ["a"]);
  assert.deepEqual([...genRosterFrom({ genRoster: [] }, ["b"])], [], "an empty set was recorded, so it is honoured");
  assert.deepEqual([...genRosterFrom({}, ["b"])], ["b"], "a record from a build that never wrote the field falls back");
  assert.deepEqual([...genRosterFrom(null, ["b"])], ["b"]);
});

// ---------------------------------------------------------- re-key wraps

test("admitting somebody already pinned does not wrap to them twice", async () => {
  // The defect: a welcome that failed to send left the joiner pinned, the
  // person accepted again, and the admission was pushed onto a list that
  // already held them. rosterHash sorts and joins, it does not dedupe, so the
  // hash went out over "a,a,b" and no other device could reach it. Every other
  // member was then stuck on a membership mismatch nothing could clear.
  const a = await member("Ada");
  const b = await member("Bo");
  const pinned = new Map([[a.memberId, { ...a.pinned, verified: true }], [b.memberId, b.pinned]]);
  const admit = { memberId: a.memberId, epk: new Uint8Array(65), rec: { ...a.pinned, verified: false } };

  const recipients = rekeyRecipients({ pinned, admit });
  const ids = recipients.map((r) => r.memberId);

  assert.equal(ids.length, new Set(ids).size, "one wrap per member");
  assert.equal(await rosterHash(ids), await rosterHash([a.memberId, b.memberId]), "and a hash every other device can reach");
  assert.equal(recipients.find((r) => r.memberId === a.memberId).rec.verified, true, "the record already held is the one kept");
});

test("a re-key wraps to everyone pinned except the people it removes", async () => {
  const a = await member();
  const b = await member();
  const c = await member();
  const pinned = new Map([[a.memberId, a.pinned], [b.memberId, b.pinned], [c.memberId, c.pinned]]);

  const recipients = rekeyRecipients({ pinned, removed: [b.memberId] });

  assert.deepEqual(recipients.map((r) => r.memberId), [a.memberId, c.memberId]);
  assert.equal(recipients[0].epk.length, 65, "each one carries the bytes to wrap to");
});

test("a pinned key nothing can decode is not wrapped to and not counted", async () => {
  const a = await member();
  const pinned = new Map([[a.memberId, a.pinned], ["b", { alg: "p256", pk: "!!!", epk: "!!!" }]]);

  const recipients = rekeyRecipients({ pinned });

  assert.deepEqual(recipients.map((r) => r.memberId), [a.memberId], "unwrappable is effectively removed");
  assert.equal(
    await rosterHash(recipients.map((r) => r.memberId)),
    await rosterHash([a.memberId]),
    "and the hash says exactly that, so nobody is told about a member nobody got keys to",
  );
});

test("a new admission joins the recipients once", async () => {
  const a = await member();
  const joiner = await member("Zed");
  const pinned = new Map([[a.memberId, a.pinned]]);
  const admit = { memberId: joiner.memberId, epk: new Uint8Array(65), rec: joiner.pinned };

  const recipients = rekeyRecipients({ pinned, admit });

  assert.deepEqual(recipients.map((r) => r.memberId), [a.memberId, joiner.memberId]);
});

test("the roster a new generation opens with is exactly who it wrapped to", async () => {
  const a = await member("Ada");
  const b = await member("Bo");
  const next = pinnedFromRecipients([
    { memberId: a.memberId, epk: new Uint8Array(65), rec: { ...a.pinned, verified: true } },
    { memberId: b.memberId, epk: new Uint8Array(65), rec: b.pinned },
  ]);

  assert.deepEqual([...next.keys()], [a.memberId, b.memberId]);
  assert.equal(next.get(a.memberId).verified, true, "a re-key does not quietly un-verify anybody");
});
