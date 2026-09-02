// Multiple circles, one active. The active circle keeps living in the
// original kv slots (secret, identity, profile, circleName, lastSentTs), so a
// device that only ever holds one circle never changes shape. The inactive
// circles wait in a single array: plaintext under the `circles` key with the
// app lock off, or split with the lock on into `vaultCircles` (names, chain
// keys, profiles, rosters, timestamps, sealed under the vault key) plus
// `circleIdentities` (the keypairs, which are non-extractable CryptoKeys and
// can only be structured-cloned, never serialized into a sealed blob; they
// reveal the same class of thing the active identity already does today: key
// material counts, but no names, no keys, no channels).
//
// Every mutation here writes the inactive array BEFORE the active slots, so a
// crash between the two duplicates a circle instead of losing one; boot runs
// reconcileCircles to drop the duplicate.
//
// What v2 changed here: `secret` is no longer a circle root that lives
// forever. It is the OLDEST RETAINED CHAIN KEY of the circle's current
// generation, rewritten as the ratchet moves, and on its own it names nothing:
// the channel comes from the generation's anchor, which is derived from a seed
// that was destroyed the moment the generation opened. So the chain key now
// travels with a `genMeta` record naming the generation, and with the pinned
// roster the circle verifies its members against. Those two are new slots;
// the crown-jewel slot keeps its name, its 32 bytes, and every crash-window
// rule already proven around it.

import { sealUnderVault, openUnderVault } from "./lock.js";
import { b64uEncode, b64uDecode, isChannelId, isMemberId } from "./wire.js";

const te = new TextEncoder();
const td = new TextDecoder();

// The slot pairs that hold one JSON record each: plaintext key with the lock
// off, sealed key with the lock on, and never both at once.
export const GEN_SLOT = { plain: "genMeta", sealed: "vaultGenMeta" };
export const PINNED_SLOT = { plain: "pinned", sealed: "vaultPinned" };
export const INVITE_SLOT = { plain: "invite", sealed: "vaultInvite" };
export const STAGED_SLOT = { plain: "genNext", sealed: "vaultGenNext" };

// Every sealed spelling, for boot's guarded purge and for the lock
// transitions. Kept in one place so a new slot cannot be added on one side of
// a transition and forgotten on the other.
export const SEALED_KEYS = [
  "vaultSecret",
  "vaultCircles",
  "circleIdentities",
  GEN_SLOT.sealed,
  PINNED_SLOT.sealed,
  INVITE_SLOT.sealed,
  STAGED_SLOT.sealed,
];

// --- generation metadata ----------------------------------------------------
//
// Three numbers and a channel. `g` and `e0` name the generation, `ckEpoch` is
// the epoch the stored chain key belongs to (the ratchet's snapshot, which
// walks forward as old keys are destroyed), and `at` is when this generation
// opened, which is what the daily re-key timer counts from.
//
// The channel id is in here because it cannot be recovered from the chain key:
// it is derived from the generation's anchor, and the anchor's seed was
// destroyed at open. It is also the one field in this record with anything to
// hide. A channel id names a live conversation on the relay, so a seized
// locked device that gave one up would tell the seizer exactly which channel
// to watch and how many people post to it. That is why this record is sealed
// under the vault key like the roster, rather than kept in plaintext as the
// bare integers would allow.
// `genRoster` travels with the generation because it is part of what the
// generation IS: the members it opened with, and so the only members whose
// re-keys move it. Rebuilding it from the pinned roster on every reload widens
// it back out to everyone this device has ever seen a point from, which is a
// larger set and one an attacker has a say in. A restart is not a reason to
// trust more people.
export function packGenMeta(gen) {
  return {
    g: gen.g,
    e0: gen.e0,
    ckEpoch: gen.ckEpoch,
    channelId: gen.channelId,
    at: gen.at || 0,
    genRoster: [...(gen.genRoster || [])].filter(isMemberId),
  };
}

// `genRoster` comes back as null when the record predates it, which is the one
// case a caller has to handle: an empty array is a real answer (a circle whose
// generation opened alone), so absence cannot be spelled the same way.
export function readGenMeta(raw) {
  if (!raw || typeof raw !== "object") return null;
  const { g, e0, ckEpoch, channelId, at, genRoster } = raw;
  if (!Number.isSafeInteger(g) || g < 0) return null;
  if (!Number.isSafeInteger(e0) || e0 < 0) return null;
  if (!Number.isSafeInteger(ckEpoch) || ckEpoch < 0) return null;
  if (!isChannelId(channelId)) return null;
  return {
    g,
    e0,
    ckEpoch,
    channelId,
    at: Number.isFinite(at) ? at : 0,
    genRoster: Array.isArray(genRoster) ? genRoster.filter(isMemberId) : null,
  };
}

