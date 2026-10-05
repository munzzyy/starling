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

test("the clock on the sharing notification is off unless turned on, and never on the generic version", () => {
  const svc = kt("LocationService.kt");
  assert.match(
    svc,
    /fun clockShown\(ctx: Context\): Boolean =\s*ctx\.getSharedPreferences\(MainActivity\.PREFS, MODE_PRIVATE\)\.getBoolean\(MainActivity\.PREF_SHARE_CLOCK, false\)/,
  );
  assert.match(svc, /fun showClock\(ctx: Context, on: Boolean\) \{[^}]*putBoolean\(MainActivity\.PREF_SHARE_CLOCK, on\)[^}]*\.apply\(\)\s*refreshNotification\(\)\s*\}/);

  const build = fn(svc, "buildNotification");
  const pub = build.slice(build.indexOf("val publicVersion"), build.indexOf(".build()", build.indexOf("val publicVersion")));
  assert.match(pub, /\.setShowWhen\(false\)/);
  assert.doesNotMatch(pub, /setWhen|Chronometer/);
  assert.match(
    build,
    /val clock = if \(clockShown\(this\)\) \{\s*ShareResume\.clock\(System\.currentTimeMillis\(\), SystemClock\.elapsedRealtime\(\), startedAt, ShareResume\.deadline\(this\)\)\s*\} else \{\s*null\s*\}/,
  );
  assert.match(
    build,
    /\.apply \{\s*if \(clock != null\) \{\s*setWhen\(clock\.first\)\s*setShowWhen\(true\)\s*setUsesChronometer\(true\)\s*setChronometerCountDown\(clock\.second\)\s*\}\s*\}\s*\.build\(\)\s*\}$/,
  );
  assert.equal(svc.match(/setUsesChronometer|setWhen\(/g).length, 2, "the private version's two calls and nothing else");

  const tick = fn(svc, "onTick");
  assert.match(tick, /if \(countingDown && System\.currentTimeMillis\(\) >= ShareResume\.deadline\(this\)\) refreshNotification\(\)/);
  assert.match(fn(kt("ShareResume.kt"), "arm"), /LocationService\.refreshNotification\(\)/, "a window picked mid-share reaches the clock");

  const bridge = kt("StarlingBridge.kt");
  assert.match(bridge, /fun shareClock\(\): Boolean = LocationService\.clockShown\(app\)/);
  assert.match(bridge, /fun setShareClock\(on: Boolean\) = LocationService\.showClock\(app, on\)/);
});

test("a share paused by location off offers the switch, behind the unlock, and only in the private version", () => {
  const svc = kt("LocationService.kt");
  const build = fn(svc, "buildNotification");
  assert.match(build, /\.addAction\(stopAction\)\s*\.apply \{ if \(locationOff\) addAction\(locationOnAction\(\)\) \}/);
  assert.equal(build.match(/addAction\(/g).length, 2);
  const pub = build.slice(build.indexOf("val publicVersion"), build.indexOf(".build()", build.indexOf("val publicVersion")));
  assert.doesNotMatch(pub, /addAction/);

  const action = svc.slice(svc.indexOf("private fun locationOnAction()"), svc.indexOf("private fun buildNotification()"));
  assert.ok(action.length > 0);
  assert.match(
    action,
    /PendingIntent\.getActivity\(\s*this,\s*4,\s*Intent\(Settings\.ACTION_LOCATION_SOURCE_SETTINGS\)\.addFlags\(Intent\.FLAG_ACTIVITY_NEW_TASK\),\s*PendingIntent\.FLAG_IMMUTABLE,\s*\)/,
  );
  assert.match(action, /getString\(R\.string\.notif_location_on\)/);
  assert.match(action, /if \(Build\.VERSION\.SDK_INT >= Build\.VERSION_CODES\.S\) setAuthenticationRequired\(true\)/);

  for (const dir of ["values", "values-es", "values-de", "values-fr", "values-pt"]) {
    const xml = readFileSync(new URL(`../android/app/src/main/res/${dir}/strings.xml`, import.meta.url), "utf8");
    assert.match(xml, /<string name="notif_location_on">[^<%]+<\/string>/, dir);
  }
});

test("Battery Saver settings open from a window only, with the main settings as the fallback", () => {
  const act = fn(kt("MainActivity.kt"), "openSaverSettings");
  assert.match(
    act,
    /if \(runCatching \{ startActivity\(Intent\(Settings\.ACTION_BATTERY_SAVER_SETTINGS\)\) \}\.isSuccess\) return\s*runCatching \{ startActivity\(Intent\(Settings\.ACTION_SETTINGS\)\) \}/,
  );
  assert.match(kt("StarlingBridge.kt"), /fun openSaverSettings\(\) \{\s*ui \{ it\.openSaverSettings\(\) \}\s*\}/);
});
