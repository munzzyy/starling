// Replays test/vectors/*.json against the shipped implementation.
//
// The vectors are the artifact an independent implementation checks itself
// against, so this file has one job: fail loudly the moment the code and the
// recorded bytes disagree. Where a value can be recomputed without touching
// app/js at all it is, using node:crypto directly, so the vectors are pinned to
// the primitive rather than to our own wrapper around it.
//
// Regenerate with: node tools/gen-vectors.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { hkdfSync, createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

import {
  PROTO,
  PAD_LEN,
  aadFor,
  sigBase,
  b64uDecode,
  b64uEncode,
  bytesToHex,
  memberIdFromKeys,
  safetyNumber,
  rosterHash,
  verifySig,
} from "../app/js/wire.js";
import {
  EPOCH_MS,
  deriveAnchor,
  chainInit,
  chainStep,
  channelFromAnchor,
  createRatchet,
} from "../app/js/ratchet.js";
import {
  openMessage,
  openSealed,
  deriveInviteChannelId,
  deriveInviteKey,
  parseInviteFragment,
  deriveHelpChannelId,
  deriveHelpEncKey,
} from "../app/js/crypto.js";
import { openGeneration, rekeyContext } from "../app/js/rekey.js";
import { inviterMatches, openWelcome, welcomeContext } from "../app/js/membership.js";
import { createRoster } from "../app/js/net.js";

const subtle = globalThis.crypto.subtle;
const te = new TextEncoder();
const HERE = path.dirname(fileURLToPath(import.meta.url));

const load = (name) => JSON.parse(fs.readFileSync(path.join(HERE, "vectors", `${name}.json`), "utf8"));
const hexToBytes = (h) => Uint8Array.from(h.match(/../g) ?? [], (b) => parseInt(b, 16));

// HKDF straight from node:crypto, so the vectors are checked against the
// primitive and not against our own call into WebCrypto.
const hkdfRef = (ikmHex, info, len) =>
  new Uint8Array(hkdfSync("sha256", hexToBytes(ikmHex), new Uint8Array(32), te.encode(info), len));

const aesKey = (rawHex) =>
  subtle.importKey("raw", hexToBytes(rawHex), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);

// ------------------------------------------------------------------ hkdf.json

test("vectors: every HKDF info string derives its recorded output", async () => {
  const v = load("hkdf");
  assert.equal(v.proto, PROTO);
  assert.equal(v.salt, "00".repeat(32), "the salt is 32 zero bytes everywhere");
  assert.ok(v.cases.length >= 11, "every label in the protocol has a case");
  for (const c of v.cases) {
    assert.ok(c.info.startsWith(`${PROTO}/`), `${c.info} is domain separated`);
    assert.equal(bytesToHex(hkdfRef(c.ikm, c.info, c.len)), c.okm, c.info);
    assert.equal(c.okm.length, c.len * 2);
  }
  // No two labels may collide on one input, or a value derived for one purpose
  // would be usable for another.
  const outs = new Set(v.cases.map((c) => c.okm));
  assert.equal(outs.size, v.cases.length);
});

test("vectors: the app derives the same bytes the HKDF vectors record", async () => {
  const v = load("hkdf");
  const by = (info) => v.cases.find((c) => c.info === info);

  const anchorCase = by(`${PROTO}/anchor`);
  assert.equal(bytesToHex(await deriveAnchor(hexToBytes(anchorCase.ikm))), anchorCase.okm);

  const chanCase = by(`${PROTO}/channel-id`);
  assert.equal(await channelFromAnchor(hexToBytes(chanCase.ikm)), chanCase.okm);

  const chainCase = by(`${PROTO}/chain`);
  assert.equal(bytesToHex(await chainInit(hexToBytes(chainCase.ikm))), chainCase.okm);

  const stepCase = by(`${PROTO}/step`);
  assert.equal(bytesToHex(await chainStep(hexToBytes(stepCase.ikm))), stepCase.okm);

  const inviteChan = by(`${PROTO}/invite-channel`);
  assert.equal(await deriveInviteChannelId(hexToBytes(inviteChan.ikm)), inviteChan.okm);

  const helpChan = by(`${PROTO}/help-channel-id`);
  assert.equal(await deriveHelpChannelId(hexToBytes(helpChan.ikm)), helpChan.okm);

  // The two sealing keys are non-extractable, so they get pinned by opening
  // something the vector's raw bytes sealed.
  for (const [info, derive] of [
    [`${PROTO}/invite-enc`, deriveInviteKey],
    [`${PROTO}/help-enc`, deriveHelpEncKey],
  ]) {
    const c = by(info);
    const derived = await derive(hexToBytes(c.ikm));
    const pinned = await aesKey(c.okm);
    const iv = new Uint8Array(12);
    const ct = await subtle.encrypt({ name: "AES-GCM", iv }, pinned, te.encode("pin"));
    const pt = await subtle.decrypt({ name: "AES-GCM", iv }, derived, ct);
    assert.equal(new TextDecoder().decode(pt), "pin", info);
  }
});

