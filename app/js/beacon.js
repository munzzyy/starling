// Beacon: one SOS's outside-help session. A fresh secret, a fresh signing
// identity, and its own relay channel, so the helper link shares exactly one
// thing: this emergency's location trail. Nothing here reads the circle
// secret or the circle identity, and the relay cannot link the two channels
// by key material (fresh identity) or by name (separate HKDF domains).
//
// A beacon lives in memory for the duration of the SOS. If the app process
// dies the beacon dies with it; the helper page shows the trail going stale
// rather than a silent blank, and a new SOS mints a new link.

import {
  randomBytes,
  generateIdentity,
  deriveHelpChannelId,
  deriveHelpEncKey,
  beaconFragment,
} from "./crypto.js";
import { createSender } from "./net.js";
import { helpUrlBase } from "./env.js";

export async function startBeacon() {
  const secret = randomBytes(32);
  const identity = await generateIdentity();
  const channelId = await deriveHelpChannelId(secret);
  const encKey = await deriveHelpEncKey(secret);

  // Monotonic ts is in-memory: the channel is fresh, so there is no earlier
  // ts of ours on it to collide with.
  let lastTs = 0;
  const sender = createSender({
    identity,
    channelId,
    encKey,
    getLastTs: () => lastTs,
    setLastTs: (t) => {
      lastTs = t;
    },
  });

  let ended = false;
  return {
    link: `${helpUrlBase()}${beaconFragment(secret)}`,
    channelId,
    send(fields) {
      if (ended) return Promise.reject(new Error("beacon ended"));
      return sender.send(fields);
    },
    // Ending says goodbye so the helper page can show "ended" instead of
    // guessing from staleness, then cancels so nothing further can land.
    //
    // The goodbye is best effort and must never hold the door open: a fetch
    // with no response and no timeout would otherwise hang here forever and
    // the cancel would never run, leaving a live sender behind a switch the
    // user already flipped. So the cancel happens on every path, and a
    // goodbye that has not landed within a few seconds is abandoned to it.
    async end() {
      if (ended) return;
      ended = true;
      try {
        await Promise.race([
          sender.send({ t: "bye" }).catch(() => {}),
          new Promise((r) => setTimeout(r, 3000)),
        ]);
      } finally {
        sender.cancel();
      }
    },
  };
}
