// The duress passcode's verifier: a record that can say "this is the duress
// code" without ever being able to unlock anything, plus the fail-closed
// behavior around malformed and tampered records.
import test from "node:test";
import assert from "node:assert/strict";

import { makeDuressRecord, matchesDuress, PBKDF2_ITERS } from "../app/js/lock.js";

test("duress record matches its passcode and nothing else", async () => {
  const rec = await makeDuressRecord("0000");
  assert.ok(await matchesDuress(rec, "0000"));
  for (const bad of ["", "000", "00000", "0001", "1234", "0000 "]) {
    assert.equal(await matchesDuress(rec, bad), false, `bad=${JSON.stringify(bad)}`);
  }
});

test("duress record is a hash with a real KDF cost, not a wrapped key", async () => {
  const rec = await makeDuressRecord("0000");
  assert.equal(rec.kdf, "pbkdf2-sha256");
  assert.ok(rec.iters >= PBKDF2_ITERS, "same OWASP floor as the unlock passcode");
  assert.equal(rec.salt.length, 16);
  assert.equal(rec.hash.length, 32);
  // No nonce, no ciphertext: there is nothing here that could decrypt into
  // key material, which is the property that makes it safe to store.
  assert.equal(rec.nonce, undefined);
  assert.equal(rec.ct, undefined);
});

test("two records for the same passcode share nothing visible", async () => {
  const a = await makeDuressRecord("same");
  const b = await makeDuressRecord("same");
  assert.notDeepEqual([...a.salt], [...b.salt]);
  assert.notDeepEqual([...a.hash], [...b.hash]);
});

test("tampered or malformed records fail closed", async () => {
  const rec = await makeDuressRecord("0000");
  const flipped = { ...rec, hash: Uint8Array.from(rec.hash) };
  flipped.hash[0] ^= 1;
  assert.equal(await matchesDuress(flipped, "0000"), false);
  assert.equal(await matchesDuress(null, "0000"), false);
  assert.equal(await matchesDuress({}, "0000"), false);
  assert.equal(await matchesDuress({ kdf: "pbkdf2-sha256", salt: rec.salt, iters: rec.iters, hash: "junk" }, "0000"), false);
});
