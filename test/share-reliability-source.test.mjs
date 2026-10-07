// The Kotlin half of munzzyy/starling#6, pinned by reading the source like
// pagehost-source.test.mjs: each of these fails silently on a phone.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const kt = (name) =>
  readFileSync(new URL(`../android/app/src/main/kotlin/app/starlingmap/${name}`, import.meta.url), "utf8");
const manifest = () =>
  readFileSync(new URL("../android/app/src/main/AndroidManifest.xml", import.meta.url), "utf8");

// Block bodies only, which skips the heartbeat's forwarding onLocationChanged.
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

test("a frozen page is thawed by showing the WebView its window, and only while nobody is looking", () => {
  const nudge = fn(kt("PageHost.kt"), "nudge");
  assert.match(nudge, /if \(windowShown\) return true/, "a page on screen is never frozen and needs nothing");
  assert.match(nudge, /isAttachedToWindow/, "there has to be a window to do it in");
  assert.match(nudge, /dispatchWindowVisibilityChanged\(View\.VISIBLE\)/);
  // Hidden again afterwards, unless the person opened the app meanwhile.
  assert.match(nudge, /if \(webView === v && !windowShown\) v\.dispatchWindowVisibilityChanged\(View\.GONE\)/);
  assert.match(nudge, /NUDGE_GAP_MS/, "rate limited");
});

test("thawing is for shares only: a page with no share running is left to freeze", () => {
  const src = kt("PageHost.kt");
  assert.match(fn(src, "frozen"), /if \(!LocationService\.running\) return@post[\s\S]*nudge\(\)/);
  assert.match(fn(src, "checkPage"), /!LocationService\.running/);
  assert.match(fn(src, "expectPulse"), /if \(!LocationService\.running\) return/);
});

