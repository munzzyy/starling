// Letting somebody in, and being let in.
//
// Four review rounds in a row found defects on this path, and none of them
// were in the sealing. They were ordering: a welcome posted before the records
// it stands on, a slot claimed after the re-key that needed it, a cap that
// counted the wrong people, an algorithm read off the wire instead of off the
// key. Every one of them was invisible because the rule lived in the order of
// a long function's awaits and there was nothing to point a test at.
//
// So these point at the rules. No page, no fetch, no fake DOM.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  WELCOME_GRACE_MS,
  WELCOME_MSG_CAP,
  admissionCheck,
  admissionPlan,
  inviteExpired,
  inviteMintedBy,
  inviteWatchDecision,
  joinPromptVerdict,
  memberRecordBody,
  mintDecision,
  recordOverflows,
  roomFor,
  screenJoinRequest,
  screenWelcomeMessage,
  slotFailure,
  undoAdmission,
  welcomePlan,
  welcomeRoster,
  welcomeVerdict,
} from "../app/js/joinflow.js";
import { generateIdentity, inviterCommitment } from "../app/js/crypto.js";
import { MEMBER_CAP, PAD_LEN, b64uEncode } from "../app/js/wire.js";

const NOW = 1767225600000;
const HOUR = 60 * 60 * 1000;

// An invitation as createInvite leaves it: a secret, a commitment to the
// minting identity's keys, and the member id of that identity.
const invitation = (by, { at = NOW, ttl = HOUR } = {}) => ({
  secret: new Uint8Array(32).fill(7),
  commit: new Uint8Array(16).fill(3),
  by,
  createdAt: at,
  expiresAt: at + ttl,
});

// A join request as onJoinRequest would have left it on the list.
const requestFrom = (id, name = "Zed") => ({
  memberId: id.memberId,
  alg: id.alg,
  pk: b64uEncode(id.pk),
  epk: b64uEncode(id.epk),
  name,
  safety: "11111 22222",
  at: NOW,
});

// The sender fields the invite poller hands a receiver, and the commitment the
// link would have carried for them.
async function inviterOf(id) {
  return {
    from: { memberId: id.memberId, alg: id.alg, pk: b64uEncode(id.pk), epk: b64uEncode(id.epk) },
    commit: await inviterCommitment(id.pk, id.epk),
  };
}

// The same key, spelled the other way: base64url leaves two unused bits in the
// last character of a 32 or 65 byte key, so flipping one changes the text and
// nothing else.
const B64U = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const respell = (s) => s.slice(0, -1) + B64U[B64U.indexOf(s[s.length - 1]) ^ 1];

// A roster of n members that nobody needs the keys of.
const rosterOf = (n) => new Map(Array.from({ length: n }, (_, i) => [`${i}`.padStart(32, "0"), { name: `M${i}` }]));

// --- the invitation ---------------------------------------------------------

test("an invitation another identity minted is burned, not answered", async () => {
  // There is one invite slot on this device and there can be several circles.
  // A credential naming somebody else's identity is somebody else's live link,
  // and answering it admits a stranger to a circle nobody meant to invite them
  // to.
  const mine = "a".repeat(32);
  const theirs = "b".repeat(32);
  const inv = invitation(theirs);

  assert.equal(inviteMintedBy(inv, mine), false);
  assert.deepEqual(inviteWatchDecision({ invite: inv, ready: true, selfId: mine, now: NOW }), {
    action: "burn",
    reason: "wrong-circle",
  });
  assert.deepEqual(inviteWatchDecision({ invite: invitation(mine), ready: true, selfId: mine, now: NOW }), {
    action: "watch",
  });
});

test("a link past its hour is burned rather than left looking usable", async () => {
  const mine = "a".repeat(32);
  const inv = invitation(mine);

  assert.equal(inviteExpired(inv, inv.expiresAt + 1), true);
  assert.equal(inviteExpired(inv, inv.expiresAt), false, "the expiry itself is not past it yet");
  assert.deepEqual(inviteWatchDecision({ invite: inv, ready: true, selfId: mine, now: inv.expiresAt + 1 }), {
    action: "burn",
    reason: "expired",
  });
});

test("there is nothing to watch without a circle to admit anybody to", async () => {
  const mine = "a".repeat(32);
  assert.deepEqual(inviteWatchDecision({ invite: null, ready: true, selfId: mine, now: NOW }), { action: "idle" });
  assert.deepEqual(inviteWatchDecision({ invite: invitation(mine), ready: false, selfId: mine, now: NOW }), {
    action: "idle",
  });
});

