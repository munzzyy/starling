# Google Play Console listing

Copy-pasteable answers for the Play Console store listing, data safety form,
content rating questionnaire, and the foreground service and background
location declarations. Source
facts: `docs/THREAT-MODEL.md`, `SECURITY.md`, the fastlane metadata in
`fastlane/metadata/android/en-US/`.

## Store listing

**App name:** Starling

**Short description** (80 char max, same as `fastlane/.../short_description.txt`):

```
End to end encrypted location sharing. No accounts, no tracking.
```

**Full description** (Play allows up to 4000 characters and does not render
the `<b>` tags fastlane/F-Droid use the same way; this version drops markup
and leans a little more on what Starling replaces, since Play search skews
toward people typing "life360 alternative"):

```
Starling is private location sharing for your circle: family, a partner, a
small group of friends. No accounts, no phone numbers, no company in the
middle reading your position.

END TO END ENCRYPTED
Your location is encrypted on your device with AES-256-GCM under a key
only your circle's phones hold. It never travels in an invite link: an
invite carries a one-time code, and a new member gets the circle's keys only
after you compare a safety number with them and accept. The relay stores
ciphertext it cannot read.

NO ACCOUNTS, NO TRACKING
No sign-up, no phone number, no email, no push tokens, no analytics, no
crash reporting. The only outside request Starling makes is OpenStreetMap
map tiles, and only if you leave the street basemap on. The Off-grid
basemap renders locally and makes zero network requests.

A ZERO-KNOWLEDGE RELAY
The relay moves ciphertext between your circle's devices. It sees channel
ids, padded message sizes, timing, and IP addresses, never a position, a
name, or who is in your circle. Every row expires after 24 hours.

PANIC WIPE
One action clears everything the app has stored on your device.

APP LOCK
Optional passcode lock encrypts your circle secret at rest, with the passcode stretched by
Argon2id (64 MiB, three passes), and with fingerprint or face unlock through Android Keystore
where your device supports it.

SOS AND CHECK-INS
Hold to fire an SOS your circle sees immediately, or check in with a status
without leaving your location on all the time.

BACKGROUND SHARING, HONESTLY DISCLOSED
The Android app can keep sharing your location while your screen is off,
with a persistent notification the entire time so it is never silent about
what it is doing.

SELF-HOSTABLE
Point the app at your own relay instead of ours. The relay is open source
and small: run it on Cloudflare Workers, or as a plain server behind your
own Apache or nginx with no Cloudflare account at all.

WORKS WITH ORBOT
Per-app VPN mode needs no setup. A SOCKS toggle is available if you turn on
Power User Mode in Orbot.

Source is on GitHub under the GPL-3.0-or-later license.
```

**Category:** Maps & Navigation. (Alternative: Tools, if Maps & Navigation
review turns out to expect turn-by-turn features Starling does not have.)

**Contact details:**
- Email: Munzzyy1@proton.me
- Website: https://starlingmap.app
- Privacy policy: https://starlingmap.app/privacy

**Tags / store presence suggestion:** "location sharing," "family locator
alternative," "privacy," "end to end encryption." Do not claim
HIPAA/SOC2/any compliance certification Starling has not gone through.

## Data safety form

Play's own rule: data that is end to end encrypted and unreadable by the
developer is not "collected" for data safety purposes (this is the same
exemption Signal uses). Starling's location payloads qualify, because the
relay stores ciphertext under a key derived from a secret that never leaves
member devices and the developer has no way to decrypt it. Answer the form
section by section on that basis, and declare plainly what actually is true
alongside it.

The form asks about each data type separately; answer per type rather than
one blanket yes or no.

Location: answer No, on the encrypted end-to-end / cannot be decrypted by
developer basis if the form offers that path, since the data is encrypted
before it ever reaches our servers. If the form only offers a plain yes or
no, answer No and be ready to explain the reasoning in the optional notes
field. It is used only to render the live map, never shared with third
parties, and never persisted in readable form server-side.

Personal info (name, email, phone, address): No. There is no account and
no field anywhere in the app that asks for any of these.

App activity / app info and performance (crash logs, diagnostics): No.
Starling ships no analytics, crash reporting, or telemetry SDK of any kind.

Device or other identifiers: No.

IP addresses: the relay necessarily sees the source IP of each request, as
any server does, and uses it only in an in-memory sliding-window rate
limiter that never touches the database and evicts itself within a minute.
Nothing IP-derived is stored, logged, or linked to a person. Play's form
treats server-side abuse-prevention processing of this kind under its
fraud prevention and security carve-outs; if a reviewer asks, this is the
documented answer, and the threat model discloses the same fact publicly.

Data encrypted in transit: Yes, all relay traffic is HTTPS.

Can users request data deletion? Yes, functionally. Relay rows expire
automatically within 24 hours by design, so there is no manual deletion
request needed for server-side data since nothing outlives that window
anyway, and panic wipe deletes all on-device data immediately. If the form
insists on a deletion contact regardless, use Munzzyy1@proton.me.

Does your app have a privacy policy? Yes: https://starlingmap.app/privacy

## Content rating questionnaire

Answer through Play's IARC questionnaire (not reproduced here since Google
changes the exact wording periodically, so check the live form). Violence,
gambling, in-app purchases, ads, and user-generated content visible to
strangers: Starling has none of it. One
thing to flag honestly is that it shares precise real-time location between
consenting circle members, which some rating bodies ask about under a
"shares location" or "personal information" category. Answer that question
yes, and note in any free-text field that sharing is opt-in, user-initiated,
and confined to a circle the user controls.

## Target audience and content

