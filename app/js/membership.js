// Who is in a circle, and how a device comes to believe it.
//
// Two questions live here, and they are the same question asked at two
// moments. At the invitation: is the person answering this link the person who
// wrote it, and did they hand over the whole circle or half of it? Afterwards:
// does what a re-key claims about the membership match what this device has
// pinned, and if not, is the difference a member it simply has not met yet?
//
// Both are separated from main.js because they are decisions, not plumbing,
// and a decision that cannot be tested on its own is a decision nobody has
// checked.
//
// Spec: docs/PROTOCOL.md, "Joining" and "Re-keying".

import { PROTO, MAX_SKEW_EPOCHS, b64uDecode, memberIdFromKeys, rosterHash } from "./wire.js";
import { inviterCommitment, equalBytes, openSealed } from "./crypto.js";

const td = new TextDecoder();

// --- the welcome ------------------------------------------------------------

// The context every welcome wrap is sealed under, built the same way a re-key
// builds its own: everything the message around the wrap asserts, in one
// string, inside the AEAD's associated data. A wrap therefore only opens under
// the exact claims it was made for.
//
// The default empty context was the hole. With nothing bound in, a wrap sealed
// to the joiner's agreement key opened whoever made it and whatever it
// claimed, so anyone holding the link could seal a seed of their own choosing
// and be believed. Binding the inviter's member id means a welcome only opens
// under the identity the link committed to.
// A welcome's own claim string. It deliberately does NOT route through
// rekeyContext: a welcome has no mix epoch, so borrowing that shape put the
// literal text "undefined" in the middle of every context string. It was
// symmetric, so nothing broke, but a bound claim that reads as a bug is worse
// than useless to whoever audits this. Same fields, stated for what they are.
export function welcomeContext({ by, g, e0 }) {
  return `${PROTO}/welcome|${by}|${g}|${e0}`;
}

// Is the device that posted this the device the invite link committed to? The
// keys have to be the ones the sender's member id commits to AND the ones the
// fragment's commitment names; neither check is worth anything without the
// other.
export async function inviterMatches(commit, from) {
  if (!(commit instanceof Uint8Array) || commit.length !== 16) return false;
  if (!from || typeof from.memberId !== "string") return false;
  let pk, epk;
  try {
    pk = b64uDecode(from.pk);
    epk = b64uDecode(from.epk);
  } catch {
    return false;
  }
  if ((await memberIdFromKeys(pk, epk)) !== from.memberId) return false;
  return equalBytes(commit, await inviterCommitment(pk, epk));
}

// Shape-check a welcome body against `epoch`, the epoch the welcome was posted
// in, taken from the authenticated header. `n` is how many member records the
// inviter says it is posting; it is what lets a joiner tell a complete welcome
// from a truncated one, so a welcome without it is not a welcome.
//
// No epoch is no welcome. A caller that cannot say when the message was sent
// cannot bound what it claims, and this reads key material for a device that
// has nothing else to check the inviter against.
export function readWelcome(obj, epoch) {
  if (!obj || obj.t !== "welcome") return null;
  if (!Number.isSafeInteger(epoch)) return null;
  if (!Number.isSafeInteger(obj.g) || obj.g < 0) return null;
  // The generation's opening epoch, bounded against the epoch this welcome was
  // sent in, exactly as applyRekey bounds a re-key's.
  //
  // It used to be checked only for being a non-negative integer, and that is
  // the same hole: e0 sits inside the context, so it is bound into the wrap,
  // but the INVITER computes that context, so sealing e0 = 0 makes a welcome
  // that opens perfectly on the joiner's device. The ratchet it opens starts
  // at epoch zero, the first sync sees a jump of three million epochs, and the
  // catch-up self-destruct erases the circle from memory and from disk. Being
  // let in must not be a way to be wiped by whoever let you in.
  if (!Number.isSafeInteger(obj.e0) || obj.e0 < 0) return null;
  if (Math.abs(obj.e0 - epoch) > MAX_SKEW_EPOCHS) return null;
  // At least one: the inviter's own record is always in the set, so a welcome
  // claiming none is either malformed or a welcome that would leave the joiner
  // unable to follow a single re-key.
  if (!Number.isSafeInteger(obj.n) || obj.n < 1 || obj.n > 64) return null;
  if (typeof obj.eph !== "string" || typeof obj.w !== "string") return null;
  return { g: obj.g, e0: obj.e0, n: obj.n };
}

async function unwrap(identity, chanId, obj, context) {
  let ephPub, wrapped;
  try {
    ephPub = b64uDecode(obj.eph);
    wrapped = b64uDecode(obj.w);
  } catch {
    return null;
  }
  if (ephPub.length !== 65) return null;
  return openSealed(identity, ephPub, chanId, identity.memberId, wrapped, context);
}

// Open a welcome, or refuse it. Verification comes first and the unwrap second,
// so nothing an unverified sender wrote is ever handled as key material.
export async function openWelcome({ identity, chanId, commit, from, obj, epoch }) {
  const head = readWelcome(obj, epoch);
  if (!head) return null;
  if (!(await inviterMatches(commit, from))) return null;
  const context = welcomeContext({ by: from.memberId, g: head.g, e0: head.e0 });
  const seed = await unwrap(identity, chanId, obj, context);
  if (!seed || seed.length !== 32) return null;
  return { ...head, seed, inviter: from };
}

