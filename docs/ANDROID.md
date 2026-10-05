# Android app

A hand-written Kotlin WebView wrapper around the same `app/` code that runs
at starlingmap.app. Capacitor, Cordova, Trusted Web Activity, Google Play
Services: none of it is in here. The web app and the Android app share one
codebase in `app/`; the wrapper adds native capability where the web
platform cannot reach (background location, hardware-backed biometrics, a
panic-wipe hook, Orbot integration) and otherwise gets out of the way.

## Building

You need an Android SDK (platform 36, build-tools 36) with `ANDROID_HOME`
pointing at it, or an `android/local.properties` with `sdk.dir=`; the repo
ships neither. Then, from the repo root:

```
npm ci
bash tools/sync-vendor.sh
cd android
./gradlew assembleDebug     # unsigned debug build, installable directly
./gradlew assembleRelease   # unsigned release build (see Signing below)
```

`npm ci` installs the pinned Leaflet dependency from `package-lock.json`.
`tools/sync-vendor.sh` copies the unminified `leaflet-src.js`, `leaflet.css`,
and marker images from `node_modules/leaflet` into `app/vendor/leaflet`,
which is gitignored and not committed. The Gradle build then copies
`app/**` (minus `sw.js`, which the wrapper never registers) into the app's
assets at build time, so `app/` stays the single source of truth for both
the website and the Android build. Run `npm ci` and the sync script again
any time `app/` or the Leaflet version changes before rebuilding.

## Releases

`tools/release-android.sh` is the only thing that produces a signed build.
It runs the same `npm ci` / sync-vendor / `assembleRelease` steps, then
signs the resulting unsigned APK and AAB with the local upload keystore
using `apksigner`, and finally:

- uploads the signed AAB to Google Play (Play App Signing re-signs it for
  distribution; see `docs/play-listing.md` for the signing key facts), and
- attaches the signed APK to a GitHub release, so anyone can download and
  verify a Starling build without going through either store.

Signing is deliberately kept out of Gradle and out of CI. The keystore
lives at `~/keys/starling-upload.jks` outside the repo, and its password is
in the system keyring, never in a file or an environment variable checked
into anything. CI only ever produces unsigned build artifacts.

## Reproducibility

The release build is configured to be a deterministic, unsigned artifact
that anyone can rebuild and compare byte-for-byte against what Cole
publishes:

- `vcsInfo.include = false`, so the build does not embed a git commit hash
  that would differ between two otherwise-identical checkouts.
- PNG cruncher disabled, so resource compression does not vary by machine
  or AAPT2 version quirks.
- `minifyEnabled false`, no R8/ProGuard shrinking, no baseline profiles. A
  smaller APK is not worth losing the ability for a third party to read the
  code straight out of the build.
- Dependency locking on (`package-lock.json` for the JS side, Gradle's
  dependency locking for the native side), so a rebuild months later pulls
  the exact versions we built with, not "whatever is current."
- Zip entry timestamps are zeroed automatically by AGP's reproducible build
  support, so the same inputs produce the same output bytes regardless of
  when the build ran.

**To verify a build yourself:** clone the repo at the tag matching a
published release, run the build steps above, and diff your resulting
unsigned APK against Cole's signed one after stripping the signature block
(`apksigner` can extract the pre-signature APK, or use
`unzip -l`/content hash comparison on everything outside `META-INF/`). This
is the same process F-Droid's own reproducible-builds verification runs,
and it runs it on every Starling version it builds: the APK F-Droid ships
is the developer-signed one, released only because F-Droid's own build
matched it.

## PanicKit

The app registers a PanicKit responder (`info.guardianproject.panic`).
Pairing with a trigger app like Ripple happens through the visible
`ACTION_CONNECT` flow, the same as connecting any other panic-response app;
Starling shows what it will do and asks nothing else. Once connected,
receiving `ACTION_TRIGGER` from that same paired app wipes immediately, with
no confirmation dialog, because the entire point of a panic trigger is that
it has to work without a second decision under pressure. The wipe stops a
running share, deletes the Keystore wrap key and the app's notification
channels, then hands the rest to the system's clear-data path, which removes
all app data, WebView storage and cookies included, and kills the process.
The in-app panic wipe and the duress passcode run the same code, from the
bridge thread, so it touches no view. The responder
verifies the sender package against the connected trigger app; an unpaired
or spoofed sender is ignored.

