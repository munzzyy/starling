#!/usr/bin/env node
// Writes test/vectors/*.json: the machine-readable form of protocol v2 that an
// independent implementation can check itself against without trusting this
// codebase, and that test/vectors.test.mjs replays on every `npm test`.
//
// Everything here is a function of the fixed inputs declared at the top of each
// file. Where the protocol draws random bytes the generator supplies them
// instead: the signing and agreement keys are frozen pkcs8 blobs, the seeds and
// re-key entropy are written out in hex, and getRandomValues is replaced for
// the whole run by a counter stream so the nonces come out the same every time.
// Every file names the substitution it relies on, because a vector whose inputs
// are secret is not a vector.
//
// The frozen keys below exist only in this file and the vectors it writes.
// They are not, and must never become, anything a person uses.
//
// Run: node tools/gen-vectors.mjs

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, "..", "test", "vectors");

// ---------------------------------------------------------------- fixed input

const RANDOM_STREAM = "starling/vectors/v2";

// Deterministic stand-in for the CSPRNG. Byte i comes from
// SHA-256(RANDOM_STREAM || ":" || block) so a run is reproducible and the
// stream is describable in one line inside the vector files.
function fixedRandomBytes() {
  let block = 0;
  let buf = Buffer.alloc(0);
  let at = 0;
  return (arr) => {
    const view = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
    for (let i = 0; i < view.length; i++) {
      if (at >= buf.length) {
        buf = createHash("sha256").update(`${RANDOM_STREAM}:${block++}`).digest();
        at = 0;
      }
      view[i] = buf[at++];
    }
    return arr;
  };
}

const realRandom = globalThis.crypto.getRandomValues.bind(globalThis.crypto);
globalThis.crypto.getRandomValues = fixedRandomBytes();

const {
  PROTO,
  PAD_LEN,
  b64uEncode,
  b64uDecode,
  bytesToHex,
  aadFor,
  sigBase,
  memberIdFromKeys,
  safetyNumber,
  rosterHash,
} = await import("../app/js/wire.js");
const { EPOCH_MS, deriveAnchor, chainInit, chainStep, channelFromAnchor } =
  await import("../app/js/ratchet.js");
const { sealMessage, buildPost, sealTo, deriveInviteChannelId, deriveInviteKey, inviterCommitment, inviteFragment } =
  await import("../app/js/crypto.js");
const { openGeneration, rekeyContext } = await import("../app/js/rekey.js");
const { welcomeContext } = await import("../app/js/membership.js");

const subtle = globalThis.crypto.subtle;
const te = new TextEncoder();

// Frozen keypairs. Generated once, written down here, and used for nothing else
// ever. Ed25519 signatures are deterministic (RFC 8032 §5.1.6) and ECDH is a
// function of its inputs, so every signature and every wrap below reproduces
// byte for byte. ECDSA P-256 is not deterministic, which is why the recorded
// session signs with Ed25519 throughout.
const KEYS = {
  A: {
    sk: "MC4CAQAwBQYDK2VwBCIEIFTG9yC3uHs0GcSYz-Bd-uUfzLDJ-jfsUFJrxXpTslUU",
    pk: "36PB0K4lVKaN2b-Y5enOb3leZmkKm3gPAPs5mY-ROCU",
    ecdhSk:
      "MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQg09_ycQehVMRJblO_2Io5GUF-TtzQk9xqakW9wY7KYC-hRANCAAQn9XGgpcnXc1t3i-zxwC5hpekTOxf-c9JRXHlCZdFY8HLxUZJtOnsEbwZQgRbJMc_AJbXfeRFaPKsWcRxHntzZ",
    epk: "BCf1caClyddzW3eL7PHALmGl6RM7F_5z0lFceUJl0VjwcvFRkm06ewRvBlCBFskxz8Altd95EVo8qxZxHEee3Nk",
  },
  B: {
    sk: "MC4CAQAwBQYDK2VwBCIEIJrvb8mzp_oDNrS8w21mlMyibtjUJVmMGui1pvnZoXaY",
    pk: "EoYKAK83wkv2TQQccrgxBBKnFPzKQv4N2MfXBOA7Jhc",
    ecdhSk:
      "MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgME_l18LUcwrkrcvLRibj_AsjQv68fOt_rU0jCznLdpehRANCAASuuJtXQqTwr703JGsjX3deKsCnF6Elt7Q-hEDJdiDiW8AaZkuf0ArPSzdikzr6_Pfc0MWYCznpI_smhEOt8RMC",
    epk: "BK64m1dCpPCvvTckayNfd14qwKcXoSW3tD6EQMl2IOJbwBpmS5_QCs9LN2KTOvr899zQxZgLOekj-yaEQ63xEwI",
  },
  C: {
    sk: "MC4CAQAwBQYDK2VwBCIEINiw473oGD-HwTm899oJPsQHlpJJuuNQEpgo-wsR9TgR",
    pk: "JAeo4Vy4e1oAicfyJtu2sFnSeIFmuq6AP0U3C9O0MZk",
    ecdhSk:
      "MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgixzMTYy8CWT_UMeqsede_AIh8C0zejRahM5H4pR1CgyhRANCAAS5THdMBaF0cPLNEQPOeA1S3qAz27Xe3v9q4N0y1EPYnt6sxdwgBC_2M99mReI947B0Ai2olUNarIhPbxk6y8I1",
    epk: "BLlMd0wFoXRw8s0RA854DVLeoDPbtd7e_2rg3TLUQ9ie3qzF3CAEL_Yz32ZF4j3jsHQCLaiVQ1qsiE9vGTrLwjU",
  },
};

