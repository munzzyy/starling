# Embedding Tor: verdict is no, not yet

Nathan asked about building `arti-mobile` (Tor's Rust reimplementation) into
the Android wrapper instead of talking to the separate Orbot app. Researched
it. Verdict: don't switch. Written down so we don't re-litigate this every
time someone asks why Starling still shells out to Orbot.

## What we do today

Two paths, both described in `docs/ANDROID.md` under Orbot: per-app VPN mode
through Orbot with zero code on our side, and an in-app SOCKS toggle that
points `androidx.webkit`'s `ProxyController` at Orbot's SOCKS port. Orbot
runs as its own process with its own foreground service, its own bridges and
Snowflake support, and its own decade of hardening. We ask it a question
over a broadcast and trust the answer for 30 seconds; that's the whole
integration.

## What we considered

`org.torproject:arti-mobile`, Tor Project's own Rust client, embedded
in-process instead of proxying to Orbot.

Arti itself has moved on since the last time anyone here looked at it. It's
at 2.5.1 as of August 2026, ships monthly, and the old "don't rely on this
for anonymity yet" caveat is gone from its own docs. Proxy and onion
support are described as ready for use, just not yet feature-complete
against C Tor. That part of the picture is genuinely better than we
assumed.

The packaging isn't. There's exactly one Android artifact,
`org.torproject:arti-mobile:1.7.0.1`, published by Guardian Project's
`gpmaven` off `raw.githubusercontent.com`, not Maven Central. Its API is
a real fit: `ArtiProxy.Builder` has `setWrapWebView(true)` and
`getSocksPort()`, which is close to a drop-in replacement for what
`OrbotStatus` and the `ProxyController` override already do. If the
packaging story were solved, the integration itself would be small.

## Why we said no

- **gpmaven kills the F-Droid MR.** F-Droid's inclusion policy doesn't
  accept prebuilt binaries from an arbitrary GitHub raw URL as a dependency
  source. We have an open F-Droid submission (`docs/fdroid/SUBMISSION.md`).
  Pulling in gpmaven ends that, full stop.
- **The one artifact that exists is stale where it matters.** 1.7.0.1 pins
  arti 1.7.0 / arti-client 0.36.0 from October 2025, nine minor releases
  behind the 2.5.1 line as of this writing. We'd be embedding an old Tor
  implementation, not the one whose docs we just read.
- **arti-client calls `exit(1)` on a required-subprotocol shutdown.** That's
  documented behavior, not a bug we'd be hoping to avoid. A stale or
  misconfigured embed can kill the whole app's process. For most apps
  that's a crash. For Starling that's someone's location share silently
  dying mid-session.
- **Size.** +15.7 MB of arm64 `.so` on what is currently a 7.8 MB APK. That's
  not disqualifying on its own, but it's not free either, and it buys us a
  stale, unpinnable dependency.
- **Process lifetime is the real problem.** In-process Tor lives and dies
  with our app's process, and Android freezes or kills backgrounded apps
  aggressively. Orbot's Tor runs in its own foreground service and survives
  exactly the backgrounding that would kill an embedded client. The moment
  this matters most, a live location share running while the phone is
  locked in someone's pocket, is the moment an embedded Tor is least
  reliable.
- **Guardian Project hasn't shipped arti anywhere yet.** Orbot 17.9.5 (July
  2026) still runs C tor 0.4.9.11. If the people who maintain Orbot for a
  living aren't shipping arti in it, that's a signal worth weighting.
  Switching to embedded Tor also means rebuilding bridges, Snowflake, and
  the censorship-circumvention UX ourselves, none of which we get from
  `arti-mobile` today.

Nothing here is a knock on Arti's crypto or design. It's a maturity and
supply-chain problem: one unofficial artifact, from a source F-Droid won't
allow, several versions behind, with a documented failure mode that's
actively dangerous for this app's use case.

## What would change our mind

- `arti-mobile` publishing to Maven Central (or another F-Droid-acceptable
  source), so we're not vendoring a raw GitHub URL.
- Tracking a current arti 2.x line instead of sitting nine minors behind.
- The `exit(1)`-on-shutdown behavior fixed or made opt-out, so a subprotocol
  hiccup can't take down a location share.

Any one of those alone narrows the gap. All three, and it's worth
prototyping for real instead of writing it up as a no.
