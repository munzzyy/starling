// App lock: encrypt the circle secret at rest so a stolen or dumped device
// cannot read it without the passcode or a biometric unlock. The plaintext
// secret exists only in memory after a successful unlock; on lock it is dropped
// and only encrypted blobs remain on disk.
//
// Wrapped-vault-key model (the pattern password managers use):
//   K            a random 32-byte vault key, made when lock is first enabled
//   vaultSecret  the circle secret, AES-GCM encrypted under K
//   passcode  -> PBKDF2-SHA-256 -> AES-GCM key that wraps K
//   biometric -> WebAuthn PRF secret -> HKDF -> AES-GCM key that wraps K
// Both unlock paths recover the same K, so changing the passcode or adding a
// biometric only re-wraps K, and rotating the circle only re-encrypts
// vaultSecret under the K already in memory. No path stores K or the secret in
// the clear. Wrong passcode or a failed assertion fails AES-GCM authentication
// and returns null: the GCM tag is the verifier, so there is nothing separate
// to brute force offline beyond the KDF itself.

const subtle = globalThis.crypto.subtle;
const te = new TextEncoder();

// OWASP Password Storage Cheat Sheet (2024) floor for PBKDF2-HMAC-SHA256.
export const PBKDF2_ITERS = 600000;
// Fixed PRF input. The per-credential PRF output is the entropy; this label
// only namespaces it and must stay stable across versions.
export const PRF_SALT = te.encode("starling/v1/prf");

export function randomBytes(n) {
  const b = new Uint8Array(n);
  globalThis.crypto.getRandomValues(b);
  return b;
}

export const newVaultKey = () => randomBytes(32);

// Best-effort scrub of a byte buffer we are done with. WebCrypto gives no
// guaranteed zeroing; this at least clears the copies we hold.
export function zero(bytes) {
  if (bytes && bytes.fill) bytes.fill(0);
}

async function aesKey(raw, usages) {
  return subtle.importKey("raw", raw, { name: "AES-GCM" }, false, usages);
}

async function wrap(wrapKey, plainBytes) {
  const nonce = randomBytes(12);
  const ct = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv: nonce }, wrapKey, plainBytes));
  return { nonce, ct };
}

async function unwrap(wrapKey, nonce, ct) {
  try {
    const pt = await subtle.decrypt({ name: "AES-GCM", iv: nonce }, wrapKey, ct);
    return new Uint8Array(pt);
  } catch {
    return null;
  }
}

// -------------------------------------------------- secret sealed under vault K

export async function sealUnderVault(vaultKeyBytes, secretBytes) {
  const k = await aesKey(vaultKeyBytes, ["encrypt"]);
  const { nonce, ct } = await wrap(k, secretBytes);
  return { v: 1, nonce, ct };
}

export async function openUnderVault(vaultKeyBytes, record) {
  if (!record || !record.nonce || !record.ct) return null;
  const k = await aesKey(vaultKeyBytes, ["decrypt"]);
  return unwrap(k, record.nonce, record.ct);
}

// ------------------------------------------------------------- passcode wrapper

async function pbkdf2WrapKey(passcode, salt, iters) {
  const base = await subtle.importKey("raw", te.encode(passcode), "PBKDF2", false, ["deriveKey"]);
  return subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: iters },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

// Wrap the vault key K with a passcode. Returns the on-disk passcode record.
export async function makePasscodeRecord(passcode, vaultKeyBytes, iters = PBKDF2_ITERS) {
  const salt = randomBytes(16);
  const wrapKey = await pbkdf2WrapKey(passcode, salt, iters);
  const { nonce, ct } = await wrap(wrapKey, vaultKeyBytes);
  return { v: 1, kdf: "pbkdf2-sha256", iters, salt, nonce, ct };
}

// Returns the unwrapped vault key K, or null on a wrong passcode.
export async function openPasscodeRecord(record, passcode) {
  if (!record || record.kdf !== "pbkdf2-sha256") return null;
  const wrapKey = await pbkdf2WrapKey(passcode, record.salt, record.iters);
  return unwrap(wrapKey, record.nonce, record.ct);
}

// ------------------------------------------------------------ biometric wrapper
// WebAuthn PRF: a platform authenticator (Face ID / Touch ID / fingerprint /
// Windows Hello) mints a stable per-credential secret gated behind the user's
// biometric. That secret (HKDF-stretched) wraps a copy of K. This is real
// cryptography, not a presence check: with no PRF output there is no wrap key,
// so we only ever offer biometrics when PRF actually produces bytes.

const rpId = () => location.hostname;

export function webauthnAvailable() {
  return !!(globalThis.PublicKeyCredential && globalThis.navigator?.credentials?.create);
}

export async function platformAuthenticatorAvailable() {
  if (!webauthnAvailable()) return false;
  try {
    return await globalThis.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch {
    return false;
  }
}

async function evalPrf(credentialId) {
  const assertion = await navigator.credentials.get({
    publicKey: {
      challenge: randomBytes(32),
      rpId: rpId(),
      userVerification: "required",
      allowCredentials: [{ type: "public-key", id: credentialId }],
      extensions: { prf: { eval: { first: PRF_SALT } } },
      timeout: 60000,
    },
  });
  const res = assertion?.getClientExtensionResults?.().prf?.results?.first;
  return res ? new Uint8Array(res) : null;
}

async function prfWrapKey(prfSecret) {
  const base = await subtle.importKey("raw", prfSecret, "HKDF", false, ["deriveKey"]);
  return subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: te.encode("starling/v1/bio-wrap") },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

// Enroll a biometric: create a discoverable platform credential, mint its PRF
// output, and wrap K with it. Returns the on-disk bio record, or null if the
// device or browser does not actually produce PRF output (honest fallback).
export async function makeBioRecord(vaultKeyBytes) {
  if (!webauthnAvailable()) return null;
  let cred;
  try {
    cred = await navigator.credentials.create({
      publicKey: {
        challenge: randomBytes(32),
        rp: { name: "Starling", id: rpId() },
        user: { id: randomBytes(16), name: "starling", displayName: "Starling" },
        pubKeyCredParams: [
          { type: "public-key", alg: -7 },
          { type: "public-key", alg: -257 },
        ],
        authenticatorSelection: {
          authenticatorAttachment: "platform",
          residentKey: "required",
          userVerification: "required",
        },
        extensions: { prf: {} },
        timeout: 60000,
      },
    });
  } catch {
    return null;
  }
  if (!cred) return null;
  const credentialId = new Uint8Array(cred.rawId);
  // PRF-on-create is unreliable across authenticators; a follow-up get() is the
  // dependable way to actually obtain the bytes.
  let prfSecret;
  try {
    prfSecret = await evalPrf(credentialId);
  } catch {
    return null;
  }
  if (!prfSecret) return null;
  const wrapKey = await prfWrapKey(prfSecret);
  zero(prfSecret);
  const { nonce, ct } = await wrap(wrapKey, vaultKeyBytes);
  return { v: 1, credentialId, nonce, ct };
}

// Unlock with biometrics: returns the vault key K, or null on failure.
export async function openBioRecord(record) {
  if (!record || !record.credentialId) return null;
  let prfSecret;
  try {
    prfSecret = await evalPrf(record.credentialId);
  } catch {
    return null;
  }
  if (!prfSecret) return null;
  const wrapKey = await prfWrapKey(prfSecret);
  zero(prfSecret);
  return unwrap(wrapKey, record.nonce, record.ct);
}