// Ephemeral ECDH keypairs for the wraps in the recorded session. A real re-key
// mints one per recipient; these are frozen so the wrapped bytes reproduce.
const EPH = {
  eph1: {
    sk: "MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgYICBaUBoBIiF13BKjlE7gHABZdBp0rp-zPzfAK4vgxehRANCAAR3UxYPcrdIPny25goPqiZpXvazfr6KaQctPg_OP6-mJnl11hAKiRVshPmoW4jI9UvPyBs0hoHSh5CVC7CT0sAm",
    pub: "BHdTFg9yt0g-fLbmCg-qJmle9rN-voppBy0-D84_r6YmeXXWEAqJFWyE-ahbiMj1S8_IGzSGgdKHkJULsJPSwCY",
  },
  eph2: {
    sk: "MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQghs-8Ea1taPFalXT_9ostyuJSIpn41jbNDfSgNNsq9p-hRANCAAQ2YTBGX0xSLf8_FkRVSRXxitfyt9dynRrT8fTD0iWnsQPdQBLY9l8vL2QN1I08_yrSUw_iLXAf4u0ZxprK01eH",
    pub: "BDZhMEZfTFIt_z8WRFVJFfGK1_K313KdGtPx9MPSJaexA91AEtj2Xy8vZA3UjTz_KtJTD-ItcB_i7RnGmsrTV4c",
  },
  eph3: {
    sk: "MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgnZ0Fn1De48o5Ijj_bY6vy3mXUyi-Zk_gBY0K5X8PUcWhRANCAAQTki-gmCnXdYJi0PDqEmZ0hEVylTG7mL38Qb4ReYfrVLVzWZJ74b-clqDxd0oIFJP8E6-IZknSRUfkV5HuDaAc",
    pub: "BBOSL6CYKdd1gmLQ8OoSZnSERXKVMbuYvfxBvhF5h-tUtXNZknvhv5yWoPF3SggUk_wTr4hmSdJFR-RXke4NoBw",
  },
};

const bytes = (fn) => Uint8Array.from({ length: 32 }, (_, i) => fn(i) & 0xff);
const SEED0 = bytes((i) => i);
const NS1 = bytes((i) => i * 11 + 5);
const NS2 = bytes((i) => i * 13 + 7);
const INVITE_SECRET = bytes((i) => i * 3 + 1);
const HELP_SECRET = bytes((i) => i * 5 + 9);
const FIXED_CK = bytes((i) => i * 7 + 3);
const FIXED_Z = bytes((i) => 255 - i);

const E0 = 2980471; // floor(1788282600000 / EPOCH_MS)
const T0 = E0 * EPOCH_MS; // 1788282600000

const CHANNEL_FIXED = "00112233445566778899aabbccddeeff";
const MEMBER_FIXED = "ffeeddccbbaa99887766554433221100";

const hex = (b) => bytesToHex(b);
const hexToBytes = (s) => Uint8Array.from(s.match(/../g) ?? [], (h) => parseInt(h, 16));

function write(name, obj) {
  const file = path.join(OUT, name);
  fs.writeFileSync(file, `${JSON.stringify(obj, null, 2)}\n`);
  console.log(`wrote ${path.relative(path.join(HERE, ".."), file)}`);
}

// ------------------------------------------------------------------ hkdf.json
//
// Every info string the protocol derives under, each with an input and the
// exact bytes that come out. HKDF-SHA-256, salt = 32 zero bytes, always.

async function hkdfRaw(ikm, info, len) {
  const key = await subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  const bits = await subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(32), info: te.encode(info) },
    key,
    len * 8,
  );
  return new Uint8Array(bits);
}

