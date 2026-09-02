// Letting somebody in, and being let in.
//
// This is the one exchange in Starling where two devices that have never met
// have to agree about who each other is, and it is where round after round of
// review has found defects: not in the sealing, in the ORDER. Who is checked
// before what is written down, what has already happened by the time a post
// fails, which step is the one that cannot be taken back.
//
// An ordering rule that lives in the order of a long function's awaits is not
// a rule anybody can read. It is an arrangement that happens to be right
// today, and the next person to add a step to the middle of it has no way to
// know what they broke. So the rules live here, stated, and main.js keeps the
// awaits: nothing in this file fetches, posts, stores, renders or toasts.
//
// It answers the questions instead. May this person be let in, and what has to
// be true first. What each step of admitting them commits, and what undoes it
// if the step after it fails. On the joining side: which of the messages on a
// rendezvous channel are worth keeping, when a welcome is finished, and when
// somebody answering the link is a stranger. Which invitation belongs to this
// circle, when it has run out, and when it is spent rather than merely unused.
//
// Spec: docs/PROTOCOL.md, "Joining".

import {
  MEMBER_CAP,
  PAD_LEN,
  algFromPk,
  b64uDecode,
  b64uEncode,
  memberIdFromKeys,
  safetyNumber,
  validEcdhKey,
} from "./wire.js";
import { inviterMatches } from "./membership.js";
import { sameSecret } from "./circles.js";

// --- the invitation ---------------------------------------------------------

// An invitation is dead once the clock is past its expiry, and every path that
// finds one in that state burns it rather than working around it. A credential
// that is only mostly gone is one somebody can still answer.
export function inviteExpired(inv, now) {
  return !!inv && now > inv.expiresAt;
}

// An invitation belongs to the circle whose identity minted it, and to no
// other. There is one invite slot on this device and there can be several
// circles, so a credential naming another identity is somebody else's live
// link: answering it admits a stranger to a circle nobody meant to invite them
// to.
export function inviteMintedBy(inv, memberId) {
  return !!inv && !!memberId && inv.by === memberId;
}

// Should the invite channel be watched, or is the credential in the slot one
// this device should be getting rid of?
//
// `ready` is the caller's one-word answer to "is there a real circle here to
// admit anybody to": a live generation, not the demo, not locked. There is
// nothing to decide without one.
export function inviteWatchDecision({ invite, ready, selfId, now }) {
  if (!invite || !ready) return { action: "idle" };
  if (!inviteMintedBy(invite, selfId)) return { action: "burn", reason: "wrong-circle" };
  if (inviteExpired(invite, now)) return { action: "burn", reason: "expired" };
  return { action: "watch" };
}

// Hand back the link that is already out, or mint a new one. One at a time,
// and a fresh one replaces the last: two live credentials for one circle is
// two chances for the wrong person to be holding one.
//
// Handing one back needs it to be strictly inside its lifetime, while burning
// one needs the clock to be strictly past it, so the single instant where
// `now` equals `expiresAt` is neither. That sliver is deliberate rather than
// tidied away: each check is written in the direction that fails safe, so at
// that instant the credential is not handed out again and is also not thrown
// away underneath a poll that is mid-flight. The next millisecond settles it.
export function mintDecision({ invite, ready, now }) {
  if (!ready) return { action: "refuse" };
  if (invite && now < invite.expiresAt) return { action: "reuse" };
  return { action: "mint", replaces: !!invite };
}

// Two links this device must not answer as if a stranger had sent them: the
// one it has already asked on, and its own.
export function joinPromptVerdict({ joining, invite, candidate }) {
  if (joining && sameSecret(joining.secret, candidate.secret)) return "already-asked";
  if (invite && sameSecret(invite.secret, candidate.secret)) return "own-link";
  return "ok";
}

// Did the relay refuse us a member slot on the rendezvous channel? A 403 on
// the way in is the member cap (or a pin this device cannot satisfy), and it
// is the one failure that will still be there on the next try, so it is worth
// telling apart from a network that is merely down. A link that cannot be
// posted on again is finished, and saying so beats leaving it looking usable.
// The sender carries the status in its message because nothing else survives
// the fetch.
export function slotFailure(err) {
  const jammed = /post 403/.test(String(err?.message || err));
  return { jammed, burn: jammed };
}

