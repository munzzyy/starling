import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PROTO, PAD_LEN, MAX_BODY, MEMBER_CAP, TRAIL_CAP, TTL_MS, FUTURE_SKEW_MS,
  b64uEncode, b64uDecode, bytesToHex, sha256, memberIdFromPub,
  isChannelId, isMemberId, sigBase, aadFor, ALGS, checkPostShape,
} from "../app/js/wire.js";

const te = new TextEncoder();

test("frozen constants", () => {
  assert.equal(PROTO, "starling/v1");
  assert.equal(PAD_LEN, 512);
  assert.equal(MAX_BODY, 2048);
  assert.equal(MEMBER_CAP, 16);
  assert.equal(TRAIL_CAP, 240);
  assert.equal(TTL_MS, 24 * 60 * 60 * 1000);
  assert.equal(FUTURE_SKEW_MS, 10 * 60 * 1000);
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

test("memberIdFromPub is first 16 hex of sha256", async () => {
  const pk = te.encode("abc");
  assert.equal(await memberIdFromPub(pk), "ba7816bf8f01cfea");
  const random = new Uint8Array(32);
  globalThis.crypto.getRandomValues(random);
  const full = bytesToHex(await sha256(random));
  assert.equal(await memberIdFromPub(random), full.slice(0, 16));
});

test("sigBase exact string", () => {
  const got = sigBase(
    "00112233445566778899aabbccddeeff",
    "ffeeddccbbaa9988",
    1756500000000,
    "nonceB64",
    "cipherB64",
  );
  assert.equal(
    got,
    "starling/v1|00112233445566778899aabbccddeeff|ffeeddccbbaa9988|1756500000000|nonceB64|cipherB64",
  );
});

test("aadFor exact bytes", () => {
  const got = aadFor("00112233445566778899aabbccddeeff", "ffeeddccbbaa9988");
  assert.ok(got instanceof Uint8Array);
  const expected = "starling/v1|00112233445566778899aabbccddeeff|ffeeddccbbaa9988";
  assert.deepEqual(Array.from(got), expected.split("").map((ch) => ch.charCodeAt(0)));
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
  assert.equal(isMemberId("0123456789abcdef"), true);
  assert.equal(isMemberId("0".repeat(16)), true);
  const bad = [
    "0123456789ABCDEF", // uppercase
    "0123456789abcde",  // 15
    "0123456789abcdef0", // 17
    "xyzxyzxyzxyzxyzx", // non-hex
    "", null, undefined, 42, {},
  ];
  for (const v of bad) assert.equal(isMemberId(v), false, JSON.stringify(v));
});

test("ALGS lengths", () => {
  assert.equal(ALGS.ed25519.pkLen, 32);
  assert.equal(ALGS.ed25519.sigLen, 64);
  assert.equal(ALGS.p256.pkLen, 65);
  assert.equal(ALGS.p256.sigLen, 64);
});

const validBody = () => ({
  m: "0123456789abcdef",
  alg: "ed25519",
  pk: "A".repeat(43),
  ts: 1756500000000,
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
  assert.deepEqual(Object.keys(got).sort(), ["alg", "c", "m", "n", "pk", "sig", "ts"]);
});

test("checkPostShape null for every mutation", () => {
  const cases = [];
  for (const field of ["m", "alg", "pk", "ts", "n", "c", "sig"]) {
    const body = validBody();
    delete body[field];
    cases.push([`missing ${field}`, body]);
  }
  const mutations = {
    "m wrong type": { m: 123 },
    "m uppercase": { m: "0123456789ABCDEF" },
    "m extra-long": { m: "0123456789abcdef0" },
    "m short": { m: "0123456789abcde" },
    "alg unknown": { alg: "rsa" },
    "alg wrong case": { alg: "ED25519" },
    "alg wrong type": { alg: 1 },
    "ts string": { ts: "1756500000000" },
    "ts negative": { ts: -5 },
    "ts zero": { ts: 0 },
    "ts float": { ts: 1756500000000.5 },
    "ts unsafe": { ts: 2 ** 53 },
    "ts NaN": { ts: NaN },
    "pk empty": { pk: "" },
    "pk oversize": { pk: "A".repeat(91) },
    "pk non-b64u": { pk: "A".repeat(42) + "+" },
    "pk wrong type": { pk: 42 },
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
});
