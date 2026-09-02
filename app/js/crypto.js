// Device-side crypto: identities, sealing, signing, key wrapping, invitations.
// Everything here runs on the member's device. The relay never imports this.
//
// The forward-secrecy chain itself lives in ratchet.js; this file turns the
// keys that chain produces into messages on the wire.
//
// Spec: docs/PROTOCOL.md.

import {
  PROTO,
  PAD_LEN,
  aadFor,
  bytesToHex,
  concatBytes,
  memberIdFromKeys,
  sha256,
  sigBase,
  b64uEncode,
  b64uDecode,
} from "./wire.js";
import { nonceFor } from "./ratchet.js";

const subtle = globalThis.crypto.subtle;
const te = new TextEncoder();
const td = new TextDecoder();

export function randomBytes(n) {
  const b = new Uint8Array(n);
  globalThis.crypto.getRandomValues(b);
  return b;
}

export const newSeed = () => randomBytes(32);

async function hkdf(secret, info, lenBytes) {
  const key = await subtle.importKey("raw", secret, "HKDF", false, ["deriveBits"]);
  const bits = await subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(32), info: te.encode(info) },
    key,
    lenBytes * 8,
  );
  return new Uint8Array(bits);
}

// A member identity is two keypairs: one to sign with, one to receive re-key
// material on. Both private keys are non-extractable; they can still be
// structured-cloned into IndexedDB, which is exactly how we persist them.
// Public keys of a non-extractable pair are always exportable, which is what
// lets us publish them.
//
// Ed25519 where the browser has it (Safari 17+, Chrome 137+, Firefox 130+),
// ECDSA P-256 otherwise. Key agreement is P-256 everywhere: it is the only
// curve WebCrypto offers for ECDH on every target, and having exactly one
// agreement algorithm means there is no negotiation for an attacker to
// downgrade.
export async function generateIdentity() {
  let alg, privateKey, pk;
  try {
    const kp = await subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"]);
    alg = "ed25519";
    privateKey = kp.privateKey;
    pk = new Uint8Array(await subtle.exportKey("raw", kp.publicKey));
  } catch {
    const kp = await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
    alg = "p256";
    privateKey = kp.privateKey;
    pk = new Uint8Array(await subtle.exportKey("raw", kp.publicKey));
  }
  const ec = await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  const epk = new Uint8Array(await subtle.exportKey("raw", ec.publicKey));
  return {
    alg,
    privateKey,
    pk,
    ecdhPrivate: ec.privateKey,
    epk,
    memberId: await memberIdFromKeys(pk, epk),
  };
}

export async function signBase(identity, baseString) {
  const data = te.encode(baseString);
  const params = identity.alg === "ed25519" ? { name: "Ed25519" } : { name: "ECDSA", hash: "SHA-256" };
  return new Uint8Array(await subtle.sign(params, identity.privateKey, data));
}

// Serialize, pad to PAD_LEN with trailing spaces, encrypt.
// Trailing-space padding is unambiguous because JSON.parse ignores it. Every
// message type pads to the same length, so the relay cannot tell a location
// update from a re-key by size.
export async function sealMessage(msgKey, channelId, memberId, epoch, ts, obj) {
  let json = JSON.stringify(obj);
  const jsonLen = te.encode(json).length;
  if (jsonLen > PAD_LEN) throw new Error("message too large");
  json += " ".repeat(PAD_LEN - jsonLen);
  const n = nonceFor(ts);
  const c = new Uint8Array(
    await subtle.encrypt(
      { name: "AES-GCM", iv: n, additionalData: aadFor(channelId, memberId, epoch, ts) },
      msgKey,
      te.encode(json),
    ),
  );
  return { n, c };
}

// Returns the decoded object, or null for anything that fails to authenticate.
export async function openMessage(msgKey, channelId, memberId, epoch, ts, nBytes, cBytes) {
  try {
    const pt = await subtle.decrypt(
      { name: "AES-GCM", iv: nBytes, additionalData: aadFor(channelId, memberId, epoch, ts) },
      msgKey,
      cBytes,
    );
    const obj = JSON.parse(td.decode(pt));
    return typeof obj === "object" && obj !== null ? obj : null;
  } catch {
    return null;
  }
}