// --- the joiner asking ------------------------------------------------------

// A join request, screened before a person is ever shown it. Nothing here
// accepts anybody: it decides whether there is a request worth putting in
// front of somebody to compare a safety number against.
//
// `keysMatch` is the caller's comparison of the keys in the request body
// against the keys the post was signed with, spelling ignored. They have to be
// the same keys or the safety number a person reads out is not the number of
// the member who would be pinned. `known` and `listed` are this circle's own
// two answers to "we have already dealt with this one".
export async function screenJoinRequest({ obj, from, invite, now, keysMatch, known, listed }) {
  if (!obj || obj.t !== "join") return { ok: false, reason: "not-a-join" };
  if (!invite) return { ok: false, reason: "no-invite" };
  if (inviteExpired(invite, now)) return { ok: false, reason: "expired" };
  if (!keysMatch) return { ok: false, reason: "key-mismatch" };
  if (known) return { ok: false, reason: "already-a-member" };
  if (listed) return { ok: false, reason: "already-listed" };
  let epk, safety;
  try {
    epk = b64uDecode(from.epk);
    safety = await safetyNumber(b64uDecode(from.pk), epk);
  } catch {
    return { ok: false, reason: "unreadable" };
  }
  // A request whose agreement key is not a real P-256 point is refused before
  // it is ever put in front of a person. Accepting one pins a member every
  // other device in the circle will reject, so there is nothing here for
  // anybody to decide.
  if (!(await validEcdhKey(epk))) return { ok: false, reason: "bad-key" };
  return { ok: true, safety, name: typeof obj.name === "string" ? obj.name.slice(0, 24) : "" };
}

// --- the admission decision -------------------------------------------------

// Is there a seat? Occupancy is the pinned roster PLUS this device, which is
// never in it.
//
// There was no cap on the admit path at all. The one in net.js bounds what a
// relay can push into the roster, and the one the rendezvous channel enforces
// counts a different set of people on a different channel. So a full circle
// admitted a seventeenth member, the circle channel had no slot left for
// somebody, and that person simply stopped being able to post, silently, with
// nothing on any screen saying which of them it was.
//
// Somebody already pinned takes no new seat. A failed welcome normally undoes
// its own admission, so the only way to reach this holding a pinned member is
// an undo that failed in turn, and accepting them again is the way out of it.
export function roomFor(pinned, memberId) {
  return pinned.has(memberId) || pinned.size + 1 < MEMBER_CAP;
}

// May this request be admitted, and on what record?
//
// The record is built here rather than copied off the request because the
// request is wire data. `alg` is a field the relay serves and wire.js says in
// capitals is never one: the algorithm is a function of the key. Pinned wrong,
// the member's own posts then read as a key change on this device and on every
// device the welcome hands the record to, and that alarm cannot be cleared,
// because the member keeps presenting the real key.
//
// The member id is re-derived for the same reason. It is what makes the safety
// number the person just read out loud the number of the member who actually
// lands in the roster.
//
// Two refusals, deliberately kept apart. Keys that will not decode at all are
// nothing anybody can act on; keys that decode into something that is not a
// point, or that do not commit to the id they arrived under, are a request
// somebody should be told about.
export async function admissionCheck({ req, invite, pinned, ready, now }) {
  if (!invite || !ready) return { ok: false, reason: "no-circle" };
  if (inviteExpired(invite, now)) return { ok: false, reason: "expired" };
  if (!roomFor(pinned, req.memberId)) return { ok: false, reason: "full" };
  let epk;
  try {
    epk = b64uDecode(req.epk);
  } catch {
    return { ok: false, reason: "unreadable" };
  }
  // The guard again at the moment it matters. Screening keeps a malformed key
  // off the request list, and this is what stands between a request that
  // reached the list some other way and a pinned member the rest of the circle
  // cannot see, cannot remove, and warns about forever. The relay only ever
  // bounds `epk` as a short base64url string and the member id hashes whatever
  // it is given, so this is the only check that says the key is a point.
  if (!(await validEcdhKey(epk))) return { ok: false, reason: "bad-keys" };
  let pk;
  try {
    pk = b64uDecode(req.pk);
  } catch {
    return { ok: false, reason: "unreadable" };
  }
  const alg = algFromPk(pk);
  if (!alg || (await memberIdFromKeys(pk, epk)) !== req.memberId) return { ok: false, reason: "bad-keys" };
  return {
    ok: true,
    epk,
    rec: {
      memberId: req.memberId,
      alg,
      // This record goes straight into the pinned roster and the welcome hands
      // the same bytes to everyone else, so it carries the one spelling like
      // every other pinning path does.
      pk: b64uEncode(pk),
      epk: b64uEncode(epk),
      verified: false,
      name: req.name || "",
    },
  };
}

