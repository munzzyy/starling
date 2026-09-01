// Multiple circles, one active. The active circle keeps living in the
// original kv slots (secret, identity, profile, circleName, lastSentTs), so a
// device that only ever holds one circle never changes shape. The inactive
// circles wait in a single array: plaintext under the `circles` key with the
// app lock off, or split with the lock on into `vaultCircles` (names, secrets,
// profiles, timestamps, sealed under the vault key) plus `circleIdentities`
// (the signing keys, which are non-extractable CryptoKeys and can only be
// structured-cloned, never serialized into a sealed blob; they reveal the same
// class of thing the active identity already does today: key material counts,
// but no names, no secrets, no channels).
//
// Every mutation here writes the inactive array BEFORE the active slots, so a
// crash between the two duplicates a circle instead of losing one; boot runs
// reconcileCircles to drop the duplicate.

import { sealUnderVault, openUnderVault } from "./lock.js";
import { b64uEncode, b64uDecode } from "./wire.js";

const te = new TextEncoder();
const td = new TextDecoder();

// The sealable half of a circle record: everything except the CryptoKey. Each
// meta carries its identity's memberId so unpack can re-pair metas with
// identities by id, never by array position; the two records are separate kv
// keys and nothing guarantees they were written in the same breath.
export function packCircles(circles) {
  const metas = circles.map((c) => ({
    name: c.name,
    secret: b64uEncode(c.secret),
    memberId: c.identity?.memberId || null,
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
    if (id?.memberId) byId.set(id.memberId, id);
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
    out.push({
      name: typeof m.name === "string" ? m.name : "My circle",
      secret,
      identity,
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

// Persist the inactive array in whichever form the lock state demands.
// Fail closed exactly like the active secret: with the lock enabled and no
// vault key in memory we are locked or mid-teardown, and nothing may be
// written at all.
export async function writeCirclesAtRest(kv, lock, circles) {
  if (lock?.enabled) {
    if (!lock.vaultKey) throw new Error("locked: refusing to write circles");
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
export async function enableLockAtRest(kv, { vaultKey, lockRecord, secret, circles }) {
  await kv.set("vaultSecret", await sealUnderVault(vaultKey, secret));
  await kv.set("vaultCircles", await sealUnderVault(vaultKey, packCircles(circles)));
  await kv.set(
    "circleIdentities",
    circles.map((c) => c.identity),
  );
  await kv.set("lock", lockRecord);
  await kv.del("secret");
  await kv.del("circles");
}

export async function disableLockAtRest(kv, { secret, circles }) {
  await kv.set("secret", secret);
  await kv.set("circles", circles);
  await kv.del("lock");
  await kv.del("vaultSecret");
  await kv.del("vaultCircles");
  await kv.del("circleIdentities");
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
      () => kv.del("lock"),
      () => kv.del("vaultSecret"),
      () => kv.del("vaultCircles"),
      () => kv.del("circleIdentities"),
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
export async function disableLockTransition(kv, { secret, circles }) {
  try {
    await disableLockAtRest(kv, { secret, circles });
    return true;
  } catch (e) {
    let record;
    try {
      record = await kv.get("lock");
    } catch {
      record = "unknown";
    }
    if (record) throw e;
    for (const k of ["vaultSecret", "vaultCircles", "circleIdentities"]) {
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
export async function leaveActive(kv, lock, { circles, toIndex }) {
  const promoted = circles[toIndex] ?? null;
  if (promoted) {
    await writeActive(kv, lock, promoted);
    const nextInactive = circles.filter((_, i) => i !== toIndex);
    await writeCirclesAtRest(kv, lock, nextInactive);
    return { active: promoted, circles: nextInactive };
  }
  await kv.del("secret");
  await kv.del("vaultSecret");
  await kv.del("identity");
  await kv.del("circleName");
  await kv.del("lastSentTs");
  return { active: null, circles };
}

// The active slots. The secret is written before the identity: a crash
// between the two leaves slots that agree with NEITHER inactive entry, so
// the AND-matching reconcile below keeps both circles instead of eating one
// half of a torn pair.
async function writeActive(kv, lock, c) {
  if (c.profile) await kv.set("profile", c.profile);
  await kv.set("circleName", c.name);
  await kv.set("lastSentTs", c.lastTs || 0);
  if (lock?.enabled) {
    if (!lock.vaultKey) throw new Error("locked: refusing to write the secret");
    await kv.set("vaultSecret", await sealUnderVault(lock.vaultKey, c.secret));
    await kv.del("secret");
  } else {
    await kv.set("secret", c.secret);
    await kv.del("vaultSecret");
  }
  await kv.set("identity", c.identity);
}

// The second boot self-heal: a crash between writeActive's secret and
// identity writes leaves the slots pairing one circle's secret with another
// circle's signing identity. Entering with that chimera would publish the old
// identity onto the new circle's channel, linking the two pseudonyms. The
// superset step of a switch guarantees the inactive array still holds the
// correctly paired record for that secret; hand it back so the caller can
// adopt it before entering. Two circles never legitimately share a secret
// (joining a known invite switches instead of duplicating), so a same-secret
// entry with a different memberId is always the repair, never a collision.
export function adoptPairedIdentity({ activeSecret, activeMemberId, circles }) {
  if (!activeSecret) return null;
  for (const c of circles || []) {
    if (sameSecret(c.secret, activeSecret) && c.identity?.memberId && c.identity.memberId !== activeMemberId) {
      return c;
    }
  }
  return null;
}

// Boot self-heal: a crash mid-switch leaves the active circle duplicated in
// the inactive array. Drop an entry only when BOTH its secret and its
// memberId match the active slots: a completed writeActive matches both,
// while a torn slot pair matches neither entry fully, so nothing that is
// still the only copy of a circle ever gets dropped.
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
