// Device-side crypto: identities, sealing, signing, key wrapping, invitations.
//
// The frozen derivation vectors moved to test/vectors/ in v2; this file is
// about behaviour. Most of it is negative, because almost everything here is a
// question of what must NOT open.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PROTO, PAD_LEN, aadFor, b64uEncode, b64uDecode, bytesToHex, isChannelId,
  memberIdFromKeys, sigBase, verifySig, checkPostShape,
} from "../app/js/wire.js";
import { EPOCH_MS, chainInit, createRatchet } from "../app/js/ratchet.js";
import {
  randomBytes, newSeed, generateIdentity, signBase, sealMessage, openMessage, buildPost,
  generateEphemeral, sealTo, openSealed,
  newInviteSecret, deriveInviteChannelId, deriveInviteKey, inviteFragment, parseInviteFragment,
  inviterCommitment, equalBytes,
  deriveHelpChannelId, deriveHelpEncKey, beaconFragment, parseBeaconFragment,
} from "../app/js/crypto.js";

const subtle = globalThis.crypto.subtle;
const te = new TextEncoder();

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

const CHANNEL = "00112233445566778899aabbccddeeff";
const MEMBER = "ffeeddccbbaa99887766554433221100";
const OTHER = "00000000111111112222222233333333";
const E = 2980472;
const TS = E * EPOCH_MS + 59_714;

const SEED = Uint8Array.from({ length: 32 }, (_, i) => (i * 7 + 3) & 0xff);

// The content key for one (epoch, member), the way a live ratchet produces it.
async function keyAt(e = E, member = MEMBER, seed = SEED) {
  const r = createRatchet({ e0: E, ck0: await chainInit(new Uint8Array(seed)), historyEpochs: 144 });
  return r.keyFor(e, member, e * EPOCH_MS);
}

// A typical location payload from PROTOCOL.md.
const LOC = {
  v: 2, t: "loc", ts: TS, lat: 44.98, lon: -93.27, acc: 12,
  bat: 0.81, name: "Cole", emoji: "🐦", hue: 210, mode: "precise",
};

// Encrypt an arbitrary pre-serialized plaintext with the real padding and AAD,
// bypassing sealMessage's object-in requirement.
async function sealRaw(key, channelId, memberId, epoch, ts, jsonString) {
  const padded = jsonString + " ".repeat(PAD_LEN - te.encode(jsonString).length);
  const n = randomBytes(12);
  const c = new Uint8Array(await subtle.encrypt(
    { name: "AES-GCM", iv: n, additionalData: aadFor(channelId, memberId, epoch, ts) },
    key,
    te.encode(padded),
  ));
  return { n, c };
}

test("seal/open round trip preserves a location payload", async () => {
  const key = await keyAt();
  const sealed = await sealMessage(key, CHANNEL, MEMBER, E, TS, LOC);
  assert.equal(sealed.n.length, 12);
  const opened = await openMessage(key, CHANNEL, MEMBER, E, TS, sealed.n, sealed.c);
  assert.deepEqual(opened, LOC);
  assert.equal(opened.emoji, "🐦");
});

test("ciphertext length is exactly PAD_LEN+16 regardless of content", async () => {
  const key = await keyAt();
  const minimal = await sealMessage(key, CHANNEL, MEMBER, E, TS, {});
  const maximal = await sealMessage(key, CHANNEL, MEMBER, E, TS, { ...LOC, name: "N".repeat(300) });
  assert.equal(minimal.c.length, PAD_LEN + 16);
  assert.equal(maximal.c.length, PAD_LEN + 16);
  // Every message type is the same size, so the relay cannot tell a re-key from
  // a location update by looking at the length.
  const rekey = await sealMessage(key, CHANNEL, MEMBER, E, TS, { t: "rekey", g: 4, to: MEMBER });
  assert.equal(rekey.c.length, minimal.c.length);
});

test("sealMessage fills PAD_LEN exactly, throws one byte past it", async () => {
  const key = await keyAt();
  // {"p":"..."} with 504 x's is exactly 512 JSON bytes
  const atCap = await sealMessage(key, CHANNEL, MEMBER, E, TS, { p: "x".repeat(504) });
  assert.equal(atCap.c.length, PAD_LEN + 16);
  await assert.rejects(sealMessage(key, CHANNEL, MEMBER, E, TS, { p: "x".repeat(505) }), /message too large/);
  await assert.rejects(sealMessage(key, CHANNEL, MEMBER, E, TS, { big: "y".repeat(2000) }), /message too large/);
});

