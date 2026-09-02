// Beacon: one SOS's outside-help session, holding any number of viewer links.
// Each viewer gets its own secret, its own derived channel, and its own
// freshly generated signing identity, so two people who compare links cannot
// tell they are watching the same emergency, and the relay cannot link their
// channels by key or by name. Revoking one viewer is then just cutting one
// channel; the rest never notice.
//
// A beacon lives in memory for the duration of the SOS. If the app process
// dies the beacon dies with it; the helper page shows the trail going stale
// rather than a silent blank, and a new SOS mints new links.
//
// The file is called helpsession and the code inside says beacon on purpose.
// EasyPrivacy ships a bare `/beacon.js` rule with no domain attached to it, so
// any file at that name is blocked for everyone running uBlock Origin, AdGuard
// or Brave on default lists. main.js imports this module statically and sw.js
// precaches it, so the block killed the whole app and the service worker
// install, not only the SOS feature. Do not rename it back.

import {
  randomBytes,
  generateIdentity,
  deriveHelpChannelId,
  deriveHelpEncKey,
  beaconFragment,
} from "./crypto.js";
import { createSender, epochAt } from "./net.js";
import { helpUrlBase } from "./env.js";
import { TTL_MS } from "./wire.js";

// A viewer's channel has one sender and one epoch value carried purely for
// wire shape (AAD, sigBase): there is no ratchet to advance, because a beacon
// covers one emergency rather than a circle's whole life. Re-keying exists to
// recover from a compromise over time and to remove a member later; neither
// applies here, so the "ratchet" is just the same derived key handed back for
// every epoch it is asked about.
function fixedKeyRatchet(key) {
  return {
    keyFor: async () => key,
    currentEpoch: async (now) => epochAt(now),
    retainedEpochs: () => [],
  };
}

// A link outliving the relay's own retention window is a link to nothing: the
// points it could ever show are already swept. TTL_MS is the sane upper
// bound, not a default meant to be relied on; callers should pass a real
// ttlMs sized to the emergency.
const DEFAULT_TTL_MS = TTL_MS;

export async function startBeacon() {
  const viewers = new Map(); // id -> { label, expiresAt, revoked, retired, failing, sender }
  let ended = false;
  let seq = 0;

  async function addViewer({ label, ttlMs } = {}) {
    if (ended) throw new Error("beacon ended");
    const secret = randomBytes(32);
    const identity = await generateIdentity();
    const channelId = await deriveHelpChannelId(secret);
    // Encrypt only: this side of the link seals, it never opens. The viewer
    // derives the same bytes with decrypt only.
    const encKey = await deriveHelpEncKey(secret, ["encrypt"]);
    const expiresAt = Date.now() + (Number(ttlMs) > 0 ? Number(ttlMs) : DEFAULT_TTL_MS);

    let lastTs = 0;
    const sender = createSender({
      identity,
      channelId,
      ratchet: fixedKeyRatchet(encKey),
      getLastTs: () => lastTs,
      setLastTs: (t) => {
        lastTs = t;
      },
    });

    const id = `v${++seq}`;
    viewers.set(id, {
      label: typeof label === "string" ? label.slice(0, 40) : "",
      expiresAt,
      revoked: false,
      retired: false,
      failing: false,
      sender,
    });
    // The link commits to this viewer's signing identity, which is fresh per
    // viewer, so the page it opens knows whose points to believe before it
    // fetches anything. Without that commitment the beacon secret is a write
    // capability for everyone it was forwarded to: the channel and the content
    // key both fall out of the link, so anyone holding it can seal a position
    // or a "bye" that opens cleanly, and a viewer with nothing pinned believes
    // it. First sight is not a defence when the attacker can be first.
    return {
      id,
      label: viewers.get(id).label,
      expiresAt,
      link: `${helpUrlBase()}${beaconFragment(secret, expiresAt, identity.memberId)}`,
    };
  }

  // A viewer is live until it is revoked or its link expires. Expiry is
  // enforced here, on the writer, and not only on the page that was asked to
  // respect it: past expiresAt the viewer page has already stopped polling and
  // said so, so every further post is a position nobody will read, left on the
  // relay for TTL_MS where the link can still fetch it. Retiring cancels the
  // sender, which also aborts a POST already in flight, so nothing lands on
  // that channel after its own deadline.
  function live(v, now) {
    return !v.revoked && !v.retired && now < v.expiresAt;
  }

  function retire(v) {
    if (v.retired) return;
    v.retired = true;
    v.sender.cancel();
  }

  // Post one position to every live viewer channel. One viewer's channel
  // failing must never keep the rest from hearing about an emergency, so this
  // fans out with allSettled instead of stopping at the first rejection. There
  // is no separate retry timer for a failed send: an active SOS calls this
  // again with the next position within seconds, which is the retry, and the
  // failure sits on the viewer record in the meantime for the UI to show.
  async function send(fields) {
    if (ended) return;
    const now = Date.now();
    for (const v of viewers.values()) {
      if (!v.revoked && !v.retired && now >= v.expiresAt) retire(v);
    }
    const audience = [...viewers.values()].filter((v) => live(v, now));
    await Promise.allSettled(
      audience.map((v) =>
        v.sender.send(fields).then(
          () => {
            v.failing = false;
          },
          (err) => {
            v.failing = true;
            throw err;
          },
        ),
      ),
    );
  }

  // Best effort goodbye, then cancel no matter what. A fetch with no response
  // and no timeout would otherwise hang here forever and the cancel would
  // never run, leaving a live sender behind a switch the user already
  // flipped, so the cancel happens on every path and a goodbye that has not
  // landed within a few seconds is abandoned to it.
  async function sayBye(sender) {
    try {
      await Promise.race([
        sender.send({ t: "bye" }).catch(() => {}),
        new Promise((r) => setTimeout(r, 3000)),
      ]);
    } finally {
      sender.cancel();
    }
  }

  // An expired viewer gets no goodbye: its page stopped polling at the deadline
  // and already says the link is over, so a bye would be one more write to a
  // channel whose own link declares it dead.
  async function revokeViewer(id) {
    const v = viewers.get(id);
    if (!v || v.revoked) return;
    v.revoked = true;
    if (v.retired) return;
    v.retired = true;
    await sayBye(v.sender);
  }

  return {
    addViewer,
    send,
    revokeViewer,
    // Ending revokes every viewer that has not already been cut off; each one
    // gets its own goodbye and its own cancel, run in parallel so a stuck
    // channel cannot delay the others.
    async end() {
      if (ended) return;
      ended = true;
      const now = Date.now();
      await Promise.allSettled(
        [...viewers.values()]
          .filter((v) => !v.revoked)
          .map((v) => {
            // Liveness is read BEFORE the viewer is marked revoked, because
            // live() itself checks !revoked. Setting the flag first made this
            // branch always take the silent path, so ending an emergency
            // retired every viewer without a goodbye and a helper watching a
            // real SOS was left looking at a position that would simply go
            // stale. The end-to-end test that opens a third browser as the
            // helper is what caught it.
            const wasLive = live(v, now);
            v.revoked = true;
            if (!wasLive) {
              retire(v);
              return Promise.resolve();
            }
            v.retired = true;
            return sayBye(v.sender);
          }),
      );
    },
    list: (now = Date.now()) =>
      [...viewers.entries()].map(([id, v]) => ({
        id,
        label: v.label,
        expiresAt: v.expiresAt,
        revoked: v.revoked,
        expired: !v.revoked && now >= v.expiresAt,
        failing: v.failing,
      })),
  };
}
