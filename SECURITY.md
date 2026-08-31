# Security

Starling encrypts everyone's location on their own device. If you find a way to
break that, I want to know before anyone else does.

## Reporting a vulnerability

Email **Munzzyy1@proton.me** with what you found and how to reproduce it. Please
give me a reasonable window to fix it before any public write-up. I will confirm
I received it, keep you posted, and credit you when the fix ships if you want.

Good things to report:

- Any path where a location, name, or the circle secret reaches the relay, a
  log, a URL, or disk in a form the server or a bystander can read.
- Any way to write, alter, or replay another member's position that the
  signature and timestamp rules should have blocked.
- XSS or injection reachable from a decrypted message field or a relay response.
- A way to bypass the app lock or recover the sealed circle secret without the
  passcode or biometric.

## What is in scope

The app (`app/`), the relay (`relay/`), the protocol (`docs/PROTOCOL.md`), and
the crypto (`app/js/crypto.js`, `app/js/lock.js`, `app/js/wire.js`).

## What is already known

`docs/THREAT-MODEL.md` lists the limits Starling does not try to solve in v1:
network and timing metadata visible to the relay, no forward-secrecy ratchet
within a circle's lifetime, invite links as bearer capabilities, the web
delivery trust model, and passcode strength being the user's own. Reports that
restate these are welcome as discussion but are not treated as new findings.

## Handling

Fixes ship with a test that reproduces the issue first. Nothing about a report
is shared beyond what is needed to fix it.