test("one live link at a time: a live one is handed back, a dead one is replaced", async () => {
  // Two live credentials for one circle is two chances for the wrong person to
  // be holding one.
  const mine = "a".repeat(32);
  const inv = invitation(mine);

  assert.deepEqual(mintDecision({ invite: inv, ready: true, now: NOW + 1 }), { action: "reuse" });
  assert.deepEqual(mintDecision({ invite: inv, ready: true, now: inv.expiresAt + 1 }), { action: "mint", replaces: true });
  assert.deepEqual(mintDecision({ invite: null, ready: true, now: NOW }), { action: "mint", replaces: false });
  assert.deepEqual(mintDecision({ invite: inv, ready: false, now: NOW }), { action: "refuse" });
  // The one instant that is neither: handing a link back needs the clock
  // strictly inside its life, burning one needs it strictly past. At the
  // expiry itself a fresh link is minted and nothing is torn out from under a
  // poll that is mid-flight.
  assert.equal(mintDecision({ invite: inv, ready: true, now: inv.expiresAt }).action, "mint");
  assert.equal(inviteExpired(inv, inv.expiresAt), false);
});

test("this device does not answer its own link, or one it has already asked on", async () => {
  const mine = "a".repeat(32);
  const inv = invitation(mine);
  const other = { ...invitation(mine), secret: new Uint8Array(32).fill(9) };

  assert.equal(joinPromptVerdict({ joining: null, invite: inv, candidate: { secret: inv.secret } }), "own-link");
  assert.equal(joinPromptVerdict({ joining: { secret: inv.secret }, invite: null, candidate: { secret: inv.secret } }), "already-asked");
  assert.equal(joinPromptVerdict({ joining: null, invite: inv, candidate: { secret: other.secret } }), "ok");
});

test("a refused slot is told apart from a network that is merely down", async () => {
  // A 403 on the way into a rendezvous channel is the member cap, and it will
  // still be there on the next try, so that link is finished. A 503 is a bad
  // moment and the link still works.
  assert.deepEqual(slotFailure(new Error("post 403")), { jammed: true, burn: true });
  assert.deepEqual(slotFailure(new Error("post 503")), { jammed: false, burn: false });
  assert.equal(slotFailure(undefined).burn, false);
});

// --- the joiner asking ------------------------------------------------------

test("a request is screened before a person is ever shown it", async () => {
  const joiner = await generateIdentity();
  const { from } = await inviterOf(joiner);
  const inv = invitation("a".repeat(32));
  const base = { obj: { t: "join", name: "Zed" }, from, invite: inv, now: NOW, keysMatch: true, known: false, listed: false };

  const ok = await screenJoinRequest(base);
  assert.equal(ok.ok, true);
  assert.equal(ok.name, "Zed");
  assert.match(ok.safety, /^\d{5}( \d{5}){5}$/, "the number the two people read to each other");

  assert.equal((await screenJoinRequest({ ...base, obj: { t: "loc" } })).reason, "not-a-join");
  assert.equal((await screenJoinRequest({ ...base, invite: null })).reason, "no-invite");
  assert.equal((await screenJoinRequest({ ...base, now: inv.expiresAt + 1 })).reason, "expired");
  assert.equal((await screenJoinRequest({ ...base, known: true })).reason, "already-a-member");
  assert.equal((await screenJoinRequest({ ...base, listed: true })).reason, "already-listed");
  assert.equal((await screenJoinRequest({ ...base, from: { ...from, pk: "!!!" } })).reason, "unreadable");
});

test("a request whose keys are not the keys it signed with never reaches a person", async () => {
  // The safety number a person compares has to be the number of the member who
  // would be pinned, or comparing it means nothing.
  const joiner = await generateIdentity();
  const { from } = await inviterOf(joiner);
  const seen = await screenJoinRequest({
    obj: { t: "join", name: "Zed" },
    from,
    invite: invitation("a".repeat(32)),
    now: NOW,
    keysMatch: false,
    known: false,
    listed: false,
  });
  assert.deepEqual(seen, { ok: false, reason: "key-mismatch" });
});

