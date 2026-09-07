# iOS app

A hand-written Swift WKWebView wrapper around the same `app/` code that runs
at starlingmap.app and inside the Android wrapper. Capacitor, Cordova, React
Native: none of it is in here. The wrapper serves the bundle on the fixed
origin `starling://localhost` and otherwise gets out of the way.

This is the honest version of Starling that iOS can have today. It is a real
app that holds a real circle; what it is not is the Android app, and the
table below is the whole difference.

## What works, what does not

| | Android wrapper | iOS wrapper |
|---|---|---|
| Create, join, and run a circle | yes | yes |
| Tapped invite links open the app | yes, App Links | no: a tapped invite opens Safari's landing page. Joining means copying the link and pasting it inside the app (Join, then paste). Universal links need a paid team's association file and are roadmap |
| End-to-end encryption, safety numbers, re-keying | yes | yes |
| Live map, places, SOS, status, duress code | yes | yes |
| Sharing with the screen off | yes, foreground service | no. iOS gives a web view zero background execution; sharing runs while the app is open, and the UI says so |
| SOS/arrival/low-battery notifications | yes | no, they need the background poller |
| Panic wipe clearing OS-level app data | yes | in-app wipe only. What page JS cannot reach is WebKit's HTTP cache, so map tiles of areas you viewed can survive the wipe until iOS evicts them; the wipe confirmation says so, and the Off-grid basemap never creates them |
| Hardware-backed biometric lock | yes, Keystore | no OS keystore bridge; the passcode lock works |
| Orbot/Tor awareness | yes | no |
| Custom relay | yes | yes |
| App-switcher privacy | FLAG_SECURE | a shield covers the window when the app leaves the foreground |
| Location permission | Android prompt | iOS prompt, while-using only |
| Cloud backups of app data | blocked, `allowBackup="false"` | blocked: WebKit's store is marked excluded from iCloud and device backups at every launch |
| System text size | textZoom from the OS setting | page zoom follows Dynamic Type, live, not just at launch |

The gap list is the roadmap, not an apology: each row that says no is
something a future bridge could add. What ships never claims more than it
does, and `canShareInBackground()` reporting false on iOS is what keeps the
app's own UI honest about the biggest row.

## Why circles are allowed here and not in a browser tab

The hosted site refuses to create or open circles: a browser tab is the
weakest place to hold a long-lived location secret (extensions, shared
machines, served code that can be re-targeted at one visitor). The iOS
wrapper has none of those problems. Its page is a pinned bundle inside an
app sandbox, so `env.js` lets the circle gate pass for the wrapper's scheme
while the hosted web keeps refusing. The reasoning lives next to the
`WEB_SHARE_ENABLED` switch in `app/js/env.js`.

## Accessibility

The page zoom follows the system Dynamic Type setting live, so growing your
text in Settings grows the app. Everything else rides on the web app's own
accessibility work (labels, focus order, reduced motion, contrast tokens);
what has NOT happened yet is a VoiceOver pass on physical hardware, so treat
screen-reader behavior in this wrapper as unverified rather than promised.

## Building

You need a Mac with Xcode 15 or newer, and Node 24 or newer for the bundle
steps. The Xcode project is generated, not checked in. From the repo root:

```
npm ci
bash tools/sync-vendor.sh
brew install xcodegen
cd ios
xcodegen generate
open Starling.xcodeproj
```

`sync-vendor.sh` matters: Leaflet is vendored into `app/vendor/` at build
time and is not committed, and the iOS bundle carries `app/` as-is. Skip it
and the map pane is empty.

Two steps Xcode will not do for you on a first free-Apple-ID build: pick
your personal team under Signing & Capabilities before running, and after
the first install, trust your own certificate on the phone (Settings >
General > VPN & Device Management). Then pick your device and press run.
A free Apple ID signs a personal build that runs for 7 days at a time; App
Store or TestFlight distribution needs a paid developer account, and
Starling is not published there today.

CI builds the wrapper for the iOS simulator on every push and fails if any
permission prompt other than location, or any App Transport Security
exception, appears in the built Info.plist. That is a compile plus static
asserts, not a runtime test: nothing launches the app in CI yet, so the
runtime behavior documented here is verified by people running it, not by
the pipeline.

## One rule for maintainers

`starling://localhost` is the storage origin, and the circle secret lives
under it. Rename the scheme or the host and every install's data is
orphaned with no migration path. Never change either.