// ----------------------------------------------------------------- chain.json

test("vectors: the chain advances to its recorded keys, including the long jump", async () => {
  const v = load("chain");
  const seed = hexToBytes(v.seed);
  assert.equal(bytesToHex(await deriveAnchor(new Uint8Array(seed))), v.anchor);
  assert.equal(await channelFromAnchor(hexToBytes(v.anchor)), v.channel);
  assert.equal(v.epochMs, EPOCH_MS);

  let ck = await chainInit(new Uint8Array(seed));
  for (const step of v.steps) {
    if (step.i > 0) ck = await chainStep(ck);
    assert.equal(step.e, v.e0 + step.i, "e is e0 plus the step count");
    assert.equal(bytesToHex(ck), step.ck, `CK_${step.i}`);
  }

  // The long jump is the step an implementation is most likely to get wrong,
  // because it is the only place the chain runs more than one step at a time.
  let far = await chainInit(new Uint8Array(seed));
  for (let i = 1; i <= v.jump.i; i++) far = await chainStep(far);
  assert.equal(bytesToHex(far), v.jump.ck, `CK_${v.jump.i}`);
  assert.notEqual(v.jump.ck, v.steps.at(-1).ck);
});

// ------------------------------------------------------------------ keys.json

test("vectors: (epoch, member) derives the recorded content key", async () => {
  const v = load("keys");
  for (const entry of v.entries) {
    assert.equal(
      bytesToHex(hkdfRef(entry.ck, `${PROTO}/msg|${entry.member}`, 32)),
      entry.key,
      `e=${entry.e} m=${entry.memberLabel}`,
    );
  }
  // Per sender, not per epoch: two members in the same epoch never share a key.
  const perEpoch = new Map();
  for (const e of v.entries) {
    const seen = perEpoch.get(e.e) || new Set();
    assert.ok(!seen.has(e.key), `two members share a key in epoch ${e.e}`);
    seen.add(e.key);
    perEpoch.set(e.e, seen);
  }
});

test("vectors: the ratchet hands back the same content key the vectors record", async () => {
  const v = load("keys");
  const seal = v.seal;
  const ck0 = await chainInit(hexToBytes(v.seed));
  const ratchet = createRatchet({ e0: v.e0, ck0, historyEpochs: 144 });
  const key = await ratchet.keyFor(seal.e, seal.member, seal.e * EPOCH_MS);
  assert.ok(key, "the epoch is inside the window");
  // The ratchet's key is non-extractable, so it is pinned by opening the
  // ciphertext the vector's raw key bytes produced.
  const opened = await openMessage(
    key,
    seal.channel,
    seal.member,
    seal.e,
    seal.ts,
    hexToBytes(seal.nonce),
    b64uDecode(seal.ciphertext),
  );
  assert.deepEqual(opened, seal.plaintext);
});

test("vectors: the nonce is a zeroed guard followed by ts big-endian", () => {
  const v = load("keys").nonce;
  const n = hexToBytes(v.nonce);
  assert.equal(n.length, 12);
  assert.equal(bytesToHex(n.subarray(0, 4)), v.guard);
  assert.equal(new DataView(n.buffer, n.byteOffset).getBigUint64(4, false), BigInt(v.ts));
});

