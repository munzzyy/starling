// Wire-level helpers shared verbatim by the app, the relay, and the tests.
// Pure ES module: browser, Node, and workerd all import this same file.

export const PROTO = "starling/v1";
export const PAD_LEN = 512;          // plaintext padded to exactly this
export const MAX_BODY = 2048;        // relay rejects bigger POST bodies
export const MEMBER_CAP = 16;        // member slots per channel
export const TRAIL_CAP = 240;        // stored points per member
export const TTL_MS = 24 * 60 * 60 * 1000;
export const FUTURE_SKEW_MS = 10 * 60 * 1000;

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

export async function sha256(bytes) {
  return new Uint8Array(await subtle.digest("SHA-256", bytes));
}

// member_id = first 32 hex chars of SHA-256(raw public key).
//
// 128 bits, not 64. This binding is the whole of a receiver's trust in "who
// sent this": a member is their key, and the id is how the key is named. At
// 64 bits a second preimage is within reach of anyone who can rent enough
// hashing, and finding one lets an attacker occupy a member's slot with a key
// they control. 128 bits puts that out of reach.
export async function memberIdFromPub(pkBytes) {
  return bytesToHex(await sha256(pkBytes)).slice(0, 32);
}

export const isChannelId = (s) => typeof s === "string" && /^[0-9a-f]{32}$/.test(s);
export const isMemberId = (s) => typeof s === "string" && /^[0-9a-f]{32}$/.test(s);

// The exact string a location post signs.
export function sigBase(channel, member, ts, n, c) {
  return `${PROTO}|${channel}|${member}|${ts}|${n}|${c}`;
}

// AAD binding a ciphertext to its channel and member slot.
export function aadFor(channel, member) {
  return new TextEncoder().encode(`${PROTO}|${channel}|${member}`);
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
// an identity or a dedup key; replay defenses key on channel, member and ts.
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
  const { m, alg, pk, ts, n, c, sig } = body;
  if (!isMemberId(m)) return null;
  if (alg !== "ed25519" && alg !== "p256") return null;
  if (!Number.isSafeInteger(ts) || ts <= 0) return null;
  for (const [name, v, max] of [["pk", pk, 90], ["n", n, 18], ["c", c, 720], ["sig", sig, 90]]) {
    if (typeof v !== "string" || v.length === 0 || v.length > max) return null;
    if (!/^[A-Za-z0-9_-]+$/.test(v)) { void name; return null; }
  }
  return { m, alg, pk, ts, n, c, sig };
}
