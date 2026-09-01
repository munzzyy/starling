// Device-side crypto: circle secrets, key derivation, seal/open, signing.
// Everything here runs on the member's device. The relay never imports this.

import { PROTO, PAD_LEN, aadFor, bytesToHex, memberIdFromPub, sigBase, b64uEncode, b64uDecode } from "./wire.js";

const subtle = globalThis.crypto.subtle;
const te = new TextEncoder();
const td = new TextDecoder();

export function randomBytes(n) {
  const b = new Uint8Array(n);
  globalThis.crypto.getRandomValues(b);
  return b;
}

export const newCircleSecret = () => randomBytes(32);

async function hkdf(secret, info, lenBytes) {
  const key = await subtle.importKey("raw", secret, "HKDF", false, ["deriveBits"]);
  const bits = await subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(32), info: te.encode(info) },
    key,
    lenBytes * 8,
  );
  return new Uint8Array(bits);
}

export async function deriveChannelId(secret) {
  return bytesToHex(await hkdf(secret, `${PROTO}/channel-id`, 16));
}

export async function deriveEncKey(secret) {
  const raw = await hkdf(secret, `${PROTO}/enc`, 32);
  return subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

// Signing identity. Ed25519 when the browser has it, ECDSA P-256 otherwise.
// The private key is non-extractable; it can still be structured-cloned into
// IndexedDB, which is exactly how we persist it.
export async function generateIdentity() {
  try {
    const kp = await subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"]);
    const pk = new Uint8Array(await subtle.exportKey("raw", kp.publicKey));
    return { alg: "ed25519", privateKey: kp.privateKey, pk, memberId: await memberIdFromPub(pk) };
  } catch {
    const kp = await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
    const pk = new Uint8Array(await subtle.exportKey("raw", kp.publicKey));
    return { alg: "p256", privateKey: kp.privateKey, pk, memberId: await memberIdFromPub(pk) };
  }
}

export async function signBase(identity, baseString) {
  const data = te.encode(baseString);
  const params = identity.alg === "ed25519" ? { name: "Ed25519" } : { name: "ECDSA", hash: "SHA-256" };
  return new Uint8Array(await subtle.sign(params, identity.privateKey, data));
}

// Serialize, pad to PAD_LEN with trailing spaces, encrypt.
// Trailing-space padding is unambiguous because JSON.parse ignores it.
export async function sealMessage(encKey, channelId, memberId, obj) {
  let json = JSON.stringify(obj);
  const jsonLen = te.encode(json).length;
  if (jsonLen > PAD_LEN) throw new Error("message too large");
  json += " ".repeat(PAD_LEN - jsonLen);
  const n = randomBytes(12);
  const c = new Uint8Array(
    await subtle.encrypt({ name: "AES-GCM", iv: n, additionalData: aadFor(channelId, memberId) }, encKey, te.encode(json)),
  );
  return { n, c };
}

// Returns the decoded object, or null for anything that fails to authenticate.
export async function openMessage(encKey, channelId, memberId, nBytes, cBytes) {
  try {
    const pt = await subtle.decrypt(
      { name: "AES-GCM", iv: nBytes, additionalData: aadFor(channelId, memberId) },
      encKey,
      cBytes,
    );
    const obj = JSON.parse(td.decode(pt));
    return typeof obj === "object" && obj !== null ? obj : null;
  } catch {
    return null;
  }
}

// Build a fully signed POST body for one sealed message.
export async function buildPost(identity, channelId, sealed, ts) {
  const n = b64uEncode(sealed.n);
  const c = b64uEncode(sealed.c);
  const sig = await signBase(identity, sigBase(channelId, identity.memberId, ts, n, c));
  return { m: identity.memberId, alg: identity.alg, pk: b64uEncode(identity.pk), ts, n, c, sig: b64uEncode(sig) };
}

// Beacon (emergency help) sessions: a fresh 32-byte secret per SOS whose
// channel and key derive under their own HKDF info strings, so a beacon
// secret and a circle secret can never produce overlapping material. The
// helper link carries the secret in the fragment, same rule as invites.
export async function deriveHelpChannelId(secret) {
  return bytesToHex(await hkdf(secret, `${PROTO}/help-channel-id`, 16));
}

export async function deriveHelpEncKey(secret) {
  const raw = await hkdf(secret, `${PROTO}/help-enc`, 32);
  return subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export function beaconFragment(secret) {
  return `#b=${b64uEncode(secret)}`;
}

export function parseBeaconFragment(hash) {
  const m = /^#b=([A-Za-z0-9_-]{43})$/.exec(hash || "");
  if (!m) return null;
  try {
    const secret = b64uDecode(m[1]);
    return secret.length === 32 ? secret : null;
  } catch {
    return null;
  }
}

// Invite links: secret in the URL fragment, never sent to any server.
export function inviteFragment(secret) {
  return `#j=${b64uEncode(secret)}`;
}

export function parseInviteFragment(hash) {
  const m = /^#j=([A-Za-z0-9_-]{43})$/.exec(hash || "");
  if (!m) return null;
  try {
    const secret = b64uDecode(m[1]);
    return secret.length === 32 ? secret : null;
  } catch {
    return null;
  }
}
