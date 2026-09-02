// The forward-secrecy ratchet.
//
// A circle generation starts from a 32-byte seed. The seed names a relay
// channel (via the anchor) and starts a hash chain. The chain advances once per
// EPOCH_MS, and each step destroys the step before it, so a device that has
// moved to epoch e cannot decrypt epoch e-1 and neither can anyone who takes
// the device. That one-way step is the whole of the forward secrecy claim.
//
// What it deliberately does NOT do: hashing forward introduces no entropy an
// attacker holding the current chain key does not already have, so this file
// cannot provide post-compromise security or remove a member. Both of those
// come from re-keying with fresh ECDH entropy (see rekey.js). Confusing the two
// is the most common way this construction is got wrong.
//
// Spec: docs/PROTOCOL.md, "Key schedule".

import { PROTO, bytesToHex } from "./wire.js";

const subtle = globalThis.crypto.subtle;
const te = new TextEncoder();

export const EPOCH_MS = 600_000; // 10 minutes
export const MAX_SKEW_EPOCHS = 2; // ±20 minutes of tolerated clock disagreement
export const MAX_CATCHUP_EPOCHS = 4320; // 30 days: bounds a hostile epoch index
export const DEFAULT_HISTORY_EPOCHS = 6; // 1 hour of readable trail

// The history window is a user setting because it is exactly the trade the user
// should be making: how much trail they can still read against how much a
// seized device gives up.
export const HISTORY_CHOICES = [
  { id: "high-risk", epochs: 1, label: "10 minutes" },
  { id: "default", epochs: 6, label: "1 hour" },
  { id: "longer", epochs: 36, label: "6 hours" },
  { id: "full", epochs: 144, label: "24 hours" },
];

export const epochAt = (ms) => Math.floor(ms / EPOCH_MS);

export function zero(bytes) {
  if (bytes && typeof bytes.fill === "function") bytes.fill(0);
}

async function hkdf(secret, info, lenBytes) {
  const key = await subtle.importKey("raw", secret, "HKDF", false, ["deriveBits"]);
  const bits = await subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(32), info: te.encode(info) },
    key,
    lenBytes * 8,
  );
  return new Uint8Array(bits);
}

// A generation's four roots. The seed is destroyed by the caller as soon as
// these exist: keeping it would let a seized device recompute CK_0 and walk the
// chain forward through every epoch it had already dropped, which is precisely
// the thing the chain exists to prevent.
export const deriveAnchor = (seed) => hkdf(seed, `${PROTO}/anchor`, 32);
export const chainInit = (seed) => hkdf(seed, `${PROTO}/chain`, 32);
export const chainStep = (ck) => hkdf(ck, `${PROTO}/step`, 32);

export async function channelFromAnchor(anchor) {
  return bytesToHex(await hkdf(anchor, `${PROTO}/channel-id`, 16));
}

// Per-sender content key. The member id is in the info string, so no two
// members ever encrypt under the same key and a nonce collision between senders
// is impossible rather than unlikely. Non-extractable: the raw bytes never
// become script-readable again.
export async function messageKey(ck, memberId) {
  const raw = await hkdf(ck, `${PROTO}/msg|${memberId}`, 32);
  const key = await subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
  zero(raw);
  return key;
}

// Nonce: 4 random bytes then ts as a 64-bit big-endian counter.
//
// MK is unique per (generation, epoch, member) and ts is strictly increasing
// per member, so the counter half cannot repeat under one key in normal
// operation. The random half is a reuse guard in the sense of RFC 9420 §9: if
// persisted state is ever rolled back (a restored backup, a failed IndexedDB
// write) a repeated ts then still needs the guard to collide as well, which is
// a 1 in 2^32 chance per repeated ts. GCM nonce reuse leaks the XOR of the
// plaintexts and the GHASH key, so it is worth being exact about this: the
// counter makes reuse impossible in normal operation, and the guard makes it
// unlikely after a rollback. It does not make it impossible.
export function nonceFor(ts) {
  const n = new Uint8Array(12);
  globalThis.crypto.getRandomValues(n.subarray(0, 4));
  const view = new DataView(n.buffer);
  view.setBigUint64(4, BigInt(ts), false);
  return n;
}