test("vectors: the recorded seal opens to its plaintext and nothing else", async () => {
  const v = load("keys").seal;
  const key = await aesKey(v.key);
  const n = hexToBytes(v.nonce);
  const ct = b64uDecode(v.ciphertext);
  assert.equal(ct.length, PAD_LEN + 16, "padded to PAD_LEN, plus the GCM tag");
  assert.equal(v.aad, new TextDecoder().decode(aadFor(v.channel, v.member, v.e, v.ts)));

  const pt = new TextDecoder().decode(
    await subtle.decrypt({ name: "AES-GCM", iv: n, additionalData: te.encode(v.aad) }, key, ct),
  );
  assert.equal(te.encode(pt).length, v.paddedLen);
  assert.deepEqual(JSON.parse(pt), v.plaintext);

  // The AAD binds channel, member, epoch and ts. Move any one of them and the
  // same bytes stop opening.
  for (const [what, aad] of [
    ["channel", aadFor("f".repeat(32), v.member, v.e, v.ts)],
    ["member", aadFor(v.channel, "0".repeat(32), v.e, v.ts)],
    ["epoch", aadFor(v.channel, v.member, v.e + 1, v.ts)],
    ["ts", aadFor(v.channel, v.member, v.e, v.ts + 1)],
  ]) {
    await assert.rejects(
      subtle.decrypt({ name: "AES-GCM", iv: n, additionalData: aad }, key, ct),
      `${what} is bound by the AAD`,
    );
  }
});

// --------------------------------------------------------------- strings.json

test("vectors: aad and sigBase are byte-for-byte what the vector records", () => {
  const v = load("strings");
  const m = v.message;
  const aad = aadFor(m.channel, m.member, m.e, m.ts);
  assert.equal(new TextDecoder().decode(aad), v.aad.string);
  assert.equal(bytesToHex(aad), v.aad.hex);
  assert.equal(aad.length, v.aad.len);

  const base = sigBase(m.channel, m.member, m.e, m.ts, m.n, m.c);
  assert.equal(base, v.sigBase.string);
  assert.equal(bytesToHex(te.encode(base)), v.sigBase.hex);

  // sigBase is the aad with the nonce and ciphertext appended: the signature
  // covers strictly more than the AEAD does, never less.
  assert.ok(base.startsWith(v.aad.string));
  assert.equal(base, `${v.aad.string}|${m.n}|${m.c}`);
});

// -------------------------------------------------------------- identity.json

test("vectors: member ids and safety numbers match for every recorded key pair", async () => {
  const v = load("identity");
  assert.equal(v.memberLabel, `${PROTO}/member`);
  assert.equal(v.fpLabel, `${PROTO}/fp`);
  for (const c of v.cases) {
    const pk = b64uDecode(c.pk);
    const epk = b64uDecode(c.epk);
    assert.equal(await memberIdFromKeys(pk, epk), c.memberId, c.label);
    assert.equal(await safetyNumber(pk, epk), c.safetyNumber, c.label);
    assert.match(c.memberId, /^[0-9a-f]{32}$/);
    assert.match(c.safetyNumber, /^(\d{5} ){5}\d{5}$/);
    // 128 bits of a SHA-256 over the label and both keys, in that order.
    const digest = createHash("sha256")
      .update(Buffer.concat([Buffer.from(`${PROTO}/member`), Buffer.from(pk), Buffer.from(epk)]))
      .digest("hex");
    assert.equal(digest.slice(0, 32), c.memberId, `${c.label} id is the truncated digest`);
  }
  // The id commits to both keys: swapping which pair it came from changes it.
  const [a, b] = v.cases;
  const crossed = await memberIdFromKeys(b64uDecode(a.pk), b64uDecode(b.epk));
  assert.notEqual(crossed, a.memberId);
  assert.notEqual(crossed, b.memberId);
});

// --------------------------------------------------------------- session.json

const session = load("session");
const memberOf = (label) => session.members.find((m) => m.label === label);
const genOf = (g) => session.generations.find((x) => x.g === g);