test("a request whose agreement key is not a real point is dropped at the door", async () => {
  // Accepting one pins a member every other device in the circle will reject,
  // so there is nothing here for anybody to decide.
  const joiner = await generateIdentity();
  const { from } = await inviterOf(joiner);
  const junk = new Uint8Array(65);
  junk[0] = 4;
  const seen = await screenJoinRequest({
    obj: { t: "join", name: "Zed" },
    from: { ...from, epk: b64uEncode(junk) },
    invite: invitation("a".repeat(32)),
    now: NOW,
    keysMatch: true,
    known: false,
    listed: false,
  });
  assert.deepEqual(seen, { ok: false, reason: "bad-key" });
});

test("a name is clamped, and a name that is not a name is no name", async () => {
  const joiner = await generateIdentity();
  const { from } = await inviterOf(joiner);
  const base = { from, invite: invitation("a".repeat(32)), now: NOW, keysMatch: true, known: false, listed: false };

  assert.equal((await screenJoinRequest({ ...base, obj: { t: "join", name: "x".repeat(80) } })).name.length, 24);
  assert.equal((await screenJoinRequest({ ...base, obj: { t: "join", name: { evil: 1 } } })).name, "");
});

// --- the admission decision -------------------------------------------------

test("a full circle turns the next joiner away instead of admitting a seventeenth", async () => {
  // Occupancy is the pinned roster PLUS this device, which is never in it. The
  // cap in net.js bounds what a relay can push into the roster and the one the
  // rendezvous channel enforces counts a different set of people, so neither
  // of them stands here. Without this one a full circle admitted one more, the
  // circle channel had no slot left for somebody, and that person stopped
  // being able to post with nothing on any screen saying which of them it was.
  const joiner = await generateIdentity();
  const req = requestFrom(joiner);
  const inv = invitation("a".repeat(32));
  const args = { req, invite: inv, ready: true, now: NOW };

  const lastSeat = rosterOf(MEMBER_CAP - 2);
  assert.equal(roomFor(lastSeat, req.memberId), true, "the negative control: one seat left");
  assert.equal((await admissionCheck({ ...args, pinned: lastSeat })).ok, true);

  const full = rosterOf(MEMBER_CAP - 1);
  assert.equal(roomFor(full, req.memberId), false);
  assert.deepEqual(await admissionCheck({ ...args, pinned: full }), { ok: false, reason: "full" });
});

test("somebody already pinned takes no new seat", async () => {
  // Undoing a failed admission is itself a re-key and it can fail in turn.
  // That is the only way to reach a full circle holding a member who still has
  // to be accepted, and accepting them again is the way out of it.
  const joiner = await generateIdentity();
  const req = requestFrom(joiner);
  const full = rosterOf(MEMBER_CAP - 1);
  full.set(req.memberId, { name: "Zed" });

  assert.equal(roomFor(full, req.memberId), true);
  assert.equal((await admissionCheck({ req, invite: invitation("a".repeat(32)), pinned: full, ready: true, now: NOW })).ok, true);
});

test("nothing is admitted without a live circle and a live link", async () => {
  const joiner = await generateIdentity();
  const req = requestFrom(joiner);
  const inv = invitation("a".repeat(32));

  assert.deepEqual(await admissionCheck({ req, invite: null, pinned: new Map(), ready: true, now: NOW }), {
    ok: false,
    reason: "no-circle",
  });
  assert.deepEqual(await admissionCheck({ req, invite: inv, pinned: new Map(), ready: false, now: NOW }), {
    ok: false,
    reason: "no-circle",
  });
  assert.deepEqual(await admissionCheck({ req, invite: inv, pinned: new Map(), ready: true, now: inv.expiresAt + 1 }), {
    ok: false,
    reason: "expired",
  });
});

test("the record pinned is derived from the keys, never read off the request", async () => {
  // `alg` is a wire field the relay serves. Pinned from the request, a member
  // whose record said ed25519 over a P-256 key read as a key change on every
  // device the welcome handed the record to, and the alarm could not be
  // cleared, because the member kept presenting the real key.
  const joiner = await generateIdentity();
  const lie = joiner.alg === "ed25519" ? "p256" : "ed25519";
  const req = { ...requestFrom(joiner), alg: lie };
  const check = await admissionCheck({ req, invite: invitation("a".repeat(32)), pinned: new Map(), ready: true, now: NOW });

  assert.equal(check.ok, true);
  assert.equal(check.rec.alg, joiner.alg, "the algorithm the key actually is");
  assert.notEqual(check.rec.alg, req.alg);
  assert.equal(check.rec.verified, false, "nobody is verified by being let in");
});