// A live chain: the retained window of epoch keys, and the rules for moving it.
//
// `e0` is the absolute epoch the generation began in, and ck0 belongs to it.
// Epoch indices on the wire are absolute (floor(unixTime / EPOCH_MS)) so a
// receiver can sanity-check one against its own clock without knowing when the
// generation started.
export function createRatchet({ e0, ck0, historyEpochs = DEFAULT_HISTORY_EPOCHS }) {
  if (!Number.isSafeInteger(e0) || e0 < 0) throw new Error("bad generation epoch");
  if (!(ck0 instanceof Uint8Array) || ck0.length !== 32) throw new Error("bad chain key");

  // epoch -> chain key. Never grows past the window; entries leaving it are
  // zeroed, not just dropped.
  const chain = new Map([[e0, ck0]]);
  const keys = new Map(); // "epoch|member" -> CryptoKey, derived on demand
  let head = e0; // highest epoch whose chain key we hold
  let sentEpoch = e0; // highest epoch WE have encrypted in, never peer-driven
  let window = Math.max(1, historyEpochs | 0);
  let destroyed = false;

  function forget(below) {
    for (const [e, ck] of chain) {
      if (e < below) {
        zero(ck);
        chain.delete(e);
      }
    }
    for (const k of keys.keys()) {
      if (Number(k.slice(0, k.indexOf("|"))) < below) keys.delete(k);
    }
  }

  // Trim against the CLOCK, not against the highest epoch we have seen.
  //
  // Anchoring on head was wrong and it was exploitable: keyFor advances the
  // chain to whatever epoch arrives on the wire, within the skew tolerance, so
  // one peer running two epochs fast would push head forward and take the
  // window with it. At the High risk setting, where the window is a single
  // epoch, that destroyed the receiver's own current-epoch key and blinded it
  // to the whole circle, durably. The window belongs to the passage of time,
  // not to whatever a peer claims the time is.
  function trim(now = Date.now()) {
    forget(Math.min(head, epochAt(now)) - window + 1);
  }

  // Move the head forward to `target`, materialising the epochs in between.
  // Returns false rather than throwing when the jump is beyond the cap, so a
  // hostile epoch index on the wire is a dropped message and not a CPU sink.
  async function advanceTo(target, now = Date.now()) {
    if (destroyed) return false;
    if (!Number.isSafeInteger(target) || target <= head) return true;
    if (target - head > MAX_CATCHUP_EPOCHS) return false;
    let ck = chain.get(head);
    for (let e = head + 1; e <= target; e++) {
      ck = await chainStep(ck);
      chain.set(e, ck);
    }
    head = target;
    trim(now);
    return true;
  }

  // The only way a key is ever selected. `e` comes off the wire, inside the
  // signature and the AEAD's associated data; the clock only bounds it.
  //
  // Returns null for an epoch that is out of bounds or already destroyed, and
  // the caller drops the message. Exactly one key is ever tried: trying several
  // candidates would be a partitioning oracle against non-committing AES-GCM.
  async function keyFor(e, memberId, now = Date.now()) {
    if (destroyed) return null;
    if (!Number.isSafeInteger(e) || e < e0) return null;
    const nowEpoch = epochAt(now);
    if (e > nowEpoch + MAX_SKEW_EPOCHS) return null;
    if (e > head && !(await advanceTo(e, now))) return null;
    // Below the retained window it is gone by design, not by accident.
    if (!chain.has(e)) return null;
    const cacheKey = `${e}|${memberId}`;
    let key = keys.get(cacheKey);
    if (!key) {
      key = await messageKey(chain.get(e), memberId);
      keys.set(cacheKey, key);
    }
    return key;
  }

  // The epoch this device should be encrypting in right now. Advancing on send
  // is what actually destroys the past: a device that never sends still
  // advances on boot (see syncToClock).
  // The epoch WE encrypt in. It follows our own clock and our own last send,
  // never `head`.
  //
  // head moves whenever a peer's message arrives from a later epoch, within
  // the skew tolerance. Taking max(head, now) therefore let one member with a
  // fast clock drag every other member's send epoch forward with them, and a
  // receiver whose window is short then could not read any of it. Our own
  // monotonicity is worth keeping (a clock that steps backwards would
  // otherwise post an epoch a receiver has already passed), so it is tracked
  // separately from anything a peer can influence.
  async function currentEpoch(now = Date.now()) {
    if (destroyed) return null;
    const e = Math.max(sentEpoch, epochAt(now));
    if (!(await advanceTo(e, now))) return null;
    sentEpoch = e;
    return e;
  }

  function destroyAll() {
    destroyed = true;
    for (const ck of chain.values()) zero(ck);
    chain.clear();
    keys.clear();
  }

  // Called on boot and on every epoch boundary. A device that has been off for
  // three days drops three days of keys the moment it comes back, rather than
  // carrying them until something happens to need one.
  async function syncToClock(now = Date.now()) {
    const e = epochAt(now);
    if (e > head) {
      // A jump past the catch-up cap cannot be walked, and bailing out without
      // destroying anything would be the worst of both worlds: the device
      // still cannot read current traffic, and it is now holding a month of
      // chain keys for whoever picks it up. Everything retained here is older
      // than the relay's own 24 hour retention, so it can decrypt nothing that
      // still exists. Destroy it and let the caller say so.
      if (!(await advanceTo(e, now))) {
        destroyAll();
        return null;
      }
    } else {
      trim(now);
    }
    return head;
  }

  return {
    get e0() {
      return e0;
    },
    get head() {
      return head;
    },
    get historyEpochs() {
      return window;
    },
    // The clock is a parameter because trimming is anchored to it. A caller
    // that is simulating time has to be able to say which time it means.
    setHistoryEpochs(n, now = Date.now()) {
      window = Math.max(1, n | 0);
      trim(now);
    },
    retainedEpochs: () => [...chain.keys()].sort((a, b) => a - b),
    // The next generation's seed, mixed from the chain key at a NAMED epoch and
    // the rotator's fresh entropy. The chain key never leaves this closure.
    //
    // The epoch is named rather than assumed to be the head because rotator and
    // receiver process a re-key at different moments: mixing a different chain
    // key on each side would silently produce two generations that cannot talk.
    // An epoch that has already left the window returns null, and the caller
    // has to be re-invited rather than guess.
    async nextSeed(ns, epoch) {
      if (destroyed) return null;
      if (!(ns instanceof Uint8Array) || ns.length !== 32) return null;
      const ck = chain.get(epoch);
      if (!ck) return null;
      const mixed = new Uint8Array(64);
      mixed.set(ck, 0);
      mixed.set(ns, 32);
      const seed = await hkdf(mixed, `${PROTO}/rekey`, 32);
      zero(mixed);
      return seed;
    },
    advanceTo,
    keyFor,
    currentEpoch,
    syncToClock,
    // The persisted form: the oldest retained chain key and its epoch. Storing
    // the oldest rather than the newest is what lets a reload still read the
    // window the user asked for; storing e0/ck0 forever would mean the chain
    // never actually forgets anything.
    snapshot() {
      const oldest = retainedOldest();
      return oldest ? { e0: oldest.e, ck0: new Uint8Array(oldest.ck) } : null;
    },
    destroy: destroyAll,
    // True once the chain has been destroyed, either deliberately or because
    // this device fell too far behind to catch up. The caller has to tell the
    // user they need to be re-invited; there is no way back from here.
    get destroyed() {
      return destroyed;
    },
  };

  function retainedOldest() {
    let best = null;
    for (const [e, ck] of chain) if (!best || e < best.e) best = { e, ck };
    return best;
  }
}
