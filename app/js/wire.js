// Wire-level helpers shared verbatim by the app, the relay, and the tests.
// Pure ES module: browser, Node, and workerd all import this same file.
//
// Spec: docs/PROTOCOL.md.

export const PROTO = "starling/v2";
export const PAD_LEN = 512;          // plaintext padded to exactly this
export const MAX_BODY = 2048;        // relay rejects bigger POST bodies
export const MEMBER_CAP = 16;        // member slots per channel
export const TRAIL_CAP = 240;        // stored points per member
export const TTL_MS = 24 * 60 * 60 * 1000;
export const FUTURE_SKEW_MS = 10 * 60 * 1000;
export const INVITE_TTL_MS = 60 * 60 * 1000;

// Duplicated from ratchet.js on purpose: the relay imports this file and must
// not pull in the client-side ratchet to bounds-check an epoch index.
export const EPOCH_MS = 600_000;
export const MAX_SKEW_EPOCHS = 2;

const subtle = globalThis.crypto.subtle;

export function b64uEncode(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function b64uDecode(str) {
  if (typeof str !== "string" || !/^[A-Za-z0-9_-]*$/.test(str)) throw new Error("bad b64u");
  const s = str.replaceAll("-", "+").replaceAll("_", "/");
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function concatBytes(...parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export async function sha256(bytes) {
  return new Uint8Array(await subtle.digest("SHA-256", bytes));
}

export const ECDH_PK_LEN = 65; // P-256 raw public key

// member_id = first 32 hex chars of SHA-256("starling/v2/member" || pk || epk).
//
// 128 bits, and it commits to BOTH public keys. This binding is the whole of a
// receiver's trust in "who sent this": a member is their keys, and the id is
// how the pair is named. Committing to the signing key alone would let a relay
// swap in an agreement key of its choosing for a member whose signature it
// cannot forge, and the agreement key is what re-key material is sealed to.
// At 64 bits a second preimage is within reach of anyone who can rent enough
// hashing, and finding one lets an attacker occupy a member's slot.
export async function memberIdFromKeys(pkBytes, epkBytes) {
  const label = new TextEncoder().encode(`${PROTO}/member`);
  return bytesToHex(await sha256(concatBytes(label, pkBytes, epkBytes))).slice(0, 32);
}

// Safety number: the out-of-band check that turns trust-on-first-use into
// something a human verified. Six groups of five decimal digits, from the same
// key pair the member id commits to.
export async function safetyNumber(pkBytes, epkBytes) {
  const label = new TextEncoder().encode(`${PROTO}/fp`);
  const digest = await sha256(concatBytes(label, pkBytes, epkBytes));
  let digits = "";
  for (let i = 0; i < 18; i += 3) {
    const chunk = (digest[i] << 16) | (digest[i + 1] << 8) | digest[i + 2];
    digits += String(chunk % 100000).padStart(5, "0");
  }
  return digits.replace(/(\d{5})(?=\d)/g, "$1 ");
}

// The roster hash a re-key commits to, so members can tell whether they agree
// about who is in the circle.
export async function rosterHash(memberIds) {
  const label = `${PROTO}/roster|${[...memberIds].sort().join(",")}`;
  return b64uEncode(await sha256(new TextEncoder().encode(label)));
}

// The signing algorithm is a FUNCTION OF THE PUBLIC KEY, never a wire field.
//
// `alg` used to be read straight off the relay's response, and it is not
// covered by the member id, so a relay could flip it. The two key lengths do
// not overlap (Ed25519 is 32 bytes raw, P-256 is 65), so the key names its own
// algorithm unambiguously, and because the member id commits to the key, the
// algorithm is pinned along with it. A relay that flips the field now changes
// nothing; before, it silently erased that member from everyone's map, and the
// safety number could not detect it because the safety number does not cover
// `alg` either.
export function algFromPk(pkBytes) {
  if (pkBytes.length === ALGS.ed25519.pkLen) return "ed25519";
  if (pkBytes.length === ALGS.p256.pkLen) return "p256";
  return null;
}

// A real, importable P-256 point. An `epk` was only ever length-bounded as a
// base64url string, so a malformed one could be pinned and then make every
// future re-key throw when ECDH tried to import it, which permanently disabled
// re-keying, removal and joining for the whole circle.
export async function validEcdhKey(epkBytes) {
  if (!(epkBytes instanceof Uint8Array) || epkBytes.length !== ECDH_PK_LEN) return false;
  try {
    await subtle.importKey("raw", epkBytes, { name: "ECDH", namedCurve: "P-256" }, false, []);
    return true;
  } catch {
    return false;
  }
}

export const isChannelId = (s) => typeof s === "string" && /^[0-9a-f]{32}$/.test(s);
export const isMemberId = (s) => typeof s === "string" && /^[0-9a-f]{32}$/.test(s);

// The exact string a location post signs. The epoch is in here, so a point
// cannot be replayed into a different epoch any more than into a different
// channel or member slot.
export function sigBase(channel, member, e, ts, n, c) {
  return `${PROTO}|${channel}|${member}|${e}|${ts}|${n}|${c}`;
}

// AAD binding a ciphertext to its channel, member slot and epoch.
export function aadFor(channel, member, e, ts) {
  return new TextEncoder().encode(`${PROTO}|${channel}|${member}|${e}|${ts}`);
}

export const ALGS = {
  ed25519: {
    import: (pk) => subtle.importKey("raw", pk, { name: "Ed25519" }, false, ["verify"]),
    verify: (key, sig, data) => subtle.verify({ name: "Ed25519" }, key, sig, data),
    pkLen: 32,
    sigLen: 64,
  },
  p256: {
    import: (pk) => subtle.importKey("raw", pk, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]),
    verify: (key, sig, data) => subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, sig, data),
    pkLen: 65,
    sigLen: 64,
  },
};

// True only if alg is known, key length matches, and the signature verifies.
// `alg` is an allowlist lookup, never a name handed to the crypto layer, so an
// unknown or hostile value fails here rather than selecting some other
// primitive. Note also that a P-256 signature is not a unique bitstring for
// its message (the S value is malleable), so nothing may ever treat `sig` as
// an identity or a dedup key; replay defenses key on channel, member, epoch
// and ts.
export async function verifySig(alg, pkBytes, sigBytes, baseString) {
  const spec = ALGS[alg];
  if (!spec || pkBytes.length !== spec.pkLen || sigBytes.length !== spec.sigLen) return false;
  try {
    const key = await spec.import(pkBytes);
    return await spec.verify(key, sigBytes, new TextEncoder().encode(baseString));
  } catch {
    return false;
  }
}

// Shape-check one POSTed location body. Returns null if malformed.
export function checkPostShape(body) {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const { m, alg, pk, epk, e, ts, n, c, sig } = body;
  if (!isMemberId(m)) return null;
  if (alg !== "ed25519" && alg !== "p256") return null;
  if (!Number.isSafeInteger(ts) || ts <= 0) return null;
  if (!Number.isSafeInteger(e) || e < 0) return null;
  for (const [name, v, max] of [
    ["pk", pk, 90],
    ["epk", epk, 90],
    ["n", n, 18],
    ["c", c, 720],
    ["sig", sig, 90],
  ]) {
    if (typeof v !== "string" || v.length === 0 || v.length > max) return null;
    if (!/^[A-Za-z0-9_-]+$/.test(v)) { void name; return null; }
  }
  return { m, alg, pk, epk, e, ts, n, c, sig };
}

// Is this epoch index plausible against a clock? Used by the relay to keep junk
// out of storage and by receivers as one of several checks. Never used to
// SELECT a key: the key comes from the carried index alone.
export function epochPlausible(e, now) {
  const nowEpoch = Math.floor(now / EPOCH_MS);
  return e <= nowEpoch + MAX_SKEW_EPOCHS && e >= nowEpoch - MAX_SKEW_EPOCHS;
}