// --- the ordering contract --------------------------------------------------

// What admitting somebody does, in order, and what each step costs if the one
// after it fails. This is the protocol rule that keeps getting rewritten by
// accident, so it is written down as data: the order is inspectable, and a
// test can hold the app to it instead of hoping the awaits still read the same
// way after the next edit.
//
// Two properties are the whole point of the order, and both were bought with a
// real defect.
//
// The slot is claimed BEFORE the re-key. A rendezvous channel holds MEMBER_CAP
// member slots and anybody holding the link can fill them with identities of
// their own. This device has never posted there, since the joiner's request is
// what starts the conversation, so the welcome is its FIRST post and the cap
// turns exactly that one away. Run the other way round, the wraps were on the
// relay, the generation was open and the joiner was pinned into it before
// anyone found out, and the failure the cap produces is permanent for that
// channel. The cheap check goes first and the re-key that would have to be
// unwound never happens.
//
// The welcome is the commit point, and it goes LAST. The member records mean
// nothing without it, because openWelcomeRecord seals each one under the
// welcome's own context, so an orphan record opens for nobody and is counted
// by nobody. Posted welcome-first, a delivery that stopped partway left a
// welcome standing on the channel with records missing, and the joiner opened
// that same stale welcome on every later poll: it is the first one in the
// buffer, so a retry's complete welcome was never even looked at.
export function admissionPlan() {
  return [
    {
      step: "claim-slot",
      does: "take a member slot on the rendezvous channel with one padded ack",
      commits: "nothing: the ack says nothing and no other device has heard of this join",
      undo: "cancel the sender",
      onFailure: "abort",
    },
    {
      step: "rekey",
      does: "end this generation and open the next one with the joiner in it",
      commits: "the admission, on this device and on every other member's",
      undo: "a second re-key that removes them again",
      onFailure: "release-slot",
    },
    {
      step: "send-records",
      does: "post one sealed member record per existing member",
      commits: "nothing: a record whose welcome never lands opens for nobody",
      undo: "none needed",
      onFailure: "undo-admission",
    },
    {
      step: "send-welcome",
      does: "post the sealed seed and the number of records it stands on",
      commits: "the join, for the joiner",
      undo: "none: this is the commit point",
      onFailure: "undo-admission",
    },
    {
      step: "burn-invite",
      does: "erase the credential from memory and from disk",
      commits: "the link, spent",
      undo: "mint a new one",
      onFailure: "none",
    },
  ];
}

// The re-key that takes an admission back out, for a welcome that did not go
// out. It is the "undo-admission" the plan names, and it is a real re-key with
// a real cost, which is why it is only reached once delivery has failed.
//
// Deferring the burn so a failed welcome can be retried is right as far as it
// goes, and it is kept: the link is still live and the request is still on the
// list, so accepting again is one tap. What it cannot do is stand alone. Until
// the retry happens the joiner is pinned into a generation nobody handed them,
// and the retry lives only as long as this device's memory: a lock or a
// restart empties the request list, and the joiner's own half of the handshake
// is in memory too, so re-opening the link hands us a fresh keypair under a
// fresh member id rather than the one already in the roster. What is left
// behind is a member nobody can reach, sitting in the roster looking exactly
// like everybody else, taking a seat and putting every re-key's hash out of
// everyone else's reach.
export function undoAdmission(memberId) {
  return { removed: [memberId], reason: "welcome-failed" };
}

