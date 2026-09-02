// Networking: the poll loop, the authenticated sender, and the member roster
// built from decrypted points. All verification the receiver owes the protocol
// happens here: key binding, signature, epoch selection, GCM open, replay,
// timestamp windows, TTL expiry.
//
// Nothing here trusts the relay. Every check the relay performs on the way in
// is performed again on the way out, because an untrusted party's verdict is
// worth nothing.

import {
  FUTURE_SKEW_MS,
  MEMBER_CAP,
  TTL_MS,
  TRAIL_CAP,
  algFromPk,
  b64uDecode,
  b64uEncode,
  memberIdFromKeys,
  sigBase,
  validEcdhKey,
  verifySig,
} from "./wire.js";
import { openMessage, sealMessage, buildPost } from "./crypto.js";
import { admitPinned, keyChangeVerdict } from "./roster.js";
import { EPOCH_MS, epochAt } from "./ratchet.js";
import { apiUrl } from "./env.js";

const POLL_MS = 10000;
const BACKOFF_MAX_MS = 120000;

export const STALE_MS = 3 * 60 * 1000;

export function statusOf(rec, now) {
  if (rec.type === "bye") return "stopped";
  if (now - rec.ts > STALE_MS) return "stale";
  if (rec.type === "sos") return "sos";
  if (rec.type === "checkin") return "checkin";
  return "live";
}

const RANK = { sos: 0, live: 1, checkin: 1, stale: 2, stopped: 3 };

export function sortMembers(list, now) {
  return [...list].sort((a, b) => {
    const ra = RANK[statusOf(a, now)];
    const rb = RANK[statusOf(b, now)];
    return ra !== rb ? ra - rb : b.ts - a.ts;
  });
}