test("openMessage null on truncated ciphertext", async () => {
  const key = await keyAt();
  const { n, c } = await sealMessage(key, CHANNEL, MEMBER, E, TS, LOC);
  assert.equal(await openMessage(key, CHANNEL, MEMBER, E, TS, n, c.slice(0, 100)), null);
  assert.equal(await openMessage(key, CHANNEL, MEMBER, E, TS, n, c.slice(0, c.length - 16)), null);
  assert.equal(await openMessage(key, CHANNEL, MEMBER, E, TS, n, c.slice(0, c.length - 1)), null);
});

test("openMessage null for every single flipped ciphertext byte", async () => {
  const key = await keyAt();
  const { n, c } = await sealMessage(key, CHANNEL, MEMBER, E, TS, LOC);
  for (let i = 0; i < c.length; i++) {
    const tampered = c.slice();
    tampered[i] ^= 0x01;
    assert.equal(await openMessage(key, CHANNEL, MEMBER, E, TS, n, tampered), null, `byte ${i}`);
  }
});

test("openMessage null on flipped nonce byte", async () => {
  const key = await keyAt();
  const { n, c } = await sealMessage(key, CHANNEL, MEMBER, E, TS, LOC);
  const badN = n.slice();
  badN[0] ^= 0x80;
  assert.equal(await openMessage(key, CHANNEL, MEMBER, E, TS, badN, c), null);
});

test("openMessage null on wrong AAD channel, member, epoch or ts", async () => {
  const key = await keyAt();
  const { n, c } = await sealMessage(key, CHANNEL, MEMBER, E, TS, LOC);
  assert.equal(await openMessage(key, "ff112233445566778899aabbccddeeff", MEMBER, E, TS, n, c), null, "channel");
  assert.equal(await openMessage(key, CHANNEL, OTHER, E, TS, n, c), null, "member");
  // The epoch is inside the AAD, so the same ciphertext cannot be re-filed
  // under a neighbouring epoch even by someone holding the key.
  assert.equal(await openMessage(key, CHANNEL, MEMBER, E + 1, TS, n, c), null, "epoch");
  assert.equal(await openMessage(key, CHANNEL, MEMBER, E - 1, TS, n, c), null, "epoch back");
  assert.equal(await openMessage(key, CHANNEL, MEMBER, E, TS + 1, n, c), null, "ts");
});

test("openMessage null with a key from another epoch, member or generation", async () => {
  const key = await keyAt();
  const { n, c } = await sealMessage(key, CHANNEL, MEMBER, E, TS, LOC);
  assert.equal(await openMessage(await keyAt(E + 1, MEMBER, SEED), CHANNEL, MEMBER, E, TS, n, c), null);
  assert.equal(await openMessage(await keyAt(E, OTHER, SEED), CHANNEL, MEMBER, E, TS, n, c), null);
  assert.equal(await openMessage(await keyAt(E, MEMBER, newSeed()), CHANNEL, MEMBER, E, TS, n, c), null);
});

test("openMessage null on empty inputs", async () => {
  const key = await keyAt();
  const { n, c } = await sealMessage(key, CHANNEL, MEMBER, E, TS, LOC);
  const empty = new Uint8Array(0);
  assert.equal(await openMessage(key, CHANNEL, MEMBER, E, TS, empty, c), null);
  assert.equal(await openMessage(key, CHANNEL, MEMBER, E, TS, n, empty), null);
  assert.equal(await openMessage(key, CHANNEL, MEMBER, E, TS, empty, empty), null);
});

test("openMessage rejects non-object plaintext", async () => {
  const key = await keyAt();
  for (const raw of ['"just a string"', "42", "null", "true", "not json at all"]) {
    const { n, c } = await sealRaw(key, CHANNEL, MEMBER, E, TS, raw);
    assert.equal(await openMessage(key, CHANNEL, MEMBER, E, TS, n, c), null, raw);
  }
  const { n, c } = await sealRaw(key, CHANNEL, MEMBER, E, TS, '{"ok":1}');
  assert.deepEqual(await openMessage(key, CHANNEL, MEMBER, E, TS, n, c), { ok: 1 });
});