// --- pinned roster ----------------------------------------------------------
//
// Public keys, so nothing here is a secret in the sense the chain key is. It
// is still sealed under the lock, because the member COUNT is meaningful on
// its own: "this phone is in a circle of seven" is a fact about a network of
// people, and a seized device should not answer it.
export function packPinned(pinned) {
  const list = pinned instanceof Map ? [...pinned.entries()].map(([memberId, r]) => ({ memberId, ...r })) : pinned || [];
  return list
    .filter((r) => r && isMemberId(r.memberId) && typeof r.pk === "string" && typeof r.epk === "string")
    .map((r) => ({
      memberId: r.memberId,
      alg: r.alg === "ed25519" ? "ed25519" : "p256",
      pk: r.pk,
      epk: r.epk,
      verified: !!r.verified,
      name: typeof r.name === "string" ? r.name.slice(0, 24) : "",
    }));
}

export function readPinned(raw) {
  if (!Array.isArray(raw)) return [];
  return packPinned(raw);
}

export const pinnedMap = (list) => new Map(readPinned(list).map((r) => [r.memberId, r]));

// --- the outstanding invitation ---------------------------------------------
//
// One at a time, and a credential while it lives: whoever holds these 32 bytes
// can post a join request the inviter will be asked to accept. Sealed under
// the lock for the same reason the chain key is.
// `by` is the member id of the identity that minted it, and `commit` is the
// commitment its link carries to that identity. Both are here because there is
// one invite slot and a device can hold several circles: without them, joining
// or creating a second circle leaves the first circle's live credential in the
// slot, the new circle answers the old circle's link, and a stranger is
// admitted to a circle nobody meant to invite them to. A record missing either
// is refused rather than repaired, because that is exactly the unscoped,
// uncommitted shape being retired.
export function packInvite(inv) {
  if (!inv?.secret || !inv.commit || !isMemberId(inv.by)) return null;
  return {
    secret: b64uEncode(inv.secret),
    commit: b64uEncode(inv.commit),
    by: inv.by,
    createdAt: inv.createdAt || 0,
    expiresAt: inv.expiresAt || 0,
  };
}

export function readInvite(raw) {
  if (!raw || typeof raw.secret !== "string" || typeof raw.commit !== "string") return null;
  if (!isMemberId(raw.by)) return null;
  let secret, commit;
  try {
    secret = b64uDecode(raw.secret);
    commit = b64uDecode(raw.commit);
  } catch {
    return null;
  }
  if (secret.length !== 32 || commit.length !== 16) return null;
  return {
    secret,
    commit,
    by: raw.by,
    createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : 0,
    expiresAt: Number.isFinite(raw.expiresAt) ? raw.expiresAt : 0,
  };
}

// --- the staged generation --------------------------------------------------
//
// A re-key has to replace the chain key and the generation record together,
// and two kv writes are not one write. So the whole next generation lands in a
// single slot first, then the live slots are rewritten from it, then the slot
// is dropped. A crash anywhere in that sequence leaves the staged record on
// disk, and boot applies it: the re-key either happened or is finished on the
// next launch, and the circle never ends up holding one generation's channel
// with another generation's key, which would take a member silently off the
// air.
//
// It holds live key material for the width of that sequence, so it is sealed
// under the lock exactly like the slot it is about to become.
export function packStagedGen(staged) {
  return { ...packGenMeta(staged), ck: b64uEncode(staged.ck), pinned: packPinned(staged.pinned) };
}

export function readStagedGen(raw) {
  const meta = readGenMeta(raw);
  if (!meta) return null;
  let ck;
  try {
    ck = b64uDecode(raw.ck);
  } catch {
    return null;
  }
  if (ck.length !== 32) return null;
  return { ...meta, ck, pinned: readPinned(raw.pinned) };
}

// The sealable half of a circle record: everything except the CryptoKeys. Each
// meta carries its identity's memberId so unpack can re-pair metas with
// identities by id, never by array position; the two records are separate kv
// keys and nothing guarantees they were written in the same breath.
export function packCircles(circles) {
  const metas = circles.map((c) => ({
    name: c.name,
    secret: b64uEncode(c.secret),
    memberId: c.identity?.memberId || null,
    g: c.g || 0,
    e0: c.e0 || 0,
    ckEpoch: c.ckEpoch || 0,
    channelId: c.channelId || null,
    // When this generation opened, which is the only thing the daily re-key
    // timer counts from. Leave it out and a circle that has been through the
    // array comes back with at:0, the timer reads that as "no open time" and
    // never fires again, and post compromise security quietly stops for that
    // circle while every other one keeps rotating.
    at: c.at || 0,
    genRoster: [...(c.genRoster || [])].filter(isMemberId),
    pinned: packPinned(c.pinned),
    profile: c.profile || null,
    lastTs: c.lastTs || 0,
  }));
  return te.encode(JSON.stringify(metas));
}