async function openGen(g, historyEpochs = 6) {
  const rec = genOf(g);
  return openGeneration({ seed: hexToBytes(rec.seed), g: rec.g, e0: rec.e0, historyEpochs });
}

// One member's ECDH private key, imported from the frozen pkcs8 the generator
// used. Only the recipient of a wrap can open it, which is the whole point.
const ECDH_SK = {
  A: "MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQg09_ycQehVMRJblO_2Io5GUF-TtzQk9xqakW9wY7KYC-hRANCAAQn9XGgpcnXc1t3i-zxwC5hpekTOxf-c9JRXHlCZdFY8HLxUZJtOnsEbwZQgRbJMc_AJbXfeRFaPKsWcRxHntzZ",
  B: "MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgME_l18LUcwrkrcvLRibj_AsjQv68fOt_rU0jCznLdpehRANCAASuuJtXQqTwr703JGsjX3deKsCnF6Elt7Q-hEDJdiDiW8AaZkuf0ArPSzdikzr6_Pfc0MWYCznpI_smhEOt8RMC",
  C: "MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgixzMTYy8CWT_UMeqsede_AIh8C0zejRahM5H4pR1CgyhRANCAAS5THdMBaF0cPLNEQPOeA1S3qAz27Xe3v9q4N0y1EPYnt6sxdwgBC_2M99mReI947B0Ai2olUNarIhPbxk6y8I1",
};

async function identityFor(label) {
  const m = memberOf(label);
  return {
    alg: m.alg,
    pk: b64uDecode(m.pk),
    epk: b64uDecode(m.epk),
    memberId: m.memberId,
    ecdhPrivate: await subtle.importKey(
      "pkcs8",
      b64uDecode(ECDH_SK[label]),
      { name: "ECDH", namedCurve: "P-256" },
      false,
      ["deriveBits"],
    ),
  };
}

test("vectors: the session's members and generations derive from their seeds", async () => {
  for (const m of session.members) {
    const pk = b64uDecode(m.pk);
    const epk = b64uDecode(m.epk);
    assert.equal(await memberIdFromKeys(pk, epk), m.memberId, m.label);
    assert.equal(await safetyNumber(pk, epk), m.safetyNumber, m.label);
  }
  for (const rec of session.generations) {
    assert.equal(bytesToHex(await deriveAnchor(hexToBytes(rec.seed))), rec.anchor, `g${rec.g} anchor`);
    assert.equal(bytesToHex(await chainInit(hexToBytes(rec.seed))), rec.ck0, `g${rec.g} CK_0`);
    const gen = await openGen(rec.g);
    assert.equal(gen.channelId, rec.channel, `g${rec.g} channel`);
    assert.equal(await rosterHash(rec.roster), rec.rosterHash, `g${rec.g} roster hash`);
  }
  // Every generation lands on its own channel, which is what stops a relay
  // correlating a circle across re-keys and what a removed member cannot follow.
  const channels = new Set(session.generations.map((g) => g.channel));
  assert.equal(channels.size, session.generations.length);
});

test("vectors: every recorded post carries a signature that verifies", async () => {
  const posts = [];
  for (const s of session.steps) {
    if (s.post) posts.push({ note: s.kind, post: s.post, channel: s.channel });
    for (const p of s.posts || []) posts.push({ note: s.kind, post: p.post, channel: s.fromChannel });
  }
  assert.ok(posts.length >= 7, "the session records a real amount of traffic");
  for (const { note, post, channel } of posts) {
    const base = sigBase(channel, post.m, post.e, post.ts, post.n, post.c);
    assert.equal(await verifySig(post.alg, b64uDecode(post.pk), b64uDecode(post.sig), base), true, note);
    assert.equal(await memberIdFromKeys(b64uDecode(post.pk), b64uDecode(post.epk)), post.m, `${note} id binding`);
  }
});