Not designed for or directed at children. Set the target age group to 18+
(or Play's nearest "not for children" designation) and do not enroll in the
Designed for Families program. The app should not appear in child-directed
search surfaces.

## Foreground service (location) declaration

Play requires apps declaring `FOREGROUND_SERVICE_LOCATION` to explain the
use case and what happens if the service is interrupted, in the Play
Console's App content section.

Use case: user-initiated live location sharing. A user who taps "share"
starts a foreground service that keeps sending their position to members of
a circle they belong to, so sharing continues if they lock the screen or
switch apps. It runs only while the user has explicitly turned sharing on.
The one start without the app on screen is a share coming back after a
restart or an app update, which happens only if the user turned on one of the
two switches for it; see the background location declaration below.

What the user sees: a persistent notification for the entire time sharing
is active. It states that Starling is sharing the location of the user. On
Android 14 and later it can be swiped away, and the app posts it again at
once. Tapping it returns to the app; there is a stop action to end
sharing immediately.

Impact if interrupted: if the OS kills the foreground service (low memory,
battery optimization, force-stop), location sharing stops. Circle members
see the user's last known position go stale in the UI rather than a false
live indicator, and the user gets a notice that sharing stopped; when the OS
stopped it, opening the app turns it back on. Nothing safety-critical depends
on the service staying alive (this is not an emergency dispatch app).

Google's review team also wants a short screen recording of the flow: open
the app, start sharing, background the app, see the persistent
notification, stop sharing. Record it once the wrapper build is functional
and attach the link here. Not recorded yet, flagged for a build-complete
pass.

## Background location declaration

The app declares `ACCESS_BACKGROUND_LOCATION` for one feature: a share the
user had running comes back by itself after the phone restarts or the app
updates. It is off by default, behind two switches in Settings, Sharing (Also
after a restart, Also after an update), and each needs Keep sharing when the
app is closed on first.

Use case, to paste:

```
Starling shares the user's live location with the people in their circle,
end to end encrypted. If the user turns on "Also after a restart" or "Also
after an update" in Settings, a share they had running starts again by itself
after the phone restarts or Starling updates, so their family does not lose
sight of them because of a restart they did not notice. The share runs in the
same location foreground service, with its notification showing the whole
time and an alert saying it came back. Starling asks for "Allow all the time"
only when the user turns one of these switches on, after an in-app
explanation. Location is used for nothing else, and nothing is collected by
the developer.
```

Prominent disclosure, shown in the app before the system asks, verbatim:

> **Allow location all the time?**
>
> Starling uses your location to keep sharing it with your circle after a
> restart or an update, even when the app is closed or not in use. Your
> position is encrypted on this phone before it leaves, only your circle can
> read it, and Starling uses it for nothing else.
>
> Android opens Starling's location settings next. Choose Allow all the
> time, then come back.

Buttons: Continue, Not now. On Android 10 the second paragraph reads
"Android asks next. Choose Allow all the time." and the system dialog
follows.

Video storyboard (Play wants one, under 30 seconds):

1. Settings, Sharing, Keep sharing when the app is closed on.
2. Tap Also after a restart. The disclosure above appears; tap Continue.
3. Android's location permission screen for Starling; choose Allow all the
   time; come back. The switch is on, and a toast says sharing will come
   back after a restart.
4. Start a share; the sharing notification shows.
5. Restart the phone (`adb reboot` on the recording device) and unlock it.
6. Without opening the app, pull down the shade: "Sharing again after a
   restart" and the "Sharing resumed" alert.
7. Open the app: the card saying sharing came back by itself.

Data safety: unchanged. Location is still processed on the device and sent
end to end encrypted to the user's circle; the developer collects nothing.

Not recorded yet, and Play is not live; do this before the first submission.

## Battery optimization exemption

The app declares `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`, and Play checks that
against its list of acceptable uses. Paste this:

```
Starling shares the user's live location with their circle while the screen
is off, from a foreground service the user turned on. On some phones battery
optimization pauses that work, and the circle sees an old position while the
notification still says sharing is on. Starling asks once, when the user
starts a share on a phone that is optimizing it. It explains why first, and
"Not now" is never asked again. The request itself is the system dialog.
Settings shows the current state and a button to change it. Sharing works
without the exemption; it just holds up better with it.
```

If Play says no, drop the permission and open the system's list instead
(`ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS`). That needs no permission,
but the user has to find Starling in the list themselves.

## App signing and upload key

- Play App Signing is mandatory for new apps; enroll during first upload
  from Play Console.
- Upload key: local keystore at `~/keys/starling-upload.jks`, alias
  `starling-upload`, password in the system keyring (`secret-tool lookup
  service starling-keystore key upload`). This never enters the repo.
- Upload certificate SHA-256 fingerprint:
  `DB:B0:C4:91:53:0F:74:75:40:9C:4C:29:53:E9:F6:8A:52:51:9C:2F:68:1D:D9:E5:F6:99:38:F3:BF:9B:8C:9E`
- Google re-signs the AAB with its own Play Signing key for distribution;
  pull that Play Signing certificate fingerprint from Play Console after
  the first upload and add it as a second entry in the `ASSETLINKS`
  constant in `relay/src/index.js` (the worker serves
  `/.well-known/assetlinks.json` from that constant; there is no static
  file), then redeploy the relay. With both fingerprints listed, Verified
  App Links work for the Play-distributed build and a locally signed
  release APK alike.

## Before first submission

- Personal (non-organization) Play Console accounts created now must clear
  a closed test with at least 12 testers held for 14 continuous days before
  Play allows a production release. Budget for that window.
- Target API level 36 (Android 16) is required for new app submissions.