// Build a fully signed POST body for one sealed message.
export async function buildPost(identity, channelId, epoch, sealed, ts) {
  const n = b64uEncode(sealed.n);
  const c = b64uEncode(sealed.c);
  const sig = await signBase(identity, sigBase(channelId, identity.memberId, epoch, ts, n, c));
  return {
    m: identity.memberId,
    alg: identity.alg,
    pk: b64uEncode(identity.pk),
    epk: b64uEncode(identity.epk),
    e: epoch,
    ts,
    n,
    c,
    sig: b64uEncode(sig),
  };
}

// --- Key wrapping (re-key delivery and welcomes) ---------------------------
//
// A fresh ephemeral ECDH keypair per wrap, agreed against the recipient's
// pinned agreement key. The recipient is named in the info string and in the
// AAD, so a wrap for one member cannot be replayed at another even by someone
// who can move bytes around the relay.

export async function generateEphemeral() {
  const kp = await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  return { privateKey: kp.privateKey, pub: new Uint8Array(await subtle.exportKey("raw", kp.publicKey)) };
}

async function wrapKeyFor(privateKey, peerEpkBytes, label) {
  const peer = await subtle.importKey("raw", peerEpkBytes, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await subtle.deriveBits({ name: "ECDH", public: peer }, privateKey, 256));
  const raw = await hkdf(shared, label, 32);
  shared.fill(0);
  const key = await subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
  raw.fill(0);
  return key;
}

const wrapLabel = (channelId, memberId) => `${PROTO}/wrap|${channelId}|${memberId}`;

// The wrap's associated data covers the recipient AND everything the message
// around it claims: who rotated, which generation, and which members were
// dropped.
//
// Binding only the recipient is not enough, and this was a live bug. The outer
// message is signed by whoever posted it, but the wrap is an opaque blob, so
// any member could lift another member's wrap, re-post it under their own
// signature with a different removal list, and be believed: the recipient
// would unwrap it fine, land on the correct new generation, and be told the
// wrong person had re-keyed and the wrong person had been removed. Nothing
// about the keys breaks, but the members screen is the trust surface of this
// app, and a member who can frame another member on it has broken something
// that matters. With `context` in the AAD the splice fails to decrypt.
const wrapAad = (channelId, memberId, context) =>
  te.encode(`${PROTO}/rekey|${channelId}|${memberId}|${context}`);

// Returns nonce || ciphertext.
export async function sealTo(ephPrivate, peerEpkBytes, channelId, memberId, plaintext, context = "") {
  const key = await wrapKeyFor(ephPrivate, peerEpkBytes, wrapLabel(channelId, memberId));
  const n = randomBytes(12);
  const ct = new Uint8Array(
    await subtle.encrypt(
      { name: "AES-GCM", iv: n, additionalData: wrapAad(channelId, memberId, context) },
      key,
      plaintext,
    ),
  );
  return concatBytes(n, ct);
}

export async function openSealed(identity, ephPubBytes, channelId, memberId, wrapped, context = "") {
  if (!(wrapped instanceof Uint8Array) || wrapped.length <= 12) return null;
  try {
    const key = await wrapKeyFor(identity.ecdhPrivate, ephPubBytes, wrapLabel(channelId, memberId));
    const pt = await subtle.decrypt(
      { name: "AES-GCM", iv: wrapped.subarray(0, 12), additionalData: wrapAad(channelId, memberId, context) },
      key,
      wrapped.subarray(12),
    );
    return new Uint8Array(pt);
  } catch {
    return null;
  }
}

// --- Invitations ------------------------------------------------------------
//
// A one-time credential that bootstraps a pairwise channel, not a bearer token
// carrying the circle's keys. A stolen link is worth something only in the
// window before the real joiner uses it, and only if a human accepts a safety
// number they were not expecting.

export const newInviteSecret = () => randomBytes(32);

export async function deriveInviteChannelId(secret) {
  return bytesToHex(await hkdf(secret, `${PROTO}/invite-channel`, 16));
}