## Orbot

Two independent paths, both supported:

- **Per-app VPN mode.** Orbot's per-app proxying works with zero code on
  Starling's side. Turn it on for Starling in Orbot and its traffic routes
  through Tor like any other app's.
- **In-app SOCKS toggle.** Settings has a proxy toggle that routes requests
  through Orbot's SOCKS port using `androidx.webkit`'s
  `ProxyController` (SOCKS5, so hostname resolution happens proxy-side and
  DNS rides through Tor too), feature-detected at runtime so it silently
  does nothing on WebView versions that lack `PROXY_OVERRIDE` support
  instead of breaking. This path needs Orbot's **Power User Mode** turned
  on, since Orbot only exposes its SOCKS port to other apps in that mode.
  With the toggle on, location fixes come from GPS only: the network
  provider works by sending nearby wifi and cell identifiers to an
  off-device lookup service, which is the kind of side channel the toggle
  exists to avoid.

The port is not assumed. Turning the toggle on registers a receiver and asks
Orbot for its status (`ACTION_START` with our package name); Orbot answers
with a broadcast carrying the live SOCKS port, and the proxy is re-applied if
it differs from the 9050 default. That receiver has to be registered
`RECEIVER_EXPORTED`, since Orbot is a separate app, and the manifest needs a
`<queries>` entry for `org.torproject.android` or the request is dropped
silently on Android 11 and up. NetCipher used to be the polite way to do
this; it has been unmaintained since 2020 and never actually read the port
extra it declared a constant for, so this talks to Orbot directly.

A share that comes back by itself after a restart (see Notifications) sends
Orbot that same broadcast, and keeps sending it while it waits. Orbot's own
Start on boot is still the sure way to have Tor up in time.

Honest limits of the toggle, so nobody has to discover them the hard way:
if Orbot never answers, 9050 stands, and a wrong port fails closed rather
than leaking, but sharing stops until the ports agree. It covers the WebView
only. A link that leaves the app (say a
repo link in settings) opens in the system browser, which the toggle does
not proxy. And nothing binds 127.0.0.1:9050 to Orbot specifically; another
local app could squat the port, and while it would only ever see TLS to
the relay carrying E2EE payloads, it would see that much. Per-app VPN mode
has none of these caveats, which is why both paths are supported.

## Custom relay

Both the web app and the Android wrapper have a relay address setting.
Default is `https://starlingmap.app`. Anyone running their own relay
(`relay/` in this repo, deployed with `relay/deploy.sh`) can point their
client at it instead. This is the mechanism that keeps Starling out of
F-Droid's "tethered to a specific server" anti-feature category: using our
relay is a default, not a requirement.

## Your own server

Settings, Sharing, "Your own server" takes an https address and, while a share
runs, posts the phone's own position to it in OwnTracks' HTTP format
(`_type: location`, `lat`, `lon`, `tst`, `acc`, `alt`, `vel`, `cog`, `batt`), at
most every 15 seconds. `Forward.kt` sends it, not the page: a page fetch would
need CORS, which these servers do not answer, and the page can be frozen. A key
in the query (`?api_key=`, `?token=`) works, which covers colota-forwarder,
Reitti, Dawarich and Home Assistant's OwnTracks webhook. Nothing goes out while
Tor mode is on.

A point the server did not take waits when the cause can pass: no connection,
408, 429 or a 5xx. The next fix sends the waiting points first, oldest first,
so a tunnel or a server restart leaves no gap in the track. Up to 20 wait,
about five minutes at the 15 second floor, and past that the oldest goes. Any
other answer drops the point, because sending it again would get the same
answer. Waiting points live in memory only, never in a file or the prefs, and
go when the share ends, the address changes or Tor mode goes on. Every retry
checks Tor mode and the address again. Requests say `User-Agent: Starling`,
where Android's default named the phone model and its build.

