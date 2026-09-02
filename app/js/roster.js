// Who this device believes is in the circle, and on what evidence.
//
// Every function here answers one question and returns a verdict. Nothing in
// it touches the network, the disk, the map or the screen: main.js keeps the
// awaits, the writes, the renders and the toasts, and asks these questions on
// the way through. The split is not tidiness. The membership defects this
// project has actually shipped were all the same shape, a rule stated at four
// call sites and correct at three: the receiver member cap compared against a
// size that was never there and did nothing for a release, and the accept
// path pinned a member without ever asking whether the agreement key was a
// point. A rule with one home cannot be right in one place and wrong in
// another, and a rule that needs no DOM can be checked without one.
//
// Spec: docs/PROTOCOL.md, "Members" and "Re-keying".

import {
  MEMBER_CAP,
  algFromPk,
  b64uDecode,
  b64uEncode,
  memberIdFromKeys,
  safetyNumber,
  validEcdhKey,
} from "./wire.js";
import { rosterConverged, rosterView } from "./membership.js";

// ------------------------------------------------------------- key spelling

// The relay's spelling of a key is not the key.
//
// b64uDecode takes any string in its character class, and base64url has slack
// at the end: the last character of a 32 or 65 byte key carries two bits
// nothing decodes, so four different strings mean the same bytes. Keys were
// pinned as the text the relay served and then compared as text, so the same
// key re-encoded read as somebody else's, and what that raises is the card
// telling a person to check a safety number and think about removing a member
// who has changed nothing.
//
// So: one spelling on disk, and bytes wherever two keys are compared. Both
// halves are needed, because canonical storage on its own still trusts
// whoever wrote the record last.
export function canonKey(s) {
  return b64uEncode(b64uDecode(s));
}

// The same, for a whole pinned record. A record whose keys will not decode has
// no canonical form, so it is left exactly as it is: nothing can wrap to it
// and nothing matches it, which was already true of it before this ran.
export function canonPinned(rec) {
  try {
    return { ...rec, pk: canonKey(rec.pk), epk: canonKey(rec.epk) };
  } catch {
    return rec;
  }
}

