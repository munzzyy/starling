# F-Droid submission runbook

This is a runbook, not an action already taken. Filing the merge request is
Cole's call. `docs/fdroid/app.starlingmap.yml` is a draft sitting in this
repo until then; nothing here pushes it anywhere.

## Preferred path: fdroiddata merge request

F-Droid accepts new apps either through a Request For Packaging (RFP) issue
or a direct merge request against fdroiddata. For an app whose metadata is
already written and whose build is already verified, the direct MR is
faster and skips a round of someone else volunteering to write the metadata
for you. Use it.

1. Fork `gitlab.com/fdroid/fdroiddata` on GitLab.
2. Add `metadata/app.starlingmap.yml`, copied from
   `docs/fdroid/app.starlingmap.yml` in this repo with the real commit hash
   for the `v0.2.0` tag filled in (replace `COMMIT_HASH_OF_v0.2.0_TAG`).
3. Run the local build check before pushing:
   `fdroid build --verbose app.starlingmap:200` (needs the fdroidserver
   tooling and buildserver setup; see the fdroidserver docs for the
   sandboxed build environment, since running it unsandboxed on a dev
   machine is not how F-Droid's own infra builds it).
4. Push the branch, let the fdroiddata CI pipeline run, and fix anything it
   flags (lint rules, missing fields, category naming).
5. Open the merge request once the pipeline is green.

## What has to exist before filing

- A tagged release (`v0.2.0`) on `github.com/munzzyy/starling` with a commit
  that fdroiddata's `Builds.commit` field can pin to. F-Droid builds from a
  specific commit, not from a rolling branch.
- The fastlane metadata already in this repo under
  `fastlane/metadata/android/en-US/` (title, descriptions, changelog). This
  feeds F-Droid's listing the same way it feeds Play.
- A working, reproducible-from-source build: `npm ci`, `tools/sync-vendor.sh`,
  then `android/gradlew assembleRelease` from a clean checkout (with an
  Android SDK on `ANDROID_HOME`) and no network access beyond the `init`
  step, producing an unsigned APK.
- No vendored, minified, or prebuilt JavaScript committed to the repo.
  Leaflet is a normal npm dependency with a lockfile; `tools/sync-vendor.sh`
  copies the unminified `dist/leaflet-src.js` into `app/vendor/leaflet` at
  build time and that directory stays gitignored. This is the difference
  between "F-Droid can build this from source" and a rejection.

## Reproducible builds upgrade path

F-Droid signs the APKs it distributes with its own key by default. A
reproducible build lets F-Droid instead ship the exact APK we signed with
our own upload key, verified byte-for-byte against F-Droid's own build of
the same commit. That is a stronger guarantee for users (Play, F-Droid, and
a manual download all trace to one signature) but it is a later step, not a
blocker for initial acceptance.

1. Get the app accepted and building normally first. F-Droid signs it with
   the F-Droid key in the meantime; that is a normal, working state, not a
   failure state.
2. Once our release process (`tools/release-android.sh`) and F-Droid's build
   both produce byte-identical output for the same commit and versionCode,
   uncomment the `Binaries:` and `AllowedAPKSigningKeys:` lines in
   `app.starlingmap.yml`. `Binaries:` points at the GitHub Releases URL
   pattern for our signed APK; `AllowedAPKSigningKeys:` is our upload
   certificate's SHA-256 fingerprint with the colons removed, lowercase
   (fdroidserver compares the string exactly and uses lowercase hex).
3. Verify reproducibility independently before flipping that switch, using
   `verification.f-droid.org` (or `fdroid build --verbose` locally against
   the same commit) to diff F-Droid's rebuild against our published APK.
   `apksigner` from build-tools 34 is the version F-Droid's own tooling
   expects for the signature-copy step; using a newer build-tools version
   here can produce a technically valid but non-matching signing block.
4. Send the follow-up MR enabling those two lines once the diff is clean.

## What is already decided

- Reproducibility properties (unsigned deterministic release build, vcsInfo
  off, PNG cruncher off, no minification, dependency locking on) are chosen
  specifically so this upgrade path stays open. See `docs/ANDROID.md`.
- Signing never happens inside Gradle or CI. `tools/release-android.sh`
  signs locally with `apksigner` from a keystore that is not in the repo.
  Nobody but Cole can produce a validly signed Starling release APK, which
  is also why F-Droid's own signature necessarily differs from ours until
  the `AllowedAPKSigningKeys` step above is done.