An optional tracker ID goes out as `tid`. colota-forwarder routes on it: a
target with `TARGET_n_FILTER_TID` set only receives points whose `tid` matches,
and skips the rest without logging anything, and its Home Assistant integration
names the device after it (#10). Up to 64 characters, no control characters,
the same rule the forwarder applies. It is a label, not a destination, so
changing it needs no passcode.

To test it on an emulator, debug builds trust user-added CAs
(`debug-overrides` in `network_security_config.xml`, which release builds
ignore). Make a throwaway CA and a certificate for `IP:10.0.2.2`, copy the CA
to `/data/misc/user/0/cacerts-added/<subject_hash_old>.0` after `adb root`, run
an https receiver on the host at port 8443, and set
`https://10.0.2.2:8443/owntracks?api_key=test`.

## GrapheneOS and de-googled Android

The app is built to run without Google anything, which makes GrapheneOS a
first-class target rather than an afterthought:

- No Google Play Services, Firebase, or push dependency. Location comes from
  the plain `LocationManager`, so it works with no sandboxed Play services
  installed.
- The WebView requirement (137 or newer, see below) is met by GrapheneOS's
  own Vanadium, which tracks current Chromium.
- Install paths that do not touch Google: F-Droid
  (<https://f-droid.org/packages/app.starlingmap/>, the same developer-signed
  APK after its reproducible-build check), or add it to Tern
  (<https://tern.munzzyy.dev>), which follows the GitHub releases
  page; every release carries a stable `starling.apk` asset name for that.
- GrapheneOS's per-app Network and Sensors toggles degrade the app the way
  you would hope: no network means the poller backs off and the Off-grid
  basemap still renders; denying location just means nothing to share.
- Verification happens on the no-GMS AOSP emulator image
  (`system-images;android-36;default`), which is the closest stand-in for a
  de-googled device that automated testing can get. It runs debug builds:
  that image's WebView is 133, older than a release build accepts.

## Android 9 and old WebViews

The app installs on Android 9 (minSdk 28). Two calls differ there:
`LocationService` starts through `ServiceCompat.startForeground`, because
Android 9 has no foreground service types, and the health report reads the
location op with `checkOpNoThrow`. Android 9 also has no "only while using
the app" location grant, so the permission covers all the time. The first
launch on Android 9 shows a one-time note saying that, and that Android 9
has had no security fixes since January 2022.

`SystemCheck` won't load the page on an Android System WebView older than
137, the first version with WebCrypto Ed25519. On anything older, every
member whose identity is Ed25519 fails signature checks and silently drops
off the map, so the app shows a native screen with the version it needs and
the one the phone has instead. Debug builds only require 80, the page's
syntax floor, so the AOSP emulator images (WebView 133) still run the e2e
checks; identities made there fall back to P-256. `test/webview-floor.test.mjs`
fails if the page starts using anything newer than the floor.

Tested on the `system-images;android-28;default` image with its WebView
updated to 133 from the Android 16 image (same AOSP signing key, so
`adb install -r` takes it): a share with the screen off and Chromium's
freeze delay cut to 60 seconds froze twice and was woken twice; over 160
seconds the relay accepted 40 posts, with no errors and no gap longer than
five seconds. The image's own WebView is 66, which gets the update screen.

## Notifications

### An SOS rings through Do Not Disturb

An SOS from your circle posts on its own "Emergency alerts" channel, with the
ringtone and a vibration that keeps pulsing. It goes out as an alarm: alarm
audio usage and the alarm category. Do Not Disturb lets alarms through unless
the person turned that off, so an SOS at 2 am reaches a phone in Do Not
Disturb and plays at the alarm volume. Total silence still stops it. For that
case Settings has a button under Places and alerts that opens the channel's
system page, where "Override Do Not Disturb" lets it through anyway. The text
is the same generic line as before. Android fixes a channel's sound when the
channel is created, so the alarm version needed a new id, `events_sos_alarm`.
The first SOS deletes the old `events_sos` channel and the panic wipe deletes
both.

### A sound for each kind of alert

Arrivals, departures and check-ins each post on a channel of their own
("Arrivals", "Departures", "Check-ins"); low battery, join requests and
anything else stay on "Circle alerts". Sounds are picked per channel in
Android's notification settings, so a person can tell an arrival from a
departure without looking (issue #24). Starling ships no sounds of its own:
each new channel starts with the phone's default notification sound, the
same one the general channel already had, and the text on every one of them
is still the generic "Open Starling to see what happened." Settings, Places
and alerts has "Open alert sound settings", which creates all four channels
first, so they are there to choose from before the first arrival ever comes
in. The note under it says the trade: a sound of its own also tells anyone
near the phone which kind of alert came in. An SOS and a missed check-in stay
on "Emergency alerts" exactly as before. The page names the kind with
`notifyKind`; a wrapper without it gets the old `notify` call. The panic wipe
deletes the three new channels with the others.

Emulator check, not run yet: post one alert of each kind with the app in the
background, then `adb shell cmd notification list-channels app.starlingmap 0`
lists `events`, `events_arrive`, `events_leave`, `events_checkin` and
`events_sos_alarm`, and `dumpsys notification --noredact` shows each alert on
its channel.

### The sharing notification comes back

On Android 14 and later anyone holding an unlocked phone can swipe a
foreground service notification away, and the service keeps running without
it. For a location share that is a phone sharing with nothing in the shade to
show it and no Stop button in reach. The notification now carries a delete
intent that points back at `LocationService`. If the share is still live, the
service posts it again under the same id. If the share already ended, it does
nothing. Stop and the lock screen behave as before.

### Stop on a locked phone

On Android 12 and up, Stop on the sharing notification asks for the unlock
first (`setAuthenticationRequired`). Android 11 and below have no such flag,
and SystemUI fires a service intent from a notification button straight from
the lock screen. It does dismiss the lock screen before it starts an activity,
so below 12 Stop now opens `StopShareActivity`. It has no screen, is not
exported, is never shown over the lock screen, and runs in its own task so
Starling does not come forward. It sends the service the same stop it always
got and closes. On the Android 9 and 10 emulators with a PIN set (2026-10-05),
Stop on the lock screen brought up the PIN pad and the share kept running
until the PIN went in. Backing out of the PIN pad left it running, and after
the PIN the event log showed `StopShareActivity` created and finished in
under 30 ms while the home screen stayed in front. There is no Android 11
phone image on this machine, so 11 has not been seen.

### The time on the sharing notification

Settings, Sharing, "Show the time on the sharing notification" is off by
default. With it on, the notification counts down to the end of a timed
share, or up from the start of an open one, using Android's own chronometer.
The window end is the copy the page already hands over for a restart
(`ShareResume`), and a window picked mid-share reaches the clock at once. If
the page is frozen past the end, the next minute tick switches the clock to
counting up instead of below zero. It is off by default because Android shows
a notification's full content on a locked phone unless the owner has turned
on hiding sensitive content, so the lock screen would say how long a share
has left. The generic version Android shows in that case never has a clock.

### A reminder when sharing stays off

Settings, Sharing has "Remind me if sharing stays off" (#6): Never, 1 h, 4 h
or 12 h, and Never is the default. Turning sharing off yourself sets an alarm
for that long. So do Stop on the notification, a timed share that runs out
and a circle switch. A stop that came from Android or the app lock sets
nothing, because that share comes back by itself. If no share is running when
the alarm goes off, the events channel shows "Sharing is off. Open Starling
to share again." Nothing in it names a circle or a person. Starting a share
or a panic wipe cancels the alarm and takes down a reminder that is already
showing.

The alarm is inexact because an exact one needs its own permission. On Android
12 and up an alarm window is at least 10 minutes, and the emulator delivered
at the end of it, so expect a 1 h reminder about 70 minutes after the stop. A
plain inexact alarm is allowed to run 75% late. On the Android 16 emulator
that came to 45 minutes on 1 h and an hour, the cap, on 12 h, so the hour
choices use the window. Under about 13 minutes the plain alarm is the tighter
one. Settings never offers that, but a debug build can ask the bridge for 60
seconds, and that reminder lands inside 2 minutes. Doze can hold either kind
back, and a restart drops it: the boot receiver below offers a share back and
does not set reminders again. If the reminder never turns up on your phone,
please say so on #6 with the phone model.

### After a restart or an update

A restart or an app update kills the page that seals every position, so the
share stops (#22). Opening Starling has put it back since 0.12.1, but nothing
told you it had stopped. Now a receiver for `BOOT_COMPLETED` and
`MY_PACKAGE_REPLACED` posts one notification on the events channel: "Sharing
stopped. Your phone restarted. Tap to share again." (or "Starling was
updated"). It names no circle and no person. The tap opens the app, which
resumes the share the way any reopen does, after the passcode if the app lock
is on. Nothing is decrypted or sent before that.

It only offers a share that would come back on a reopen anyway. The page hands
the wrapper a copy of its armed record (when the share started and when its
window ends, nothing else), and the receiver stays quiet if the share was
turned off by hand or with Stop on the notification, if a timed share's
window has passed, or after a panic wipe, which deletes the copy with
everything else. Starting a share or stopping one takes the notification
down. The receiver is not exported; both broadcasts come from the system.

Why it is a tap unless you turn this on: by default the app holds
while-in-use location only. A location service started from a boot or update
receiver was measured on the emulators, with the same signer installed over
itself (`adb install -r`) and a real `adb reboot`, and fixes fed in with `adb
emu geo fix`. As a control, the same service started with the app on screen
got 10 or 11 fixes from 8 injections on every image. The fourth column is the
same start with Allow all the time granted, on a throwaway build on
2026-10-05. The last is the 0.18.0 debug build with Also after a restart and
Also after an update on, measured the same day against a local relay over TLS,
counting the posts the relay stored after the restart or the `adb install -r`.

| Android | Service started at boot or update | Fixes | With Allow all the time | 0.18.0 coming back by itself |
| --- | --- | --- | --- | --- |
| 9 (API 28) | starts, notification shows | arrive | not needed | first post 7 s after boot, 13 in the first minute |
| 10 (API 29) | starts, notification shows | arrive | not measured | not measured |
| 13 (API 33) | starts, notification shows | none in 24 s | 11 at boot, 11 after an update | first post 16 s after boot, 11 to 13 a minute for 13 minutes; first post 5 s after an update |
| 16 (API 36) | `startForeground` throws `SecurityException` | none | starts typed location; 10 at boot, 11 after an update | first post 8 s after boot, 10 to 13 a minute for 14 minutes; first post 6 s after an update |

In every one of those runs no Starling activity was created, the service ran
in the foreground (type location, `0x8`, where `dumpsys` prints it), and the
shade held both "Sharing again after a restart" (or "after an update") and the
"Sharing resumed" alert. Opening the app afterwards showed the came-back card,
and the sharing report said the share came back by itself. The headless page
froze and was woken two or three times during the long runs and kept posting
to the end.

The controls on 33 and 36 each gave no posts and no service, and the tap where
the share was still due: the switch off, the app lock on, notifications
revoked, Allow all the time revoked (checked revoked before and after the
restart), and Stop on the notification before the restart, which left no tap
either. With the switch forced on behind the app lock, the service started,
the page reported locked, and the service was gone within 1.2 s with the tap
posted and nothing sent; IndexedDB held only the sealed vault records. With a
PIN set nothing ran until the first unlock, and posts started 11 to 17 s after
it. With Tor mode on and no Orbot installed, the notification said "Waiting
for Orbot", the relay saw no connection at all, and after 300 s the service
stopped and "Orbot did not connect, so nothing was sent" was posted. On 33 a
panic wipe left Allow all the time revoked.

That matches Android's own rules. From Android 11 a foreground service started
in the background cannot use location without background location, and from
14 the start itself fails ([while-in-use
restrictions](https://developer.android.com/develop/background-work/services/fgs/restrictions-bg-start#wiu-restrictions),
[Android 11
change](https://developer.android.com/about/versions/11/privacy/foreground-services),
[location type
prerequisites](https://developer.android.com/develop/background-work/services/fgs/service-types#location)).
A boot receiver is not on the list of exemptions. Android 15's boot receiver
limits leave the location type out
([list](https://developer.android.com/about/versions/15/behavior-changes-15#fgs-boot-completed)),
which does not help when 14 already refuses it. On Android 9 and 10 the
service would get fixes, but positions are sealed in the page, and the page
only starts a share from a window: the WebView version gate and the Orbot
proxy are set up there. So every version gets the tap unless you turn on one
of the switches below.

An update from 0.16.1 or older to this version offers nothing, because the
older page never handed its record over. The first share after the update
does.

#### Coming back by itself

Settings, Sharing has two switches under Keep sharing when the app is closed,
both off by default: Also after a restart and Also after an update. A share
that comes back runs with no window, so both need Keep sharing, and turning
Keep sharing off turns them off. Turning one on also needs a location grant,
Starling's notifications visible (the app's, and neither the Location sharing
nor the Circle alerts channel blocked), and on Android 10 and later Allow all the
time: the page explains first, then Android asks, with a dialog on 10 and the
app's location settings page from 11. Android 9 needs nothing more, because
its location grant already covers all the time. With the app lock on the
switches are off and stay off: the passcode seals the circle key, so a page
built at boot would be locked and could share nothing. Turning the lock on
turns them off before anything is sealed.

At a restart or an update the receiver checks what a reopen would: the armed
record (never a share you stopped, never a lapsed window, never after a panic
wipe), the switch for this case, Keep sharing, the grant and the
notifications, then the WebView floor and, with Tor mode on, that the WebView
can take a proxy. A switch whose conditions have gone is turned off rather
than left waiting. Any miss gets the tap above. Otherwise it starts the
location service, whose notification reads "Sharing again after a restart"
(or "after an update"), and builds the page with no activity, held in the same
private virtual display a page kept past a swipe uses. The proxy setting goes
in before that page's WebView exists. With Tor mode on the page loads only
once it has landed; with it off there is nothing to wait for, so it loads at
once. It boots the way a reopen does and tells the wrapper how that went.
When the share is back, Starling posts "Sharing resumed" on the Circle alerts
channel, and the next time the app is opened a card says the share came back
by itself, and to check who has access to the phone if that was not you. When
the app lock held the page shut, or the page said no or failed, the service
stops and you get the tap, as long as the share is still due: a share you
stopped or one whose window ran out gets nothing. If the page says nothing
within 90 seconds, it is destroyed first so nothing more is posted, then the
service stops and you get the tap.

Your own server gets nothing until the page says started. The map fetches no
tiles until a window shows the page for the first time. With no window the
page freezes after a few minutes like any kept page. The same nudge and
watchdog keep it posting. With Tor mode on, fixes come from GPS only, the
notification says "Waiting for Orbot" until the first post gets through, and
Starling asks Orbot every 25 seconds; if nothing has gone out after 5 minutes
the page and the service go and you get "Orbot did not connect, so nothing was
sent". Nothing is ever sent outside Tor while it waits. If you use Orbot's
per-app VPN instead of the proxy switch, turn on Always-on VPN with Block
connections without VPN for Orbot in Android's settings, or a share that comes
back can go out before Orbot's VPN is up.

The receiver is not direct boot aware on purpose, so after a restart nothing
happens until the phone is unlocked once. A panic wipe forgets both switches,
and on Android 13 and later asks Android to take Allow all the time back as
the wiped process dies.

What this does not cover: a share Android ends by killing the whole process
(a low-memory or OEM killer) still waits for a reopen. A service that asked
Android to restart it would come back in a new process with no window, and
nobody has measured whether Android 12 and later let it go foreground from
there.

## Sharing with the screen off

Everything that seals and posts a position runs in the page, and a WebView
page is not built to be a background worker. Three things stood between a
locked phone and its circle, and each one has its own fix.

### Chromium freezes hidden pages

A page that has been hidden for a while is frozen: five minutes in WebView
133, one minute from Chromium 143 on. A fix the service pushes still reaches a
frozen page, because `evaluateJavascript` runs regardless, but everything a
post needs after that (IndexedDB, WebCrypto, `fetch`, timers) waits until the
page is visible again. This was munzzyy/starling#6: phones locked and put down
went quiet a minute or five later and stayed quiet until somebody opened the
app, at which point the whole backlog went out at once. The only thing that
thaws a page is being visible, so while a share runs `PageHost` calls
`dispatchWindowVisibilityChanged(View.VISIBLE)` on the WebView, and a second
later `GONE` again. Chromium unfreezes the page and starts its freeze clock
over; nothing is drawn, because the real window is still hidden. It happens
when the page's own `freeze` event says it was just frozen, and as a fallback
when the page stops answering: every push is answered from a task of the
page's own (a `MessageChannel` message), which only runs if the page is really
running. The page asks `StarlingNative.windowShown()` instead of trusting
`document.visibilityState` wherever "visible" has to mean a person is looking
(notifications, the autolock, the poll pace), since for that second it reads
"visible".

### A swiped app has no window to be visible in

Once a WebView has been attached to a window, Chromium only counts it visible
while it is attached to one, so a page carried past a swipe could never be
thawed. With "keep sharing when the app is closed" on, the page moves into a
window of its own when the activity goes: a `Presentation` on a private
virtual display the app creates and owns. It needs no permission, its root
view is `GONE` so it never draws or gets a surface, and no other app can see a
private display. Opening the app moves the page back and releases the display.
If a phone refuses the presentation, the page is left with no window, and the
watchdog below ends the share out loud when the page freezes.

### The CPU sleeps between fixes

Android holds a wake lock while it hands a fix over and lets go when the
listener returns, which is before the page has started on it. The service now
holds one partial wake lock during a share, with a 30 second ceiling per fix,
and the page releases it as soon as its post settles. A phone lying still
wakes once per cadence, every 15 seconds unless the circle is set to a minute
or five, for as long as it takes to seal and post, usually well under a
second.

### Save battery when still

Issue #25 measured Starling at about three times Life360's battery on a Pixel
6a. Most of that is GPS: the distance-filtered listener asks for a fix every
3 seconds, which keeps the GPS engine on for the whole share, and a still
phone still seals and posts on every cadence. Settings, Sharing, "Save battery
when still" (off by default) changes that for a phone that is not going
anywhere:

- The service watches for two minutes with no fix outside
  max(25 m, 2 x the worse accuracy) of where the phone was, and no word from
  the significant motion sensor. Fixes worse than 100 m count for nothing
  either way. The detector is `StillClock.kt`, with JVM tests in
  `StillTest.kt`.
- Still, it drops the 3 second listener and keeps one heartbeat every
  5 minutes, so the GPS wakes for one fix at a time instead of staying on.
  The page re-arms its own timer to 5 minutes and posts once at once with
  `cadence: 300`, so receivers move their quiet line to 10 minutes before the
  old pace calls the phone quiet at 3. After that a post goes out about every
  5 minutes, from the heartbeat fix or from the minute tick.
- Moving again ends it: the significant motion sensor is a one-shot wake-up
  sensor that fires when someone starts walking or riding, and a heartbeat
  fix outside the radius does the same. Both listeners come back at once and
  the first fix goes out on the circle's pace.
- It needs a significant motion sensor. Without one there is nothing that can
  wake a sleeping phone when it starts moving without a stream of sensor
  wake-ups that would cost what it saves, so the switch stays off and says
  why. The sensor needs no permission; nothing here uses activity
  recognition or Google Play services, which de-googled phones do not have.
- It never runs during an SOS or with Steady sending on. Steady sending
  exists to keep the timing even, and slower posts while still are exactly
  the timing it hides, so the switch shows off and disabled with a note.
- The sharing report says whether it is on, whether the phone is still now,
  and how many times and for how long it was still this share.

Not measured yet, since there is no emulator in this round. What to check on
API 36 and one older image: with the switch on, `adb emu geo fix` the same
spot for three minutes, then `adb shell dumpsys location` shows only a 300 s
request from `app.starlingmap` and a local relay gets a post about every
5 minutes; `adb emu sensor set acceleration` jolts plus a moved fix bring the
3 second request back within seconds and a post goes out at once; an SOS
during still mode posts every 15 seconds. The emulator may have no
significant motion sensor, in which case the switch must say so.

### Around the same failure


- If the page stops answering for three minutes and waking it does nothing,
  the share ends with a record and a notice (route `stalled`), rather than
  leaving a notification that says "sharing" over a page that posts nothing.
- If Android stops the service itself, which it does about a minute after the
  app leaves the screen when battery use is set to Restricted, the page is
  told, the share ends with a record (route `system`), and opening the app
  puts it back on.
- A share that ends while nobody is looking wakes the page once more, so its
  goodbye still reaches the circle before the page is let go.
- Location switched off shows on the notification and on the line under your
  name, and the last position is not sent again as if it were live.
- A minute with no fix at all wakes the phone and sends the last position
  again, and five minutes of silence with location on renews the location
  requests.
- A share start from a page whose window is not showing waits for the window
  instead of failing, since Android refuses to start a location service from
  the background.
- Back, during a share, leaves the app the way Home does. Android finishes the
  activity on Back unless it was opened from the home screen, and a Starling
  opened from its own notification used to close, taking the share with it.

### The battery exemption

AOSP already exempts a location foreground service from Doze's network and
wake lock limits, and the emulator measurements showed no difference with or
without the exemption. Phones add their own battery management on top, though,
and the open source trackers people compare this to (Traccar, GPSLogger,
OwnTracks) all ask for it, so the app does too: once, when a share starts on a
phone that is optimizing Starling, with its own explanation before the system
dialog, and "Not now" is final. Settings shows the current state under
Sharing, with the one button that changes it. "Restricted" cannot be fixed by
the dialog, so both the card and Settings send the person to the app's own
settings page for it. This is what `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` is
for; `WAKE_LOCK` is for the wake lock above. Neither grants access to
anything.

When Battery Saver is what turns location off, its card has a button that
opens the Battery Saver screen (`ACTION_BATTERY_SAVER_SETTINGS`, or the main
settings on a phone without one). When location itself is off, the sharing
notification gets "Turn on location" next to Stop. It opens the system
location settings through an activity intent, so a locked phone asks for the
unlock first, and the generic version has no buttons at all.

### The sharing report

Settings, Sharing, "Copy sharing report" puts a plain text summary on the
clipboard for a bug report: app, Android and WebView versions, the device
model, permission and battery states, Battery Saver, idle state, standby
bucket, and counts and ages for fixes, posts, freezes and wake-ups. It is
built from a fixed list of fields in `sharehealth.js`, each held to the shape
it should have, so it cannot carry a position, a key, a name, a place, a
circle or a relay address. The app never sends it anywhere.

### Testing it

The freeze only shows after the delay, so a test shorter than five minutes (or
one, on a newer WebView) passes whether or not any of this works. On a
debuggable build or a userdebug image, WebView reads flags from
`/data/local/tmp/webview-command-line`, and this shortens the delay to a
minute:

```
adb shell 'echo "_ --enable-features=stop-in-background:DelayForBackgroundTabFreezingMills/60000" > /data/local/tmp/webview-command-line'
```

Force-stop the app afterwards so the WebView reads it. The page's `freeze` and
`resume` events, and the counts in the sharing report, show each freeze and
each wake-up.

## Known WebView-specific limits

- **Safe Browsing and WebView metrics are off, autofill lookups are not.**
  On a phone with Google's WebView, Safe Browsing checks each page a WebView
  loads against lists from Google. WebView can also send usage metrics. The
  page only ever loads its own bundled files and map tiles. So the manifest
  sets `android.webkit.WebView.EnableSafeBrowsing` to false and
  `android.webkit.WebView.MetricsOptOut` to true, and `PageHost` turns Safe
  Browsing off on the WebView it builds. A capture on 2026-09-22 also showed
  the WebView asking `content-autofill.googleapis.com` on its own. No app
  setting stops that request because it comes from the WebView build on the
  phone.
- **No service worker.** `sw.js` is never registered inside the wrapper.
  Assets are bundled into the APK and served through
  `WebViewAssetLoader` at `https://appassets.androidplatform.net/`, which is
  a secure context (WebCrypto and IndexedDB work normally), so the app does
  not need offline caching the way the installable web PWA does; the app
  itself is already the offline copy.
- **Biometric unlock uses Android Keystore, not WebAuthn PRF.** The web app's
  biometric app-lock path depends on the WebAuthn PRF extension, which is
  not available inside a plain WebView (`navigator.credentials` is absent).
  The wrapper skips WebAuthn entirely and adds a native bridge instead: an
  AES-GCM key in the Android Keystore with
  `setUserAuthenticationRequired(true)`, unlocked through `BiometricPrompt`
  with a `CryptoObject`. It is hardware-gated the same way WebAuthn PRF is,
  and Android invalidates the key automatically if the user's biometric
  enrollment changes (new fingerprint added, face re-enrolled), which is the
  correct behavior since a changed enrollment means a different set of
  biometrics can now unlock the vault. `lock.js` treats this as a third
  record type behind the same interface the passcode and WebAuthn paths use,
  so the crypto and storage logic do not fork per platform.
- **IndexedDB eviction.** Android can evict an app's storage under disk
  pressure the same as it can for any app; a WebView-hosted IndexedDB is not
  automatically exempt just because it is native-adjacent. The app calls
  `navigator.storage.persist()` on startup to ask the OS to treat its
  storage as non-evictable, which Android generally honors for apps with
  meaningful usage, but this is a request, not a guarantee, and users should
  not treat on-device storage as more durable than it is.
