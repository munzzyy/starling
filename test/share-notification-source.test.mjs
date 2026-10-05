// Kotlin read as source; the emulator check for the swiped notification is in the commit that added it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const kt = (name) =>
  readFileSync(new URL(`../android/app/src/main/kotlin/app/starlingmap/${name}`, import.meta.url), "utf8");
const manifest = () => readFileSync(new URL("../android/app/src/main/AndroidManifest.xml", import.meta.url), "utf8");

function fn(src, name) {
  const at = src.search(new RegExp(`fun ${name}\\([^)]*\\)(: [\\w?<>, ]+)? \\{`));
  assert.ok(at >= 0, `fun ${name} exists`);
  const open = src.indexOf("{", at);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(at, i + 1);
  }
  throw new Error(`unbalanced ${name}`);
}

test("the sharing notification carries a delete intent back to the service", () => {
  const build = fn(kt("LocationService.kt"), "buildNotification");
  assert.match(
    build,
    /val swiped = PendingIntent\.getService\(\s*this,\s*\d+,\s*Intent\(this, LocationService::class\.java\)\.setAction\(ACTION_REPOST\),\s*PendingIntent\.FLAG_IMMUTABLE,\s*\)/,
  );
  assert.match(build, /\.setOngoing\(true\)\s*\.setDeleteIntent\(swiped\)/);
  assert.match(manifest(), /android:name="\.LocationService"\s*android:exported="false"/, "nothing outside the app can send it");
});

test("a swipe puts the notification back only while the share is live, and starts nothing otherwise", () => {
  const start = fn(kt("LocationService.kt"), "onStartCommand");
  const repost = start.slice(start.indexOf("if (intent?.action == ACTION_REPOST)"));
  assert.ok(start.indexOf("ACTION_STOP") < start.indexOf("ACTION_REPOST"), "Stop is handled first and untouched");
  assert.match(repost, /^if \(intent\?\.action == ACTION_REPOST\) \{[\s\S]*?if \(live\) \{\s*runCatching \{[^}]*notify\(NOTIF_ID, buildNotification\(\)\)/);
  assert.match(repost, /\} else if \(!running\) \{[^}]*stopAsked = true\s*stopSelf\(startId\)\s*\}\s*return START_NOT_STICKY\s*\}/);
  assert.ok(
    repost.indexOf("return START_NOT_STICKY") < repost.indexOf("startForeground"),
    "the repost path returns before anything that starts a share",
  );
});

test("below Android 12 Stop starts an activity, so a locked phone asks for the unlock first", () => {
  const build = fn(kt("LocationService.kt"), "buildNotification");
  assert.match(
    build,
    /val stop = if \(Build\.VERSION\.SDK_INT >= Build\.VERSION_CODES\.S\) \{\s*PendingIntent\.getService\(\s*this,\s*1,\s*Intent\(this, LocationService::class\.java\)\.setAction\(ACTION_STOP\),\s*PendingIntent\.FLAG_IMMUTABLE,\s*\)\s*\} else \{\s*PendingIntent\.getActivity\(\s*this,\s*1,\s*Intent\(this, StopShareActivity::class\.java\)[^,]*,\s*PendingIntent\.FLAG_IMMUTABLE,\s*\)\s*\}/,
  );
  assert.equal(build.match(/setAction\(ACTION_STOP\)/g).length, 1, "no other route reaches the service's Stop");
  assert.match(
    build,
    /Notification\.Action\.Builder\(null, getString\(R\.string\.notif_stop\), stop\)\.apply \{\s*if \(Build\.VERSION\.SDK_INT >= Build\.VERSION_CODES\.S\) setAuthenticationRequired\(true\)\s*\}/,
  );
  assert.match(kt("LocationService.kt"), /internal const val ACTION_STOP = "app\.starlingmap\.STOP_SHARE"/);
});

test("the Stop activity is private, shows nothing, never shows over the lock screen and only sends Stop", () => {
  const entry = manifest().match(/<activity\s+android:name="\.StopShareActivity"[^>]*>/);
  assert.ok(entry, "declared");
  const tag = entry[0];
  assert.ok(tag.endsWith("/>"), "no intent filter");
  assert.match(tag, /android:exported="false"/);
  assert.match(tag, /android:theme="@android:style\/Theme\.NoDisplay"/);
  assert.match(tag, /android:excludeFromRecents="true"/);
  assert.match(tag, /android:noHistory="true"/);
  assert.match(tag, /android:taskAffinity=""/, "its own task, so the app does not come forward");
  assert.doesNotMatch(tag, /showWhenLocked|turnScreenOn|showOnLockScreen/);

  const src = kt("StopShareActivity.kt");
  const create = fn(src, "onCreate");
  assert.match(
    create,
    /super\.onCreate\(savedInstanceState\)\s*startService\(Intent\(this, LocationService::class\.java\)\.setAction\(LocationService\.ACTION_STOP\)\)\s*finish\(\)\s*\}$/,
  );
  assert.doesNotMatch(src, /ShowWhenLocked|TurnScreenOn|DismissKeyguard|SHOW_WHEN_LOCKED|DISMISS_KEYGUARD|MainActivity|getStringExtra|extras/);
});
