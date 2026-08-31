// The wrapper's Keystore biometric wrap, driven through a fake bridge. The
// fake mirrors the Kotlin side: async completion through __starlingBio, URL
// safe unpadded base64 payloads, null on a failed or dismissed prompt.
import test from "node:test";
import assert from "node:assert/strict";
import { b64uEncode, b64uDecode } from "../app/js/wire.js";
import { makeBioRecord, openBioRecord, bioAvailable, webauthnAvailable, newVaultKey } from "../app/js/lock.js";

// AES-GCM stand-in for the Keystore key so wrap and unwrap really roundtrip.
const rawKey = crypto.getRandomValues(new Uint8Array(32));
async function gcmKey() {
  return crypto.subtle.importKey("raw", rawKey, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

function makeBridge({ failWrap = false, failUnwrap = false } = {}) {
  return {
    bioSupported: () => true,
    bioWrap(vaultB64, token) {
      queueMicrotask(async () => {
        if (failWrap) return globalThis.__starlingBio(token, null);
        const nonce = crypto.getRandomValues(new Uint8Array(12));
        const ct = new Uint8Array(
          await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, await gcmKey(), b64uDecode(vaultB64)),
        );
        globalThis.__starlingBio(token, JSON.stringify({ nonce: b64uEncode(nonce), ct: b64uEncode(ct) }));
      });
    },
    bioUnwrap(nonceB64, ctB64, token) {
      queueMicrotask(async () => {
        if (failUnwrap) return globalThis.__starlingBio(token, null);
        try {
          const pt = await crypto.subtle.decrypt(
            { name: "AES-GCM", iv: b64uDecode(nonceB64) },
            await gcmKey(),
            b64uDecode(ctB64),
          );
          globalThis.__starlingBio(token, b64uEncode(new Uint8Array(pt)));
        } catch {
          globalThis.__starlingBio(token, null);
        }
      });
    },
  };
}

async function withBridge(bridge, fn) {
  globalThis.StarlingNative = bridge;
  try {
    return await fn();
  } finally {
    delete globalThis.StarlingNative;
  }
}

test("keystore wrap and unwrap roundtrip the vault key", async () => {
  await withBridge(makeBridge(), async () => {
    const K = newVaultKey();
    const rec = await makeBioRecord(K);
    assert.ok(rec);
    assert.equal(rec.kind, "android-keystore");
    assert.ok(rec.nonce instanceof Uint8Array);
    assert.ok(rec.ct instanceof Uint8Array);
    const back = await openBioRecord(rec);
    assert.deepEqual(back, K);
  });
});

test("a failed prompt yields null, never a bogus record or key", async () => {
  await withBridge(makeBridge({ failWrap: true }), async () => {
    assert.equal(await makeBioRecord(newVaultKey()), null);
  });
  await withBridge(makeBridge(), async () => {
    const rec = await makeBioRecord(newVaultKey());
    await withBridge(makeBridge({ failUnwrap: true }), async () => {
      assert.equal(await openBioRecord(rec), null);
    });
  });
});

test("a tampered ciphertext fails closed", async () => {
  await withBridge(makeBridge(), async () => {
    const rec = await makeBioRecord(newVaultKey());
    rec.ct[0] ^= 1;
    assert.equal(await openBioRecord(rec), null);
  });
});

test("a keystore record cannot open outside the wrapper", async () => {
  let rec;
  await withBridge(makeBridge(), async () => {
    rec = await makeBioRecord(newVaultKey());
  });
  assert.equal(await openBioRecord(rec), null);
});

test("the wrapper never offers WebAuthn and answers bio from the bridge", async () => {
  await withBridge({ bioSupported: () => true }, async () => {
    assert.equal(webauthnAvailable(), false);
    assert.equal(await bioAvailable(), true);
  });
  await withBridge({ bioSupported: () => false }, async () => {
    assert.equal(await bioAvailable(), false);
  });
  await withBridge(
    {
      bioSupported: () => {
        throw new Error("bridge died");
      },
    },
    async () => {
      assert.equal(await bioAvailable(), false);
    },
  );
});

test("a bridge that throws on wrap resolves null instead of hanging", async () => {
  await withBridge(
    {
      bioSupported: () => true,
      bioWrap() {
        throw new Error("no activity");
      },
    },
    async () => {
      assert.equal(await makeBioRecord(newVaultKey()), null);
    },
  );
});
