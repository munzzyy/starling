# Web integrity

What the hosted site can and cannot prove about the code it serves, and what
we do about the gap. See [docs/THREAT-MODEL.md](THREAT-MODEL.md) for the
cryptography and [README.md](../README.md#what-it-does-not-do) for the
short version of the same point.

## The risk

starlingmap.app is a web origin. An origin can serve different bytes to
different visitors: by IP, by cookie, by request header, by nothing more than
whoever is running the edge that day deciding to. A subpoena, a compromised
deploy key, or a coerced employee can all produce the same outcome, a copy of
the JavaScript that only one specific person ever sees, that exfiltrates a key
or a position and looks identical to everyone else who ever checks the site.

Nothing in a browser today stops this. Subresource Integrity and the new
Integrity-Policy header both check served bytes against a hash the origin
itself provides, so they harden an honest origin against a compromised CDN or
a malicious third party script. They do nothing against a hostile origin,
because the attacker who controls the origin also controls the hash. TLS
proves you are talking to starlingmap.app. It says nothing about what
starlingmap.app decided to send you specifically.

This is why circles do not exist on the web at all. Creating or opening a
circle in a browser tab means the origin holds, even briefly, the ability to
read a long-lived location secret, and a browser tab is the worst place to
keep one: no OS keystore, extensions with page access, shared machines,
no code signing. The Android app closes this by shipping a signed APK. A
signature check is something a device can do offline, before running
anything; a web page cannot check itself before it runs.

## What we do about it

The site still has to serve one piece of security relevant code: `/help`,
the beacon viewer a helper opens during someone's emergency. We cannot make
that page immune to a targeted swap. We can make a swap detectable by anyone
who bothers to check.

**A strict, single origin CSP.** `script-src 'self'` and no exceptions,
enforced by the `_headers` file the site actually serves it with. There is no
third party script that could be compromised on its own, and no inline script
that could be injected around the policy.

**Published per-release asset hashes.** `tools/asset-hashes.mjs` walks
`app/` and writes a SHA-256 of every file the site serves to
`dist/asset-hashes-<version>.txt`, checked in in the GitHub release for that
version. Run `npm run hashes` to write it, `npm run hashes -- --check` to
verify a tree against an existing manifest.

A third party who wants to check the live site against a given release runs:

```
curl -s https://starlingmap.app/help.html | sha256sum
curl -s https://starlingmap.app/js/helpview.js | sha256sum
curl -s https://starlingmap.app/vendor/leaflet/leaflet.js | sha256sum
```

and compares each line against the matching path in that release's
`asset-hashes-<version>.txt`. Any file, any path under `app/`, gets the same
treatment; the manifest lists all of them.

## What this buys, and what it does not

It turns a targeted swap into a detectable event, for anyone who checks. It
does not prevent the swap and it does not detect it automatically. Nobody is
diffing starlingmap.app against the published manifest on every page load.
An ordinary helper who opens a beacon link during someone's actual emergency
is never going to open a terminal and run `curl | sha256sum` first, and
expecting them to would be dishonest about what this protects. What it
protects is the case where a journalist, a researcher, or Starling's own
maintainers periodically check, and where the origin operator therefore has
to weigh being caught against whatever they'd gain from a targeted swap. That
is a real deterrent. It is not a technical guarantee, and we are not going to
describe it as one.

This is also why the beacon viewer is the one page we accept this trade for
and nothing else is. `/help` holds one ephemeral key, generated fresh for one
emergency, tied to no account and no identity, and it is gone once the beacon
stops posting. The worst a targeted swap of that page buys an attacker is one
person's position during one emergency window. A circle's key material is
long lived and covers every member's position indefinitely, which is a much
larger prize for the same kind of attack, and is exactly why circles stay off
the web entirely.

## State of the art, honestly

Nobody has shipped a browser-native answer to this yet.

- **Subresource Integrity** and **Integrity-Policy** (new in Safari 26) are
  both origin controlled. They stop a compromised third party or a
  compromised CDN in front of an honest origin. They do nothing against the
  origin itself.
- **Code Verify** (Meta) checks a page's served code against a hash Meta
  publishes, but it is a macOS only browser extension, tied to Meta's own
  properties, and not something we can point a general user at.
- **WEBCAT** (Freedom of the Press Foundation) does something closer to what
  we would want, checking served code against a signed manifest, but it is a
  Firefox alpha and not something to depend on for people at real risk today.
- **WAICT**, the proposal for browser-native website integrity checking, is a
  Firefox Nightly prototype with no WebKit standards position filed. It does
  not exist for Safari or Chrome and there is no timeline for it to.

Published hashes plus a third party who checks is the honest state of the
art. It is not enough for circles, which is why circles are not on the web.
It is enough to make a targeted swap of the beacon viewer something we can be
caught doing, which is the most the web platform gives anyone right now.