async function hkdfVectors() {
  const anchor = await deriveAnchor(new Uint8Array(SEED0));
  const wrapInfo = `${PROTO}/wrap|${CHANNEL_FIXED}|${MEMBER_FIXED}`;
  const msgInfo = `${PROTO}/msg|${MEMBER_FIXED}`;
  const mixed = new Uint8Array(64);
  mixed.set(FIXED_CK, 0);
  mixed.set(NS1, 32);

  const specs = [
    { info: `${PROTO}/anchor`, ikm: SEED0, len: 32, use: "names a generation's relay channel" },
    { info: `${PROTO}/channel-id`, ikm: anchor, len: 16, use: "the channel id, rendered as hex", hexOut: true },
    { info: `${PROTO}/chain`, ikm: SEED0, len: 32, use: "CK_0, the generation's first chain key" },
    { info: `${PROTO}/step`, ikm: FIXED_CK, len: 32, use: "CK_e -> CK_{e+1}" },
    { info: msgInfo, ikm: FIXED_CK, len: 32, use: "AES-256-GCM content key for one (epoch, member)" },
    { info: `${PROTO}/rekey`, ikm: mixed, len: 32, use: "next generation's seed, from CK_e || NS" },
    { info: wrapInfo, ikm: FIXED_Z, len: 32, use: "AES-256-GCM key wrapping NS to one member" },
    { info: `${PROTO}/invite-channel`, ikm: INVITE_SECRET, len: 16, use: "invite rendezvous channel", hexOut: true },
    { info: `${PROTO}/invite-enc`, ikm: INVITE_SECRET, len: 32, use: "seals the invite handshake" },
    { info: `${PROTO}/help-channel-id`, ikm: HELP_SECRET, len: 16, use: "one beacon viewer's channel", hexOut: true },
    { info: `${PROTO}/help-enc`, ikm: HELP_SECRET, len: 32, use: "seals beacon positions to one viewer" },
  ];

  const cases = [];
  for (const s of specs) {
    const okm = await hkdfRaw(s.ikm, s.info, s.len);
    cases.push({
      info: s.info,
      use: s.use,
      ikm: hex(s.ikm),
      len: s.len,
      okm: hex(okm),
      ...(s.hexOut ? { rendered: hex(okm) } : {}),
    });
  }

  write("hkdf.json", {
    note:
      "Every HKDF info string in protocol v2, with a fixed input and the exact output. " +
      "HKDF-SHA-256 throughout; the salt is always 32 zero bytes and the info string always " +
      "begins with the protocol prefix. All byte strings are hex.",
    hash: "SHA-256",
    salt: hex(new Uint8Array(32)),
    proto: PROTO,
    fixed: {
      channel: CHANNEL_FIXED,
      member: MEMBER_FIXED,
      note: "the channel and member ids above appear inside two of the info strings",
    },
    cases,
  });
}

// ----------------------------------------------------------------- chain.json
//
// The forward ratchet: a fixed seed, its anchor and channel, CK_0..CK_5, and a
// long jump. The jump is the one an implementation is most likely to get wrong,
// because it is the only place the chain is walked more than a step at a time.

async function chainVectors() {
  const seed = new Uint8Array(SEED0);
  const anchor = await deriveAnchor(new Uint8Array(seed));
  const channel = await channelFromAnchor(anchor);
  let ck = await chainInit(new Uint8Array(seed));

  const steps = [{ e: E0, i: 0, ck: hex(ck) }];
  for (let i = 1; i <= 5; i++) {
    ck = await chainStep(ck);
    steps.push({ e: E0 + i, i, ck: hex(ck) });
  }
  let far = await chainInit(new Uint8Array(seed));
  for (let i = 1; i <= 1000; i++) far = await chainStep(far);

  write("chain.json", {
    note:
      "One generation's chain from a fixed seed. CK_0 = HKDF(seed, chain); " +
      "CK_{i+1} = HKDF(CK_i, step). The chain runs one way only: holding CK_{i+1} " +
      "says nothing about CK_i, which is the whole of the forward secrecy claim. " +
      "e is the absolute epoch index (floor(unixMillis / 600000)); e0 is where this " +
      "generation began, and i is the number of steps from CK_0.",
    seed: hex(seed),
    e0: E0,
    epochMs: EPOCH_MS,
    anchor: hex(anchor),
    channel,
    steps,
    jump: {
      note: "CK_1000 reached by 1000 single steps, the same value a catch-up must land on",
      e: E0 + 1000,
      i: 1000,
      ck: hex(far),
    },
  });
}

// ------------------------------------------------------------------ keys.json
//
// (epoch, member) to the exact AES-GCM key bytes, the nonce layout, and one
// full seal under a nonce whose random guard is zeroed so the ciphertext is
// reproducible.