// The same key, however it is spelled.
export function sameKey(a, b) {
  let x, y;
  try {
    x = b64uDecode(a);
    y = b64uDecode(b);
  } catch {
    return false;
  }
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

// --------------------------------------------------------- pinning a member

// May this record be pinned, and in what form?
//
// One answer for every path that adds somebody to the durable roster, because
// the three rules below have each been missing from one path or another:
//
//   - the agreement key has to be a real P-256 point. A 33 byte compressed key
//     satisfies every other check here and on the relay, and pinning one
//     leaves a member every other device refuses: they read the circle for as
//     long as it lasts, appear on nobody else's roster, cannot be removed by
//     anyone else, and leave everyone with a membership warning nothing clears.
//   - the algorithm is a function of the public key and never a wire field.
//     Taken off a record, an inviter could put "ed25519" on a welcome record
//     carrying a P-256 key: every joiner pinned the wrong algorithm, and the
//     moment that member posted anything it read as a key change against
//     somebody who had changed nothing. That alarm never clears, because the
//     real member keeps presenting the real key, and the safety number does
//     not cover `alg` so no amount of checking it in person resolves it.
//   - the member id commits to both keys, so re-deriving it is what makes the
//     safety number a person read out loud the number of the member who
//     actually lands in the roster.
//
// `pinned` is anything with a `get` and a `size`, which is the live roster map
// or the duck-typed store main.js hands net.js. `cap` is the occupancy bound:
// a caller pinning into a channel's own slots wants the default, and a caller
// that has never had one says so out loud rather than by omission.
//
// Returns a verdict, never a mutation. `already` means the id is in the roster
// and its existing record is the answer: a member is not re-pinned by meeting
// them again, because a re-pin would quietly drop whatever the person has
// since verified.
export async function admitPinned({ pinned, rec, cap = MEMBER_CAP } = {}) {
  if (!rec) return { ok: false, reason: "unreadable" };
  let pk, epk;
  try {
    pk = b64uDecode(rec.pk);
    epk = b64uDecode(rec.epk);
  } catch {
    return { ok: false, reason: "unreadable" };
  }
  if (!(await validEcdhKey(epk))) return { ok: false, reason: "epk" };
  const alg = algFromPk(pk);
  if (!alg) return { ok: false, reason: "alg" };
  const memberId = await memberIdFromKeys(pk, epk);
  // A record may carry the id it claims. If it does, it has to be the id the
  // keys derive to, or the record is describing one member and carrying
  // another's keys.
  if (rec.memberId && rec.memberId !== memberId) return { ok: false, reason: "id" };
  const known = pinned?.get?.(memberId);
  if (known) return { ok: true, already: true, memberId, entry: known };
  // Somebody already pinned takes no new slot, so occupancy is asked only for
  // a member who is genuinely new. The relay enforces a cap too, but it is
  // untrusted, and without this one a malicious relay could pin unlimited
  // fabricated members into the durable roster at no cost to itself.
  if (pinned && pinned.size >= cap) return { ok: false, reason: "cap" };
  return {
    ok: true,
    already: false,
    memberId,
    entry: {
      memberId,
      alg,
      // The bytes this id was just derived from, re-encoded, rather than the
      // spelling the record arrived in.
      pk: b64uEncode(pk),
      epk: b64uEncode(epk),
      verified: false,
      name: typeof rec.name === "string" ? rec.name.slice(0, 24) : "",
    },
  };
}

// ----------------------------------------------------------- key changes

// A pinned member is presenting different keys. Is that anything?
//
// "same" is the same two keys spelled differently. The member id commits to
// the BYTES, so a re-encoding is not a second preimage, there is nothing here
// for anybody to check in person, and raising the card anyway pointed a person
// at a member who had done nothing.
//
// "change" is everything else, including a presentation for an id this device
// has not pinned. That case cannot arrive from net.js, which reports a change
// only for a member it already knows, and it is treated as a change rather
// than waved through because the safe answer to "keys for somebody I cannot
// compare against" is to ask a human.
export function keyChangeVerdict(known, presented) {
  if (
    known &&
    known.alg === presented.alg &&
    sameKey(known.pk, presented.pk) &&
    sameKey(known.epk, presented.epk)
  ) {
    return "same";
  }
  return "change";
}

async function safetyOf(rec) {
  try {
    return await safetyNumber(b64uDecode(rec.pk), b64uDecode(rec.epk));
  } catch {
    return null;
  }
}

// What a person is shown about a key change: both safety numbers, so the one
// they read out loud can be compared against the one that was there before.
// A key that will not decode has no safety number and says so with null,
// rather than throwing and losing the whole card.
export async function describeKeyChange({ known, presented, now }) {
  return {
    presented,
    was: known ? { alg: known.alg, pk: known.pk, epk: known.epk } : null,
    oldSafety: known ? await safetyOf(known) : null,
    newSafety: await safetyOf(presented),
    at: now,
  };
}

// The record a human accepting a key change would pin, or null if there is
// nothing pinnable in it.
//
// Every path that writes into the roster checks the agreement key first, this
// one included. net.js has already refused a malformed key by the time it
// reports the change, so this is the floor under that rather than a second
// opinion: a human tapping accept must not be the way a bad point gets in.
//
// The name carries over. It is local, it is not in the record on the wire, and
// a person who accepts new keys for somebody they named has not renamed them.
// Verification does not: the safety number changed, so whatever was checked in
// person was checked against keys that are no longer these.
export async function acceptedKeyChange({ known, presented }) {
  let epk;
  try {
    epk = b64uDecode(presented.epk);
  } catch {
    epk = null;
  }
  if (!epk || !(await validEcdhKey(epk))) return null;
  return canonPinned({ ...presented, verified: false, name: known?.name || "" });
}

// ------------------------------------------------------ roster convergence

// How long a roster disagreement is given to explain itself before a person is
// told about it. An admitted member is pinned as soon as they post anything,
// which is normally seconds after they land in the circle.
export const ROSTER_GRACE_MS = 5 * 60 * 1000;

// Does this device now agree with the rotator about who is in the circle?
//
// Every admission starts as a disagreement: the new member is in the rotator's
// roster hash and in nobody else's roster, so alarming on the spot would make
// "somebody joined" indistinguishable from "somebody is standing in for a
// member". It is not the same event and must not read like it.
//
// The hash is sealed inside the rotator's wrap, so only the rotator could have
// produced it. When the members we have pinned since hash to it, the rotator
// has named exactly these people, and a member an authenticated re-key names
// may re-key in turn: that is what puts the newcomer into genRoster, so their
// first re-key does not split the circle. A disagreement that never resolves
// is a real one and is surfaced.
//
// "wait" is the only verdict that keeps the pending hash alive. The caller
// clears it on "converged" because it is answered, and on "mismatch" because
// it has been said out loud.
export async function reconcileVerdict({ pinned, self, pending, now, graceMs = ROSTER_GRACE_MS }) {
  if (!pending) return "none";
  if (await rosterConverged({ pinned, self, by: pending.by, rh: pending.rh })) return "converged";
  if (now - pending.at < graceMs) return "wait";
  return "mismatch";
}

// What a re-key leaves this device holding, and the view of the circle it
// would compare against the rotator's hash.
//
// The rotator hashed everyone it wrapped to, which is the circle minus itself,
// so the matching view from here is our roster minus the rotator, plus us.
// Both halves are built from the same post-removal map, because a view taken
// over a roster the removals have not been applied to hashes to a circle
// nobody is in.
export function rosterAfterRekey({ pinned, removed = [], self, by }) {
  const next = new Map(pinned);
  for (const id of removed) next.delete(id);
  return { pinned: next, view: rosterView({ pinned: next.keys(), self, by }) };
}

// Whether a re-key we just applied leaves a disagreement worth holding on to.
//
// Held back rather than raised: an admission looks exactly like a disagreement
// for as long as it takes the new member to say something. A re-key that
// carried no hash at all leaves nothing to reconcile against, so there is
// nothing to hold either.
export function pendingAfterRekey({ agrees, rh, by, now }) {
  return agrees || !rh ? null : { by, rh, at: now };
}

// The members a generation opened with, as written down with it. A record from
// a build that did not persist the set falls back to whatever is pinned now,
// which is what this device did before and no worse than it; every write after
// that carries the narrow set.
export function genRosterFrom(meta, fallback) {
  return new Set(meta?.genRoster ?? fallback);
}

// ------------------------------------------------------------ re-key wraps

// Who a re-key wraps to.
//
// The admitted member may ALREADY be pinned, and the list has to stay a set.
// A welcome that did not send leaves the joiner in the roster, and the whole
// point of leaving the link alive is that the person can accept again. On that
// second accept the loop below already yields them, and pushing the admission
// on top produced a recipient list holding them twice: two wraps sent to one
// member, and a roster hash taken over a list with a duplicate in it.
// rosterHash sorts and joins, it does not dedupe, so "a,a,b" is not "a,b" and
// no other device can ever hash its way to that value. Every other member is
// then stuck on a membership mismatch nothing can clear.
//
// Their pinned record is kept rather than replaced: it is the same keys (the
// member id commits to them), and it carries whatever the person has since
// verified.
//
// An unreadable pinned key cannot be wrapped to, so that member is dropped
// here and the roster hash the caller takes over this list says so.
export function rekeyRecipients({ pinned, removed = [], admit = null }) {
  const recipients = [];
  for (const [memberId, rec] of pinned) {
    if (removed.includes(memberId)) continue;
    try {
      recipients.push({ memberId, epk: b64uDecode(rec.epk), rec });
    } catch {
      // Not wrappable, so not a recipient. See above.
    }
  }
  if (admit && !recipients.some((r) => r.memberId === admit.memberId)) recipients.push(admit);
  return recipients;
}

// The roster the new generation opens with: exactly the people it was wrapped
// to. Keyed by member id, and the record itself is the one that was already
// pinned, so a re-key never quietly rewrites what anybody verified.
export function pinnedFromRecipients(recipients) {
  const next = new Map();
  for (const r of recipients) next.set(r.memberId, r.rec);
  return next;
}
