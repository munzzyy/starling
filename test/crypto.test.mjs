import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PAD_LEN, aadFor, b64uDecode, bytesToHex, isChannelId, memberIdFromPub,
  sigBase, verifySig, checkPostShape,
} from "../app/js/wire.js";
import {
  randomBytes, newCircleSecret, deriveChannelId, deriveEncKey,
  generateIdentity, signBase, sealMessage, openMessage, buildPost,
  inviteFragment, parseInviteFragment,
} from "../app/js/crypto.js";

const subtle = globalThis.crypto.subtle;
const te = new TextEncoder();

const hexToBytes = (hex) =>
  Uint8Array.from(hex.match(/../g) ?? [], (h) => parseInt(h, 16));

// Fixed context used across seal/open tests.
const SECRET = Uint8Array.from({ length: 32 }, (_, i) => (i * 7 + 3) & 0xff);
const CHANNEL = "00112233445566778899aabbccddeeff";
const MEMBER = "ffeeddccbbaa9988";

// Typical location payload from PROTOCOL.md.
const LOC = {
  v: 1, t: "loc", ts: 1756500000000, lat: 44.98, lon: -93.27, acc: 12,
  spd: 0.4, hdg: 90, bat: 0.81, name: "Cole", emoji: "🐦", hue: 210,
  mode: "precise", st: "",
};

async function fixedKey() {
  return deriveEncKey(SECRET);
}

// Encrypt an arbitrary pre-serialized plaintext with the real padding and AAD,
// bypassing sealMessage's object-in requirement.
async function sealRaw(encKey, channelId, memberId, jsonString) {
  const padded = jsonString + " ".repeat(PAD_LEN - te.encode(jsonString).length);
  const n = randomBytes(12);
  const c = new Uint8Array(await subtle.encrypt(
    { name: "AES-GCM", iv: n, additionalData: aadFor(channelId, memberId) },
    encKey,
    te.encode(padded),
  ));
  return { n, c };
}

test("seal/open round trip preserves a location payload", async () => {
  const key = await fixedKey();
  const sealed = await sealMessage(key, CHANNEL, MEMBER, LOC);
  assert.equal(sealed.n.length, 12);
  const opened = await openMessage(key, CHANNEL, MEMBER, sealed.n, sealed.c);
  assert.deepEqual(opened, LOC);
  assert.equal(opened.emoji, "🐦");
});

test("ciphertext length is exactly PAD_LEN+16 regardless of content", async () => {
  const key = await fixedKey();
  const minimal = await sealMessage(key, CHANNEL, MEMBER, {});
  const maximal = await sealMessage(key, CHANNEL, MEMBER, { ...LOC, name: "N".repeat(300) });
  assert.equal(minimal.c.length, PAD_LEN + 16);
  assert.equal(maximal.c.length, PAD_LEN + 16);
  assert.equal(minimal.c.length, maximal.c.length);
});

test("sealMessage fills PAD_LEN exactly, throws one byte past it", async () => {
  const key = await fixedKey();
  // {"p":"..."} with 504 x's is exactly 512 JSON bytes
  const atCap = await sealMessage(key, CHANNEL, MEMBER, { p: "x".repeat(504) });
  assert.equal(atCap.c.length, PAD_LEN + 16);
  await assert.rejects(
    sealMessage(key, CHANNEL, MEMBER, { p: "x".repeat(505) }),
    /message too large/,
  );
  await assert.rejects(
    sealMessage(key, CHANNEL, MEMBER, { big: "y".repeat(2000) }),
    /message too large/,
  );
});

test("openMessage null on truncated ciphertext", async () => {
  const key = await fixedKey();
  const { n, c } = await sealMessage(key, CHANNEL, MEMBER, LOC);
  assert.equal(await openMessage(key, CHANNEL, MEMBER, n, c.slice(0, 100)), null);
  assert.equal(await openMessage(key, CHANNEL, MEMBER, n, c.slice(0, c.length - 16)), null);
  assert.equal(await openMessage(key, CHANNEL, MEMBER, n, c.slice(0, c.length - 1)), null);
});

test("openMessage null for every single flipped ciphertext byte", async () => {
  const key = await fixedKey();
  const { n, c } = await sealMessage(key, CHANNEL, MEMBER, LOC);
  for (let i = 0; i < c.length; i++) {
    const tampered = c.slice();
    tampered[i] ^= 0x01;
    assert.equal(await openMessage(key, CHANNEL, MEMBER, n, tampered), null, `byte ${i}`);
  }
});

test("openMessage null on flipped nonce byte", async () => {
  const key = await fixedKey();
  const { n, c } = await sealMessage(key, CHANNEL, MEMBER, LOC);
  const badN = n.slice();
  badN[0] ^= 0x80;
  assert.equal(await openMessage(key, CHANNEL, MEMBER, badN, c), null);
});