// One member record from the same welcome. It carries no claims of its own, so
// it is sealed under the welcome's context: a record that came from anyone but
// the verified inviter, or that was lifted out of a different welcome, does
// not open.
export async function openWelcomeRecord({ identity, chanId, welcome, from, obj }) {
  if (!obj || obj.t !== "member") return null;
  if (typeof obj.eph !== "string" || typeof obj.w !== "string") return null;
  if (!from || from.memberId !== welcome.inviter.memberId) return null;
  const context = welcomeContext({ by: welcome.inviter.memberId, g: welcome.g, e0: welcome.e0 });
  const raw = await unwrap(identity, chanId, obj, context);
  if (!raw) return null;
  try {
    const rec = JSON.parse(td.decode(raw));
    return rec && typeof rec === "object" && !Array.isArray(rec) ? rec : null;
  } catch {
    return null;
  }
}

// Put a welcome back together from whatever the invite channel has served.
//
// Nothing is opened as it arrives. The relay chooses the order, and a member
// record means nothing until the welcome it belongs to has been checked
// against the commitment in the link, so the messages are held raw and opened
// in the right order once the response is in.
//
// Each held message carries the epoch its own header was signed under, because
// the welcome's opening epoch is bounded against it and nothing downstream can
// recover that number once the messages are off the wire.
//
// `complete` is the other half of the guarantee. A welcome delivered without
// its member records leaves a device that decrypts the circle perfectly and
// can attribute no re-key at all: every one is dropped for coming from a
// member it was never told about, silently, for as long as the circle lasts.
// So the count travels with the seed and a short delivery is a refusal, not a
// join.
export async function assembleWelcome({ identity, chanId, commit, messages }) {
  let welcome = null;
  let imposters = 0;
  for (const { obj, from, epoch } of messages || []) {
    if (!obj || obj.t !== "welcome") continue;
    const opened = await openWelcome({ identity, chanId, commit, from, obj, epoch });
    // A welcome from somebody who is not the person who sent the link is not
    // noise, and every one is counted, including the ones that arrive after
    // the real welcome, because the count is what gets said out loud and a
    // person who sees it should stop and ask.
    //
    // A welcome the committed inviter DID sign and this device cannot open is
    // a different thing entirely: it is a welcome addressed to a different
    // joiner, sealed to their agreement key, which is what a link that has
    // already been answered once leaves behind. openWelcome returns null for
    // both, so the two were counted the same, and the second person to open a
    // link was told somebody was impersonating the sender when they were
    // looking at a leftover. Ask who signed it before calling it an attack.
    if (!opened) {
      if (!(await inviterMatches(commit, from))) imposters += 1;
    } else if (!welcome) welcome = opened;
  }
  if (!welcome) return { welcome: null, imposters };
  const members = [];
  for (const { obj, from } of messages) {
    if (!obj || obj.t !== "member") continue;
    const rec = await openWelcomeRecord({ identity, chanId, welcome, from, obj });
    if (rec) members.push(rec);
  }
  return { welcome: { ...welcome, members, complete: members.length >= welcome.n }, imposters };
}

// --- control on the circle channel -----------------------------------------

// What a circle channel is allowed to carry, as opposed to what a member can
// physically post on one.
//
// A `member` record is a piece of a welcome. On the invite channel it is
// sealed to one joiner under a context naming the inviter, and it tells a
// device that has no roster yet who the circle is. On the circle channel it is
// none of those things: it is an ordinary padded message any member can write,
// and honouring one lets that member graft a keypair of their own onto every
// device's roster, with no human asked. Removing the member who did it does
// not remove the graft, because a re-key wraps to the pinned roster, so it
// defeats the only defence the threat model offers against a compromised
// member. Re-keys are the only control a circle channel carries.
export function circleControl(msg) {
  return msg && msg.t === "rekey" ? "rekey" : null;
}

// --- roster convergence -----------------------------------------------------

// The member ids this device would hash to compare with a rotator's roster
// hash. A rotator hashes everyone it wrapped to, which is the circle minus
// itself, so the matching view from here is our roster minus the rotator, plus
// us.
export function rosterView({ pinned, self, by }) {
  return [...pinned].filter((id) => id !== by).concat(self);
}

// Does our roster now agree with what that re-key claimed?
//
// This is how a legitimate admission converges instead of alarming. The
// admitted member is in the rotator's hash and in nobody else's roster, so
// every other device disagrees for as long as it takes the new member to post
// anything. The hash is sealed inside the rotator's wrap, so only the rotator
// could have produced it: when adding the members we have since pinned makes
// our view hash to it, the rotator has named exactly these people, and a
// member named by an authenticated re-key may re-key in turn.
//
// Reaching agreement by search would be the wrong shape here, and this is not
// that: nothing is guessed. We hash the roster we actually hold and compare
// once. An attacker who wanted a slot this way would need a member id that
// completes the rotator's set, which is a second preimage on 128 bits.
export async function rosterConverged({ pinned, self, by, rh }) {
  if (typeof rh !== "string" || !rh) return false;
  return rh === (await rosterHash(rosterView({ pinned, self, by })));
}