// Roster: verify, decrypt and merge incoming points into per-member records.
//
// `pinned` is the caller's durable map of memberId -> { alg, pk, epk, verified,
// name }. Pinning happens HERE and only for members whose id genuinely commits
// to the keys presented. A member whose pinned keys change is not silently
// re-pinned: their points are dropped and the change is surfaced, because
// re-pinning on the relay's say-so is the whole of the "burgle into the group"
// attack.
export function createRoster({ channelId, ratchet, selfId, pinned, onControl, onKeyChange }) {
  const members = new Map();
  const seen = new Map(); // memberId -> { e, ts } of the last accepted position
  // Control messages get their own dedup, a bounded set rather than a moving
  // high-water mark.
  //
  // Sharing the watermark with positions handed an untrusted relay a way to
  // suppress one member's re-key permanently: serve a LATER position first,
  // the watermark moves past the re-key, and the re-key is then rejected
  // forever when it finally arrives. Withholding a message is a power the
  // relay always has, but making the client refuse it afterwards turns a
  // temporary withholding into a permanent one.
  const controlSeen = new Set();
  const CONTROL_SEEN_CAP = 512;

  function controlFresh(id, e, ts) {
    const key = `${id}|${e}|${ts}`;
    if (controlSeen.has(key)) return false;
    controlSeen.add(key);
    if (controlSeen.size > CONTROL_SEEN_CAP) {
      controlSeen.delete(controlSeen.values().next().value);
    }
    return true;
  }

  function accepted(id, e, ts) {
    const last = seen.get(id);
    // Strictly increasing (epoch, ts). A hash ratchet gives no replay
    // resistance and one key covers a whole epoch, so a recorded point stays
    // decryptable for the rest of it. Replaying a location is a real attack:
    // it puts someone where they no longer are.
    if (last && (e < last.e || (e === last.e && ts <= last.ts))) return false;
    seen.set(id, { e, ts });
    return true;
  }

  async function ingest(entries, now = Date.now()) {
    for (const entry of entries || []) {
      if (!entry || typeof entry.m !== "string") continue;
      if (entry.m === selfId) continue;

      let pk, epk;
      try {
        pk = b64uDecode(entry.pk);
        epk = b64uDecode(entry.epk);
      } catch {
        continue;
      }

      // One home for the admission rules.
      //
      // This used to be a longhand copy of admitPinned: decode, derive the id
      // from both keys, take the algorithm from the key rather than the
      // relay's copy of it, require the agreement key to be a real point, and
      // enforce the cap. Four rules written out twice is how the last cap
      // shipped dead, so the live path goes through the module that owns them.
      //
      // The cap counts OTHERS, and self is not among them: the relay allows
      // MEMBER_CAP rows per channel and self holds one of them, so a receiver
      // that pinned MEMBER_CAP others would be believing a roster no honest
      // relay could ever serve. It was off by one in that direction.
      const verdict = await admitPinned({
        pinned,
        rec: { memberId: entry.m, pk: entry.pk, epk: entry.epk },
        cap: MEMBER_CAP - 1,
      });
      if (!verdict.ok) continue;
      // The record THIS entry presents, derived from its own keys. On an
      // already-pinned member admitPinned hands back the record we already
      // hold, so reading alg off it would compare the pinned record with
      // itself and the key-change check below could never fire.
      const alg = algFromPk(pk);
      const presented = { alg, pk: b64uEncode(pk), epk: b64uEncode(epk), verified: false, name: "" };

      const known = verdict.already ? verdict.entry : null;
      // Whether this member was pinned BEFORE this pass, not after. Pinning
      // happens below for a sender we have never seen, and a control message
      // arriving in that same pass would otherwise satisfy its own "is the
      // sender pinned" check with a key nobody had ever seen. That is the
      // whole of the burgle-into-the-group attack: a stranger posts a re-key,
      // gets pinned by it, and the re-key is then honoured. Control messages
      // are dispatched only for members who were already pinned when this
      // ingest began.
      const wasPinned = !!known;
      if (known) {
        // Defence in depth against a second preimage. The id commits to both
        // keys and admitPinned just checked that the presented keys derive to
        // it, so reaching here with different keys would mean two pairs
        // hashing to one 128 bit id. Compare bytes rather than the relay's
        // spelling: base64url leaves two unused bits in the last character, so
        // four strings decode to the same key and comparing text once read a
        // re-encoding as "this member's keys changed".
        if (keyChangeVerdict(known, presented) === "change") {
          onKeyChange?.(entry.m, { alg, pk: entry.pk, epk: entry.epk });
          continue;
        }
      } else {
        pinned?.set?.(entry.m, verdict.entry);
      }

      const points = [...(entry.points || [])].sort((a, b) => (a.e - b.e) || (a.ts - b.ts));
      let rec = members.get(entry.m);
      for (const p of points) {
        if (!Number.isSafeInteger(p.e) || !Number.isSafeInteger(p.ts)) continue;
        let n, c, sig;
        try {
          n = b64uDecode(p.n);
          c = b64uDecode(p.c);
          sig = b64uDecode(p.sig);
        } catch {
          continue;
        }
        // Verify the sender's signature here, on the receiving device. GCM
        // alone proves only that someone holding a key of this circle wrote
        // this; the signature is what says which member did.
        if (!(await verifySig(alg, pk, sig, sigBase(channelId, entry.m, p.e, p.ts, p.n, p.c)))) continue;

        // Exactly one key is ever tried, selected by the carried epoch. An
        // epoch that has left the history window returns null and the point is
        // dropped: that is the forward secrecy working, not a failure.
        const key = await ratchet.keyFor(p.e, entry.m, now);
        if (!key) continue;

        const obj = await openMessage(key, channelId, entry.m, p.e, p.ts, n, c);
        if (!obj || !Number.isFinite(obj.ts)) continue;
        // The sealed ts must be the one the header committed to, or a relay
        // could re-file a point under a different nonce/AAD pairing.
        if (obj.ts !== p.ts) continue;
        if (obj.ts > now + FUTURE_SKEW_MS) continue;
        if (obj.t === "rekey" || obj.t === "member") {
          // Order matters. Marking it seen BEFORE deciding whether we may act
          // on it burned a newcomer's very first re-key: they are pinned by
          // this same pass, so wasPinned is false, the message was dropped,
          // and the dedup set then refused it forever when they resent. The
          // freshness mark belongs to messages we actually dispatch.
          if (!wasPinned) continue;
          if (!controlFresh(entry.m, p.e, p.ts)) continue;
          // A control message changes who is in the circle and which channel
          // it lives on, so it is only ever acted on from a member we already
          // knew. Dropping it here rather than upstream keeps the rule next to
          // the pinning it depends on.
          await onControl?.(entry.m, obj, p.e);
          continue;
        }
        if (!accepted(entry.m, p.e, p.ts)) continue;

        if (!rec) {
          rec = { id: entry.m, ts: 0, trail: [] };
          members.set(entry.m, rec);
        }
        if (obj.ts <= rec.ts) continue;
        rec.ts = obj.ts;
        rec.type = typeof obj.t === "string" ? obj.t : "loc";
        if (typeof obj.name === "string") rec.name = obj.name.slice(0, 24);
        if (typeof obj.emoji === "string") rec.emoji = obj.emoji.slice(0, 8);
        if (Number.isFinite(obj.hue)) rec.hue = ((obj.hue % 360) + 360) % 360;
        if (typeof obj.bat === "number") rec.bat = obj.bat;
        if (obj.mode === "coarse" || obj.mode === "precise") rec.mode = obj.mode;
        if (Number.isFinite(obj.lat) && Number.isFinite(obj.lon)) {
          rec.lat = obj.lat;
          rec.lon = obj.lon;
          rec.acc = Number.isFinite(obj.acc) ? obj.acc : null;
          rec.trail.push({ lat: obj.lat, lon: obj.lon, ts: obj.ts });
          if (rec.trail.length > TRAIL_CAP) rec.trail.splice(0, rec.trail.length - TRAIL_CAP);
        }
      }
    }
    for (const [id, rec] of members) {
      if (now - rec.ts > TTL_MS) members.delete(id);
    }
  }

  return {
    ingest,
    list: () => [...members.values()],
    get: (id) => members.get(id),
    drop: (id) => {
      members.delete(id);
      seen.delete(id);
    },
    clear: () => {
      members.clear();
      seen.clear();
      controlSeen.clear();
    },
  };
}