async function keyVectors() {
  const seed = new Uint8Array(SEED0);
  let ck = await chainInit(new Uint8Array(seed));
  const chain = new Map([[E0, new Uint8Array(ck)]]);
  for (let i = 1; i <= 3; i++) {
    ck = await chainStep(ck);
    chain.set(E0 + i, new Uint8Array(ck));
  }

  const members = [];
  for (const label of ["A", "B", "C"]) {
    const pk = b64uDecode(KEYS[label].pk);
    const epk = b64uDecode(KEYS[label].epk);
    members.push({ label, memberId: await memberIdFromKeys(pk, epk) });
  }

  const entries = [];
  for (const [e, ckAt] of [...chain].sort((a, b) => a[0] - b[0])) {
    for (const m of members) {
      entries.push({
        e,
        member: m.memberId,
        memberLabel: m.label,
        ck: hex(ckAt),
        key: hex(await hkdfRaw(ckAt, `${PROTO}/msg|${m.memberId}`, 32)),
      });
    }
  }

  // The nonce, spelled out. 4 bytes of random guard then ts as a 64-bit big
  // endian counter; the guard is zeroed here so the layout is checkable.
  const ts = T0 + 59_714;
  const nonce = new Uint8Array(12);
  new DataView(nonce.buffer).setBigUint64(4, BigInt(ts), false);

  const plaintext = {
    v: 2,
    ts,
    t: "loc",
    lat: 44.98,
    lon: -93.27,
    acc: 12,
    name: "Ana",
    emoji: "\u{1F98A}",
    hue: 210,
    bat: 0.62,
    mode: "precise",
  };
  const json = JSON.stringify(plaintext);
  const padded = json + " ".repeat(PAD_LEN - te.encode(json).length);
  const sealEpoch = E0 + 1;
  const sealMember = members[0].memberId;
  const keyBytes = await hkdfRaw(chain.get(sealEpoch), `${PROTO}/msg|${sealMember}`, 32);
  const key = await subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
  const aad = aadFor(CHANNEL_FIXED, sealMember, sealEpoch, ts);
  const ct = new Uint8Array(
    await subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: aad }, key, te.encode(padded)),
  );

  write("keys.json", {
    note:
      "Content keys are per (epoch, sender): MK(e, m) = HKDF(CK_e, 'msg|' + m). No two " +
      "members ever encrypt under the same key, so a nonce collision between senders is " +
      "impossible rather than unlikely.",
    seed: hex(seed),
    e0: E0,
    entries,
    nonce: {
      note:
        "12 bytes: 4 bytes of random reuse guard, then ts as a 64-bit big-endian integer. " +
        "The guard is fixed to zero here so the layout is checkable; a real client draws it " +
        "from the CSPRNG on every message.",
      ts,
      guard: "00000000",
      nonce: hex(nonce),
    },
    seal: {
      note:
        "One full AES-256-GCM seal under the nonce above. The plaintext is JSON padded to " +
        "exactly PAD_LEN with trailing spaces, which JSON.parse ignores, so every message " +
        "type is the same size on the wire.",
      channel: CHANNEL_FIXED,
      member: sealMember,
      e: sealEpoch,
      ts,
      key: hex(keyBytes),
      nonce: hex(nonce),
      aad: new TextDecoder().decode(aad),
      padLen: PAD_LEN,
      plaintext,
      paddedLen: te.encode(padded).length,
      ciphertext: b64uEncode(ct),
    },
  });
}

// --------------------------------------------------------------- strings.json

function stringVectors() {
  const channel = CHANNEL_FIXED;
  const member = MEMBER_FIXED;
  const e = E0 + 1;
  const ts = T0 + 59_714;
  const n = "AAAAAAAADm7-4zY";
  const c = "Q2lwaGVydGV4dEJ5dGVz";
  const aad = aadFor(channel, member, e, ts);

  write("strings.json", {
    note:
      "The two byte strings a receiver has to reproduce exactly. Both bind the epoch, so a " +
      "point cannot be replayed into another epoch any more than into another channel or " +
      "another member's slot. aad is the AEAD associated data; sigBase is what the sender " +
      "signs. Both are UTF-8, no trailing newline.",
    message: { channel, member, e, ts, n, c },
    aad: {
      string: new TextDecoder().decode(aad),
      hex: hex(aad),
      len: aad.length,
    },
    sigBase: {
      string: sigBase(channel, member, e, ts, n, c),
      hex: hex(te.encode(sigBase(channel, member, e, ts, n, c))),
    },
  });
}

// -------------------------------------------------------------- identity.json

