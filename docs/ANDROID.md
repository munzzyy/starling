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
is the same process F-Droid's own reproducible-builds verification runs;
see `docs/fdroid/SUBMISSION.md` for how that gets wired up formally once
proven.

## PanicKit

The app registers a PanicKit responder (`info.guardianproject.panic`).
Pairing with a trigger app like Ripple happens through the visible
`ACTION_CONNECT` flow, the same as connecting any other panic-response app;
Starling shows what it will do and asks nothing else. Once connected,
receiving `ACTION_TRIGGER` from that same paired app wipes immediately, with
no confirmation dialog, because the entire point of a panic trigger is that
it has to work without a second decision under pressure. The wipe clears
IndexedDB, localStorage, and WebView's own storage/cache, matching the
in-app panic wipe path, and finishes the activity. The responder verifies
the sender package against the connected trigger app; an unpaired or
spoofed sender is ignored.

## Orbot

Two independent paths, both supported:

- **Per-app VPN mode.** Orbot's per-app proxying works with zero code on
  Starling's side. Turn it on for Starling in Orbot and its traffic routes
  through Tor like any other app's.
- **In-app SOCKS toggle.** Settings has a proxy toggle that routes requests
  through `socks://127.0.0.1:9050` using `androidx.webkit`'s
  `ProxyController`, feature-detected at runtime so it silently does
  nothing on WebView versions that lack `PROXY_OVERRIDE` support instead of
  breaking. This path needs Orbot's **Power User Mode** turned on, since
  Orbot only exposes its SOCKS port to other apps in that mode.

## Custom relay

Both the web app and the Android wrapper have a relay address setting.
Default is `https://starlingmap.app`. Anyone running their own relay
(`relay/` in this repo, deployed with `relay/deploy.sh`) can point their
client at it instead. This is the mechanism that keeps Starling out of
F-Droid's "tethered to a specific server" anti-feature category: using our
relay is a default, not a requirement.

## Known WebView-specific limits

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