test("a request whose id does not commit to its keys is not a member", async () => {
  // The id is re-derived because it is what makes the safety number the person
  // just read out loud the number of the member who lands in the roster.
  const joiner = await generateIdentity();
  const other = await generateIdentity();
  const req = { ...requestFrom(joiner), memberId: other.memberId };

  assert.deepEqual(await admissionCheck({ req, invite: invitation("a".repeat(32)), pinned: new Map(), ready: true, now: NOW }), {
    ok: false,
    reason: "bad-keys",
  });
});

test("admitting refuses an agreement key that is not a point, and says so", async () => {
  // The relay only ever bounds epk as a short base64url string and the member
  // id hashes whatever it is given, so this is the only check that says the key
  // is a point. A refusal somebody is told about is kept apart from keys that
  // will not decode at all, which is nothing anybody can act on.
  const joiner = await generateIdentity();
  const junk = new Uint8Array(65);
  junk[0] = 4;
  const inv = invitation("a".repeat(32));

  assert.deepEqual(
    await admissionCheck({ req: { ...requestFrom(joiner), epk: b64uEncode(junk) }, invite: inv, pinned: new Map(), ready: true, now: NOW }),
    { ok: false, reason: "bad-keys" },
  );
  assert.deepEqual(
    await admissionCheck({ req: { ...requestFrom(joiner), epk: "!!!" }, invite: inv, pinned: new Map(), ready: true, now: NOW }),
    { ok: false, reason: "unreadable" },
  );
  assert.deepEqual(
    await admissionCheck({ req: { ...requestFrom(joiner), pk: "!!!" }, invite: inv, pinned: new Map(), ready: true, now: NOW }),
    { ok: false, reason: "unreadable" },
  );
});

test("the roster keeps one spelling of a key, whatever spelling the request used", async () => {
  // base64url leaves two unused bits in the last character of a 32 or 65 byte
  // key, so four different strings decode to the same bytes. A record pinned
  // as whichever text arrived is a record that reads as a key change the next
  // time the same key is spelled the other way.
  const joiner = await generateIdentity();
  const req = requestFrom(joiner);
  const check = await admissionCheck({
    req: { ...req, pk: respell(req.pk), epk: respell(req.epk) },
    invite: invitation("a".repeat(32)),
    pinned: new Map(),
    ready: true,
    now: NOW,
  });

  assert.notEqual(respell(req.pk), req.pk, "the second spelling really is a different string");
  assert.equal(check.ok, true);
  assert.equal(check.rec.pk, req.pk);
  assert.equal(check.rec.epk, req.epk);
});

// --- the ordering contract --------------------------------------------------

test("the slot is claimed before anything that cannot be taken back", async () => {
  // A rendezvous channel holds MEMBER_CAP member slots and anybody holding the
  // link can fill them. This device has never posted there, so the welcome is
  // its first post and the cap turns exactly that one away. Run the other way
  // round the wraps were on the relay, the generation was open and the joiner
  // was pinned into it before anyone found out.
  const plan = admissionPlan();
  const at = (name) => plan.findIndex((s) => s.step === name);

  assert.ok(at("claim-slot") >= 0 && at("rekey") >= 0, "both steps are in the plan");
  assert.ok(at("claim-slot") < at("rekey"), "the cheap check that can fail permanently goes first");
  assert.equal(plan[at("claim-slot")].commits.startsWith("nothing"), true);
  assert.equal(plan[at("claim-slot")].onFailure, "abort");
});

test("the welcome is the commit point and it goes last", async () => {
  // Posted welcome-first, a delivery that stopped partway left a welcome
  // standing on the channel with records missing, and the joiner opened that
  // same stale welcome on every later poll: it is the first one in the buffer,
  // so a retry's complete welcome was never looked at.
  const plan = admissionPlan();
  const at = (name) => plan.findIndex((s) => s.step === name);

  assert.ok(at("send-records") < at("send-welcome"), "records first");
  assert.equal(plan[at("send-records")].commits.startsWith("nothing"), true, "a record whose welcome never lands is inert");
  assert.equal(plan[at("send-welcome")].commits, "the join, for the joiner");
  assert.equal(at("send-welcome"), plan.length - 2, "nothing but the burn comes after it");
  assert.equal(plan[plan.length - 1].step, "burn-invite");
});