test("vectors: every accepted location post opens to its recorded plaintext", async () => {
  const gens = new Map();
  for (const rec of session.generations) gens.set(rec.g, await openGen(rec.g, 144));

  for (const s of session.steps) {
    if (s.kind !== "post" || s.expect !== "accept") continue;
    const gen = gens.get(s.g);
    assert.equal(gen.channelId, s.channel);
    const key = await gen.ratchet.keyFor(s.e, s.post.m, s.e * EPOCH_MS);
    assert.ok(key, `a key for epoch ${s.e}`);
    const opened = await openMessage(
      key,
      s.channel,
      s.post.m,
      s.e,
      s.ts,
      b64uDecode(s.post.n),
      b64uDecode(s.post.c),
    );
    assert.deepEqual(opened, s.plaintext, s.note);
    assert.equal(opened.ts, s.post.ts, "the sealed ts is the one the header committed to");
  }
});

test("vectors: the join request opens under the invite key and nothing else", async () => {
  const step = session.steps.find((s) => s.kind === "join-request");
  assert.equal(await deriveInviteChannelId(hexToBytes(session.invite.secret)), session.invite.channel);
  assert.equal(step.channel, session.invite.channel);

  const key = await deriveInviteKey(hexToBytes(session.invite.secret));
  const opened = await openMessage(
    key,
    step.channel,
    step.post.m,
    step.e,
    step.ts,
    b64uDecode(step.post.n),
    b64uDecode(step.post.c),
  );
  assert.deepEqual(opened, step.plaintext);
  // The keys the request carries are the keys the id commits to, which is what
  // the inviter checks before showing a human a safety number.
  const C = memberOf("C");
  assert.equal(opened.pk, C.pk);
  assert.equal(opened.epk, C.epk);
  assert.equal(step.safetyNumber, C.safetyNumber);

  // A different invite secret is a different channel and a dead key.
  const wrong = await deriveInviteKey(hexToBytes("11".repeat(32)));
  assert.equal(
    await openMessage(wrong, step.channel, step.post.m, step.e, step.ts, b64uDecode(step.post.n), b64uDecode(step.post.c)),
    null,
  );
});

test("vectors: a re-key reaches its recipients and lands them on the recorded channel", async () => {
  for (const step of session.steps.filter((s) => s.kind === "rekey" || s.kind === "removal")) {
    const from = genOf(step.fromG);
    const to = genOf(step.toG);
    assert.equal(step.fromChannel, from.channel);

    for (const p of step.posts) {
      const recipient = await identityFor(p.to);
      const body = p.plaintext;
      assert.equal(body.to, recipient.memberId, "a wrap names its recipient");
      assert.equal(body.g, step.toG, "exactly one generation forward");
      assert.equal(body.me, step.mixEpoch, "the mix epoch travels on the wire, not just in the AAD");
      assert.equal(body.rh, step.rosterHash);
      assert.deepEqual(body.rm, step.removed);

      const ns = await openSealed(
        recipient,
        b64uDecode(body.eph),
        step.fromChannel,
        recipient.memberId,
        b64uDecode(body.w),
        step.context,
      );
      assert.ok(ns, `${p.to} can open the wrap addressed to them`);
      assert.equal(bytesToHex(ns), step.ns);

      // A wrap addressed to one member does not open for another, even though
      // both are in the circle: the recipient is in the info string and the AAD.
      for (const other of ["A", "B", "C"].filter((l) => l !== p.to)) {
        const wrong = await identityFor(other);
        assert.equal(
          await openSealed(wrong, b64uDecode(body.eph), step.fromChannel, wrong.memberId, b64uDecode(body.w), step.context),
          null,
          `${other} must not open ${p.to}'s wrap`,
        );
      }

      // The same wrap does not open under a claim other than the one it was
      // sealed for: this is the property the members screen depends on, not a
      // side effect. Flip the rotator, or the removal list, and the AAD no
      // longer matches, so the wrap fails to decrypt rather than opening and
      // lying about who did it.
      const forgedByOther = rekeyContext({
        by: recipient.memberId,
        g: body.g,
        e0: step.mixEpoch,
        me: step.mixEpoch,
        rh: body.rh,
        rm: body.rm,
      });
      assert.equal(
        await openSealed(recipient, b64uDecode(body.eph), step.fromChannel, recipient.memberId, b64uDecode(body.w), forgedByOther),
        null,
        `${p.to}'s wrap must not open under a forged rotator claim`,
      );
      const forgedRemoval = rekeyContext({
        by: step.by ? (await identityFor(step.by)).memberId : undefined,
        g: body.g,
        e0: step.mixEpoch,
        me: step.mixEpoch,
        rh: body.rh,
        rm: [...body.rm, recipient.memberId],
      });
      assert.equal(
        await openSealed(recipient, b64uDecode(body.eph), step.fromChannel, recipient.memberId, b64uDecode(body.w), forgedRemoval),
        null,
        `${p.to}'s wrap must not open under a forged removal list`,
      );
    }

    // seed_{g+1} = HKDF(CK_e || NS, "rekey"), from the chain key at the NAMED
    // epoch. Rotator and receiver process a re-key at different moments, so a
    // guessed epoch would silently produce two circles that cannot talk.
    const ratchet = createRatchet({
      e0: step.mixEpoch,
      ck0: hexToBytes(step.ckAtMixEpoch),
      historyEpochs: 6,
    });
    const seed = await ratchet.nextSeed(hexToBytes(step.ns), step.mixEpoch);
    assert.equal(bytesToHex(seed), step.seed, `g${step.toG} seed`);
    assert.equal(step.seed, to.seed);

    const next = await openGeneration({ seed: hexToBytes(step.seed), g: step.toG, e0: step.mixEpoch, historyEpochs: 6 });
    assert.equal(next.channelId, to.channel, `g${step.toG} channel`);
    assert.notEqual(next.channelId, from.channel, "a re-key always moves the circle");
  }
});

