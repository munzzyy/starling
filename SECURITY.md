# Security

Starling encrypts everyone's location on their own device. If you find a way to
break that, I want to know before anyone else does.

## Reporting a vulnerability

Email **Munzzyy1@proton.me** with what you found and how to reproduce it.
I will acknowledge your report within 3 business days.

This project follows coordinated disclosure. Please give me a 90 day window
from acknowledgment to fix the issue and ship a release before any public
write-up. If a fix genuinely needs longer, I will tell you why and propose a
new date rather than going quiet; if I go quiet past that window without
explanation, you have not agreed to anything and are free to publish.

I will keep you posted as the fix moves, and credit you by name or handle
when it ships, if you want credit. If you would rather stay anonymous, say
so and you will not be named anywhere.

## Safe harbor

Testing against your own Starling circles, your own self-hosted relay, or
the public demo without touching other users' data is authorized. I will
not pursue legal action or report you for good-faith research conducted
under this policy: no accessing, modifying, or exfiltrating another
person's real location or identity data beyond what is strictly necessary
to demonstrate the bug, no denial-of-service testing against the production
relay, and no social engineering of anyone connected to the project. Stop
and report as soon as you have a working proof of concept rather than
digging further than needed to prove the issue.

## What is in scope

The app (`app/`), the relay (`relay/`), the Android wrapper (`android/`),
the protocol (`docs/PROTOCOL.md`), and the crypto (`app/js/crypto.js`,
`app/js/wire.js`, `app/js/ratchet.js`, `app/js/rekey.js`, `app/js/net.js`,
`app/js/membership.js`, `app/js/lock.js`, `app/js/circles.js`).

Protocol v2 is wired end to end as of 0.5.0: crypto core, relay, multi-circle
storage, app orchestration, and the Android wrapper. It has not had an
independent security review; `docs/AUDIT.md` has the exact, checkable status
of what has and has not been verified, and is where to start if you are
looking for where the least-reviewed code is (currently the invite/welcome
handshake and roster convergence in `app/js/membership.js` and `app/js/main.js`).
The live relay's actual protocol version can drift from what is in this
repository depending on when it was last deployed;
`curl https://starlingmap.app/api/v2/health` tells you which one you are
testing against before you start.

Good things to report:

- Any path where a location, name, or a circle's key material reaches the
  relay, a log, a URL, or disk in a form the server or a bystander can read.
- Any way to write, alter, or replay another member's position that the
  signature and timestamp/epoch rules should have blocked.
- Any way to decrypt an epoch after the device that held its key destroyed
  it, or any way to keep reading a circle after a re-key that removed you.
- Any way to make a receiver accept a re-key from a sender it has not
  already pinned, or to re-pin a member's keys without surfacing the change.
- Any way to make a joiner accept a welcome from anyone other than the
  identity its invite link committed to, or any way to claim a member seat
  by posting a `member` record anywhere other than inside a verified welcome.
- XSS or injection reachable from a decrypted message field or a relay response.
- A way to bypass the app lock or recover the sealed circle secret without the
  passcode or biometric.
- On Android: a way to read the Keystore-wrapped vault key without the
  biometric or passcode gate, a way to trigger the PanicKit wipe from an
  unpaired app, or a way to make the WebView load content from any origin
  other than the bundled asset origin.

## What is already known

`docs/THREAT-MODEL.md` (including its "Android app deltas" section) and
`docs/AUDIT.md` list the limits Starling does not try to solve and the gaps
that are already tracked: no human security audit, network and timing
metadata visible to the relay, the SOS-and-circle correlation signal from
firing a beacon on the same IP as the circle channel, forward secrecy bounded
by a device's retained history window rather than absolute, post-compromise
security requiring an actual re-key rather than happening automatically, no
cover traffic beyond a steady-cadence posting option, no post-quantum
protection, the web delivery trust model (including why there is no iOS app
and why F-Droid has not built this yet), passcode strength being the user's
own, and the foreground-service notification being a required disclosure of
active sharing. Reports that restate these are welcome as discussion but are
not treated as new findings.

## No bounty

There is no money behind this. Starling is not backed by a company or a
bug bounty budget, and I am not going to pretend otherwise by dangling a
reward I cannot pay. What you get is a fast, honest response, a fix, and
credit if you want it.

## Handling

Fixes ship with a test that reproduces the issue first. Nothing about a
report is shared beyond what is needed to fix it.
