#!/bin/bash
# Build and sign the Android release artifacts:
#   dist/starling-<version>.apk  developer-signed universal APK: GitHub release,
#                                F-Droid reproducible verification, sideload
#   dist/starling-<version>.aab  upload-key-signed bundle for Play Console
#
# Never run by CI. The keystore lives outside the repo and its password stays
# in the system keyring (secret-tool lookup service starling-keystore key
# upload); nothing here prints it.
#
# The APK is signed with apksigner from build-tools 34.0.0 on purpose:
# F-Droid's apksigcopier verifies and copies signatures produced by that
# version; newer build-tools emit signatures it rejects.
set -euo pipefail
cd "$(dirname "$0")/.."

KEYSTORE="${STARLING_KEYSTORE:-$HOME/keys/starling-upload.jks}"
ALIAS=starling-upload
SDK="${ANDROID_HOME:-$HOME/Android/Sdk}"
SIGN_TOOLS_VERSION=34.0.0

[ -f "$KEYSTORE" ] || { echo "keystore not found: $KEYSTORE"; exit 1; }
[ -f app/vendor/leaflet/leaflet.js ] || { echo "app/vendor is missing. Run: npm ci && bash tools/sync-vendor.sh"; exit 1; }

KSPW=$(secret-tool lookup service starling-keystore key upload) || {
  echo "no keystore password in the keyring (service starling-keystore key upload)"; exit 1;
}
export KSPW

APKSIGNER="$SDK/build-tools/$SIGN_TOOLS_VERSION/apksigner"
if [ ! -x "$APKSIGNER" ]; then
  echo "== installing build-tools $SIGN_TOOLS_VERSION (apksigner pinned for F-Droid) =="
  # yes dies of SIGPIPE when sdkmanager stops reading; that is fine.
  (yes || true) | "$SDK/cmdline-tools/latest/bin/sdkmanager" "build-tools;$SIGN_TOOLS_VERSION" >/dev/null
  [ -x "$APKSIGNER" ] || { echo "build-tools $SIGN_TOOLS_VERSION did not install"; exit 1; }
fi

echo "== build =="
( cd android && ANDROID_HOME="$SDK" ./gradlew --no-daemon clean assembleRelease bundleRelease )

VERSION=$(grep -oE 'versionName = "[^"]+"' android/app/build.gradle.kts | cut -d'"' -f2)
mkdir -p dist
APK_IN=android/app/build/outputs/apk/release/app-release-unsigned.apk
AAB_IN=android/app/build/outputs/bundle/release/app-release.aab
APK_OUT="dist/starling-$VERSION.apk"
AAB_OUT="dist/starling-$VERSION.aab"

echo "== sign apk (schemes v2+v3) =="
"$APKSIGNER" sign --ks "$KEYSTORE" --ks-key-alias "$ALIAS" --ks-pass env:KSPW \
  --out "$APK_OUT" "$APK_IN"
"$APKSIGNER" verify --print-certs "$APK_OUT" | head -4

echo "== sign aab (jar signature; Play verifies the upload key from it) =="
cp "$AAB_IN" "$AAB_OUT"
jarsigner -keystore "$KEYSTORE" -storepass:env KSPW \
  -sigalg SHA256withRSA -digestalg SHA-256 "$AAB_OUT" "$ALIAS" >/dev/null
jarsigner -verify "$AAB_OUT" >/dev/null && echo "aab signature verifies"

unset KSPW

echo "== artifacts =="
sha256sum "$APK_OUT" "$AAB_OUT"