export async function deriveInviteKey(secret) {
  const raw = await hkdf(secret, `${PROTO}/invite-enc`, 32);
  const key = await subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
  raw.fill(0);
  return key;
}

// The link commits to the inviter's identity. Without it the invitation is a
// bearer credential in the one direction that matters: the joiner learns the
// rendezvous channel from the link and has no way to tell the person who
// answers from anyone else who saw the link. Whoever wins the race owns the
// joining device, and the real inviter loses the race by design, because they
// have to be online and tap accept. Sixteen bytes of SHA-256 over both public
// keys is enough: forging a welcome now means finding a second preimage on a
// 128-bit commitment to a keypair, not being quick.
export async function inviterCommitment(pkBytes, epkBytes) {
  const label = te.encode(`${PROTO}/inviter`);
  return (await sha256(concatBytes(label, pkBytes, epkBytes))).slice(0, 16);
}

export function equalBytes(a, b) {
  if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array) || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export function inviteFragment(secret, commitment) {
  return `#j=${b64uEncode(secret)}.${b64uEncode(commitment)}`;
}

// Returns { secret, commit } or null. A fragment with no commitment is not a
// v2 invitation and is refused rather than treated as an unauthenticated one:
// accepting it would keep the whole attack alive for anyone who kept an old
// link, and there is nothing a joiner could safely do with it.
export function parseInviteFragment(hash) {
  const m = /^#j=([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{22})$/.exec(hash || "");
  if (!m) return null;
  try {
    const secret = b64uDecode(m[1]);
    const commit = b64uDecode(m[2]);
    if (secret.length !== 32 || commit.length !== 16) return null;
    return { secret, commit };
  } catch {
    return null;
  }
}

// --- Emergency beacon -------------------------------------------------------
//
// Each viewer gets an independent secret, so viewer channels are unlinkable to
// each other and revoking one leaves the others untouched. The link carries an
// expiry the viewer page enforces, and a commitment to the beacon's own
// signing identity so the viewer knows whose points to believe.

export async function deriveHelpChannelId(secret) {
  return bytesToHex(await hkdf(secret, `${PROTO}/help-channel-id`, 16));
}

// The usages are the caller's to name, and the default is decrypt only.
//
// A beacon secret is symmetric, so anyone holding the link can compute this
// key in their own code and seal whatever they like: the thing that actually
// stops a false position is the viewer refusing points that are not signed by
// the beacon's pinned identity, and that lives in helpview.js. What narrowing
// the usages buys is narrower: the viewer page itself, which runs on a device
// we do not control and parses attacker-reachable input, holds a CryptoKey
// that cannot encrypt at all. A bug in that page cannot be turned into a post.
export async function deriveHelpEncKey(secret, usages = ["decrypt"]) {
  const raw = await hkdf(secret, `${PROTO}/help-enc`, 32);
  const key = await subtle.importKey("raw", raw, { name: "AES-GCM" }, false, usages);
  raw.fill(0);
  return key;
}

// The link commits to the beacon's member id, which is itself a hash of the
// signing key and the agreement key. Without it a viewer has no notion of whose
// points these are and has to trust whoever writes first, which in an emergency
// is exactly the attacker: the link is a shared secret, so anyone who was
// forwarded it can seal a point that opens cleanly, and first sight is a race
// they can win. With it the viewer pins before it ever polls.
export function beaconFragment(secret, expiresAt, ownerId) {
  return `#b=${b64uEncode(secret)}.${Number(expiresAt) || 0}.${ownerId}`;
}

export function parseBeaconFragment(hash) {
  const m = /^#b=([A-Za-z0-9_-]{43})\.(\d{1,15})\.([0-9a-f]{32})$/.exec(hash || "");
  if (!m) return null;
  try {
    const secret = b64uDecode(m[1]);
    if (secret.length !== 32) return null;
    // No fallback for a link without the commitment. Accepting one would hand
    // an attacker the downgrade: strip the last field off a link they were
    // forwarded and the viewer is back to believing whoever posts first.
    return { secret, expiresAt: Number(m[2]), ownerId: m[3] };
  } catch {
    return null;
  }
}
