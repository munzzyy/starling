#!/bin/bash
# Grep-based invariants for the two lock-screen notification leaks fixed in
# Events.kt and LocationService.kt. A grep cannot prove a notification is
# safe (it does not run the code or inspect what actually reaches the OS at
# runtime), only that specific known-vulnerable patterns are absent and that
# specific required calls are present in the right place. Treat a pass here
# as "the known regression didn't come back," not as a full audit.
set -uo pipefail
cd "$(dirname "$0")/.."

events=android/app/src/main/kotlin/app/starlingmap/Events.kt
service=android/app/src/main/kotlin/app/starlingmap/LocationService.kt
fail=0

# Events.post takes the real title/body of a circle event (a member's name,
# a place name) as arguments. Before the fix, one of the two builders fed
# those straight into a notification field, which the OS shows on the lock
# screen by default regardless of VISIBILITY_PRIVATE, since
# LOCK_SCREEN_ALLOW_PRIVATE_NOTIFICATIONS defaults to true. Both builders
# must stay generic; this pattern must never come back on either.
if grep -nE '\.setContentTitle\(title\)|setContentText\(body\)' "$events" >/dev/null; then
  echo "Events.kt feeds the real title or body into a notification field:"
  grep -nE '\.setContentTitle\(title\)|setContentText\(body\)' "$events"
  fail=1
fi

# The Stop action on the ongoing share notification must require the device
# to be unlocked (Android 12+, Notification.Action.Builder#setAuthenticationRequired).
if ! grep -q 'setAuthenticationRequired(true)' "$service"; then
  echo "LocationService.kt's Stop action does not require authentication"
  fail=1
fi

# A stop triggered from ACTION_STOP (the notification's Stop button) must
# leave the same "share ended" trace onTaskRemoved leaves, so a lock-screen
# stop is not silent to the person relying on the share.
stop_branch=$(awk '/ACTION_STOP/,/^        }/' "$service")
if ! grep -qE 'Events\.post|postShareEnded\(' <<<"$stop_branch"; then
  echo "LocationService.kt's ACTION_STOP branch does not post a share-ended event"
  fail=1
fi

if [ "$fail" -eq 0 ]; then echo "clean: notification privacy invariants hold"; fi
exit $fail