test("every step that commits the admission names what undoes it", async () => {
  const plan = admissionPlan();
  for (const step of plan) {
    assert.ok(step.does && step.commits && step.undo && step.onFailure, `${step.step} is fully stated`);
  }
  const rekey = plan.find((s) => s.step === "rekey");
  assert.equal(rekey.commits, "the admission, on this device and on every other member's");
  assert.equal(rekey.undo, "a second re-key that removes them again");
  // Every step after the admission is real has an undo that puts it back.
  for (const name of ["send-records", "send-welcome"]) {
    assert.equal(plan.find((s) => s.step === name).onFailure, "undo-admission");
  }
});

test("undoing an admission removes exactly the member it admitted", async () => {
  const id = "c".repeat(32);
  assert.deepEqual(undoAdmission(id), { removed: [id], reason: "welcome-failed" });
});

// --- delivering the welcome -------------------------------------------------

test("a welcome names every member the joiner has to pin, and never the joiner", async () => {
  const self = { memberId: "s".repeat(32), alg: "p256", pk: "PK", epk: "EPK", name: "Me" };
  const joinerId = "j".repeat(32);
  const others = [
    { memberId: "a".repeat(32), alg: "p256", pk: "A", epk: "AE", name: "Ada" },
    { memberId: joinerId, alg: "p256", pk: "J", epk: "JE", name: "Zed" },
  ];

  const roster = welcomeRoster({ self, members: others, joinerId });
  assert.deepEqual(
    roster.map((m) => m.memberId),
    [self.memberId, "a".repeat(32)],
    "the inviter is in it and the joiner is not",
  );
  assert.deepEqual(welcomeRoster({ self, members: null, joinerId }).map((m) => m.memberId), [self.memberId]);
});

test("the records go out first and the count the joiner holds the welcome to matches them", async () => {
  // A welcome whose member records go missing leaves a device that decrypts
  // the circle perfectly and can attribute no re-key at all, silently, for as
  // long as the circle lasts. The count is what lets the joiner refuse that.
  const roster = [
    { memberId: "s".repeat(32), alg: "p256", pk: "PK", epk: "EPK", name: "Me" },
    { memberId: "a".repeat(32), alg: "p256", pk: "A", epk: "AE", name: "Ada" },
  ];
  const plan = welcomePlan({ roster, g: 4, e0: 2980471 });

  assert.deepEqual(plan.map((p) => p.t), ["member", "member", "welcome"]);
  assert.deepEqual(plan[plan.length - 1].head, { g: 4, e0: 2980471, n: 2 });
  assert.equal(
    plan[plan.length - 1].head.n,
    plan.filter((p) => p.t === "member").length,
    "the count is the number of records actually posted",
  );
  assert.deepEqual(plan[0].body, { alg: "p256", pk: "PK", epk: "EPK", name: "Me" });
});

test("a record too big to pad drops the name, which is the only part nobody needs", async () => {
  // Every message pads to exactly PAD_LEN, so it is a ceiling and not a
  // target, and a P-256 key pair plus a name can reach it. The name arrives
  // again with their first position.
  assert.equal(memberRecordBody({ alg: "p256", pk: "A", epk: "B", name: "x".repeat(80) }).name.length, 24);
  assert.equal(memberRecordBody({ alg: "p256", pk: "A", epk: "B" }).name, "");

  assert.equal(recordOverflows({ eph: "e", w: "w" }), false);
  assert.equal(recordOverflows({ eph: "e".repeat(PAD_LEN), w: "w" }), true);
});

// --- being let in -----------------------------------------------------------

test("a link holder cannot crowd the real welcome out of the join buffer", async () => {
  // The cap was a weapon: anyone holding the link could post WELCOME_MSG_CAP
  // well-formed member records before the inviter tapped accept, the real
  // welcome was dropped at the cap, and the joiner sat on "your request is
  // waiting" forever while the circle had already re-keyed to admit them and
  // burned the invitation.
  const inviter = await generateIdentity();
  const stranger = await generateIdentity();
  const { from, commit } = await inviterOf(inviter);
  const other = (await inviterOf(stranger)).from;

  const junk = await screenWelcomeMessage({ obj: { t: "member" }, from: other, commit, buffered: 0 });
  assert.deepEqual(junk, { action: "stranger" }, "a stranger's record never takes a place at all");

  const real = await screenWelcomeMessage({ obj: { t: "welcome" }, from, commit, buffered: WELCOME_MSG_CAP - 1 });
  assert.deepEqual(real, { action: "keep" }, "and the real welcome still fits");
});