async function identityVectors() {
  const cases = [];
  for (const label of ["A", "B", "C"]) {
    const pk = b64uDecode(KEYS[label].pk);
    const epk = b64uDecode(KEYS[label].epk);
    cases.push({
      label,
      alg: "ed25519",
      pk: KEYS[label].pk,
      epk: KEYS[label].epk,
      memberId: await memberIdFromKeys(pk, epk),
      safetyNumber: await safetyNumber(pk, epk),
    });
  }
  // Degenerate byte patterns: not keys anyone could hold, but they pin the
  // concatenation order and the truncation, which is where an independent
  // implementation goes wrong.
  const patterns = [
    { label: "zeros", pk: new Uint8Array(32), epk: new Uint8Array(65) },
    { label: "ones", pk: new Uint8Array(32).fill(0xff), epk: new Uint8Array(65).fill(0xff) },
    { label: "p256-signing-key", pk: bytes((i) => i * 9 + 1), epk: Uint8Array.from({ length: 65 }, (_, i) => (i * 5 + 2) & 0xff) },
  ];
  for (const p of patterns) {
    cases.push({
      label: p.label,
      alg: p.pk.length === 65 ? "p256" : "ed25519",
      pk: b64uEncode(p.pk),
      epk: b64uEncode(p.epk),
      memberId: await memberIdFromKeys(p.pk, p.epk),
      safetyNumber: await safetyNumber(p.pk, p.epk),
    });
  }
  // The p256 case above still carries a 32-byte pk; give a real 65-byte one so
  // the length is exercised too.
  const p256pk = Uint8Array.from({ length: 65 }, (_, i) => (i * 3 + 4) & 0xff);
  const p256epk = Uint8Array.from({ length: 65 }, (_, i) => (i * 7 + 11) & 0xff);
  cases.push({
    label: "p256-65-byte-pk",
    alg: "p256",
    pk: b64uEncode(p256pk),
    epk: b64uEncode(p256epk),
    memberId: await memberIdFromKeys(p256pk, p256epk),
    safetyNumber: await safetyNumber(p256pk, p256epk),
  });

  write("identity.json", {
    note:
      "member_id = first 32 hex chars (128 bits) of SHA-256('starling/v2/member' || pk || epk). " +
      "The safety number is the first 30 decimal digits of SHA-256('starling/v2/fp' || pk || epk), " +
      "taken three digest bytes at a time as a 24-bit integer mod 100000, in six groups of five. " +
      "Both commit to BOTH public keys, so pinning an id pins the signing key and the agreement " +
      "key together.",
    memberLabel: `${PROTO}/member`,
    fpLabel: `${PROTO}/fp`,
    idBits: 128,
    cases,
  });
}

// --------------------------------------------------------------- session.json
//
// One circle, recorded end to end: two members, a third joining, a re-key, a
// removal, a late point that must still open, and a replay that must not.

async function member(label) {
  const k = KEYS[label];
  const pk = b64uDecode(k.pk);
  const epk = b64uDecode(k.epk);
  return {
    label,
    alg: "ed25519",
    privateKey: await subtle.importKey("pkcs8", b64uDecode(k.sk), { name: "Ed25519" }, false, ["sign"]),
    ecdhPrivate: await subtle.importKey(
      "pkcs8",
      b64uDecode(k.ecdhSk),
      { name: "ECDH", namedCurve: "P-256" },
      false,
      ["deriveBits"],
    ),
    pk,
    epk,
    memberId: await memberIdFromKeys(pk, epk),
  };
}

// A generation record, with the seed kept in hex before openGeneration eats it.
async function generation(seed, g, e0) {
  const seedHex = hex(seed);
  const anchor = await deriveAnchor(new Uint8Array(seed));
  const ck0 = await chainInit(new Uint8Array(seed));
  const gen = await openGeneration({ seed: new Uint8Array(seed), g, e0, historyEpochs: 6 });
  return { gen, seedHex, anchorHex: hex(anchor), ck0Hex: hex(ck0) };
}

async function postFrom(id, gen, e, ts, obj) {
  const key = await gen.ratchet.keyFor(e, id.memberId, e * EPOCH_MS);
  if (!key) throw new Error(`no key for epoch ${e}`);
  const sealed = await sealMessage(key, gen.channelId, id.memberId, e, ts, obj);
  const body = await buildPost(id, gen.channelId, e, sealed, ts);
  return { body, plaintext: obj };
}