test("the page reports its freeze, and the bridge hands it straight to PageHost", () => {
  assert.match(kt("StarlingBridge.kt"), /fun pageFrozen\(\) = PageHost\.frozen\(\)/);
  const main = readFileSync(new URL("../app/js/main.js", import.meta.url), "utf8");
  assert.match(main, /document\.addEventListener\("freeze", \(\) => \{\s*try \{\s*native\(\)\?\.pageFrozen\?\.\(\);/);
});

test("the watchdog times from the oldest unanswered push, so a moving phone cannot starve it", () => {
  const src = kt("PageHost.kt");
  const expect = fn(src, "expectPulse");
  assert.match(expect, /if \(waitingSince == 0L \|\| pulseAt >= waitingSince\) waitingSince = SystemClock\.elapsedRealtime\(\)/);
  const check = fn(src, "checkPage");
  assert.match(check, /now - waitingSince < PULSE_WAIT_MS/);
  assert.doesNotMatch(src, /deliveredAt/, "the latest push is the wrong clock");
});

test("a page that cannot be revived ends the share out loud instead of leaving it looking live", () => {
  const src = kt("PageHost.kt");
  const check = fn(src, "checkPage");
  assert.match(check, /STALL_MS/);
  assert.match(check, /if \(windowShown\) return/, "never over a page somebody is looking at");
  const stalled = fn(src, "stalled");
  assert.match(stalled, /put\("route", "stalled"\)/, "the page is told, so it stops claiming a share");
  assert.match(stalled, /LocationService\.endShare\(app, "stalled"\)/, "and the stop is recorded and announced");
});

test("a page carried past a swipe gets a window of its own that never draws", () => {
  const hold = fn(kt("PageHost.kt"), "hold");
  // flags 0: private, no permission, never shown anywhere.
  assert.match(hold, /createVirtualDisplay\([\s\S]*?null,\s*0,\s*\)/);
  assert.match(hold, /Presentation\(app, vd\.display\)/);
  assert.match(hold, /decorView\.visibility = View\.GONE/, "never drawn, never given a surface");
  assert.match(hold, /FLAG_NOT_FOCUSABLE/);
  assert.match(hold, /FLAG_NOT_TOUCHABLE/);
  assert.match(hold, /catch \(e: Exception\)[\s\S]*?holderFailed = true/, "a refusal falls back instead of crashing");
});

test("the holder is only for a kept share, and goes the moment a window or the end of the share comes", () => {
  const src = kt("PageHost.kt");
  assert.match(fn(src, "detachFrom"), /else if \(!host\.isChangingConfigurations\) hold\(\)/);
  assert.match(fn(src, "attach"), /removeView\(existing\)\s*releaseHolder\(\)/);
  assert.match(fn(src, "destroy"), /releaseHolder\(\)/);
  const release = fn(src, "releaseHolder");
  assert.match(release, /dismiss\(\)/);
  assert.match(release, /release\(\)/);
});

test("windowShown follows the activity's start and stop", () => {
  const act = kt("MainActivity.kt");
  assert.match(fn(act, "onStart"), /PageHost\.setShown\(this, true\)/);
  assert.match(fn(act, "onStop"), /PageHost\.setShown\(this, false\)/);
  assert.match(kt("StarlingBridge.kt"), /fun windowShown\(\): Boolean = PageHost\.windowShown/);
});

test("each fix holds the CPU up for the page, from before the page hears of it", () => {
  const svc = kt("LocationService.kt");
  const onFix = fn(svc, "onLocationChanged");
  const hold = onFix.indexOf("holdAwake(this)");
  const push = onFix.indexOf("sink?.invoke(fix.toString())");
  assert.ok(hold >= 0 && push > hold, "acquired before the fix is handed over");
  const awake = fn(svc, "holdAwake");
  assert.match(awake, /if \(!running \|\| sink == null\) return/, "never outside a share, and never with no page to let go");
  assert.match(awake, /PARTIAL_WAKE_LOCK/);
  assert.match(awake, /setReferenceCounted\(false\)/, "one release lets go however many fixes asked");
  assert.match(awake, /acquire\(ms\)/, "always with a ceiling");
});

test("the wake lock is let go when the page is done, and on every way a share ends", () => {
  const bridge = kt("StarlingBridge.kt");
  assert.match(fn(bridge, "pulse"), /if \(busy <= 0\) LocationService\.letSleep\(\)/);
  const destroy = fn(kt("LocationService.kt"), "onDestroy");
  assert.match(destroy, /letSleep\(\)/);
  assert.match(destroy, /cancel\(tickIntent\)/, "the keepalive alarm dies with the share");
  assert.match(destroy, /unregisterReceiver\(tickReceiver\)/);
});

test("a tick only takes the wake lock when it has something for the page", () => {
  const tick = fn(kt("LocationService.kt"), "onTick");
  assert.doesNotMatch(tick, /letSleep/, "a fix mid-post must not have the lock pulled from under it");
  const at = tick.indexOf("if (now - lastFixAt >= tickMs())");
  assert.ok(at >= 0, "a tick pushes only after a whole tick with no fix");
  const branch = tick.slice(at);
  assert.ok(branch.indexOf("holdAwake(this)") < branch.indexOf('put("tick", true)'));
  assert.match(fn(kt("LocationService.kt"), "armTick"), /setAndAllowWhileIdle\(\s*AlarmManager\.ELAPSED_REALTIME_WAKEUP/);
});

test("the location switch is watched, and the notification says when it is off", () => {
  const svc = kt("LocationService.kt");
  // Both listeners, the service's own and the heartbeat.
  assert.equal((svc.match(/override fun onProviderEnabled\(provider: String\) = providersChanged\(\)/g) || []).length, 2);
  assert.equal((svc.match(/override fun onProviderDisabled\(provider: String\) = providersChanged\(\)/g) || []).length, 2);
  const changed = fn(svc, "providersChanged");
  assert.match(changed, /put\("paused", if \(locationOff\) "location-off" else ""\)/);
  assert.match(changed, /nm\.notify\(NOTIF_ID, buildNotification\(\)\)/);
  const build = fn(svc, "buildNotification");
  const off = build.indexOf("locationOff -> getString(R.string.notif_location_off)");
  const fwd = build.indexOf("forwardHost != null -> getString(R.string.notif_text_forward, forwardHost)");
  assert.ok(off >= 0 && fwd > off, "location off is said first, then your own server");
  assert.match(build, /else -> getString\(R\.string\.notif_text\)/);
});

test("a service Android stops on its own is reported, and every stop this app makes says it was us", () => {
  const svc = kt("LocationService.kt");
  const destroy = fn(svc, "onDestroy");
  assert.match(destroy, /if \(!byUs\) \{[\s\S]*?put\("route", "system"\)[\s\S]*?postShareEnded\("system"\)/);
  assert.match(fn(svc, "stop"), /stopAsked = true/);
  const start = fn(svc, "onStartCommand");
  // Stop, a refused startForeground, and a swipe that landed after the share ended.
  assert.equal((start.match(/stopAsked = true/g) || []).length, 3);
  assert.match(fn(svc, "noProvider"), /stopAsked = true\s*sink\?\.invoke\(JSONObject\(\)\.put\("error", "no location provider"\)/);
  assert.match(fn(svc, "onTaskRemoved"), /stopAsked = true\s*postShareEnded\("swipe"\)/);
});

test("requests that have produced nothing for minutes with location on are made again", () => {
  const svc = kt("LocationService.kt");
  const tick = fn(svc, "onTick");
  assert.match(
    tick,
    /val rewatchAfter = LocationPlan\.rewatchMs\(heartbeatMs, still\.on\)\s*if \(!locationOff && now - maxOf\(lastFixAt, watchedAt\) >= rewatchAfter\) rewatch\(\)/,
  );
  const again = fn(svc, "rewatch");
  assert.match(again, /removeUpdates\(this\)/);
  assert.match(again, /removeUpdates\(heartbeat\)/);
  assert.match(again, /if \(request\(lm\)\.isEmpty\(\)\) noProvider\(\)/, "and if none will take it, the share ends out loud");
  assert.match(fn(svc, "request"), /watchedAt = SystemClock\.elapsedRealtime\(\)/);
});

test("a share start from a page with no window waits for the window instead of throwing", () => {
  const bridge = kt("StarlingBridge.kt");
  const start = fn(bridge, "startLocation");
  assert.match(start, /if \(PageHost\.windowShown && PageHost\.activity === a\) a\.startShareFlow\(\)/);
  assert.match(start, /else a\.startShareWhenShown\(\)/);
  assert.match(fn(bridge, "stopLocation"), /cancelShareWhenShown\(\)/, "a stop cancels a start still waiting");
  const act = kt("MainActivity.kt");
  assert.match(fn(act, "onStart"), /if \(startWhenShown\) \{\s*startWhenShown = false\s*startShareFlow\(\)/);
});

test("the battery exemption is asked for, never taken, and background location only from its switch", () => {
  const m = manifest();
  assert.match(m, /android\.permission\.WAKE_LOCK/);
  assert.match(m, /android\.permission\.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS/);
  // Declared for the opt-in switches; the share flow's own ask is unchanged.
  const act = kt("MainActivity.kt");
  const asks = [...act.matchAll(/ACCESS_BACKGROUND_LOCATION/g)].map((x) => x.index);
  const own = fn(act, "askBackgroundLocation");
  const at = act.indexOf(own);
  assert.ok(asks.length >= 1 && asks.every((i) => i > at && i < at + own.length), "asked for in askBackgroundLocation and nowhere else");
  assert.match(
    fn(act, "requestLocationPermission"),
    /launch\(\s*arrayOf\(\s*Manifest\.permission\.ACCESS_FINE_LOCATION,\s*Manifest\.permission\.ACCESS_COARSE_LOCATION,\s*\),\s*\)/,
    "the share flow asks for fine and coarse, exactly",
  );
  const ask = fn(kt("MainActivity.kt"), "askBatteryExemption");
  assert.match(ask, /isIgnoringBatteryOptimizations\(packageName\) == true\) return/, "not asked twice");
  assert.match(ask, /ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS/);
  assert.match(kt("StarlingBridge.kt"), /fun askBatteryExemption\(\) \{\s*ui \{ it\.askBatteryExemption\(\) \}/, "only from a window");
});

test("the health snapshot never goes near a position", () => {
  const src = kt("Health.kt");
  for (const banned of ["latitude", "longitude", "getLastKnownLocation", "Location(", "lastLocation", "sink"]) {
    assert.ok(!src.includes(banned), `Health.kt must not touch ${banned}`);
  }
  // Nothing from the page's storage or the circle either.
  for (const banned of ["getSharedPreferences(MainActivity.PREFS, Context.MODE_PRIVATE).all", "evaluateJavascript"]) {
    assert.ok(!src.includes(banned), `Health.kt must not touch ${banned}`);
  }
});

test("Back during a share leaves the app instead of closing it, and a share its window takes down says so", () => {
  const act = kt("MainActivity.kt");
  assert.match(act, /object : OnBackPressedCallback\(false\) \{\s*override fun handleOnBackPressed\(\) \{\s*moveTaskToBack\(true\)/);
  assert.match(fn(act, "onCreate"), /onBackPressedDispatcher\.addCallback\(this, backWhileSharing\)/);
  assert.match(fn(act, "startShareService"), /LocationService\.start\(this\)\s*backWhileSharing\.isEnabled = true/);
  assert.match(fn(act, "cancelShareWhenShown"), /backWhileSharing\.isEnabled = false/);
  // onResume runs straight after a start from the permission prompt or onStart, before the service is up.
  const resume = fn(act, "onResume");
  assert.match(resume, /if \(LocationService\.live\) backWhileSharing\.isEnabled = true/);
  assert.doesNotMatch(resume, /backWhileSharing\.isEnabled = (?!true)/, "a start still on its way must not be switched back off");
  assert.match(fn(act, "onDestroy"), /if \(LocationService\.live\) LocationService\.endShare\(this, "swipe"\) else LocationService\.stop\(this\)/);
  assert.match(kt("LocationService.kt"), /val live: Boolean get\(\) = running && !stopAsked/);
});

// Comments out, whitespace folded, so a body can be compared whole.
const code = (body) => body.replace(/\/\/[^\n]*/g, "").replace(/\s+/g, " ").trim();

test("the panic wipe never touches the WebView from the bridge thread, so the wipe itself runs", () => {
  const bridge = kt("StarlingBridge.kt");
  // removeView and WebView.destroy() throw off the main thread, and panicWipe died there before Wipe ran.
  for (const call of ["PageHost.destroy(", "PageHost.load(", "PageHost.attach(", "PageHost.detachFrom("]) {
    assert.ok(!bridge.includes(call), `StarlingBridge must not call ${call}`);
  }
  assert.equal(code(fn(bridge, "panicWipe")), "fun panicWipe() { Wipe.everything(app) }");
  assert.match(kt("PanicActivity.kt"), /private fun wipeEverything\(\) = Wipe\.everything\(this\)/, "both triggers run the same wipe");
});

test("the wipe stops the share first, deletes each channel on its own, and kills the process last", () => {
  const wipe = fn(kt("Wipe.kt"), "everything");
  const at = (s) => {
    const i = wipe.indexOf(s);
    assert.ok(i >= 0, `Wipe.everything has ${s}`);
    return i;
  };
  assert.match(wipe, /runCatching \{ LocationService\.stop\(ctx\) \}/);
  assert.ok(at("LocationService.stop(ctx)") < at("KeystoreVault.deleteKey()"));
  assert.ok(at("KeystoreVault.deleteKey()") < at("deleteNotificationChannel"));
  assert.ok(at("deleteNotificationChannel") < at("clearApplicationUserData()"));
  // Deleting "share" throws while its foreground service is up; that must not keep the others.
  assert.match(
    wipe,
    /for \(id in listOf\(\s*LocationService\.CHANNEL,\s*MainActivity\.EVENTS_CHANNEL,\s*MainActivity\.ARRIVE_CHANNEL,\s*MainActivity\.LEAVE_CHANNEL,\s*MainActivity\.CHECKIN_CHANNEL,\s*MainActivity\.SOS_CHANNEL,\s*MainActivity\.OLD_SOS_CHANNEL,\s*\)\) \{\s*runCatching \{ nm\.deleteNotificationChannel\(id\) \}\s*\}/,
  );
  assert.equal((wipe.match(/deleteNotificationChannel/g) || []).length, 1, "no channel deleted outside the loop");
});

test("a share left with no page ends out loud instead of holding GPS and a wake lock for nobody", () => {
  const check = fn(kt("PageHost.kt"), "checkPage");
  assert.match(check, /if \(webView == null && LocationService\.live\) appCtx\?\.let \{ LocationService\.endShare\(it, "stalled"\) \}/);
  assert.match(fn(kt("LocationService.kt"), "onTick"), /PageHost\.checkPage\(\)/, "the keepalive tick is what finds it");
});

test("a share that ends behind a frozen page thaws it once, so the goodbye still goes out", () => {
  const release = fn(kt("PageHost.kt"), "releaseSoon");
  const thaw = release.indexOf("nudge()");
  const early = release.indexOf("if (webView == null || activity != null) return");
  assert.ok(thaw >= 0 && early > thaw, "before the early return, so a page still in its activity gets it too");
  assert.match(fn(kt("LocationService.kt"), "onDestroy"), /PageHost\.releaseSoon\(\)/);
});

test("opening the app mid-thaw still gives the page a return it can see", () => {
  const shown = fn(kt("PageHost.kt"), "setShown");
  const at = shown.indexOf("if (nudging)");
  assert.ok(at >= 0, "setShown looks for a thaw in progress");
  const body = shown.slice(at);
  const gone = body.indexOf("dispatchWindowVisibilityChanged(View.GONE)");
  const real = body.indexOf("dispatchWindowVisibilityChanged(v.windowVisibility)");
  assert.ok(gone >= 0 && real > gone, "hidden first, then the window's real state");
});

test("the notice after a stop only says the app was closed when it was", () => {
  const rec = fn(kt("LocationService.kt"), "recordEnded");
  assert.match(rec, /if \(route == "swipe"\) R\.string\.notif_swiped_text else R\.string\.notif_locked_text/);
  assert.match(rec, /if \(!notify\) return/);
  const put = rec.indexOf("PREF_STOP_ROUTE");
  assert.ok(put >= 0 && put < rec.indexOf("if (!notify) return"), "the record goes down even with no notice");
});

test("the app lock ending a share leaves a record, and a notice only when nobody is looking", () => {
  const bridge = fn(kt("StarlingBridge.kt"), "shareEndedByLock");
  assert.match(bridge, /LocationService\.endShare\(app, "lock", notify = !PageHost\.windowShown\)/);
  assert.match(kt("StarlingBridge.kt"), /@JavascriptInterface\s+fun shareEndedByLock\(\)/);
});

test("the fused provider is only used on Android 12+, never with Tor on, and falls back to the platform pair", () => {
  const svc = kt("LocationService.kt");
  const start = fn(svc, "startWatching");
  assert.match(start, /fusedOn = !torOn && Build\.VERSION\.SDK_INT >= Build\.VERSION_CODES\.S && lm\.allProviders\.contains\(LocationPlan\.FUSED\)/);
  const request = fn(svc, "request");
  assert.match(request, /if \(!fusedOn\) throw e\s*fusedOn = false/, "a refused fused request retries on gps and network");
  assert.match(fn(svc, "register"), /requestLocationUpdates\(LocationPlan\.FUSED, req,/);
});
