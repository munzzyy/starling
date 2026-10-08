// Argon2id for the app lock. The function itself is the Argon2 reference
// implementation, compiled to a WebAssembly module with no imports at all
// (tools/build-argon2.sh, pinned source commit and file hashes), so the code
// that stretches a passcode cannot reach the network, the clock, or anything
// outside its own memory. The bytes are hashed before they are compiled and
// have to match ARGON2_WASM_SHA256; a swapped file never runs. docs/ARGON2.md
// walks through rebuilding and checking it.

const WASM_URL = new URL("./argon2.wasm", import.meta.url);
export const ARGON2_WASM_SHA256 = "faf6ae0fae0fc3645131a1297a357cf1c50cea45f926285181f6960f514cf158";

// 64 MiB, three passes, one lane: the defaults KeePassXC and Bitwarden ship,
// above the OWASP floor of 19 MiB and two passes, about a second on a phone.
export const ARGON2_PARAMS = Object.freeze({ t: 3, m: 65536, p: 1 });

// What any parameters are held to before memory is asked for. The floors
// are Argon2's own (at least 8 blocks per lane); the ceilings keep a tampered
// record from making an unlock allocate gigabytes or spin for minutes.
export const ARGON2_LIMITS = Object.freeze({ t: [1, 16], m: [8, 262144], p: [1, 8] });

export class KdfUnavailableError extends Error {
  constructor(why) {
    super(`argon2 unavailable: ${why}`);
    this.name = "KdfUnavailableError";
  }
}

export function validParams(rec) {
  if (!rec) return false;
  for (const k of ["t", "m", "p"]) {
    const v = rec[k];
    const [lo, hi] = ARGON2_LIMITS[k];
    if (!Number.isInteger(v) || v < lo || v > hi) return false;
  }
  return rec.m >= 8 * rec.p;
}

const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

async function loadBytes() {
  if (WASM_URL.protocol === "file:") {
    const { readFile } = await import("node:fs/promises");
    return new Uint8Array(await readFile(WASM_URL));
  }
  const res = await fetch(WASM_URL);
  if (!res.ok) throw new KdfUnavailableError(`fetch ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

async function compileModule() {
  if (typeof WebAssembly !== "object") throw new KdfUnavailableError("no WebAssembly");
  const bytes = await loadBytes();
  const digest = hex(new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes)));
  if (digest !== ARGON2_WASM_SHA256) throw new KdfUnavailableError("wasm hash mismatch");
  const mod = await WebAssembly.compile(bytes);
  if (WebAssembly.Module.imports(mod).length !== 0) throw new KdfUnavailableError("wasm wants imports");
  return mod;
}

let modulePromise = null;

function getModule() {
  if (!modulePromise) {
    modulePromise = compileModule().catch((e) => {
      modulePromise = null;
      throw e instanceof KdfUnavailableError ? e : new KdfUnavailableError(String(e?.message || e));
    });
  }
  return modulePromise;
}

// Reference return codes that mean the host could not give the module its
// memory; anything else is a bug in the parameters, not a device limit.
const MEMORY_ERRORS = new Set([-22]);

// One instance per hash. WebAssembly memory never shrinks, so a fresh
// instance each time lets the 64 MiB go as soon as the hash is done.
export async function argon2id({ password, salt, secret = null, ad = null, t, m, p, outLen = 32 }) {
  if (!validParams({ t, m, p })) throw new RangeError("argon2 parameters out of range");
  if (!(password instanceof Uint8Array) || !(salt instanceof Uint8Array) || salt.length < 8) {
    throw new RangeError("argon2 needs byte inputs and an 8+ byte salt");
  }
  const mod = await getModule();
  let ex;
  try {
    ex = (await WebAssembly.instantiate(mod)).exports;
  } catch (e) {
    throw new KdfUnavailableError(`instantiate: ${String(e?.message || e)}`);
  }
  const put = (bytes) => {
    if (!bytes || bytes.length === 0) return 0;
    const ptr = ex.alloc(bytes.length);
    if (!ptr) throw new KdfUnavailableError("out of memory");
    new Uint8Array(ex.memory.buffer, ptr, bytes.length).set(bytes);
    return ptr;
  };
  try {
    const pwdPtr = put(password);
    const saltPtr = put(salt);
    const secretPtr = put(secret);
    const adPtr = put(ad);
    const outPtr = ex.alloc(outLen);
    if (!outPtr) throw new KdfUnavailableError("out of memory");
    const rc = ex.argon2id(
      t, m, p,
      pwdPtr, password.length,
      saltPtr, salt.length,
      secretPtr, secret ? secret.length : 0,
      adPtr, ad ? ad.length : 0,
      outPtr, outLen,
    );
    if (rc !== 0) {
      if (MEMORY_ERRORS.has(rc)) throw new KdfUnavailableError(`memory (${rc})`);
      throw new Error(`argon2 failed: ${rc}`);
    }
    return Uint8Array.from(new Uint8Array(ex.memory.buffer, outPtr, outLen));
  } finally {
    ex.reset();
  }
}