test("vectors: the welcome hands the joiner the new generation's seed", async () => {
  const step = session.steps.find((s) => s.kind === "welcome");
  const C = await identityFor("C");
  const A = memberOf(step.by);
  const commit = b64uDecode(session.invite.commitment);
  const from = { memberId: A.memberId, alg: A.alg, pk: A.pk, epk: A.epk };

  // The recorded context is the one the shipped builder makes, and the wrap
  // only opens under it.
  assert.equal(step.context, welcomeContext({ by: A.memberId, g: step.g, e0: step.e0 }));
  assert.equal(await inviterMatches(commit, from), true);

  const obj = { t: "welcome", g: step.g, e0: step.e0, n: step.n, eph: step.eph, w: step.w };
  // A welcome is bounded against the epoch its header was signed under, and
  // the recorded step is one moment: the generation opens in the epoch the
  // welcome is posted in.
  const opened = await openWelcome({ identity: C, chanId: step.channel, commit, from, obj, epoch: step.e0 });
  assert.ok(opened, "the vector's welcome must open as the inviter the link commits to");
  assert.equal(bytesToHex(opened.seed), step.seed);
  assert.equal(step.seed, genOf(step.g).seed);

  // The link's fragment carries both halves, and the commitment in it is the
  // one this welcome was checked against.
  const frag = parseInviteFragment(session.invite.fragment);
  assert.equal(bytesToHex(frag.secret), session.invite.secret);
  assert.deepEqual(frag.commit, commit);

  // And the same bytes from anybody else are refused. This is the takeover the
  // commitment exists to stop: whoever else saw the link answers first, because
  // the real inviter has to be online and tap accept.
  const B = memberOf("B");
  assert.equal(
    await openWelcome({
      identity: C,
      chanId: step.channel,
      commit,
      from: { memberId: B.memberId, alg: B.alg, pk: B.pk, epk: B.epk },
      obj,
      epoch: step.e0,
    }),
    null,
  );
  // A welcome with no record count is not a welcome.
  const { n, ...noCount } = obj;
  void n;
  assert.equal(
    await openWelcome({ identity: C, chanId: step.channel, commit, from, obj: noCount, epoch: step.e0 }),
    null,
  );
  // The raw wrap does not open under the empty context the old build used.
  assert.equal(await openSealed(C, b64uDecode(step.eph), step.channel, C.memberId, b64uDecode(step.w)), null);

  // The welcome is what the joiner gets INSTEAD of a backlog: the generation it
  // opens did not exist when the invitation was minted.
  const gen = await openGeneration({ seed: hexToBytes(step.seed), g: step.g, e0: step.e0, historyEpochs: 6 });
  assert.equal(gen.channelId, genOf(step.g).channel);
  assert.notEqual(gen.channelId, genOf(0).channel);
});

