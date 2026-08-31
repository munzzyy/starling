// Networking: the poll loop, the authenticated sender, and the member roster
// built from decrypted points. All verification the receiver owes the protocol
// happens here: pk binding, GCM open, timestamp windows, TTL expiry.

import {
  FUTURE_SKEW_MS,
  TTL_MS,
  TRAIL_CAP,
  b64uDecode,
  memberIdFromPub,
} from "./wire.js";
import { openMessage, sealMessage, buildPost } from "./crypto.js";

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

// Roster: decrypt-and-merge incoming points into per-member records.
export function createRoster({ channelId, encKey, selfId }) {
  const members = new Map();

  async function ingest(entries, now = Date.now()) {
    for (const entry of entries || []) {
      if (!entry || typeof entry.m !== "string") continue;
      if (entry.m === selfId) continue;
      let pk;
      try {
        pk = b64uDecode(entry.pk);
      } catch {
        continue;
      }
      if ((await memberIdFromPub(pk)) !== entry.m) continue;

      const points = [...(entry.points || [])].sort((a, b) => a.ts - b.ts);
      let rec = members.get(entry.m);
      for (const p of points) {
        let n, c;
        try {
          n = b64uDecode(p.n);
          c = b64uDecode(p.c);
        } catch {
          continue;
        }
        const obj = await openMessage(encKey, channelId, entry.m, n, c);
        if (!obj || !Number.isFinite(obj.ts)) continue;
        if (rec && obj.ts <= rec.ts) continue;
        if (obj.ts > now + FUTURE_SKEW_MS) continue;
        if (!rec) {
          rec = { id: entry.m, ts: 0, trail: [] };
          members.set(entry.m, rec);
        }
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
    clear: () => members.clear(),
  };
}

// Poller: GET the channel feed every 10 s while visible, back off on failure,
// pause when hidden, poll immediately on return.
export function createPoller({ channelId, roster, onChange, onStatus }) {
  let since = 0;
  let timer = 0;
  let inFlight = false;
  let failures = 0;
  let running = false;

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
      const res = await fetch(`/api/v1/f/${channelId}?since=${since}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`poll ${res.status}`);
      const data = await res.json();
      for (const entry of data.members || []) {
        for (const p of entry.points || []) {
          if (Number.isFinite(p.ts) && p.ts > since) since = p.ts;
        }
      }
      await roster.ingest(data.members);
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

// Sender: seal, sign, POST. Outgoing ts is strictly monotonic even if the
// clock steps backwards; the last sent ts is persisted by the caller.
export function createSender({ identity, channelId, encKey, getLastTs, setLastTs }) {
  let chain = Promise.resolve();

  function send(fields) {
    const job = chain.then(async () => {
      const last = (await getLastTs()) || 0;
      const ts = Math.max(Date.now(), last + 1);
      await setLastTs(ts);
      const msg = { v: 1, ts, ...fields };
      const sealed = await sealMessage(encKey, channelId, identity.memberId, msg);
      const post = await buildPost(identity, channelId, sealed, ts);
      const res = await fetch(`/api/v1/f/${channelId}/loc`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(post),
      });
      if (!res.ok) throw new Error(`post ${res.status}`);
      return ts;
    });
    chain = job.catch(() => {});
    return job;
  }

  return { send };
}