test("openMessage null on wrong AAD channel or member", async () => {
  const key = await fixedKey();
  const { n, c } = await sealMessage(key, CHANNEL, MEMBER, LOC);
  const otherChannel = "ff112233445566778899aabbccddeeff";
  const otherMember = "0feeddccbbaa9988";
  assert.equal(await openMessage(key, otherChannel, MEMBER, n, c), null);
  assert.equal(await openMessage(key, CHANNEL, otherMember, n, c), null);
});

test("openMessage null with wrong key", async () => {
  const key = await fixedKey();
  const wrongKey = await deriveEncKey(newCircleSecret());
  const { n, c } = await sealMessage(key, CHANNEL, MEMBER, LOC);
  assert.equal(await openMessage(wrongKey, CHANNEL, MEMBER, n, c), null);
});

test("openMessage null on empty inputs", async () => {
  const key = await fixedKey();
  const { n, c } = await sealMessage(key, CHANNEL, MEMBER, LOC);
  const empty = new Uint8Array(0);
  assert.equal(await openMessage(key, CHANNEL, MEMBER, empty, c), null);
  assert.equal(await openMessage(key, CHANNEL, MEMBER, n, empty), null);
  assert.equal(await openMessage(key, CHANNEL, MEMBER, empty, empty), null);
});

test("openMessage rejects non-object plaintext", async () => {
  const key = await fixedKey();
  for (const raw of ['"just a string"', "42", "null", "true", "not json at all"]) {
    const { n, c } = await sealRaw(key, CHANNEL, MEMBER, raw);
    assert.equal(await openMessage(key, CHANNEL, MEMBER, n, c), null, raw);
  }
  // sanity: the same hand-rolled seal of an object does open
  const { n, c } = await sealRaw(key, CHANNEL, MEMBER, '{"ok":1}');
  assert.deepEqual(await openMessage(key, CHANNEL, MEMBER, n, c), { ok: 1 });
});

test("generateIdentity: ed25519 in node, memberId binds to pk", async () => {
  const id = await generateIdentity();
  assert.equal(id.alg, "ed25519");
  assert.equal(id.pk.length, 32);
  assert.match(id.memberId, /^[0-9a-f]{32}$/);
  assert.equal(id.memberId, await memberIdFromPub(id.pk));
  const other = await generateIdentity();
  assert.notEqual(id.memberId, other.memberId);
});

test("buildPost passes checkPostShape and verifySig", async () => {
  const id = await generateIdentity();
  const key = await fixedKey();
  const channelId = await deriveChannelId(SECRET);
  const sealed = await sealMessage(key, channelId, id.memberId, LOC);
  const ts = Date.now();
  const post = await buildPost(id, channelId, sealed, ts);
  const shaped = checkPostShape(post);
  assert.deepEqual(shaped, post);
  assert.equal(post.m, id.memberId);
  assert.equal(post.alg, "ed25519");
  assert.equal(post.ts, ts);
  const base = sigBase(channelId, post.m, post.ts, post.n, post.c);
  assert.equal(await verifySig(post.alg, b64uDecode(post.pk), b64uDecode(post.sig), base), true);
});

test("verifySig false on any alteration", async () => {
  const id = await generateIdentity();
  const base = sigBase(CHANNEL, id.memberId, 1756500000000, "NN", "CC");
  const sig = await signBase(id, base);
  assert.equal(await verifySig("ed25519", id.pk, sig, base), true);

  assert.equal(await verifySig("ed25519", id.pk, sig, base + "x"), false, "altered base");
  const badSig = sig.slice();
  badSig[10] ^= 0x01;
  assert.equal(await verifySig("ed25519", id.pk, badSig, base), false, "altered sig byte");
  const badPk = id.pk.slice();
  badPk[5] ^= 0x01;
  assert.equal(await verifySig("ed25519", badPk, sig, base), false, "altered pk byte");
  assert.equal(await verifySig("p256", id.pk, sig, base), false, "wrong alg label");
  assert.equal(await verifySig("nope", id.pk, sig, base), false, "unknown alg");
  const bigPk = new Uint8Array(33);
  bigPk.set(id.pk);
  assert.equal(await verifySig("ed25519", bigPk, sig, base), false, "oversized pk");
  assert.equal(await verifySig("ed25519", id.pk, new Uint8Array(0), base), false, "empty sig");
});

