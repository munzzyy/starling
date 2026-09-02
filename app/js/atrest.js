// What may be written and under which key, what an unlock attempt found, what
// a launch found, and the order a circle erases itself in.
//
// Three review rounds running produced a critical defect in this cluster, and
// all three were the same shape: a decision tangled up with storage effects
// inside a function that also touches the page. A failed unlock left the vault
// key live in memory behind the lock screen, because the wrong-passcode exit
// scrubbed it and the damaged-install exit did not. A device resumed after a
// self-destruct was read as an abandoned install, so the next correct passcode
// deleted the app lock and rewrote every circle in plaintext. A destruct wrote
// its bookkeeping before the erase, so one failing dbSet on a device with no
// quota left vetoed the whole erase while the card on screen said the keys
// were gone.
//
// None of those are storage bugs. Each one is a question with a definite
// answer that nobody could see, because reaching it meant standing up a fake
// browser and driving an async function full of awaits. So the questions live
// here, stated, and main.js keeps every await, every dbSet and dbDel, every
// render and every toast: nothing in this file reads, writes, draws or says
// anything.
//
// Spec: docs/THREAT-MODEL.md, "app lock"; docs/PROTOCOL.md, "History window
// and destruction" and "Leaving and removing".

import { usableVaultKey } from "./circles.js";

// ------------------------------------------------- may this be written, and how

// The one place that answers "may this be written, and under which key".
//
// Two facts decide it and they are not the same fact. Whether the lock is on
// says which FORM belongs on disk: sealed under the vault key, or plaintext
// like any other app data on an unlocked phone. Whether the key in hand is
// still a key says whether anything may be written at all.
//
// Fail closed is the whole point of the second half. With the lock on and no
// usable vault key we are locked or mid-teardown, and key material must not be
// persisted at all: a writer that silently fell back to plaintext there would
// undo the lock with one autolock landing in the wrong millisecond. Usable and
// not merely present, because zero() empties a buffer in place and leaves
// every reference to it alive: a lock context captured before the app locked
// still carries a `vaultKey` field afterwards, holding 32 zero bytes, and a
// bare presence check waves it through and seals the crown jewel under a
// constant every attacker already has.
//
// `ok` is permission to write, `sealed` is the form. They are separate fields
// because the refusal only exists in the sealed form: an unlocked device
// always has somewhere honest to put its bytes.
export function atRestForm(lock) {
  if (!lock?.enabled) return { ok: true, sealed: false, vaultKey: null };
  if (!usableVaultKey(lock.vaultKey)) return { ok: false, sealed: true, vaultKey: null, reason: "no-vault-key" };
  return { ok: true, sealed: true, vaultKey: lock.vaultKey };
}

// ------------------------------------------------------ what an unlock found

// A passcode or a biometric just recovered a key. What is this?
//
// Several different things reach this point and they were told apart by a chain
// of if-branches inside one async function, which is how two of them ended up
// confused with each other in two separate review rounds. Written out, they
// are:
//
//   wrong-passcode     the sealed chain key did not open. Nothing else about
//                      the disk matters and nothing is repaired.
//   open-circle        it did open. Ordinary unlock, and the slots decide the
//                      rest (see slotsVerdict).
//   resume-destroyed   no sealed chain key, and a destroy mark. The chain
//                      threw itself away while this phone was in a drawer.
//                      This is NOT a leave the person asked for, so the repair
//                      below is wrong for it: the app lock stays, and the
//                      remaining circles stay sealed under the key that just
//                      opened.
//   restore-plaintext  no sealed chain key, no mark, and a plaintext circle
//                      sitting there. A crash cut a lock transition or an
//                      earlier recovery short after it wrote the plaintext and
//                      before it cleared the lock record. Plaintext is checked
//                      BEFORE the sealed array for exactly that reason: the
//                      recovery writes plaintext first, so its last crash
//                      window leaves a fully restored circle that only needs
//                      the stale record cleared, never onboarding.
//   promote-circles /  no chain key in either form. Whether there is anything
//   abandoned          left to promote decides between a circle coming back
//                      and a lock record protecting nothing.
//
// The sealed circle array cannot be read without side effects: an unreadable
// blob is quarantined and the person is told. So `circles` starts out unknown,
// this answers "read-circles", and the caller asks again with the count in
// hand. An unknown count is not a zero count, which is the difference between
// promoting a circle and wiping the lock off a device that still has one.
export function unlockVerdict({ sealed, opened, destroyed, plainSecret, plainIdentity, circles }) {
  if (sealed) return { kind: opened ? "open-circle" : "wrong-passcode" };
  if (destroyed) return { kind: "resume-destroyed" };
  if (plainSecret && plainIdentity) return { kind: "restore-plaintext" };
  if (circles === undefined || circles === null) return { kind: "read-circles" };
  return { kind: circles > 0 ? "promote-circles" : "abandoned" };
}