// The oldest server time worth fetching. Points older than the history window
// cannot be decrypted by design, so there is no reason to pull them down.
export function windowStart(ratchet, now = Date.now()) {
  const oldest = ratchet.retainedEpochs()[0];
  if (!Number.isSafeInteger(oldest)) return 0;
  return Math.max(0, Math.min(now, oldest * EPOCH_MS));
}

// Poller: GET the channel feed every 10 s while visible, back off on failure,
// pause when hidden, poll immediately on return.
export function createPoller({ channelId, roster, ratchet, onChange, onStatus, onRetired }) {
  let since = ratchet ? windowStart(ratchet) : 0;
  let timer = 0;
  let inFlight = false;
  let failures = 0;
  let running = false;
  const seen = new Set();
  const SEEN_CAP = 4096;

  function remember(key) {
    seen.add(key);
    if (seen.size > SEEN_CAP) {
      for (const k of seen) {
        seen.delete(k);
        if (seen.size <= SEEN_CAP / 2) break;
      }
    }
  }

  function schedule(delay) {
    clearTimeout(timer);
    if (!running) return;
    timer = setTimeout(poll, delay);
  }

  async function poll() {
    if (!running || inFlight) return;
    if (document.visibilityState === "hidden") return;
    inFlight = true;
    try {
      const res = await fetch(apiUrl(`/api/v2/f/${channelId}?since=${since}`), { cache: "no-store" });
      // The relay retires a protocol version by answering 410 rather than by
      // going quiet, so an out-of-date client says so instead of syncing into
      // an empty channel nobody else is on.
      if (res.status === 410) {
        running = false;
        clearTimeout(timer);
        onRetired?.();
        return;
      }
      if (!res.ok) throw new Error(`poll ${res.status}`);
      const data = await res.json();
      const fresh = (data.members || []).map((entry) => ({
        ...entry,
        points: (entry.points || []).filter((p) => !seen.has(`${entry.m}|${p.e}|${p.ts}|${p.n}`)),
      }));
      await roster.ingest(fresh);
      let maxCursor = since;
      for (const entry of data.members || []) {
        for (const p of entry.points || []) {
          remember(`${entry.m}|${p.e}|${p.ts}|${p.n}`);
          if (Number.isFinite(p.srv) && p.srv > maxCursor) maxCursor = p.srv;
        }
      }
      since = Math.max(since, maxCursor);
      // Advance the chain AFTER the backlog has been read, never before.
      //
      // Advancing first was worse than not advancing at all: a re-key that had
      // been sitting on the relay across an epoch boundary was destroyed by
      // the very tick that was about to fetch it, so the device stayed on a
      // generation the circle had already left, and a removed member was still
      // holding keys for it. Doing it here still means an idle listener
      // forgets on schedule, which is the whole reason it is on the poll path.
      await ratchet?.syncToClock?.();
      failures = 0;
      onStatus?.("ok");
      onChange?.();
      schedule(POLL_MS);
    } catch {
      failures += 1;
      if (failures >= 2) onStatus?.("reconnecting");
      const backoff = Math.min(POLL_MS * 2 ** (failures - 1), BACKOFF_MAX_MS);
      schedule(backoff * (0.8 + Math.random() * 0.4));
    } finally {
      inFlight = false;
    }
  }

  function onVisibility() {
    if (document.visibilityState === "visible") {
      poll();
    } else {
      clearTimeout(timer);
      onStatus?.("idle");
    }
  }

  return {
    start() {
      if (running) return;
      running = true;
      document.addEventListener("visibilitychange", onVisibility);
      poll();
    },
    stop() {
      running = false;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
      onStatus?.("idle");
    },
    pollNow: () => poll(),
  };
}