test("the buffer holds what the inviter wrote, and only up to the cap", async () => {
  const inviter = await generateIdentity();
  const { from, commit } = await inviterOf(inviter);

  assert.equal((await screenWelcomeMessage({ obj: { t: "loc" }, from, commit, buffered: 0 })).action, "ignore");
  assert.equal((await screenWelcomeMessage({ obj: null, from, commit, buffered: 0 })).action, "ignore");
  assert.equal((await screenWelcomeMessage({ obj: { t: "member" }, from, commit, buffered: 0 })).action, "keep");
  assert.equal((await screenWelcomeMessage({ obj: { t: "member" }, from, commit, buffered: WELCOME_MSG_CAP })).action, "drop");
});

test("a short welcome is waited for, then refused, and it says by how much", async () => {
  // The seed opened, so this device could join and then be unable to attribute
  // a single re-key: every one dropped for coming from a member it was never
  // told about, silently, for as long as the circle lasts.
  const short = { complete: false, n: 4, members: [{}, {}] };
  const whole = { complete: true, n: 2, members: [{}, {}] };

  assert.deepEqual(welcomeVerdict({ welcome: null, since: NOW, now: NOW }), { action: "wait" });
  assert.deepEqual(welcomeVerdict({ welcome: whole, since: NOW, now: NOW + 1 }), { action: "join" });
  assert.deepEqual(welcomeVerdict({ welcome: short, since: NOW, now: NOW + WELCOME_GRACE_MS - 1 }), {
    action: "wait",
    short: true,
  });
  assert.deepEqual(welcomeVerdict({ welcome: short, since: NOW, now: NOW + WELCOME_GRACE_MS }), {
    action: "refuse",
    got: 2,
    want: 4,
  });
});

test("the wait is bounded from the welcome, not from when the person tapped join", async () => {
  // A joiner who sat on the sheet for an hour before the inviter accepted must
  // still get the full grace for the records to arrive behind the welcome.
  const short = { complete: false, n: 3, members: [{}] };
  const welcomeAt = NOW + HOUR;
  assert.equal(welcomeVerdict({ welcome: short, since: welcomeAt, now: welcomeAt + 1 }).action, "wait");
});

test("the code admits in the order the plan says it does", async () => {
  // admissionPlan() is the ordering contract, and until this test existed it
  // was only a comment wearing a function's clothes: nothing called it, and a
  // reviewer proved the point by inverting claim-slot and rekey in acceptJoin
  // while all of this file's plan tests stayed green, because they were
  // asserting properties of a literal array against itself.
  //
  // The order genuinely matters. Claiming the slot first means a jammed
  // rendezvous channel costs nothing, because nothing irreversible has
  // happened. Posting the member records before the welcome makes the welcome
  // the commit point, so a delivery that stops partway leaves nothing anybody
  // can open. Burning last means a failed delivery can still be retried.
  //
  // So bind the plan to the source. This is the same trick the protocol spec
  // now uses on itself: a document that cannot drift from the code without a
  // test noticing.
  const src = await readFile(new URL("../app/js/main.js", import.meta.url), "utf8");
  const body = src.slice(src.indexOf("async function acceptJoin"), src.indexOf("async function openWelcomeChannel"));
  assert.ok(body.length > 500, "found acceptJoin's body to read");

  // Where each step of the plan actually happens in that function.
  const marker = {
    "claim-slot": "openWelcomeChannel(",
    rekey: "doRekey({",
    "send-welcome": "sendWelcome(",
    "burn-invite": "burnInvite(",
  };
  // Walk FORWARD: each step has to appear at or after the one before it. Taking
  // first occurrences would trip over the early burn on the jammed-link
  // refusal path, which is a different branch and legitimately runs first.
  let at = 0;
  const found = [];
  for (const { step } of admissionPlan()) {
    const needle = marker[step];
    if (!needle) continue; // send-records lives inside sendWelcome, covered by welcomePlan
    const next = body.indexOf(needle, at);
    assert.notEqual(next, -1, `acceptJoin still performs ${step}, at or after ${found.at(-1) || "the top"}`);
    found.push(step);
    at = next;
  }
  assert.deepEqual(found, ["claim-slot", "rekey", "send-welcome", "burn-invite"], "every step was located in order");
});
