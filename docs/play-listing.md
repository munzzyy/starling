# Google Play Console listing

Copy-pasteable answers for the Play Console store listing, data safety form,
content rating questionnaire, and the foreground service declaration. Source
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
derived from a 32-byte secret that only exists in your invite link, in the
part of the URL browsers never send to a server. The relay stores ciphertext
it cannot read.

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
Optional passcode lock encrypts your circle secret at rest (PBKDF2-SHA-256,
600k iterations), with fingerprint or face unlock through Android Keystore
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
and small.

WORKS WITH ORBOT
Per-app VPN mode needs no setup. A SOCKS toggle is available if you turn on
Power User Mode in Orbot.

Source is on GitHub under the MIT license.
```

**Category:** Maps & Navigation. (Alternative: Tools, if Maps & Navigation
review turns out to expect turn-by-turn features Starling does not have.)

**Contact details:**
- Email: Munzzyy1@proton.me
- Website: https://starlingmap.app
- Privacy policy: https://starlingmap.app/privacy.html

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

Does your app have a privacy policy? Yes: https://starlingmap.app/privacy.html

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
switch apps. It runs only while the user has explicitly turned sharing on,
never in the background without that action, and never requests
`ACCESS_BACKGROUND_LOCATION`.

What the user sees: a persistent, non-dismissible notification for the
entire time sharing is active, stating that Starling is sharing the user's
location. Tapping it returns to the app; there is a stop action to end
sharing immediately.

Impact if interrupted: if the OS kills the foreground service (low memory,
battery optimization, force-stop), location sharing simply stops. Circle
members see the user's last known position go stale in the UI rather than
a false live indicator. Nothing safety-critical depends on the service
staying alive (this is not an emergency dispatch app). The user restarts
sharing with one tap whenever they want.

Google's review team also wants a short screen recording of the flow: open
the app, start sharing, background the app, see the persistent
notification, stop sharing. Record it once the wrapper build is functional
and attach the link here. Not recorded yet, flagged for a build-complete
pass.

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