test("vectors: a removed member holding the old chain key cannot follow the re-key", async () => {
  const step = session.steps.find((s) => s.kind === "removal");
  const B = memberOf("B");
  assert.deepEqual(step.removed, [B.memberId]);
  assert.ok(!step.posts.some((p) => p.plaintext.to === B.memberId), "no wrap is addressed to B");

  // B really does hold the generation-1 chain key at the epoch the seed was
  // mixed from. That is the strongest position a removed member is ever in.
  const held = hexToBytes(step.holdout.holds);
  assert.equal(step.holdout.holds, step.ckAtMixEpoch);
  const g1 = genOf(1);
  let ck = await chainInit(hexToBytes(g1.seed));
  for (let e = g1.e0; e < step.mixEpoch; e++) ck = await chainStep(ck);
  assert.equal(bytesToHex(ck), step.holdout.holds, "B's chain key is genuinely generation 1's");

  // And it buys nothing. NS2 is the only input B is missing, so pin that first:
  // with NS2 the chain key B holds reaches seed_2 exactly. Without it, every
  // seed B can compute is a different one, and the channel the circle moved to
  // is not derivable from anything B has.
  const ratchet = createRatchet({ e0: step.mixEpoch, ck0: new Uint8Array(held), historyEpochs: 6 });
  const withNs = await ratchet.nextSeed(hexToBytes(step.ns), step.mixEpoch);
  assert.equal(bytesToHex(withNs), step.seed, "NS2 is the whole of what B is missing");
  const guesses = [
    new Uint8Array(32),
    new Uint8Array(32).fill(0xff),
    hexToBytes(session.fixed.ns1),
    hexToBytes(session.fixed.seed0),
    new Uint8Array(held),
  ];
  for (const guess of guesses) {
    const seed = await ratchet.nextSeed(guess, step.mixEpoch);
    assert.notEqual(bytesToHex(seed), step.holdout.cannotDerive, "a guessed NS must not hit seed_2");
    assert.notEqual(bytesToHex(seed), bytesToHex(withNs), "and must not reach where NS2 reaches");
    const gen = await openGeneration({ seed, g: 2, e0: step.mixEpoch, historyEpochs: 6 });
    assert.notEqual(gen.channelId, step.holdout.cannotReach, "and must not land on generation 2's channel");
  }
  assert.equal(step.holdout.cannotReach, genOf(2).channel);
});

test("vectors: the same point delivered twice is accepted exactly once", async () => {
  const first = session.steps[0];
  const replay = session.steps.find((s) => s.kind === "replay");
  assert.equal(replay.expect, "reject");
  assert.deepEqual(replay.post, first.post, "the replay is the same bytes, not a re-seal");

  const gen = await openGen(0, 144);
  const roster = createRoster({
    channelId: gen.channelId,
    ratchet: gen.ratchet,
    selfId: "0".repeat(32),
    pinned: new Map(),
  });
  const entry = (post) => ({
    m: post.m,
    alg: post.alg,
    pk: post.pk,
    epk: post.epk,
    points: [{ e: post.e, ts: post.ts, srv: post.ts, n: post.n, c: post.c, sig: post.sig }],
  });

  const now = (first.e + 1) * EPOCH_MS;
  await roster.ingest([entry(first.post)], now);
  const rec = roster.get(first.post.m);
  assert.ok(rec, "the honest delivery lands");
  assert.equal(rec.lat, first.plaintext.lat);
  assert.equal(rec.trail.length, 1);

  await roster.ingest([entry(replay.post)], now);
  assert.equal(roster.get(first.post.m).trail.length, 1, "the replay adds nothing");
});