// --- delivering the welcome -------------------------------------------------

// Who a welcome names: every member the joiner has to pin, the inviter
// included, and never the joiner themself. This is what lets a joiner pin the
// circle from the invitation rather than from whatever the relay serves first.
export function welcomeRoster({ self, members, joinerId }) {
  return [self, ...(members || [])].filter((m) => m && m.memberId !== joinerId);
}

// One member's record, as it travels. The name is clamped here because it is
// the only field of the four that a person chose.
export function memberRecordBody(m) {
  return { alg: m.alg, pk: m.pk, epk: m.epk, name: (m.name || "").slice(0, 24) };
}

// Every message pads to exactly PAD_LEN, so it is a ceiling and not a target,
// and a P-256 key pair plus a name can reach it. The name is the part nobody
// needs: it arrives again with their first position.
export function recordOverflows(sealed) {
  return JSON.stringify({ t: "member", ...sealed }).length > PAD_LEN - 64;
}

// The posts a welcome is, in the order they go out. Records first, welcome
// last, and `n` is how many records the welcome stands on.
//
// They are separate posts because one message cannot hold sixteen key pairs,
// so any of them can be the one the network eats. `n` is what lets the joiner
// tell a complete delivery from a truncated one: a welcome whose records went
// missing leaves a device that decrypts the circle perfectly and can attribute
// no re-key at all, which is silent and permanent, so the count travels with
// the seed.
export function welcomePlan({ roster, g, e0 }) {
  const posts = roster.map((m) => ({ t: "member", body: memberRecordBody(m) }));
  posts.push({ t: "welcome", head: { g, e0, n: roster.length } });
  return posts;
}

// --- being let in -----------------------------------------------------------

// How long the rest of a welcome is waited for once the welcome itself has
// been verified, and how many unopened messages a rendezvous channel is
// allowed to accumulate before this device stops holding them.
export const WELCOME_GRACE_MS = 60000;
export const WELCOME_MSG_CAP = 128;

// Is this message worth a place in the join buffer?
//
// Only the device the invite link committed to can write a welcome or a member
// record, so anybody else's message never enters the buffer at all. It used
// to, and the cap was then a weapon: anyone holding the link could post
// WELCOME_MSG_CAP well-formed member records before the inviter tapped accept,
// the real welcome was dropped at the cap, and the joiner sat on "your request
// is waiting" forever while the circle had already re-keyed to admit them and
// burned the invitation. This is the same commitment check openWelcome makes,
// moved to the moment the space is claimed.
//
// Strangers are counted at the door rather than found later: assembleWelcome
// only ever looks at welcomes, so a stranger posting member records was
// invisible to it, and the buffer it filled was the only place the jam showed.
export async function screenWelcomeMessage({ obj, from, commit, buffered, cap = WELCOME_MSG_CAP }) {
  if (!obj || (obj.t !== "welcome" && obj.t !== "member")) return { action: "ignore" };
  if (!(await inviterMatches(commit, from))) return { action: "stranger" };
  if (buffered >= cap) return { action: "drop" };
  return { action: "keep" };
}

// A welcome has opened. Is the join finished, still arriving, or short?
//
// A short delivery is a refusal rather than a join. The seed opened, so this
// device could join and then be unable to attribute a single re-key: every one
// would be dropped for coming from a member it was never told about, silently,
// for as long as the circle lasts. `since` is when the welcome itself first
// verified, so the wait is bounded from that moment and not from when the
// person tapped join.
export function welcomeVerdict({ welcome, since, now, grace = WELCOME_GRACE_MS }) {
  if (!welcome) return { action: "wait" };
  if (welcome.complete) return { action: "join" };
  if (now - since < grace) return { action: "wait", short: true };
  return { action: "refuse", got: welcome.members.length, want: welcome.n };
}