// Sender: pick the epoch, seal, sign, POST. Outgoing ts is strictly monotonic
// even if the clock steps backwards; the last sent ts is persisted by the
// caller, and the nonce carries a random reuse guard so a rolled-back ts still
// does not repeat a nonce.
export function createSender({ identity, channelId, ratchet, getLastTs, setLastTs }) {
  let chain = Promise.resolve();
  let cancelled = false;
  const ctl = new AbortController();

  function send(fields) {
    const job = chain.then(async () => {
      if (cancelled) throw new Error("sender cancelled");
      const last = (await getLastTs()) || 0;
      const ts = Math.max(Date.now(), last + 1);
      await setLastTs(ts);
      // Advancing on send is one of the two things that actually destroys the
      // past; the other is the boot-time sync.
      const epoch = await ratchet.currentEpoch(ts);
      const key = await ratchet.keyFor(epoch, identity.memberId, ts);
      if (!key) throw new Error("no key for epoch");
      const msg = { v: 2, ts, ...fields };
      const sealed = await sealMessage(key, channelId, identity.memberId, epoch, ts, msg);
      const post = await buildPost(identity, channelId, epoch, sealed, ts);
      const res = await fetch(apiUrl(`/api/v2/f/${channelId}/loc`), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(post),
        signal: ctl.signal,
      });
      if (!res.ok) {
        // A clock rejection is not a network problem and must not be shown as
        // one. This device's epoch is too far from the relay's, which means it
        // is invisible to its circle until the clock is fixed, and someone
        // relying on being visible needs to be told that in those words.
        if (res.status === 400) {
          const why = await res.json().catch(() => null);
          if (why?.error === "clock") {
            const e = new Error("device clock is wrong");
            e.code = "clock";
            throw e;
          }
        }
        throw new Error(`post ${res.status}`);
      }
      return ts;
    });
    chain = job.catch(() => {});
    return job;
  }

  // Cancel stops queued sends and aborts any POST already in flight, so a
  // rotation can guarantee nothing else lands on the old channel.
  function cancel() {
    cancelled = true;
    ctl.abort();
  }

  return { send, cancel };
}

export { epochAt };