export function unpackCircles(bytes, identities) {
  let metas;
  try {
    metas = JSON.parse(td.decode(bytes));
  } catch {
    return null;
  }
  if (!Array.isArray(metas)) return null;
  const byId = new Map();
  for (const id of identities || []) {
    if (!id?.memberId) continue;
    byId.set(id.memberId, id);
  }
  const out = [];
  for (const m of metas) {
    if (!m || typeof m.secret !== "string") continue;
    // A meta whose identity is missing is as unusable as a tampered one and
    // is dropped the same way; pairing by position would silently hand a
    // circle someone else's signing key after a torn write.
    const identity = m.memberId ? byId.get(m.memberId) : null;
    if (!identity) continue;
    let secret;
    try {
      secret = b64uDecode(m.secret);
    } catch {
      continue;
    }
    if (secret.length !== 32) continue;
    // No channel, no circle: the chain key alone cannot name where the circle
    // talks, so a meta without a readable generation is unusable rather than
    // half usable.
    const gen = readGenMeta(m);
    if (!gen) continue;
    out.push({
      name: typeof m.name === "string" ? m.name : "My circle",
      secret,
      identity,
      ...gen,
      pinned: readPinned(m.pinned),
      profile: m.profile || null,
      lastTs: Number.isFinite(m.lastTs) ? m.lastTs : 0,
    });
  }
  return out;
}

