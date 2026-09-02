// Generations: post-compromise security and cryptographic removal.
//
// The ratchet in ratchet.js only hashes forward, so it can take away the past
// but never take away the future: anyone holding the current chain key holds
// every epoch after it. Healing from a compromise, and removing a member,
// both need entropy the attacker does not have. That is what a re-key is.
//
// A re-key ends one generation and starts the next: fresh seed, fresh chain,
// fresh channel. The seed is mixed from the current chain key AND fresh random
// bytes delivered to each retained member over an ephemeral ECDH. A relay that
// has never held circle key material cannot forge one (it lacks the chain key);
// a removed member cannot follow one (it lacks the fresh bytes).
//
// Spec: docs/PROTOCOL.md, "Re-keying".

import { PROTO, MAX_SKEW_EPOCHS, b64uEncode, b64uDecode, isMemberId, rosterHash } from "./wire.js";
import { createRatchet, deriveAnchor, chainInit, channelFromAnchor, epochAt, zero } from "./ratchet.js";
import { randomBytes, generateEphemeral, sealTo, openSealed } from "./crypto.js";

// Turn a seed into a live generation, then destroy the seed. Nothing after this
// point needs it, and keeping it would let a seized device recompute CK_0 and
// walk forward through every epoch the chain had already dropped.
export async function openGeneration({ seed, g, e0, historyEpochs }) {
  if (!(seed instanceof Uint8Array) || seed.length !== 32) throw new Error("bad seed");
  if (!Number.isSafeInteger(g) || g < 0) throw new Error("bad generation");
  if (!Number.isSafeInteger(e0) || e0 < 0) throw new Error("bad generation epoch");
  const anchor = await deriveAnchor(seed);
  const channelId = await channelFromAnchor(anchor);
  const ck0 = await chainInit(seed);
  zero(anchor);
  zero(seed);
  return { g, e0, channelId, ratchet: createRatchet({ e0, ck0, historyEpochs }) };
}

// Everything the re-key message asserts, in one string, bound into each wrap's
// associated data. A wrap only opens under the exact claims it was made for,
// so a member cannot lift someone else's wrap into a message that names a
// different rotator or a different removal list.
export function rekeyContext({ by, g, e0, me, rh, rm }) {
  return `${by}|${g}|${e0}|${me}|${rh || ""}|${[...(rm || [])].sort().join(",")}`;
}

// The message bodies a rotator posts, one per retained member, on the CURRENT
// channel. One message per recipient keeps every post the same padded size, so
// the relay cannot tell a re-key from a location update.
//
// `recipients` are pinned member records: { memberId, epk }. The rotator does
// not include itself.
export async function buildRekey({ identity, gen, recipients, removed = [], now = Date.now() }) {
  if (!identity?.memberId) throw new Error("re-key needs the rotator identity");
  const epoch = await gen.ratchet.currentEpoch(now);
  const ns = randomBytes(32);
  const nextSeed = await gen.ratchet.nextSeed(ns, epoch);
  if (!nextSeed) {
    zero(ns);
    return null;
  }
  const e0 = epochAt(now);
  const g = gen.g + 1;
  const rh = await rosterHash(recipients.map((r) => r.memberId));
  const rm = removed.filter(isMemberId);

  const context = rekeyContext({ by: identity.memberId, g, e0, me: epoch, rh, rm });
  const posts = [];
  for (const r of recipients) {
    const eph = await generateEphemeral();
    const wrapped = await sealTo(eph.privateKey, r.epk, gen.channelId, r.memberId, ns, context);
    posts.push({
      t: "rekey",
      g,
      e0,
      // The epoch whose chain key was mixed into the new seed. It has to
      // travel, because it is NOT reliably the epoch this message ends up
      // posted in: buildRekey mixes at the moment it runs, and the POST can
      // land after the next epoch boundary. Deriving it from the header epoch
      // instead meant the rotator and its recipients mixed different chain
      // keys whenever a re-key straddled a boundary, which produced two
      // generations that could not see each other and split the circle in a
      // way nothing would report.
      me: epoch,
      to: r.memberId,
      eph: b64uEncode(eph.pub),
      w: b64uEncode(wrapped),
      rm,
      rh,
    });
  }
  zero(ns);
  return { g, e0, seed: nextSeed, rh, posts, epoch };
}

