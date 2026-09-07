// A RAM-only retry line for one-shot messages whose loss lies to the circle:
// a bye that never lands leaves a "live" dot pointing nowhere, a check-in
// that never lands leaves an SOS burning after its owner said safe.
//
// Deliberately memoryless across locks and launches. Nothing here may ever
// touch storage: what a locked or wiped device must not hold, this module
// cannot hold, because it was never given a way to write. Retries call the
// injected send() fresh each time, which re-seals under the current epoch
// key, so a queued intent never pins old key material either.
const BACKOFF_MS = [4000, 15000, 60000];

export function createOutbox({ send, onSettle, backoff = BACKOFF_MS }) {
  // type -> { tries, timer }. One slot per type: a newer bye replaces an
  // older bye's schedule instead of queueing a second one.
  const line = new Map();

  function settle(type, ok, err, tries) {
    onSettle?.(type, ok, err, tries);
  }

  function attempt(type) {
    const rec = line.get(type);
    if (!rec) return Promise.resolve(false);
    return send(type).then(
      () => {
        const tries = rec.tries;
        drop(type);
        // tries is how many FAILURES came first: 0 means the plain success
        // a caller already handled, 1+ means a recovery worth announcing.
        settle(type, true, null, tries);
        return true;
      },
      (err) => {
        const cur = line.get(type);
        if (!cur) return false;
        cur.tries += 1;
        const wait = backoff[Math.min(cur.tries - 1, backoff.length - 1)];
        clearTimeout(cur.timer);
        cur.timer = setTimeout(() => attempt(type), wait);
        // In Node (the tests), a pending retry must not pin the process.
        cur.timer.unref?.();
        settle(type, false, err, cur.tries);
        return false;
      },
    );
  }

  function drop(type) {
    const rec = line.get(type);
    if (rec) clearTimeout(rec.timer);
    line.delete(type);
  }

  return {
    // Queue a type and try it immediately. The returned promise settles with
    // the FIRST attempt, so callers that used to await one send still can;
    // later retries run on their own schedule.
    enqueue(type) {
      drop(type);
      line.set(type, { tries: 0, timer: 0 });
      return attempt(type);
    },
    // A working network just showed itself: try everything now.
    flush() {
      for (const [type, rec] of line) {
        clearTimeout(rec.timer);
        rec.timer = 0;
        attempt(type);
      }
    },
    // A queued intent the world moved past: firing a fresh SOS cancels a
    // queued check-in, and the other way around.
    drop,
    // Locks, wipes and circle switches: the line dies with the context it
    // was queued in. A bye meant for one channel must never be re-sent into
    // another.
    clear() {
      for (const type of [...line.keys()]) drop(type);
    },
    pending: () => [...line.keys()],
  };
}