test("manual p256 identity signs and verifies (browser fallback path)", async () => {
  const kp = await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  const pk = new Uint8Array(await subtle.exportKey("raw", kp.publicKey));
  assert.equal(pk.length, 65);
  const id = { alg: "p256", privateKey: kp.privateKey, pk, memberId: await memberIdFromPub(pk) };
  const base = sigBase(CHANNEL, id.memberId, 1756500000000, "NN", "CC");
  const sig = await signBase(id, base);
  assert.equal(sig.length, 64);
  assert.equal(await verifySig("p256", pk, sig, base), true);
  assert.equal(await verifySig("p256", pk, sig, base + "x"), false);

  const key = await fixedKey();
  const sealed = await sealMessage(key, CHANNEL, id.memberId, LOC);
  const post = await buildPost(id, CHANNEL, sealed, 1756500000000);
  assert.deepEqual(checkPostShape(post), post);
  assert.equal(post.alg, "p256");
  const postBase = sigBase(CHANNEL, post.m, post.ts, post.n, post.c);
  assert.equal(await verifySig("p256", b64uDecode(post.pk), b64uDecode(post.sig), postBase), true);
});

// Frozen derivation vectors. Computed once from the shipped HKDF parameters;
// any change to salt, info strings, or lengths breaks these on purpose.
const KDF_VECTORS = [
  {
    name: "secret = 32 bytes of 0x42",
    secret: new Uint8Array(32).fill(0x42),
    channelId: "939b1b49c1d66987727e693d81182ef4",
    encKeyHex: "4f426c561fa6c58264c53c71772587bd56ddddc2f432e73e3ff41dfcddb875ff",
  },
  {
    name: "secret = bytes 0..31",
    secret: Uint8Array.from({ length: 32 }, (_, i) => i),
    channelId: "57e7cc9b8447e1374b104bfe9348c47b",
    encKeyHex: "c662f5ac2646aaf4b2fd10add95677cd140e7ff5dea9ad5eb1d311a214062d0c",
  },
];

test("KDF stability: channelId vectors are frozen", async () => {
  for (const v of KDF_VECTORS) {
    assert.equal(await deriveChannelId(v.secret), v.channelId, v.name);
  }
});

test("KDF stability: enc key material matches frozen vectors", async () => {
  // deriveEncKey is non-extractable, so pin it by cross-decrypting against
  // a key imported from the frozen raw bytes.
  for (const v of KDF_VECTORS) {
    const derived = await deriveEncKey(v.secret);
    const vectorKey = await subtle.importKey(
      "raw", hexToBytes(v.encKeyHex), { name: "AES-GCM" }, false, ["encrypt", "decrypt"],
    );
    const sealed = await sealMessage(derived, v.channelId, MEMBER, { pin: v.name });
    const opened = await openMessage(vectorKey, v.channelId, MEMBER, sealed.n, sealed.c);
    assert.deepEqual(opened, { pin: v.name }, v.name);
    const sealedBack = await sealMessage(vectorKey, v.channelId, MEMBER, { back: 1 });
    assert.deepEqual(await openMessage(derived, v.channelId, MEMBER, sealedBack.n, sealedBack.c), { back: 1 }, v.name);
  }
});

test("deriveChannelId shape and uniqueness", async () => {
  const a = await deriveChannelId(newCircleSecret());
  const b = await deriveChannelId(newCircleSecret());
  assert.equal(isChannelId(a), true);
  assert.equal(isChannelId(b), true);
  assert.notEqual(a, b);
});

test("invite fragment round trip", () => {
  const secret = newCircleSecret();
  const frag = inviteFragment(secret);
  assert.match(frag, /^#j=[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(parseInviteFragment(frag), secret);
});

test("parseInviteFragment rejects malformed fragments", () => {
  const valid43 = inviteFragment(newCircleSecret()).slice(3);
  assert.equal(valid43.length, 43);
  const bad = [
    "",
    null,
    undefined,
    valid43,               // missing prefix entirely
    "j=" + valid43,        // missing #
    "#J=" + valid43,       // wrong case prefix
    "#k=" + valid43,       // wrong key letter
    " #j=" + valid43,      // leading junk
    "x#j=" + valid43,      // leading junk
    "#j=" + valid43 + "A", // 44-char payload
    "#j=" + valid43.slice(0, 42), // 42-char payload
    "#j=" + "A".repeat(42),
    "#j=" + "A".repeat(44),
    "#j=" + "+".repeat(43),       // non-b64u chars
    "#j=" + valid43.slice(0, 42) + "=",
    "#j=" + valid43.slice(0, 21) + "/" + valid43.slice(22),
    "#j=",
  ];
  for (const h of bad) {
    assert.equal(parseInviteFragment(h), null, JSON.stringify(h));
  }
  // the same 43 chars are accepted only behind the exact "#j=" prefix
  assert.deepEqual(parseInviteFragment("#j=" + valid43), b64uDecode(valid43));
});

test("randomBytes and newCircleSecret shapes", () => {
  assert.equal(randomBytes(12).length, 12);
  const s = newCircleSecret();
  assert.equal(s.length, 32);
  assert.notDeepEqual(newCircleSecret(), s);
});