test("generateIdentity: two keypairs, and the id binds both", async () => {
  const id = await generateIdentity();
  assert.equal(id.alg, "ed25519", "node has Ed25519; browsers without it fall back to p256");
  assert.equal(id.pk.length, 32);
  assert.equal(id.epk.length, 65, "ECDH is P-256 everywhere, raw");
  assert.match(id.memberId, /^[0-9a-f]{32}$/);
  assert.equal(id.memberId, await memberIdFromKeys(id.pk, id.epk));
  assert.notEqual(id.memberId, await memberIdFromKeys(id.pk, new Uint8Array(65)));

  const other = await generateIdentity();
  assert.notEqual(id.memberId, other.memberId);
  assert.notDeepEqual(id.epk, other.epk);
  // Both private keys are non-extractable: the raw bytes never become
  // script-readable, and structured clone is how they persist.
  assert.equal(id.privateKey.extractable, false);
  assert.equal(id.ecdhPrivate.extractable, false);
  await assert.rejects(() => subtle.exportKey("pkcs8", id.privateKey));
  await assert.rejects(() => subtle.exportKey("pkcs8", id.ecdhPrivate));
});

test("buildPost passes checkPostShape and verifySig", async () => {
  const id = await generateIdentity();
  const key = await keyAt(E, id.memberId);
  const sealed = await sealMessage(key, CHANNEL, id.memberId, E, TS, LOC);
  const post = await buildPost(id, CHANNEL, E, sealed, TS);
  assert.deepEqual(checkPostShape(post), post);
  assert.equal(post.m, id.memberId);
  assert.equal(post.alg, "ed25519");
  assert.equal(post.e, E);
  assert.equal(post.ts, TS);
  assert.equal(post.epk, b64uEncode(id.epk), "the agreement key travels with every point");
  assert.equal(await memberIdFromKeys(b64uDecode(post.pk), b64uDecode(post.epk)), post.m);
  const base = sigBase(CHANNEL, post.m, post.e, post.ts, post.n, post.c);
  assert.equal(await verifySig(post.alg, b64uDecode(post.pk), b64uDecode(post.sig), base), true);
  // The signature covers the epoch, so a point cannot be moved into another one.
  const moved = sigBase(CHANNEL, post.m, post.e + 1, post.ts, post.n, post.c);
  assert.equal(await verifySig(post.alg, b64uDecode(post.pk), b64uDecode(post.sig), moved), false);
});

test("verifySig false on any alteration", async () => {
  const id = await generateIdentity();
  const base = sigBase(CHANNEL, id.memberId, E, TS, "NN", "CC");
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
  assert.equal(await verifySig("__proto__", id.pk, sig, base), false, "alg is an allowlist lookup");
  const bigPk = new Uint8Array(33);
  bigPk.set(id.pk);
  assert.equal(await verifySig("ed25519", bigPk, sig, base), false, "oversized pk");
  assert.equal(await verifySig("ed25519", id.pk, new Uint8Array(0), base), false, "empty sig");
});

test("manual p256 identity signs and verifies (browser fallback path)", async () => {
  const kp = await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  const pk = new Uint8Array(await subtle.exportKey("raw", kp.publicKey));
  const ec = await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  const epk = new Uint8Array(await subtle.exportKey("raw", ec.publicKey));
  assert.equal(pk.length, 65);
  const id = {
    alg: "p256",
    privateKey: kp.privateKey,
    pk,
    ecdhPrivate: ec.privateKey,
    epk,
    memberId: await memberIdFromKeys(pk, epk),
  };
  const base = sigBase(CHANNEL, id.memberId, E, TS, "NN", "CC");
  const sig = await signBase(id, base);
  assert.equal(sig.length, 64);
  assert.equal(await verifySig("p256", pk, sig, base), true);
  assert.equal(await verifySig("p256", pk, sig, base + "x"), false);

  const key = await keyAt(E, id.memberId);
  const sealed = await sealMessage(key, CHANNEL, id.memberId, E, TS, LOC);
  const post = await buildPost(id, CHANNEL, E, sealed, TS);
  assert.deepEqual(checkPostShape(post), post);
  assert.equal(post.alg, "p256");
  const postBase = sigBase(CHANNEL, post.m, post.e, post.ts, post.n, post.c);
  assert.equal(await verifySig("p256", b64uDecode(post.pk), b64uDecode(post.sig), postBase), true);
});

// --- key wrapping ----------------------------------------------------------