// The active slots opened. Is there a circle in them?
//
// Asked on four paths that all used to spell it out for themselves: the
// ordinary unlock, the plaintext recovery, the launch that finds a circle with
// no lock on it, and the launch that promotes one out of the array.
//
// No identity is not a v1 install and not a wrong passcode either, but it is
// the one shape with nothing honest to show, so it fails the unlock rather
// than entering half a circle. A record with no generation metadata IS v1: v1
// wrote a circle root and no generation record at all, that root names no v2
// channel, and a v1 client cannot talk to a v2 relay, so there is nothing to
// migrate and saying so beats a circle where nobody ever posts.
export function slotsVerdict({ identity, meta }) {
  if (!identity) return { kind: "no-identity" };
  if (!meta) return { kind: "v1" };
  return { kind: "circle" };
}

// --------------------------------------------------------- what a launch found

// The same question at boot, before anything is decrypted.
//
// `destroyed` is read on BOTH paths. The locked one used it to keep a lock
// record alive through an empty launch and the unlocked one, which is the
// configuration the app ships with, did not read it at all, so the person who
// never turned the lock on got no explanation for a circle that vanished.
//
// The stale-lock case is the delicate one. A lock record with nothing behind
// it in either form is a crash mid last-circle leave, and clearing it beats
// presenting a lock screen no passcode can satisfy. A self-destruct leaves the
// same empty shape and is not a leave: that lock is still satisfiable, it
// still protects whatever the person sets up next, and nobody asked for it to
// come off. The mark is the only thing on disk that tells the two apart, and
// leaving it out of this test is what cost the app lock twice.
export function bootVerdict({
  lockEnabled,
  sealedSecret,
  sealedGen,
  sealedStaged,
  sealedCircles,
  secret,
  identity,
  circles,
  destroyed,
}) {
  const stored = Array.isArray(circles) ? circles.length : 0;
  if (lockEnabled) {
    if (!sealedSecret && !secret && !sealedCircles && !stored && !destroyed) return { kind: "stale-lock" };
    // A sealed secret with no generation record beside it is v1 storage.
    // Nothing needs decrypting to know that, and no passcode turns it into a
    // v2 circle.
    if (sealedSecret && !sealedGen && !sealedStaged) return { kind: "v1" };
    return { kind: "locked" };
  }
  if (secret && identity) return { kind: "active" };
  // A crash mid-leave can clear the active slots with circles still waiting.
  if (stored) return { kind: "promote" };
  return { kind: destroyed ? "destroyed" : "onboarding" };
}

// ------------------------------------------------------------ erasing a circle

// The order a circle erases itself in, as data rather than as the order of a
// function's awaits.
//
// Round six's critical was this order and nothing else. The mark used to be
// written first, copying the leave journal beside it, and that copied the
// wrong property: the leave journal goes first because it is what makes an
// interrupted delete recoverable, while this mark recovers nothing. Putting it
// first only handed a failing bookkeeping write a veto over the erase. On a
// device with no storage quota left the dbSet rejected, the throw was
// swallowed, the leave never ran, and the chain key, the channel id, the
// roster and the invitation all stayed on disk while the card on screen said
// the keys were gone. That is the exact device class the catch-up destruct
// exists for.
//
// So the rule is: what erases goes first, and what is only bookkeeping goes
// after it and is allowed to fail on its own. `erases` and `mayFail` are the
// two fields that carry it, and a test walks main.js to check the code still
// does what this says.
//
// One thing is absent by design and stays absent: no step deletes the app
// lock. A leave the person asks for takes the lock with it rather than leaving
// a lock screen no passcode can satisfy. A self-destruct is not asked for and
// must never cost anybody their lock.
export function destructPlan() {
  return [
    {
      step: "erase-circle",
      does:
        "leave the circle: purge the chain key, the generation, the roster, the invitation and this device's keypair in it, then promote the next circle if there is one",
      erases: true,
      commits: "the erase, which is the whole security action",
      mayFail: false,
      onFailure: "abort: the caller stays locked or stays on the circle it had, and nothing claims the keys are gone",
    },
    {
      step: "mark-destroyed",
      does: "write the flag that says this empty device destroyed itself rather than being left",
      erases: false,
      commits: "the wording, and a lock record kept alive through an empty launch",
      mayFail: true,
      onFailure: "continue: the circle is already off the disk, so losing the mark costs an explanation, not a secret",
    },
    {
      step: "adopt-promotion",
      does: "move the promoted circle into memory, or say this device is holding nothing",
      erases: false,
      commits: "what the session believes, which now has to match the disk",
      mayFail: false,
      onFailure: "abort",
    },
  ];
}