test("vectors: a replayed control message is acted on exactly once", async () => {
  // A location replay is stopped twice over, because the position record also
  // refuses anything not newer than what it holds. A control message has no
  // such second rule, so replaying the recorded re-key is what actually tests
  // the per-member (e, ts) high-water mark.
  const step = session.steps.find((s) => s.kind === "rekey");
  const post = step.posts[0].post;
  const gen = await openGen(step.fromG, 144);
  assert.equal(gen.channelId, step.fromChannel);

  const control = [];
  // The rotator is pinned before the pass that carries the re-key, which is
  // both what happens in life and what the receiver requires: a control
  // message from a member we have never seen is dropped rather than obeyed.
  const control_pinned = new Map([
    [post.m, { alg: post.alg, pk: post.pk, epk: post.epk, verified: false }],
  ]);
  const roster = createRoster({
    channelId: gen.channelId,
    ratchet: gen.ratchet,
    selfId: "0".repeat(32),
    pinned: control_pinned,
    onControl: (from, obj, e) => control.push([from, obj.t, obj.ts, e]),
  });
  const feed = {
    m: post.m,
    alg: post.alg,
    pk: post.pk,
    epk: post.epk,
    points: [{ e: post.e, ts: post.ts, srv: post.ts, n: post.n, c: post.c, sig: post.sig }],
  };
  const now = (post.e + 1) * EPOCH_MS;

  await roster.ingest([feed], now);
  assert.equal(control.length, 1, "the re-key is delivered");
  assert.deepEqual(control[0], [post.m, "rekey", post.ts, post.e]);

  for (let i = 0; i < 5; i++) await roster.ingest([structuredClone(feed)], now);
  assert.equal(control.length, 1, "and replaying it changes nothing");
  assert.equal(roster.list().length, 0, "a control message is not a position");
});

test("vectors: an out-of-order point still opens, and one past the window does not", async () => {
  const late = session.steps.find((s) => s.kind === "post" && s.expect === "accept" && s.deliveredAtEpoch);
  const gone = session.steps.find((s) => s.kind === "post" && s.expect === "reject");
  assert.ok(late && gone);
  assert.equal(gone.post.n, late.post.n, "the same point, delivered later");

  // Delivered a few epochs late: the key is chosen by the epoch on the wire and
  // that epoch is still inside the retained window.
  const g = await openGen(late.g, late.historyEpochs);
  await g.ratchet.syncToClock(late.deliveredAtEpoch * EPOCH_MS);
  const key = await g.ratchet.keyFor(late.e, late.post.m, late.deliveredAtEpoch * EPOCH_MS);
  assert.ok(key, "the epoch is still retained");
  assert.deepEqual(
    await openMessage(key, late.channel, late.post.m, late.e, late.ts, b64uDecode(late.post.n), b64uDecode(late.post.c)),
    late.plaintext,
  );

  // Delivered after the window closed: nothing about the point changed, the key
  // it needs is gone. That is the forward secrecy, not a bug.
  const g2 = await openGen(gone.g, gone.historyEpochs);
  await g2.ratchet.syncToClock(gone.deliveredAtEpoch * EPOCH_MS);
  assert.equal(await g2.ratchet.keyFor(gone.e, gone.post.m, gone.deliveredAtEpoch * EPOCH_MS), null);
  assert.ok(!g2.ratchet.retainedEpochs().includes(gone.e));
});

test("vectors: the recorded post bodies are exactly what buildPost emits", async () => {
  // Field names and encodings, not just values: a receiver written from the
  // vectors has to find the same keys on the wire.
  for (const s of session.steps) {
    const posts = s.post ? [s.post] : (s.posts || []).map((p) => p.post);
    for (const post of posts) {
      assert.deepEqual(
        Object.keys(post).sort(),
        ["alg", "c", "e", "epk", "m", "n", "pk", "sig", "ts"],
        s.kind,
      );
      assert.equal(b64uEncode(b64uDecode(post.n)).length, post.n.length);
      assert.equal(b64uDecode(post.n).length, 12);
      assert.equal(b64uDecode(post.c).length, PAD_LEN + 16);
      assert.equal(b64uDecode(post.sig).length, 64);
    }
  }
});
