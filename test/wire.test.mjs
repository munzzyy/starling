// The wire helpers the app, the relay and every test share verbatim. Anything
// here that changes silently changes what two devices agree "the same message"
// means, so the constants and the exact derived strings are pinned.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PROTO, PAD_LEN, MAX_BODY, MEMBER_CAP, TRAIL_CAP, TTL_MS, FUTURE_SKEW_MS,
  INVITE_TTL_MS, EPOCH_MS, MAX_SKEW_EPOCHS, ECDH_PK_LEN,
  b64uEncode, b64uDecode, bytesToHex, concatBytes, sha256,
  memberIdFromKeys, safetyNumber, rosterHash,
  isChannelId, isMemberId, sigBase, aadFor, ALGS, checkPostShape, epochPlausible,
} from "../app/js/wire.js";

const te = new TextEncoder();

test("frozen constants", () => {
  assert.equal(PROTO, "starling/v2");
  assert.equal(PAD_LEN, 512);
  assert.equal(MAX_BODY, 2048);
  assert.equal(MEMBER_CAP, 16);
  assert.equal(TRAIL_CAP, 240);
  assert.equal(TTL_MS, 24 * 60 * 60 * 1000);
  assert.equal(FUTURE_SKEW_MS, 10 * 60 * 1000);
  assert.equal(INVITE_TTL_MS, 60 * 60 * 1000);
  assert.equal(ECDH_PK_LEN, 65);
  // Duplicated from ratchet.js on purpose so the relay can bounds-check an
  // epoch without importing the client-side ratchet. Duplicated values drift,
  // so they are checked against each other here.
  assert.equal(EPOCH_MS, 600_000);
  assert.equal(MAX_SKEW_EPOCHS, 2);
});

test("the epoch constants match the ratchet's, since they are copied", async () => {
  const ratchet = await import("../app/js/ratchet.js");
  assert.equal(EPOCH_MS, ratchet.EPOCH_MS);
  assert.equal(MAX_SKEW_EPOCHS, ratchet.MAX_SKEW_EPOCHS);
});

test("b64u round trip, lengths 0..64 and 255", () => {
  const lens = Array.from({ length: 65 }, (_, i) => i);
  lens.push(255);
  for (const len of lens) {
    const bytes = new Uint8Array(len);
    globalThis.crypto.getRandomValues(bytes);
    const s = b64uEncode(bytes);
    assert.match(s, /^[A-Za-z0-9_-]*$/, `charset at len ${len}`);
    assert.ok(!s.includes("="), `no padding at len ${len}`);
    assert.deepEqual(b64uDecode(s), bytes, `round trip at len ${len}`);
  }
});

test("b64u known answers", () => {
  assert.equal(b64uEncode(new Uint8Array(0)), "");
  assert.equal(b64uEncode(Uint8Array.from([255, 254])), "__4");
  assert.deepEqual(b64uDecode("__4"), Uint8Array.from([255, 254]));
  assert.deepEqual(b64uDecode(""), new Uint8Array(0));
});

test("b64uDecode throws on bad input", () => {
  const bad = ["+", "/", "=", " ", "abc=", "a+b", "a/b", "ab cd", "é", "☃", "AA\nAA"];
  for (const s of bad) {
    assert.throws(() => b64uDecode(s), /bad b64u/, JSON.stringify(s));
  }
  assert.throws(() => b64uDecode(123), /bad b64u/);
  assert.throws(() => b64uDecode(null), /bad b64u/);
  assert.throws(() => b64uDecode(undefined), /bad b64u/);
});

test("bytesToHex known vector", () => {
  assert.equal(bytesToHex(Uint8Array.from([0x00, 0x01, 0xab, 0xff])), "0001abff");
  assert.equal(bytesToHex(new Uint8Array(0)), "");
});

test("concatBytes joins in order and copies", () => {
  const a = Uint8Array.from([1, 2]);
  const b = Uint8Array.from([3]);
  const out = concatBytes(a, new Uint8Array(0), b);
  assert.deepEqual(Array.from(out), [1, 2, 3]);
  out[0] = 9;
  assert.equal(a[0], 1, "the inputs are not aliased into the result");
  assert.deepEqual(Array.from(concatBytes()), []);
});