test("sealTo opens only for the named recipient on the named channel", async () => {
  const alice = await generateIdentity();
  const bob = await generateIdentity();
  const eph = await generateEphemeral();
  assert.equal(eph.pub.length, 65);

  const secret = randomBytes(32);
  const wrapped = await sealTo(eph.privateKey, alice.epk, CHANNEL, alice.memberId, secret);
  assert.ok(wrapped.length > 12, "nonce prepended to the ciphertext");
  assert.deepEqual(await openSealed(alice, eph.pub, CHANNEL, alice.memberId, wrapped), secret);

  // The recipient is in the wrap's key derivation AND in its AAD, so neither
  // renaming the slot nor being another member of the circle helps.
  assert.equal(await openSealed(bob, eph.pub, CHANNEL, alice.memberId, wrapped), null, "wrong holder");
  assert.equal(await openSealed(alice, eph.pub, CHANNEL, bob.memberId, wrapped), null, "wrong member label");
  assert.equal(await openSealed(alice, eph.pub, "ff112233445566778899aabbccddeeff", alice.memberId, wrapped), null, "wrong channel");
  const otherEph = await generateEphemeral();
  assert.equal(await openSealed(alice, otherEph.pub, CHANNEL, alice.memberId, wrapped), null, "wrong ephemeral key");
});

test("sealTo binds an optional context string into the AAD, not just the recipient and channel", async () => {
  // rekey.js uses this to bind a wrap to everything the re-key message claims
  // (who rotated, what generation, who was removed), so a wrap addressed to
  // the right person on the right channel still refuses to open if the claim
  // around it changed. The primitive itself does not know about re-keys; it
  // only needs to treat `context` as one more thing the ciphertext is bound
  // to, same as the channel or the member id.
  const alice = await generateIdentity();
  const eph = await generateEphemeral();
  const secret = randomBytes(32);

  const wrapped = await sealTo(eph.privateKey, alice.epk, CHANNEL, alice.memberId, secret, "ctx-a");
  assert.deepEqual(await openSealed(alice, eph.pub, CHANNEL, alice.memberId, wrapped, "ctx-a"), secret);

  assert.equal(await openSealed(alice, eph.pub, CHANNEL, alice.memberId, wrapped, "ctx-b"), null, "different context");
  assert.equal(await openSealed(alice, eph.pub, CHANNEL, alice.memberId, wrapped), null, "missing context falls back to empty, which is also wrong here");

  // And the reverse: a wrap sealed with the default empty context does not
  // open under a non-empty one, so the default is not a wildcard.
  const defaultWrapped = await sealTo(eph.privateKey, alice.epk, CHANNEL, alice.memberId, secret);
  assert.deepEqual(await openSealed(alice, eph.pub, CHANNEL, alice.memberId, defaultWrapped), secret);
  assert.equal(await openSealed(alice, eph.pub, CHANNEL, alice.memberId, defaultWrapped, "ctx-a"), null);
});

test("openSealed returns null rather than throwing on junk", async () => {
  const alice = await generateIdentity();
  const eph = await generateEphemeral();
  const wrapped = await sealTo(eph.privateKey, alice.epk, CHANNEL, alice.memberId, randomBytes(32));
  for (const bad of [new Uint8Array(0), new Uint8Array(12), null, "x", wrapped.subarray(0, 12)]) {
    assert.equal(await openSealed(alice, eph.pub, CHANNEL, alice.memberId, bad), null);
  }
  const tampered = wrapped.slice();
  tampered[tampered.length - 1] ^= 0x01;
  assert.equal(await openSealed(alice, eph.pub, CHANNEL, alice.memberId, tampered), null);
  assert.equal(await openSealed(alice, new Uint8Array(65), CHANNEL, alice.memberId, wrapped), null, "invalid point");
});

test("each wrap uses a fresh ephemeral key", async () => {
  const a = await generateEphemeral();
  const b = await generateEphemeral();
  assert.notDeepEqual(a.pub, b.pub);
  assert.equal(a.privateKey.extractable, false);
});

// --- invitations -----------------------------------------------------------

test("an invite secret derives a channel and a key, and only its own", async () => {
  const secret = newInviteSecret();
  assert.equal(secret.length, 32);
  const chan = await deriveInviteChannelId(secret);
  assert.equal(isChannelId(chan), true);
  assert.notEqual(await deriveInviteChannelId(newInviteSecret()), chan);

  const key = await deriveInviteKey(secret);
  const sealed = await sealMessage(key, chan, MEMBER, E, TS, { t: "join", name: "Ana" });
  assert.deepEqual(await openMessage(key, chan, MEMBER, E, TS, sealed.n, sealed.c), { t: "join", name: "Ana" });
  const wrong = await deriveInviteKey(newInviteSecret());
  assert.equal(await openMessage(wrong, chan, MEMBER, E, TS, sealed.n, sealed.c), null);
  // One secret, two labels, and nothing derived under one is usable under the
  // other. Deriving anything from a bare secret without a label is how two
  // purposes end up sharing bytes.
  assert.notEqual(bytesToHex(await deriveHelpChannelId(secret)), chan);
});