export function sameSecret(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

// A sealed record that is on disk and will not open, either because it was
// tampered with or because it was damaged. It is thrown rather than returned,
// because every value a reader could be handed for it also means something
// ordinary: null and undefined both read as "there is no record here", and on
// the generation slot that shape is a v1 install, whose only offer to the user
// is erase-and-start-over. A circle that cannot be read must never be routed
// into a path that erases it, so the read fails loudly and the caller has to
// decide what an unreadable circle deserves.
export class SealedRecordError extends Error {
  constructor(key) {
    super(`sealed record will not open: ${key}`);
    this.name = "SealedRecordError";
    this.key = key;
  }
}

export const isSealedRecordError = (e) => e instanceof SealedRecordError;

// --- is the vault key still a key -------------------------------------------
//
// zero() in lock.js is bytes.fill(0). It empties the buffer in place and every
// reference to it stays alive, now holding 32 zero bytes, so a lock context
// captured before the app locked (or before a last-circle leave dropped the
// key) still carries a `vaultKey` field afterwards. A check that only asks
// whether the field is set passes on that context and seals the record under a
// constant every attacker already has, which is not encryption, it is
// publishing. So every fail-closed check below asks whether the key can still
// protect something.
//
// The shape is part of the question: a Starling vault key is 32 bytes of a
// typed array, and anything else in that field, whatever it is, is not one.
export function usableVaultKey(key) {
  if (!ArrayBuffer.isView(key) || key.length !== 32) return false;
  let bits = 0;
  for (let i = 0; i < 32; i++) bits |= key[i];
  return bits !== 0;
}

// --- the active-slot fence --------------------------------------------------
//
// The roster is the one active slot the app writes off the circle guard: pins
// arrive from the network and are written down as they are made, through a
// queue that can still be holding a write when a leave takes the circle out of
// the active slots. That write then lands after the slots have been cleared,
// and with the lock off it leaves a plaintext roster on disk for a circle this
// device is no longer in. Nothing points at it afterwards, so no boot and no
// later mutation ever cleans it up.
//
// So the moment a circle is taken out of the active slots they are CLOSED,
// and they open again only when a circle takes them. The generation record is
// the signal, because it is the first thing every arrival writes: writeActive
// below, and the staged record the app writes before any roster of its own. A
// write that arrives closed is dropped rather than thrown; it was queued for a
// circle that no longer exists, and there is nothing to retry it against. The
// last-circle leave closes them harder than this, for the reason below.
//
// Keyed by the store rather than module-wide, so the flag lives exactly as
// long as the queued writes it exists to catch, and one store's leave cannot
// fence another's. It is a backstop, not a substitute for a caller that
// re-checks its own state: it catches the one write that cannot, because the
// decision to make it was taken while the circle was still there.
const closedSlots = new WeakSet();

// The harder fence, for the leave that has no successor. That leave deletes
// the slots instead of handing them over, so a write still in flight across it
// is not just a straggler: it is the tail of a sequence whose remaining steps
// write a chain key. persistRatchet is called un-awaited from the poller, and
// writeGenAtRest stages the generation, writes the record, writes the roster
// and THEN writes the chain key, so a leave landing anywhere inside that
// sequence used to be followed by the left circle's key going back onto the
// disk, in the clear if the app lock had just been dropped with it.
//
// Dropping those writes is not enough, because the step that writes the chain
// key is not one of them. They are refused loudly instead, which is what stops
// the rest of the sequence from running at all.
const leftSlots = new WeakSet();

const sameSlot = (a, b) => a?.plain === b.plain;

// Whether the disk actually holds a circle's identity right now. This is what
// tells a real arrival apart from the tail of a write decided before the
// leave: persistCircle writes the identity BEFORE the generation record
// precisely so a staged generation always has the identity it belongs to
// already on disk, and the last-circle purge deletes it. A store that will not
// answer counts as no identity, because a fence that opens on a failed read is
// not a fence.
async function hasIdentityAtRest(kv) {
  try {
    const id = await kv.get("identity");
    return id !== null && id !== undefined;
  } catch {
    return false;
  }
}

// One JSON record, in whichever form the lock state demands. Fail closed
// exactly like the chain key: with the lock enabled and no vault key in memory
// we are locked or mid-teardown, and nothing may be written at all.
export async function writeRecordAtRest(kv, lock, slot, value) {
  const clearing = value === null || value === undefined;
  // Fail closed first, ahead of every fence below, so a write that is going to
  // be refused leaves no trace of having been attempted: no journal spent, no
  // fence reopened. The key has to be usable and not merely present.
  if (lock?.enabled && !usableVaultKey(lock.vaultKey)) throw new Error(`locked: refusing to write ${slot.plain}`);
  // A generation record means a circle is taking the active slots: a switch, a
  // promotion, a create or a join. Clearing one is not an arrival, so it opens
  // nothing.
  const arriving = !clearing && (sameSlot(slot, GEN_SLOT) || sameSlot(slot, STAGED_SLOT));
  // The device left its last circle, so nothing may be written back into these
  // slots until a circle genuinely takes them, and an arrival is only genuine
  // when the identity it belongs to is already on disk. A delete is always
  // allowed: the fence exists to keep records off this disk, never to keep
  // them on it. A join that lands here between its first pin and its
  // generation write loses that one roster write and logs it; writeGenAtRest
  // rewrites the whole roster a step later, so nothing is actually lost.
  if (leftSlots.has(kv) && !clearing) {
    if (!arriving || !(await hasIdentityAtRest(kv))) throw new Error(`left: refusing to write ${slot.plain}`);
    leftSlots.delete(kv);
  }
  // Dropped, not thrown: see the fence above.
  if (sameSlot(slot, PINNED_SLOT) && closedSlots.has(kv)) return false;
  if (arriving) closedSlots.delete(kv);
  // The same arrival spends any journal a leave left behind. A device whose
  // storage refused a delete during a last-circle leave can go straight on to
  // create or join, and boot replaying that journal afterwards would delete the
  // new circle's chain key: the one circle on the device, gone, with no copy in
  // the array. It goes before the record it guards, and a delete that fails
  // fails the arrival with it: an arrival that boot would go on to purge is
  // worse than one that never happened.
  if (arriving) await kv.del(LEAVING_KEY);
  if (lock?.enabled) {
    if (clearing) await kv.del(slot.sealed);
    else await kv.set(slot.sealed, await sealUnderVault(lock.vaultKey, te.encode(JSON.stringify(value))));
    await kv.del(slot.plain);
  } else {
    if (clearing) await kv.del(slot.plain);
    else await kv.set(slot.plain, value);
    await kv.del(slot.sealed);
  }
  return true;
}

// Read one back. An absent record is null. A sealed blob that exists and will
// not open throws SealedRecordError, because a record this device HAS and
// cannot read is a different fact from having none, and the difference decides
// whether the user is shown a circle that needs attention or a device that
// looks empty enough to erase.
export async function readRecordAtRest(kv, lock, slot) {
  if (lock?.enabled) {
    // Fail closed on the way in as well. A zeroed key opens nothing, so
    // without this the caller is handed SealedRecordError and told the install
    // is damaged: boot answers that by parking the staged generation and
    // DELETING it, and the lock screen answers it by telling the user their
    // data will not open. A key that is gone is not a damaged record.
    if (!usableVaultKey(lock.vaultKey)) throw new Error(`locked: refusing to read ${slot.sealed}`);
    const sealed = await kv.get(slot.sealed);
    if (!sealed) return null;
    const bytes = await openUnderVault(lock.vaultKey, sealed);
    if (!bytes) throw new SealedRecordError(slot.sealed);
    try {
      return JSON.parse(td.decode(bytes));
    } catch {
      throw new SealedRecordError(slot.sealed);
    }
  }
  return (await kv.get(slot.plain)) ?? null;
}

// Persist the inactive array in whichever form the lock state demands.
export async function writeCirclesAtRest(kv, lock, circles) {
  if (lock?.enabled) {
    if (!usableVaultKey(lock.vaultKey)) throw new Error("locked: refusing to write circles");
    await kv.set("vaultCircles", await sealUnderVault(lock.vaultKey, packCircles(circles)));
    await kv.set("circleIdentities", circles.map((c) => c.identity));
    await kv.del("circles");
  } else {
    await kv.set("circles", circles);
    await kv.del("vaultCircles");
    await kv.del("circleIdentities");
  }
}

// Read the inactive array back. With the lock on this needs the vault key and
// returns null when the sealed blob will not authenticate, so the caller can
// tell tampering apart from an empty list.
export async function readCirclesAtRest(kv, lock) {
  if (lock?.enabled) {
    // Null here means "this blob is corrupt" and the caller answers it by
    // dropping every inactive circle it has. A zeroed key would produce that
    // answer for circles that are perfectly intact, so it is refused instead.
    if (!usableVaultKey(lock.vaultKey)) throw new Error("locked: refusing to read circles");
    const sealed = await kv.get("vaultCircles");
    if (!sealed) return [];
    const bytes = await openUnderVault(lock.vaultKey, sealed);
    if (!bytes) return null;
    return unpackCircles(bytes, (await kv.get("circleIdentities")) || []) || [];
  }
  return (await kv.get("circles")) || [];
}

// Lock transitions. The destination form must be fully durable BEFORE the
// lock flag flips, and plaintext is deleted only after: boot's guarded purge
// (which removes a plaintext slot only when its sealed twin exists, and the
// reverse) then makes every crash window recoverable instead of lossy.
export async function enableLockAtRest(kv, { vaultKey, lockRecord, secret, circles, genMeta, pinned, invite }) {
  // The staged generation is a slot like the others and it holds live key
  // material: a chain key, and the channel id that names where the circle
  // talks. It is the one slot with no counterpart in the caller's memory, so
  // it is read off disk here rather than passed in. Miss it and turning the
  // lock ON leaves a chain key and a channel id sitting in the clear, which is
  // the single thing the lock exists to prevent. It is migrated rather than
  // deleted, because it is also the repair record for a generation write that
  // was interrupted, and boot has not applied it yet. Its plaintext form goes
  // LAST, after every seal is durable, which is what lets the unwind below
  // have nothing to put back: a throw anywhere in here leaves the plaintext
  // record exactly where it was.
  // Every seal below is made under this one key, so an unusable key here would
  // put the whole device on disk under 32 zero bytes in a single pass. It is
  // checked before the first read, not before the first seal, so a refusal
  // cannot leave the transition halfway.
  if (!usableVaultKey(vaultKey)) throw new Error("locked: refusing to seal under an unusable vault key");
  const stagedRec = await kv.get(STAGED_SLOT.plain);
  await kv.set("vaultSecret", await sealUnderVault(vaultKey, secret));
  await kv.set("vaultCircles", await sealUnderVault(vaultKey, packCircles(circles)));
  await kv.set(
    "circleIdentities",
    circles.map((c) => c.identity),
  );
  const seal = (v) => sealUnderVault(vaultKey, te.encode(JSON.stringify(v)));
  if (genMeta) await kv.set(GEN_SLOT.sealed, await seal(genMeta));
  await kv.set(PINNED_SLOT.sealed, await seal(pinned || []));
  if (invite) await kv.set(INVITE_SLOT.sealed, await seal(invite));
  if (stagedRec) await kv.set(STAGED_SLOT.sealed, await seal(stagedRec));
  await kv.set("lock", lockRecord);
  await kv.del("secret");
  await kv.del("circles");
  await kv.del(GEN_SLOT.plain);
  await kv.del(PINNED_SLOT.plain);
  await kv.del(INVITE_SLOT.plain);
  await kv.del(STAGED_SLOT.plain);
}

// Going the other way there is nothing to migrate: the sealed staged record
// cannot be opened without the vault key, which is not a transition argument,
// and it is redundant anyway. The caller writes the live generation out of
// memory here, and memory is never older than the staged record: the staging
// write is made FROM memory and the caller holds the circle guard across both.
export async function disableLockAtRest(kv, { secret, circles, genMeta, pinned, invite }) {
  await kv.set("secret", secret);
  await kv.set("circles", circles);
  if (genMeta) await kv.set(GEN_SLOT.plain, genMeta);
  await kv.set(PINNED_SLOT.plain, pinned || []);
  if (invite) await kv.set(INVITE_SLOT.plain, invite);
  await kv.del("lock");
  for (const k of SEALED_KEYS) await kv.del(k);
}

// The full enable transition, including the unwind a THROWN (not crashed)
// storage op needs: the session keeps running after a failure, so disk must
// be put back on the unlocked form the caller's memory still holds. Restore
// order matters: plaintext is rewritten from memory first, so no partial
// unwind ever leaves a secret in zero locations. Resolves true on commit;
// rethrows after unwinding, and the caller must NOT adopt the lock.
export async function enableLockTransition(kv, args) {
  try {
    await enableLockAtRest(kv, args);
    return true;
  } catch (e) {
    const unwind = [
      () => kv.set("secret", args.secret),
      () => kv.set("circles", args.circles),
      () => (args.genMeta ? kv.set(GEN_SLOT.plain, args.genMeta) : kv.del(GEN_SLOT.plain)),
      () => kv.set(PINNED_SLOT.plain, args.pinned || []),
      () => (args.invite ? kv.set(INVITE_SLOT.plain, args.invite) : kv.del(INVITE_SLOT.plain)),
      () => kv.del("lock"),
      ...SEALED_KEYS.map((k) => () => kv.del(k)),
    ];
    for (const op of unwind) {
      try {
        await op();
      } catch {
        // storage is failing; boot's guarded purge covers whatever remains
      }
    }
    throw e;
  }
}

// The disable mirror. A throw is only fatal to the transition while the lock
// record still exists on disk; once the record is gone the transition has
// effectively committed (plaintext was written first), so the caller must
// finish the memory flip even though a stale seal may remain for boot to
// purge. Returns true when the caller should adopt the unlocked state.
export async function disableLockTransition(kv, args) {
  try {
    await disableLockAtRest(kv, args);
    return true;
  } catch (e) {
    let record;
    try {
      record = await kv.get("lock");
    } catch {
      record = "unknown";
    }
    if (record) throw e;
    for (const k of SEALED_KEYS) {
      try {
        await kv.del(k);
      } catch {
        // stale seals; boot deletes them once no lock record exists
      }
    }
    return true;
  }
}

// Make the circle at toIndex active. Three steps, so a crash at any point
// leaves every secret on disk in at least one place: first the array grows
// into a superset holding BOTH the incoming and outgoing circles, then the
// incoming circle lands in the active slots, and only then does the array
// shrink to drop the incoming duplicate. Boot and unlock reconcile away
// whatever duplicate a crash strands. The caller owns the live teardown
// around this and applies the returned state.
export async function switchActive(kv, lock, { outgoing, circles, toIndex }) {
  const incoming = circles[toIndex];
  if (!incoming) throw new Error("no such circle");
  await writeCirclesAtRest(kv, lock, [...circles, outgoing]);
  await writeActive(kv, lock, incoming);
  const nextInactive = circles.filter((_, i) => i !== toIndex);
  nextInactive.push(outgoing);
  await writeCirclesAtRest(kv, lock, nextInactive);
  return { active: incoming, circles: nextInactive };
}

// Remove the active circle and promote the one at toIndex (or none). The
// promoted circle stays in the array until the active slots hold it, so the
// same duplicate-not-loss rule covers a crash here too; the array shrinks
// only as the final step.
//
// With nothing to promote there is nothing to hand the slots to, so they are
// purged under the journal described below, and the result carries `pending`
// when a delete did not take and boot still owes the disk a sweep. The caller
// has to act on that: past this point the user is being told the circle is
// gone, and `pending` is the difference between that being true and the
// roster, the channel id and a live invitation still sitting on the disk.
export async function leaveActive(kv, lock, { circles, toIndex }) {
  const promoted = circles[toIndex] ?? null;
  if (promoted) {
    await writeActive(kv, lock, promoted);
    const nextInactive = circles.filter((_, i) => i !== toIndex);
    await writeCirclesAtRest(kv, lock, nextInactive);
    return { active: promoted, circles: nextInactive };
  }
  // No circle is taking these slots, so they stay closed until one does. A
  // roster write queued before the leave would otherwise land afterwards and
  // re-create the roster of a circle this device is no longer in, in plaintext
  // with the lock off, where nothing ever looks for it again. This leave
  // closes them the hard way as well: with no successor, a write still in
  // flight is the tail of a sequence that goes on to write a chain key, and
  // only a refusal stops the rest of it.
  closedSlots.add(kv);
  leftSlots.add(kv);
  try {
    await kv.set(LEAVING_KEY, 1);
  } catch (e) {
    // Nothing has been deleted yet, so the circle is whole on disk and the
    // caller keeps it live. Leaving the slots closed would silently drop that
    // circle's pins until its next generation write, which is the same reason
    // writeActive reopens them when it fails.
    closedSlots.delete(kv);
    leftSlots.delete(kv);
    throw e;
  }
  let pending = !(await purgeActiveSlots(kv));
  if (!pending) {
    try {
      await kv.del(LEAVING_KEY);
    } catch {
      // A journal with nothing left to purge is the safe thing to strand: the
      // next launch replays deletes for keys that are already gone.
      pending = true;
    }
  }
  // Past the journal write the leave has committed, so a delete that failed is
  // reported rather than thrown. Throwing would send the caller back into a
  // circle whose chain key is already off the disk.
  return { active: null, circles, pending };
}

// --- the last-circle leave --------------------------------------------------
//
// Every other teardown hands the active slots to another circle, so each of
// its crash windows still ends with some circle owning every slot. This one
// has no successor: it has to DELETE the slots, and a run of deletes has no
// commit point the way writeActive's identity write does. A crash partway used
// to leave the generation record (which names the channel), the pinned roster
// (every member's public keys) and the outstanding invitation (a live
// credential) behind, in plaintext with the lock off, for a circle the user
// had just been told was gone. Nothing looked for them again either, because
// every boot path keys off the chain key and the identity, and those went
// first: the device read as empty while it still held the leftovers.
//
// So the deletes are journalled. This key is written before the first delete
// and removed after the last, which turns the whole run into one recoverable
// step: finishPendingLeave replays it at boot, and replaying deletes costs
// nothing. It ends one of two ways and no other: boot replays it, or a circle
// arrives in the slots and spends it in writeRecordAtRest above.
//
// The journal itself is a flag and nothing else. It names no circle and holds
// no key, so unlike every slot it guards it needs no sealed spelling, and it
// can be written and replayed by a device that cannot open the vault at all.
export const LEAVING_KEY = "leaving";

// The slots that leave takes with it, most dangerous first. The journal only
// helps a device that runs the app again, and a seized phone never does, so
// the order still has to earn its place: the chain key goes first, then the
// staged generation (a second chain key, with the channel it belongs to), then
// the live invitation, then the channel id, then the roster, and only then
// this device's own keypair and the plain metadata.
//
// Built from the slot constants rather than spelled out, so a new slot cannot
// be added to the circle and forgotten here, and both spellings of every slot
// go: which one is on disk depends on a lock state this device may no longer
// be able to read.
export const LEAVE_PURGE_KEYS = [
  "secret",
  "vaultSecret",
  ...[STAGED_SLOT, INVITE_SLOT, GEN_SLOT, PINNED_SLOT].flatMap((slot) => [slot.plain, slot.sealed]),
  "identity",
  "circleName",
  "lastSentTs",
];

// Delete them all, and keep going past a failure: one key that storage will
// not give up must never keep the invitation or the roster alive behind it.
// Resolves true only when the disk is actually clean.
async function purgeActiveSlots(kv) {
  let clean = true;
  for (const k of LEAVE_PURGE_KEYS) {
    try {
      await kv.del(k);
      // A delete that resolved is not a delete that stuck. store.js resolves
      // its IndexedDB ops when the REQUEST succeeds, and a transaction commits
      // after that: one that aborts on the way to disk (a full volume, an I/O
      // error, a page killed mid-commit) rolls the delete back after we were
      // told it worked. So the key is read back rather than assumed gone. The
      // read runs in a later transaction over the same store, which the
      // database orders after the write it follows, so it sees whatever
      // actually committed. Without it `clean` means reported, and the caller
      // and the journal both act on it as though it meant observed.
      const left = await kv.get(k);
      if (left !== null && left !== undefined) clean = false;
    } catch {
      // The journal outlives this attempt, and boot runs it again.
      clean = false;
    }
  }
  return clean;
}

// Boot's half of the journal. It has to run BEFORE anything reads the active
// slots, because a half-purged circle is exactly the shape a boot mistakes for
// a real one: a generation record and a roster with no key to read them with.
// No journal means no work, which is every ordinary launch. It never throws,
// because a device that cannot clean up must still boot.
export async function finishPendingLeave(kv) {
  let journal = null;
  try {
    journal = await kv.get(LEAVING_KEY);
  } catch {
    return false;
  }
  if (!journal) return false;
  if (await purgeActiveSlots(kv)) {
    try {
      await kv.del(LEAVING_KEY);
    } catch {
      // Clean disk, stranded journal: harmless, and the next launch retries.
    }
  }
  return true;
}

// The active slots. The generation record and the roster are written before
// the chain key, and the chain key before the identity: the identity write is
// the commit point, and every earlier tear leaves the active slots pairing one
// circle's part with another circle's part. adoptPairedCircle below finds the
// complete record in the array and repairs from it, which is only sound
// because switch and leave keep that complete record in the array for the
// whole width of this function.
async function writeActive(kv, lock, c) {
  // Closed for the width of the swap, and opened again by the generation
  // record below: a roster write queued for the outgoing circle must not land
  // on the incoming circle's slots.
  closedSlots.add(kv);
  try {
    await writeActiveSlots(kv, lock, c);
  } catch (e) {
    // Nothing was swapped, so the slots still belong to whichever circle held
    // them before and its own writes are legitimate again. Leaving them closed
    // here would silently drop that circle's pins until its next generation
    // write, which is a change nobody asked for on a path that already failed.
    closedSlots.delete(kv);
    throw e;
  }
}

async function writeActiveSlots(kv, lock, c) {
  if (c.profile) await kv.set("profile", c.profile);
  await kv.set("circleName", c.name);
  await kv.set("lastSentTs", c.lastTs || 0);
  // An invitation belongs to the circle that issued it, and no invitation
  // travels with a switch. Burning it first means a torn switch can only cost
  // an invite link somebody has to re-send, never leave a live credential
  // pointing at a circle it was not minted for.
  await writeRecordAtRest(kv, lock, INVITE_SLOT, null);
  // A staged generation belongs to the circle that staged it, and boot applies
  // whatever the slot holds over whatever the active slots hold. Left here it
  // is applied to the INCOMING circle on the next launch and overwrites the
  // only chain key that circle has, which is silent and permanent loss of a
  // circle. It goes for the same reason the invitation does, and before the
  // generation record for the same reason: a torn switch can then cost the
  // outgoing circle a re-key it has to make again, never cost the incoming
  // circle its key. The outgoing circle's own complete record is in the array
  // throughout, so nothing else about it is lost either way.
  await writeRecordAtRest(kv, lock, STAGED_SLOT, null);
  await writeRecordAtRest(kv, lock, GEN_SLOT, packGenMeta(c));
  await writeRecordAtRest(kv, lock, PINNED_SLOT, packPinned(c.pinned));
  if (lock?.enabled) {
    if (!usableVaultKey(lock.vaultKey)) throw new Error("locked: refusing to write the chain key");
    await kv.set("vaultSecret", await sealUnderVault(lock.vaultKey, c.secret));
    await kv.del("secret");
  } else {
    await kv.set("secret", c.secret);
    await kv.del("vaultSecret");
  }
  await kv.set("identity", c.identity);
}

// The second boot self-heal: a crash inside writeActive leaves the active
// slots pairing one circle's chain key with another circle's identity, or
// with another circle's generation record. Entering with that chimera would
// either publish the old identity onto the new circle's channel, linking the
// two pseudonyms, or post under a key nobody on that channel can read. The
// superset step of a switch guarantees the inactive array still holds the
// correctly paired record for whichever chain key survived; hand it back so
// the caller can adopt it before entering.
//
// Two circles never legitimately share a chain key, so a same-key entry that
// disagrees with the active slots is always the repair, never a collision.
export function adoptPairedCircle({ activeSecret, activeMemberId, activeGen, circles }) {
  if (!activeSecret) return null;
  const activeCkEpoch = genCkEpoch(activeGen);
  for (const c of circles || []) {
    if (!sameSecret(c.secret, activeSecret)) continue;
    if (!c.identity?.memberId) continue;
    if (c.identity.memberId !== activeMemberId) return c;
    if (!activeGen) return c;
    if (c.g !== activeGen.g || c.channelId !== activeGen.channelId) return c;
    if (activeCkEpoch !== null && c.ckEpoch !== activeCkEpoch) return c;
    return null;
  }
  return null;
}

// The chain key's epoch, from either shape the callers hold: a generation
// record read off disk carries it as a field, while the LIVE generation keeps
// it only in its ratchet, whose snapshot is the epoch of the oldest key it
// still retains. Reading the field alone means the live shape always compares
// as a mismatch, every boot repairs a circle that needs no repair, and the
// torn-write repair this function exists for can never be told apart from an
// intact circle. Null means the epoch is not knowable from what was passed,
// and an unknown epoch is not evidence of a tear.
function genCkEpoch(gen) {
  if (Number.isSafeInteger(gen?.ckEpoch)) return gen.ckEpoch;
  let snap = null;
  try {
    snap = gen?.ratchet?.snapshot?.() || null;
  } catch {
    return null;
  }
  return Number.isSafeInteger(snap?.e0) ? snap.e0 : null;
}

// Boot self-heal: a crash mid-switch leaves the active circle duplicated in
// the inactive array. Drop an entry only when BOTH its chain key and its
// memberId match the active slots: a completed writeActive matches both,
// while a torn slot pair matches neither entry fully, so nothing that is
// still the only copy of a circle ever gets dropped. Runs AFTER
// adoptPairedCircle, never before: a torn generation record matches on both
// counts and the repair has to happen while the array still holds it.
export function reconcileCircles({ activeSecret, activeMemberId, circles }) {
  return circles.filter(
    (c) =>
      !(
        activeMemberId &&
        c.identity?.memberId === activeMemberId &&
        activeSecret &&
        sameSecret(c.secret, activeSecret)
      ),
  );
}