// Apply a re-key addressed to us. `msg` is the decrypted body, `epoch` the
// epoch the message was sent in (from the authenticated header), `senderId` a
// member we have already PINNED. An unpinned sender is dropped by the caller
// before it gets here, because pinning on the strength of a re-key is exactly
// how a relay would burgle its way into a group.
//
// Returns the next generation's seed and coordinates, or null.
export async function applyRekey({ identity, gen, msg, epoch, senderId }) {
  if (!msg || msg.t !== "rekey") return null;
  if (msg.to !== identity.memberId) return null;
  if (!isMemberId(senderId)) return null;
  // Exactly one greater: an old re-key cannot be replayed to drag a circle back
  // onto a generation whose keys someone has since collected.
  if (!Number.isSafeInteger(msg.g) || msg.g !== gen.g + 1) return null;
  // The new generation's opening epoch, bounded against the epoch this very
  // message was sent in.
  //
  // This was unbounded, and it was the worst bug in the protocol. Every other
  // epoch on the wire is checked against a clock; e0 was checked only for
  // being a non-negative integer. e0 sits inside the context, so it is bound
  // into the wrap, but the SENDER computes that context: sealing e0 = 0
  // produces a wrap that opens perfectly on every receiver. Their new ratchet
  // then opens at epoch 0, the next clock sync sees a jump of three million
  // epochs, and the catch-up self-destruct erases the circle from memory and
  // from disk. One signed message from any member permanently destroyed
  // everyone else's circle, and the victim was told their own phone had been
  // offline too long.
  //
  // Anchoring on the message's own epoch rather than on the receiver's clock
  // is deliberate: a rotator opens the generation at the moment it sends, so
  // the two are the same instant, and the header epoch is already bounded by
  // the time this runs. That keeps a re-key sitting in a relay backlog valid
  // while leaving nothing for a member to steer.
  if (!Number.isSafeInteger(msg.e0) || msg.e0 < 0) return null;
  if (Math.abs(msg.e0 - epoch) > MAX_SKEW_EPOCHS) return null;
  // The mix epoch is the sender's, not ours. It must be one we still hold a
  // chain key for, and it may not be in the future: nextSeed rejects an epoch
  // outside the window, and this rejects one that would drag us forward.
  if (!Number.isSafeInteger(msg.me) || msg.me < 0 || msg.me > epoch) return null;

  let ephPub, wrapped;
  try {
    ephPub = b64uDecode(msg.eph);
    wrapped = b64uDecode(msg.w);
  } catch {
    return null;
  }
  if (ephPub.length !== 65) return null;

  // Rebuilt from what THIS message claims. If any of it was altered after the
  // rotator sealed the wrap, the wrap does not open and the re-key is dropped.
  const context = rekeyContext({
    by: senderId,
    g: msg.g,
    e0: msg.e0,
    me: msg.me,
    rh: typeof msg.rh === "string" ? msg.rh : "",
    rm: Array.isArray(msg.rm) ? msg.rm.filter(isMemberId) : [],
  });
  const ns = await openSealed(identity, ephPub, gen.channelId, identity.memberId, wrapped, context);
  if (!ns || ns.length !== 32) return null;

  const seed = await gen.ratchet.nextSeed(ns, msg.me);
  zero(ns);
  if (!seed) return null;

  return {
    seed,
    g: msg.g,
    e0: msg.e0,
    rh: typeof msg.rh === "string" ? msg.rh : null,
    removed: Array.isArray(msg.rm) ? msg.rm.filter(isMemberId) : [],
    by: senderId,
  };
}

// Did we and the rotator agree about who is in the circle? A mismatch is not
// fatal, because the generation is still cryptographically sound, but it means one
// side is looking at a membership the other is not, and a human should be told
// rather than have it reconciled silently.
export async function rosterAgrees(claimed, memberIds) {
  if (typeof claimed !== "string" || !claimed) return true;
  return claimed === (await rosterHash(memberIds));
}

export const REKEY_LABEL = `${PROTO}/rekey`;