test("invite fragment round trip carries the secret and the inviter commitment", async () => {
  const secret = newInviteSecret();
  const id = await generateIdentity();
  const commit = await inviterCommitment(id.pk, id.epk);
  const frag = inviteFragment(secret, commit);
  assert.match(frag, /^#j=[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{22}$/);
  const back = parseInviteFragment(frag);
  assert.deepEqual(back.secret, secret);
  assert.deepEqual(back.commit, commit);
});

test("the inviter commitment is 128 bits of SHA-256 over BOTH public keys", async () => {
  const id = await generateIdentity();
  const commit = await inviterCommitment(id.pk, id.epk);
  assert.equal(commit.length, 16);
  const digest = new Uint8Array(
    await subtle.digest(
      "SHA-256",
      concat(te.encode(`${PROTO}/inviter`), id.pk, id.epk),
    ),
  );
  assert.deepEqual(commit, digest.slice(0, 16));

  // Both keys, or a relay could substitute the agreement key of a signing key
  // it cannot forge and still satisfy the link.
  const other = await generateIdentity();
  assert.equal(equalBytes(commit, await inviterCommitment(other.pk, id.epk)), false);
  assert.equal(equalBytes(commit, await inviterCommitment(id.pk, other.epk)), false);
  // And it is the same binding the member id and the safety number use.
  assert.notDeepEqual(commit, (await inviterCommitment(id.epk, id.pk)).slice(0, 16));
});

test("a v1-shaped invite fragment with no commitment is refused", async () => {
  // The whole of the takeover: a link that names nobody is answered by whoever
  // posts first, and the attacker posts first because the real inviter has to
  // be online and tap accept. There is nothing safe to do with such a link, so
  // it is not accepted in a degraded mode; it is not accepted at all.
  const secret = newInviteSecret();
  assert.equal(parseInviteFragment(`#j=${b64uEncode(secret)}`), null);
});

test("parseInviteFragment rejects malformed fragments", async () => {
  const id = await generateIdentity();
  const good = inviteFragment(newInviteSecret(), await inviterCommitment(id.pk, id.epk));
  const [s43, c22] = good.slice(3).split(".");
  assert.equal(s43.length, 43);
  assert.equal(c22.length, 22);
  const bad = [
    "", null, undefined,
    good.slice(1),               // missing #
    good.replace("#j=", "#J="),  // wrong case prefix
    good.replace("#j=", "#k="),  // wrong key letter
    ` ${good}`,                  // leading junk
    `x${good}`,
    good.replace("#j=", ""),     // missing prefix entirely
    `#j=${s43}`,                 // secret only, the v1 shape
    `#j=.${c22}`,                // commitment only
    `#j=${s43}.`,
    `#j=${s43}.${c22}A`,         // 23-char commitment
    `#j=${s43}.${c22.slice(0, 21)}`,
    `#j=${s43}A.${c22}`,         // 44-char secret
    `#j=${s43.slice(0, 42)}.${c22}`,
    `#j=${"+".repeat(43)}.${c22}`,      // non-b64u chars
    `#j=${s43}.${"/".repeat(22)}`,
    `#j=${s43}.${c22}.${c22}`,          // a third part
    "#j=",
  ];
  for (const h of bad) {
    assert.equal(parseInviteFragment(h), null, JSON.stringify(h));
  }
  const back = parseInviteFragment(good);
  assert.deepEqual(back.secret, b64uDecode(s43));
  assert.deepEqual(back.commit, b64uDecode(c22));
});

test("equalBytes compares length and content, and refuses anything that is not bytes", () => {
  assert.equal(equalBytes(Uint8Array.of(1, 2, 3), Uint8Array.of(1, 2, 3)), true);
  assert.equal(equalBytes(Uint8Array.of(1, 2, 3), Uint8Array.of(1, 2, 4)), false);
  assert.equal(equalBytes(Uint8Array.of(1, 2), Uint8Array.of(1, 2, 3)), false);
  assert.equal(equalBytes(Uint8Array.of(1), [1]), false);
  assert.equal(equalBytes(null, null), false);
});

// --- beacon ----------------------------------------------------------------

test("a beacon secret derives its own channel and key, unlinkable to a circle", async () => {
  const secret = randomBytes(32);
  const chan = await deriveHelpChannelId(secret);
  assert.equal(isChannelId(chan), true);
  // Separate info strings mean a beacon and a circle can never produce
  // overlapping material, so the relay cannot link the two channels by key.
  assert.notEqual(chan, await deriveInviteChannelId(secret));

  const key = await deriveHelpEncKey(secret, ["encrypt", "decrypt"]);
  const sealed = await sealMessage(key, chan, MEMBER, E, TS, { t: "sos", ts: TS });
  assert.deepEqual(await openMessage(key, chan, MEMBER, E, TS, sealed.n, sealed.c), { t: "sos", ts: TS });
  assert.equal(await openMessage(await deriveInviteKey(secret), chan, MEMBER, E, TS, sealed.n, sealed.c), null);
});

// The usages are named by the caller and default to the read half. The beacon
// asks for encrypt, the viewer page asks for decrypt, and a page that cannot
// encrypt cannot be turned into a poster by a bug in it.
test("deriveHelpEncKey defaults to a key that can only open, never seal", async () => {
  const secret = randomBytes(32);
  const chan = await deriveHelpChannelId(secret);
  const sealKey = await deriveHelpEncKey(secret, ["encrypt"]);
  const sealed = await sealMessage(sealKey, chan, MEMBER, E, TS, { t: "sos", ts: TS });

  const dflt = await deriveHelpEncKey(secret);
  assert.deepEqual(dflt.usages, ["decrypt"]);
  assert.deepEqual(await openMessage(dflt, chan, MEMBER, E, TS, sealed.n, sealed.c), { t: "sos", ts: TS });
  await assert.rejects(() => sealMessage(dflt, chan, MEMBER, E, TS, { t: "loc", ts: TS }));

  assert.deepEqual((await deriveHelpEncKey(secret, ["encrypt"])).usages, ["encrypt"]);
  assert.equal(await openMessage(sealKey, chan, MEMBER, E, TS, sealed.n, sealed.c), null);
});

test("beacon fragment carries the secret, an expiry and the sender commitment", () => {
  const secret = randomBytes(32);
  const expires = 1788282659714;
  const owner = "3f".repeat(16);
  const frag = beaconFragment(secret, expires, owner);
  assert.match(frag, /^#b=[A-Za-z0-9_-]{43}\.\d+\.[0-9a-f]{32}$/);
  const parsed = parseBeaconFragment(frag);
  assert.deepEqual(parsed.secret, secret);
  assert.equal(parsed.expiresAt, expires);
  assert.equal(parsed.ownerId, owner);

  const valid43 = frag.slice(3, 46);
  for (const bad of [
    "", null, undefined,
    "#b=" + valid43,                        // no expiry, no commitment
    "#b=" + valid43 + ".",                   // empty expiry
    "#b=" + valid43 + ".x." + owner,         // non-numeric expiry
    "#b=" + valid43 + "." + "9".repeat(16) + "." + owner, // absurd expiry
    // A link with the commitment stripped is the downgrade an attacker who
    // was forwarded one would try: it must not parse into a viewer that
    // believes whoever posts first.
    "#b=" + valid43 + "." + expires,
    "#b=" + valid43 + "." + expires + ".",
    "#b=" + valid43 + "." + expires + "." + owner.slice(0, 31),  // 31 hex
    "#b=" + valid43 + "." + expires + "." + owner + "a",         // 33 hex
    "#b=" + valid43 + "." + expires + "." + owner.toUpperCase(), // wrong case
    "#b=" + valid43 + "." + expires + ".zzzz" + owner.slice(4),  // non-hex
    "#j=" + valid43 + "." + expires + "." + owner,               // wrong tag
    "#b=" + valid43.slice(0, 42) + "." + expires + "." + owner,
  ]) {
    assert.equal(parseBeaconFragment(bad), null, JSON.stringify(bad));
  }
});

test("randomBytes and newSeed shapes", () => {
  assert.equal(randomBytes(12).length, 12);
  const s = newSeed();
  assert.equal(s.length, 32);
  assert.notDeepEqual(newSeed(), s);
  assert.equal(PROTO, "starling/v2");
});