async function sessionVectors() {
  const A = await member("A");
  const B = await member("B");
  const C = await member("C");
  const steps = [];
  const generations = [];

  // --- generation 0: A and B, already together.
  const g0 = await generation(new Uint8Array(SEED0), 0, E0);
  generations.push({
    g: 0,
    e0: E0,
    seed: g0.seedHex,
    anchor: g0.anchorHex,
    channel: g0.gen.channelId,
    ck0: g0.ck0Hex,
    roster: [A.memberId, B.memberId],
    rosterHash: await rosterHash([A.memberId, B.memberId]),
  });

  const loc = (ts, extra) => ({ v: 2, ts, t: "loc", lat: 44.98, lon: -93.27, acc: 12, ...extra });

  const p1 = await postFrom(A, g0.gen, E0, T0 + 1_000, loc(T0 + 1_000, { name: "Ana" }));
  steps.push({
    kind: "post",
    note: "an ordinary signed location post in the generation's first epoch",
    g: 0,
    channel: g0.gen.channelId,
    by: "A",
    e: E0,
    ts: T0 + 1_000,
    plaintext: p1.plaintext,
    post: p1.body,
    expect: "accept",
  });

  const p2 = await postFrom(B, g0.gen, E0 + 1, T0 + EPOCH_MS + 2_000, loc(T0 + EPOCH_MS + 2_000, { name: "Bo" }));
  steps.push({
    kind: "post",
    note: "a second member, one epoch later, under a different content key",
    g: 0,
    channel: g0.gen.channelId,
    by: "B",
    e: E0 + 1,
    ts: T0 + EPOCH_MS + 2_000,
    plaintext: p2.plaintext,
    post: p2.body,
    expect: "accept",
  });

  steps.push({
    kind: "replay",
    note:
      "the exact bytes of the first post, delivered a second time. The signature still " +
      "verifies and the ciphertext still opens, which is the point: replay is not caught " +
      "by the cryptography, it is caught by the receiver's per-member (e, ts) high-water " +
      "mark. A location replay puts someone where they no longer are.",
    of: 0,
    g: 0,
    channel: g0.gen.channelId,
    post: p1.body,
    expect: "reject",
    reason: "replay",
  });

  // --- the invitation C uses to ask its way in.
  const inviteChannel = await deriveInviteChannelId(new Uint8Array(INVITE_SECRET));
  const inviteKeyBytes = await hkdfRaw(INVITE_SECRET, `${PROTO}/invite-enc`, 32);
  const inviteKey = await deriveInviteKey(new Uint8Array(INVITE_SECRET));
  const joinTs = T0 + EPOCH_MS + 3_000;
  const joinObj = {
    v: 2,
    ts: joinTs,
    t: "join",
    pk: b64uEncode(C.pk),
    epk: b64uEncode(C.epk),
    name: "Cass",
  };
  const joinSealed = await sealMessage(inviteKey, inviteChannel, C.memberId, E0 + 1, joinTs, joinObj);
  const joinPost = await buildPost(C, inviteChannel, E0 + 1, joinSealed, joinTs);
  steps.push({
    kind: "join-request",
    note:
      "C asks to be let in on the invite channel, sealed under the invite key and signed by " +
      "the keypair it has just generated. Nothing happens until a human on the other side " +
      "accepts C's safety number.",
    channel: inviteChannel,
    by: "C",
    e: E0 + 1,
    ts: joinTs,
    plaintext: joinObj,
    post: joinPost,
    safetyNumber: await safetyNumber(C.pk, C.epk),
    expect: "accept",
  });

  // --- admitting C is a re-key: generation 1, on a new channel.
  const mix1 = E0 + 1;
  await g0.gen.ratchet.advanceTo(mix1);
  const ck1AtMix = await (async () => {
    let ck = await chainInit(new Uint8Array(SEED0));
    for (let i = E0; i < mix1; i++) ck = await chainStep(ck);
    return ck;
  })();
  const seed1 = await g0.gen.ratchet.nextSeed(new Uint8Array(NS1), mix1);
  const seed1Hex = hex(seed1);
  const roster1 = [A.memberId, B.memberId, C.memberId];
  const rh1 = await rosterHash(roster1);

  // Bound into every wrap's AAD below: what A claims about this re-key. A
  // recipient rebuilds this same string from the message it received and the
  // wrap only opens if the rebuild matches, which is what stops another
  // member from lifting a wrap and reposting it under a different rotator or
  // a different removal list.
  const rekey1Context = rekeyContext({ by: A.memberId, g: 1, e0: mix1, me: mix1, rh: rh1, rm: [] });

  const wraps1 = [];
  for (const [ephLabel, to] of [
    ["eph1", B],
    ["eph2", C],
  ]) {
    const ephSk = await subtle.importKey(
      "pkcs8",
      b64uDecode(EPH[ephLabel].sk),
      { name: "ECDH", namedCurve: "P-256" },
      false,
      ["deriveBits"],
    );
    const w = await sealTo(ephSk, to.epk, g0.gen.channelId, to.memberId, new Uint8Array(NS1), rekey1Context);
    const body = {
      v: 2,
      ts: 0,
      t: "rekey",
      g: 1,
      e0: mix1,
      me: mix1,
      to: to.memberId,
      eph: EPH[ephLabel].pub,
      w: b64uEncode(w),
      rm: [],
      rh: rh1,
    };
    wraps1.push({ ephLabel, to, body });
  }

  const rekeyPosts1 = [];
  let rekeyTs = T0 + EPOCH_MS + 4_000;
  for (const { ephLabel, to, body } of wraps1) {
    const obj = { ...body, ts: rekeyTs };
    const p = await postFrom(A, g0.gen, mix1, rekeyTs, obj);
    rekeyPosts1.push({ ephLabel, to: to.label, post: p.body, plaintext: obj });
    rekeyTs += 1;
  }

  steps.push({
    kind: "rekey",
    note:
      "A admits C by ending generation 0 and starting generation 1. NS is fresh entropy " +
      "wrapped to each retained member over an ephemeral ECDH; seed_1 = HKDF(CK_e || NS, " +
      "'rekey'). Mixing CK_e in stops a relay forging a generation; mixing NS in stops " +
      "anyone holding only CK_e from computing the next one. C gets a wrap too but cannot " +
      "use it: C has no chain key, so the seed reaches C in the welcome instead. Each wrap's " +
      "AAD also binds `context`, the rotator id + g + e0 + me (the mix epoch) + rosterHash + sorted removal list: " +
      "a wrap only opens under the exact claims A sealed it for, so nobody who saw it pass on " +
      "the relay can repost it under a different rotator or a different removal list.",
    by: "A",
    fromG: 0,
    toG: 1,
    fromChannel: g0.gen.channelId,
    mixEpoch: mix1,
    me: mix1,
    ckAtMixEpoch: hex(ck1AtMix),
    ns: hex(NS1),
    seed: seed1Hex,
    rosterHash: rh1,
    removed: [],
    context: rekey1Context,
    posts: rekeyPosts1,
    expect: "accept",
  });

  const g1 = await generation(new Uint8Array(hexToBytes(seed1Hex)), 1, mix1);
  generations.push({
    g: 1,
    e0: mix1,
    seed: g1.seedHex,
    anchor: g1.anchorHex,
    channel: g1.gen.channelId,
    ck0: g1.ck0Hex,
    roster: roster1,
    rosterHash: rh1,
  });

  // --- the welcome, which is how C actually learns seed_1.
  const welcomeEphSk = await subtle.importKey(
    "pkcs8",
    b64uDecode(EPH.eph3.sk),
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveBits"],
  );
  const welcomeCtx = welcomeContext({ by: A.memberId, g: 1, e0: mix1 });
  const welcomeWrap = await sealTo(
    welcomeEphSk,
    C.epk,
    inviteChannel,
    C.memberId,
    hexToBytes(seed1Hex),
    welcomeCtx,
  );
  steps.push({
    kind: "welcome",
    note:
      "The inviter posts generation 1's seed to the invite channel, sealed to C's agreement " +
      "key and signed by the circle identity the invite link commits to, and then burns the " +
      "invitation. C checks the sender against that commitment BEFORE using any of it: a " +
      "welcome from anyone else is refused, which is what stops whoever else saw the link " +
      "from owning the joining device. The wrap's AAD binds `context` the same way a re-key " +
      "wrap does, here the inviter id + g + e0, so it opens only as the inviter's. `n` is " +
      "how many member records follow, one per member other than C, each sealed under this " +
      "same context; they are not recorded here. A short delivery is refused rather than " +
      "joined: a joiner missing them can decrypt the circle and attribute no re-key at all. " +
      "C joins a generation that did not exist a moment ago, so there is no backlog to read.",
    channel: inviteChannel,
    by: "A",
    to: "C",
    g: 1,
    e0: mix1,
    n: roster1.filter((id) => id !== C.memberId).length,
    context: welcomeCtx,
    eph: EPH.eph3.pub,
    w: b64uEncode(welcomeWrap),
    seed: seed1Hex,
    expect: "accept",
  });

  // --- generation 1 traffic, including a point that arrives late.
  const cTs = mix1 * EPOCH_MS + 5_000;
  const pc = await postFrom(C, g1.gen, mix1, cTs, loc(cTs, { name: "Cass" }));
  steps.push({
    kind: "post",
    note: "C's first point, on the new channel",
    g: 1,
    channel: g1.gen.channelId,
    by: "C",
    e: mix1,
    ts: cTs,
    plaintext: pc.plaintext,
    post: pc.body,
    expect: "accept",
  });

  const lateE = mix1 + 1;
  const lateTs = lateE * EPOCH_MS + 6_000;
  const late = await postFrom(B, g1.gen, lateE, lateTs, loc(lateTs, { name: "Bo", lat: 44.9, lon: -93.2 }));
  steps.push({
    kind: "post",
    note:
      "out of order: B's point from epoch mix+1 reaches the receiver three epochs later, " +
      "after the ratchet has already moved on. It still opens, because the key is chosen by " +
      "the epoch carried on the wire and mix+1 is still inside the history window.",
    g: 1,
    channel: g1.gen.channelId,
    by: "B",
    e: lateE,
    ts: lateTs,
    deliveredAtEpoch: lateE + 3,
    historyEpochs: 6,
    plaintext: late.plaintext,
    post: late.body,
    expect: "accept",
  });

  steps.push({
    kind: "post",
    note:
      "the same point delivered after the window has closed. Nothing about it changed; the " +
      "key it needs no longer exists on the receiving device. That is the forward secrecy " +
      "working, not a failure.",
    g: 1,
    channel: g1.gen.channelId,
    by: "B",
    e: lateE,
    ts: lateTs,
    deliveredAtEpoch: lateE + 20,
    historyEpochs: 6,
    post: late.body,
    expect: "reject",
    reason: "epoch outside the retained history window",
  });

  // --- removing B: generation 2 goes to C only.
  const mix2 = lateE;
  await g1.gen.ratchet.advanceTo(mix2);
  const ck2AtMix = await (async () => {
    let ck = await chainInit(hexToBytes(seed1Hex));
    for (let i = mix1; i < mix2; i++) ck = await chainStep(ck);
    return ck;
  })();
  const seed2 = await g1.gen.ratchet.nextSeed(new Uint8Array(NS2), mix2);
  const seed2Hex = hex(seed2);
  const roster2 = [A.memberId, C.memberId];
  const rh2 = await rosterHash(roster2);

  const removalContext = rekeyContext({ by: A.memberId, g: 2, e0: mix2, me: mix2, rh: rh2, rm: [B.memberId] });

  const removalEph = await subtle.importKey(
    "pkcs8",
    b64uDecode(EPH.eph1.sk),
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveBits"],
  );
  const removalWrap = await sealTo(removalEph, C.epk, g1.gen.channelId, C.memberId, new Uint8Array(NS2), removalContext);
  const removalTs = mix2 * EPOCH_MS + 7_000;
  const removalObj = {
    v: 2,
    ts: removalTs,
    t: "rekey",
    g: 2,
    e0: mix2,
    me: mix2,
    to: C.memberId,
    eph: EPH.eph1.pub,
    w: b64uEncode(removalWrap),
    rm: [B.memberId],
    rh: rh2,
  };
  const removalPost = await postFrom(A, g1.gen, mix2, removalTs, removalObj);

  const g2 = await generation(hexToBytes(seed2Hex), 2, mix2);
  generations.push({
    g: 2,
    e0: mix2,
    seed: g2.seedHex,
    anchor: g2.anchorHex,
    channel: g2.gen.channelId,
    ck0: g2.ck0Hex,
    roster: roster2,
    rosterHash: rh2,
  });

  steps.push({
    kind: "removal",
    note:
      "B is removed. There is no wrap addressed to B, so B never learns NS2, cannot compute " +
      "seed_2, and cannot derive generation 2's channel id. B still holds the generation 1 " +
      "chain key recorded here, and it is worth nothing: the removal is cryptographic, not " +
      "advisory. B's own keys expire with the current epoch and the circle has moved. The " +
      "wrap's context names `rm: [B]`; C or a relay altering that list to frame someone else " +
      "would break the AAD and the wrap would not open.",
    by: "A",
    fromG: 1,
    toG: 2,
    fromChannel: g1.gen.channelId,
    mixEpoch: mix2,
    me: mix2,
    ckAtMixEpoch: hex(ck2AtMix),
    ns: hex(NS2),
    seed: seed2Hex,
    rosterHash: rh2,
    removed: [B.memberId],
    context: removalContext,
    posts: [{ ephLabel: "eph1", to: "C", post: removalPost.body, plaintext: removalObj }],
    holdout: {
      member: "B",
      holds: hex(ck2AtMix),
      cannotDerive: seed2Hex,
      cannotReach: g2.gen.channelId,
    },
    expect: "accept",
  });

  write("session.json", {
    note:
      "One circle recorded end to end: two members, a third joining, a re-key onto a new " +
      "channel, a removal, a late point that must still open, and a replay that must not be " +
      "accepted. Replay the steps in order.",
    fixed: {
      randomStream:
        `getRandomValues is replaced for the whole run by SHA-256("${RANDOM_STREAM}:" + block), ` +
        "block counting from 0, so every nonce below is reproducible. A real client draws " +
        "these from the CSPRNG.",
      keys: "the signing and agreement keys are frozen pkcs8 blobs in tools/gen-vectors.mjs",
      signatures:
        "Ed25519 throughout, because its signatures are deterministic. ECDSA P-256 signs the " +
        "same message differently every time and cannot be pinned in a vector.",
      rekeyWraps:
        "the rekey and removal steps below each carry a `context` string, the same one " +
        "rekeyContext() in app/js/rekey.js builds from the rotator id + g + e0 + me (the mix " +
        "epoch) + rosterHash + sorted removal list, and it is nothing but a function of the fields already in the " +
        "step; sealTo() folds it into the wrap's AAD so the wrap only opens under those exact " +
        "claims. Nothing here is substituted for it.",
      seed0: hex(SEED0),
      ns1: hex(NS1),
      ns2: hex(NS2),
      inviteSecret: hex(INVITE_SECRET),
      e0: E0,
      t0: T0,
      epochMs: EPOCH_MS,
      historyEpochs: 6,
    },
    members: await Promise.all(
      [A, B, C].map(async (m) => ({
        label: m.label,
        alg: m.alg,
        pk: b64uEncode(m.pk),
        epk: b64uEncode(m.epk),
        memberId: m.memberId,
        safetyNumber: await safetyNumber(m.pk, m.epk),
      })),
    ),
    invite: {
      secret: hex(INVITE_SECRET),
      channel: inviteChannel,
      key: hex(inviteKeyBytes),
      // The link commits to the inviter's keypair, so a welcome can only come
      // from the device that sent the link.
      inviter: "A",
      commitment: b64uEncode(await inviterCommitment(A.pk, A.epk)),
      fragment: inviteFragment(new Uint8Array(INVITE_SECRET), await inviterCommitment(A.pk, A.epk)),
    },
    generations,
    steps,
  });
}


fs.mkdirSync(OUT, { recursive: true });
await hkdfVectors();
await chainVectors();
await keyVectors();
stringVectors();
await identityVectors();
await sessionVectors();

globalThis.crypto.getRandomValues = realRandom;