test("sha256 known vectors", async () => {
  assert.equal(
    bytesToHex(await sha256(te.encode("abc"))),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
  assert.equal(
    bytesToHex(await sha256(new Uint8Array(0))),
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  );
});

test("memberIdFromKeys is 128 bits over the label and BOTH keys", async () => {
  const pk = new Uint8Array(32).fill(0xaa);
  const epk = new Uint8Array(65).fill(0xbb);
  const label = te.encode(`${PROTO}/member`);
  const expected = bytesToHex(await sha256(concatBytes(label, pk, epk))).slice(0, 32);
  assert.equal(await memberIdFromKeys(pk, epk), expected);
  assert.equal(expected.length, 32, "128 bits, not 64");

  // The binding is the whole of a receiver's trust in "who sent this". Change
  // either key and the id changes, so a relay cannot pair a signing key it
  // cannot forge with an agreement key of its own choosing.
  const otherPk = new Uint8Array(32).fill(0xab);
  const otherEpk = new Uint8Array(65).fill(0xbc);
  const ids = new Set([
    await memberIdFromKeys(pk, epk),
    await memberIdFromKeys(otherPk, epk),
    await memberIdFromKeys(pk, otherEpk),
    await memberIdFromKeys(otherPk, otherEpk),
  ]);
  assert.equal(ids.size, 4);

  // And the two keys are not run together: a byte moved from one to the other
  // is a different id, not the same one.
  const long = new Uint8Array(33).fill(0xaa);
  const short = new Uint8Array(64).fill(0xbb);
  assert.notEqual(await memberIdFromKeys(long, short), await memberIdFromKeys(pk, epk));
});

test("safetyNumber is six groups of five decimal digits over both keys", async () => {
  const pk = new Uint8Array(32).fill(0x11);
  const epk = new Uint8Array(65).fill(0x22);
  const n = await safetyNumber(pk, epk);
  assert.match(n, /^(\d{5} ){5}\d{5}$/);
  assert.equal(n.replaceAll(" ", "").length, 30);

  // Derived by hand from the digest, so the grouping and the modulus are pinned
  // rather than merely shaped.
  const digest = await sha256(concatBytes(te.encode(`${PROTO}/fp`), pk, epk));
  let expected = "";
  for (let i = 0; i < 18; i += 3) {
    expected += String(((digest[i] << 16) | (digest[i + 1] << 8) | digest[i + 2]) % 100000).padStart(5, "0");
  }
  assert.equal(n.replaceAll(" ", ""), expected);

  // A different key pair is a different number, which is the only reason two
  // people comparing them out loud proves anything.
  assert.notEqual(await safetyNumber(new Uint8Array(32).fill(0x12), epk), n);
  assert.notEqual(await safetyNumber(pk, new Uint8Array(65).fill(0x23)), n);
  // It is a different label from the member id, so one cannot be computed from
  // the other by anyone who only saw one of them.
  assert.notEqual(n.replaceAll(" ", ""), await memberIdFromKeys(pk, epk));
});

test("rosterHash is order independent and sensitive to membership", async () => {
  const a = "a".repeat(32);
  const b = "b".repeat(32);
  const c = "c".repeat(32);
  const hash = await rosterHash([a, b, c]);
  assert.match(hash, /^[A-Za-z0-9_-]+$/);
  assert.equal(await rosterHash([c, a, b]), hash, "sorted before hashing");
  assert.equal(await rosterHash(new Set([b, c, a])), hash, "any iterable");
  assert.notEqual(await rosterHash([a, b]), hash);
  assert.notEqual(await rosterHash([a, b, c, c]), hash);
  assert.notEqual(await rosterHash([]), hash);
  // The ids are joined with a separator, so two rosters cannot collide by
  // running their ids together differently.
  assert.notEqual(await rosterHash(["ab", "c"]), await rosterHash(["a", "bc"]));
});

test("sigBase exact string", () => {
  const got = sigBase(
    "00112233445566778899aabbccddeeff",
    "ffeeddccbbaa99887766554433221100",
    2980472,
    1788282659714,
    "nonceB64",
    "cipherB64",
  );
  assert.equal(
    got,
    "starling/v2|00112233445566778899aabbccddeeff|ffeeddccbbaa99887766554433221100|2980472|1788282659714|nonceB64|cipherB64",
  );
});

test("aadFor exact bytes, and sigBase extends it", () => {
  const channel = "00112233445566778899aabbccddeeff";
  const member = "ffeeddccbbaa99887766554433221100";
  const got = aadFor(channel, member, 2980472, 1788282659714);
  assert.ok(got instanceof Uint8Array);
  const expected = "starling/v2|00112233445566778899aabbccddeeff|ffeeddccbbaa99887766554433221100|2980472|1788282659714";
  assert.deepEqual(Array.from(got), expected.split("").map((ch) => ch.charCodeAt(0)));
  // The signature covers strictly more than the AEAD does: same prefix, plus
  // the nonce and the ciphertext.
  assert.equal(sigBase(channel, member, 2980472, 1788282659714, "N", "C"), `${expected}|N|C`);
});

test("the epoch is inside both bound strings", () => {
  const channel = "00112233445566778899aabbccddeeff";
  const member = "ffeeddccbbaa99887766554433221100";
  const a = new TextDecoder().decode(aadFor(channel, member, 1, 100));
  const b = new TextDecoder().decode(aadFor(channel, member, 2, 100));
  assert.notEqual(a, b, "a point cannot be replayed into another epoch");
  assert.notEqual(
    sigBase(channel, member, 1, 100, "N", "C"),
    sigBase(channel, member, 2, 100, "N", "C"),
  );
});

test("isChannelId accept/reject", () => {
  assert.equal(isChannelId("0123456789abcdef0123456789abcdef"), true);
  assert.equal(isChannelId("f".repeat(32)), true);
  const bad = [
    "0123456789ABCDEF0123456789ABCDEF", // uppercase
    "0123456789abcdef0123456789abcde",  // 31
    "0123456789abcdef0123456789abcdef0", // 33
    "g".repeat(32), // non-hex letter
    "0123456789abcdef 123456789abcdef", // space
    "", null, undefined, 123, {}, ["0123456789abcdef0123456789abcdef"],
  ];
  for (const v of bad) assert.equal(isChannelId(v), false, JSON.stringify(v));
});

test("isMemberId accept/reject", () => {
  assert.equal(isMemberId("0123456789abcdef0123456789abcdef"), true);
  assert.equal(isMemberId("0".repeat(32)), true);
  const bad = [
    "0123456789ABCDEF0123456789ABCDEF", // uppercase
    "0123456789abcdef",  // the v1 64-bit id length
    "0".repeat(31),
    "0".repeat(33),
    "x".repeat(32), // non-hex
    "", null, undefined, 42, {},
  ];
  for (const v of bad) assert.equal(isMemberId(v), false, JSON.stringify(v));
});

test("ALGS lengths", () => {
  assert.equal(ALGS.ed25519.pkLen, 32);
  assert.equal(ALGS.ed25519.sigLen, 64);
  assert.equal(ALGS.p256.pkLen, 65);
  assert.equal(ALGS.p256.sigLen, 64);
  assert.deepEqual(Object.keys(ALGS).sort(), ["ed25519", "p256"], "the allowlist is exactly two entries");
});

test("epochPlausible bounds an index against a clock without selecting a key", () => {
  const now = 2980471 * EPOCH_MS + 1234;
  assert.equal(epochPlausible(2980471, now), true);
  assert.equal(epochPlausible(2980471 + MAX_SKEW_EPOCHS, now), true);
  assert.equal(epochPlausible(2980471 - MAX_SKEW_EPOCHS, now), true);
  assert.equal(epochPlausible(2980471 + MAX_SKEW_EPOCHS + 1, now), false);
  assert.equal(epochPlausible(2980471 - MAX_SKEW_EPOCHS - 1, now), false);
  assert.equal(epochPlausible(0, now), false);
  assert.equal(epochPlausible(Number.MAX_SAFE_INTEGER, now), false);
});

const validBody = () => ({
  m: "0123456789abcdef0123456789abcdef",
  alg: "ed25519",
  pk: "A".repeat(43),
  epk: "E".repeat(87),
  e: 2980472,
  ts: 1788282659714,
  n: "A".repeat(16),
  c: "B".repeat(704),
  sig: "C".repeat(86),
});

test("checkPostShape accepts a valid body", () => {
  const body = validBody();
  const got = checkPostShape(body);
  assert.deepEqual(got, body);
  const p256Body = { ...validBody(), alg: "p256", pk: "A".repeat(87) };
  assert.deepEqual(checkPostShape(p256Body), p256Body);
});

test("checkPostShape strips extra fields", () => {
  const got = checkPostShape({ ...validBody(), extra: "x", evil: 1 });
  assert.deepEqual(Object.keys(got).sort(), ["alg", "c", "e", "epk", "m", "n", "pk", "sig", "ts"]);
});

test("checkPostShape null for every mutation", () => {
  const cases = [];
  for (const field of ["m", "alg", "pk", "epk", "e", "ts", "n", "c", "sig"]) {
    const body = validBody();
    delete body[field];
    cases.push([`missing ${field}`, body]);
  }
  const mutations = {
    "m wrong type": { m: 123 },
    "m uppercase": { m: "0123456789ABCDEF0123456789ABCDEF" },
    "m extra-long": { m: "0123456789abcdef0123456789abcdef0" },
    "m short": { m: "0123456789abcdef0123456789abcde" },
    "m at the v1 length": { m: "0123456789abcdef" },
    "alg unknown": { alg: "rsa" },
    "alg wrong case": { alg: "ED25519" },
    "alg wrong type": { alg: 1 },
    "e string": { e: "2980472" },
    "e negative": { e: -1 },
    "e float": { e: 2980472.5 },
    "e NaN": { e: NaN },
    "e unsafe": { e: 2 ** 53 },
    "ts string": { ts: "1788282659714" },
    "ts negative": { ts: -5 },
    "ts zero": { ts: 0 },
    "ts float": { ts: 1788282659714.5 },
    "ts unsafe": { ts: 2 ** 53 },
    "ts NaN": { ts: NaN },
    "pk empty": { pk: "" },
    "pk oversize": { pk: "A".repeat(91) },
    "pk non-b64u": { pk: "A".repeat(42) + "+" },
    "pk wrong type": { pk: 42 },
    "epk empty": { epk: "" },
    "epk oversize": { epk: "E".repeat(91) },
    "epk non-b64u": { epk: "E".repeat(86) + "/" },
    "epk wrong type": { epk: null },
    "n empty": { n: "" },
    "n oversize": { n: "A".repeat(19) },
    "n non-b64u": { n: "A".repeat(15) + "=" },
    "n wrong type": { n: null },
    "c empty": { c: "" },
    "c oversize": { c: "B".repeat(721) },
    "c non-b64u": { c: "B".repeat(703) + "/" },
    "c wrong type": { c: {} },
    "sig empty": { sig: "" },
    "sig oversize": { sig: "C".repeat(91) },
    "sig non-b64u": { sig: "C".repeat(85) + " " },
    "sig wrong type": { sig: ["C"] },
  };
  for (const [name, patch] of Object.entries(mutations)) {
    cases.push([name, { ...validBody(), ...patch }]);
  }
  cases.push(["array body", [validBody()]]);
  cases.push(["null body", null]);
  cases.push(["string body", "hello"]);
  cases.push(["number body", 7]);
  cases.push(["undefined body", undefined]);
  for (const [name, body] of cases) {
    assert.equal(checkPostShape(body), null, name);
  }
  // e = 0 is a real epoch index (1970), so it must survive the check that
  // rejects a negative one.
  assert.ok(checkPostShape({ ...validBody(), e: 0 }));
});
