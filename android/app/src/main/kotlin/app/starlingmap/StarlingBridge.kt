package app.starlingmap

import android.content.Context
import android.webkit.JavascriptInterface
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_STRONG
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import org.json.JSONObject

// The page's window into the platform. Only bundled app code can call this:
// the WebView never navigates off the asset origin, so every caller shipped
// in the APK. Async answers travel through __starlingBio(token, payload).
//
// Held on the application context, because the page outlives the activity
// whenever a share is running with "keep sharing when the app is closed" on.
// Anything that genuinely needs a window (a permission prompt, a biometric
// sheet, a trip to system settings) goes through `activity` and does nothing
// while there is none, which is the honest answer: the page only asks for
// those from a screen somebody is looking at.
class StarlingBridge(private val app: Context) {

    @Volatile
    var activity: MainActivity? = null

    private fun ui(body: (MainActivity) -> Unit) {
        val a = activity ?: return
        a.runOnUiThread { body(a) }
    }

    @JavascriptInterface
    fun platform(): String = "android"

    @JavascriptInterface
    fun version(): String = runCatching {
        app.packageManager.getPackageInfo(app.packageName, 0).versionName
    }.getOrNull() ?: "unknown"

    // ---------------------------------------------------------------- events

    // Post a system notification for a circle event (a member's SOS, an
    // arrival at a place, a low battery). The page only calls this while it
    // is hidden; visible, its own toast already said it. Tag replaces, so a
    // member bouncing at a boundary edits one notification instead of
    // stacking twenty. `urgent` is true only for an active SOS, and routes it
    // to its own channel so it sounds different from routine chatter.
    @JavascriptInterface
    fun notify(title: String, body: String, tag: String, urgent: Boolean) {
        Events.post(app, title.take(80), body.take(160), tag.take(64), urgent)
    }

    // Take a posted event notification back down (an SOS that cleared while
    // the app was open would otherwise stand on the lock screen forever).
    @JavascriptInterface
    fun cancelNotify(tag: String) {
        Events.cancel(app, tag.take(64))
    }

    // ------------------------------------------------------------------ theme

    // Kept so a window opened over a page that is already running matches it.
    @Volatile
    var barsLight: Boolean? = null
        private set

    // WebView settles prefers-color-scheme when it is built, and this page can outlive that by days.
    @JavascriptInterface
    fun systemDark(): Boolean =
        (app.resources.configuration.uiMode and android.content.res.Configuration.UI_MODE_NIGHT_MASK) ==
            android.content.res.Configuration.UI_MODE_NIGHT_YES

    // The page's resolved theme, which can differ from the phone's.
    @JavascriptInterface
    fun setBarsLight(light: Boolean) {
        barsLight = light
        ui { it.setBarsLight(light) }
    }

    // --------------------------------------------------------- share reminder

    // ms from now, held between a minute and a day.
    @JavascriptInterface
    fun remindShareIn(ms: Long) = ShareReminder.schedule(app, ms)

    @JavascriptInterface
    fun cancelShareReminder() = ShareReminder.cancel(app)

    // The page's armed record, copied for a restart or an update: see ShareResume.
    @JavascriptInterface
    fun armShareResume(at: Long, deadline: Long) = ShareResume.arm(app, at, deadline)

    @JavascriptInterface
    fun disarmShareResume() = ShareResume.disarm(app)

    // ----------------------------------------------------- share stop trace

    // A share can end from the Stop button on the notification or from the
    // task being swiped away, neither of which the page is guaranteed to be
    // alive to see. LocationService writes this before it ever touches the
    // notification, so the trace outlives both the process and a swipe of
    // that notification. Read once at boot; the page decides when it is
    // acknowledged and clears it.
    @JavascriptInterface
    fun readStopRecord(): String? {
        val prefs = app.getSharedPreferences(MainActivity.PREFS, Context.MODE_PRIVATE)
        val route = prefs.getString(MainActivity.PREF_STOP_ROUTE, null) ?: return null
        val at = prefs.getLong(MainActivity.PREF_STOP_TS, 0L)
        return JSONObject().put("route", route).put("at", at).toString()
    }

    @JavascriptInterface
    fun clearStopRecord() {
        app.getSharedPreferences(MainActivity.PREFS, Context.MODE_PRIVATE).edit()
            .remove(MainActivity.PREF_STOP_ROUTE)
            .remove(MainActivity.PREF_STOP_TS)
            .apply()
    }

    @JavascriptInterface
    fun openSosChannelSettings() {
        ui { it.openSosChannelSettings() }
    }

    // Ask for POST_NOTIFICATIONS outside the share flow: a member who only
    // ever watches never starts a share, and they are exactly who an SOS
    // notification is for. No-op where already granted or below API 33.
    @JavascriptInterface
    fun ensureNotifyPermission() {
        ui { it.requestNotifyPermissionIfNeeded() }
    }

    // The full-device panic wipe: the share, the Keystore wrap key,
    // notification channels, then clearApplicationUserData, which kills the
    // process. Same wipe the PanicKit trigger runs. The page's own storage
    // wipe still runs in parallel as the fallback for wrappers that predate
    // this method.
    @JavascriptInterface
    fun panicWipe() {
        // Bridge thread, where any WebView call throws: the process kill takes the page.
        Wipe.everything(app)
    }

    // Open this app's system settings page, for the moment a permission was
    // denied and the in-app prompt can no longer be shown again.
    @JavascriptInterface
    fun openAppSettings() {
        ui { a ->
            runCatching {
                a.startActivity(
                    android.content.Intent(
                        android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                        android.net.Uri.parse("package:" + a.packageName),
                    ),
                )
            }
        }
    }

    // ---------------------------------------------------------------- camera

    // Asked when the page opens the scanner, before it calls getUserMedia:
    // the WebView refuses that call outright while the app lacks the runtime
    // grant, so the prompt has to be over first. Answers through
    // __starlingCamera(token, granted); true at once when already held.
    @JavascriptInterface
    fun requestCamera(token: String) {
        ui { it.askCameraFor(token) }
    }

    @JavascriptInterface
    fun hasCameraPermission(): Boolean =
        ContextCompat.checkSelfPermission(app, android.Manifest.permission.CAMERA) ==
            android.content.pm.PackageManager.PERMISSION_GRANTED

    // ------------------------------------------------------------- clipboard

    // Clear the clipboard only if it still holds exactly the text the app put
    // there (an invite link is a credential; whatever the user copied since
    // is theirs). Reading our own clip is allowed while the app has focus;
    // without focus Android answers null and this quietly does nothing.
    @JavascriptInterface
    fun clearClipboardIf(expected: String) {
        ui { a ->
            val cm = a.getSystemService(android.content.ClipboardManager::class.java) ?: return@ui
            val current = cm.primaryClip?.takeIf { it.itemCount > 0 }?.getItemAt(0)?.text?.toString()
            if (current == expected) cm.clearPrimaryClip()
        }
    }

    // ----------------------------------------------------------------- share

    // Android System WebView has no navigator.share. False with no window, so the page copies instead.
    @JavascriptInterface
    fun shareText(text: String): Boolean {
        val a = activity ?: return false
        if (!PageHost.windowShown || PageHost.activity !== a) return false
        val body = text.take(2000)
        a.runOnUiThread { a.shareText(body) }
        return true
    }

    // ------------------------------------------------------------- location

    // From the background this threw and the page forgot its share; now it waits for the window.
    @JavascriptInterface
    fun startLocation() {
        ui { a ->
            if (PageHost.windowShown && PageHost.activity === a) a.startShareFlow()
            else a.startShareWhenShown()
        }
    }

    // Stopping needs no window: a timed share can run out, or the person can
    // stop from the notification, with nothing on screen.
    @JavascriptInterface
    fun stopLocation() {
        activity?.let { a -> a.runOnUiThread { a.cancelShareWhenShown() } }
        LocationService.stop(app)
    }

    // Seconds between heartbeat fixes while the phone lies still: the active
    // circle's cadence, sent before every start and on every change. 15 is
    // the floor and 300 the ceiling, whatever the page asks.
    @JavascriptInterface
    fun setShareCadence(seconds: Int) = LocationService.setCadence(seconds)

    // The app lock ends a share, since a locked page holds no keys. It leaves the
    // trace Android's own ends leave, and a notice when nobody is looking.
    @JavascriptInterface
    fun shareEndedByLock() {
        LocationService.endShare(app, "lock", notify = !PageHost.windowShown)
    }

    // ---------------------------------------------------- your own server

    // The host only, never the address: servers put their key in its query.
    @JavascriptInterface
    fun forwardStatus(): String = Forward.status(app)

    // "" stops it. The page asks for the passcode first when the app lock is on.
    @JavascriptInterface
    fun setForward(url: String?): Boolean {
        val ok = Forward.set(app, url)
        if (ok) LocationService.refreshNotification()
        return ok
    }

    // A label for routing, not a destination, so it needs no passcode.
    @JavascriptInterface
    fun setForwardTid(tid: String?): Boolean = Forward.setTid(app, tid)

    // --------------------------------------------------- keeping the page up

    // Not document.visibilityState, which reads visible during a nudge.
    @JavascriptInterface
    fun windowShown(): Boolean = PageHost.windowShown

    @JavascriptInterface
    fun pageFrozen() = PageHost.frozen()

    // `busy` posts still in flight; at zero the phone may sleep.
    @JavascriptInterface
    fun pulse(busy: Int) {
        PageHost.pulse()
        if (busy <= 0) LocationService.letSleep()
    }

    @JavascriptInterface
    fun health(): String = Health.snapshot(app)

    // "unrestricted", "optimized" or "restricted".
    @JavascriptInterface
    fun batteryState(): String = Health.batteryState(app)

    @JavascriptInterface
    fun askBatteryExemption() {
        ui { it.askBatteryExemption() }
    }

    @JavascriptInterface
    fun openBatterySettings() {
        ui { it.openBatterySettings() }
    }

    @JavascriptInterface
    fun openSaverSettings() {
        ui { it.openSaverSettings() }
    }

    // ------------------------------------------------- keep sharing when closed

    // Off by default, and deliberately not something the page decides on its
    // own: with it on, closing the app leaves this process holding the circle's
    // keys until the share ends. Kotlin reads the switch straight from prefs,
    // because the moment it matters is a task removal, when asking the page
    // anything is already too late.
    @JavascriptInterface
    fun keepSharing(): Boolean = PageHost.keepSharing(app)

    @JavascriptInterface
    fun setKeepSharing(on: Boolean) = PageHost.setKeepSharing(app, on)

    @JavascriptInterface
    fun shareClock(): Boolean = LocationService.clockShown(app)

    @JavascriptInterface
    fun setShareClock(on: Boolean) = LocationService.showClock(app, on)

    // ------------------------------------------------------------------ tor

    @JavascriptInterface
    fun torSupported(): Boolean =
        androidx.webkit.WebViewFeature.isFeatureSupported(androidx.webkit.WebViewFeature.PROXY_OVERRIDE)

    @JavascriptInterface
    fun torEnabled(): Boolean =
        app.getSharedPreferences(MainActivity.PREFS, Context.MODE_PRIVATE)
            .getBoolean(MainActivity.PREF_TOR, false)

    @JavascriptInterface
    fun setTor(on: Boolean) {
        ui { it.setTorEnabled(on) }
    }

    // ------------------------------------------------------------ biometric

    @JavascriptInterface
    fun bioSupported(): Boolean =
        BiometricManager.from(app).canAuthenticate(BIOMETRIC_STRONG) ==
            BiometricManager.BIOMETRIC_SUCCESS

    // Wrap the vault key K under a Keystore key the OS only unseals after a
    // biometric prompt. Returns {"nonce","ct"} as b64url, or null.
    @JavascriptInterface
    fun bioWrap(vaultB64: String, token: String) {
        ui { a ->
            val vault = KeystoreVault.b64decode(vaultB64)
            if (vault == null || vault.size != 32) {
                vault?.fill(0)
                reply(token, null)
                return@ui
            }
            val cipher = KeystoreVault.encryptCipher()
            if (cipher == null) {
                vault.fill(0)
                reply(token, null)
                return@ui
            }
            // The zero runs on every exit from the prompt, dismissal and
            // error included, not only on success. (The b64 String argument
            // itself is immutable and beyond reach; this scrubs the copy this
            // side controls.)
            prompt(a, cipher, R.string.bio_wrap_title) { authed ->
                val out = authed?.let {
                    runCatching {
                        val ct = it.doFinal(vault)
                        JSONObject()
                            .put("nonce", KeystoreVault.b64encode(it.iv))
                            .put("ct", KeystoreVault.b64encode(ct))
                            .toString()
                    }.getOrNull()
                }
                vault.fill(0)
                reply(token, out)
            }
        }
    }

    // Recover K. Returns the key as b64url, or null on any failure: dismissed
    // prompt, invalidated key (new biometric enrollment), tampered record.
    @JavascriptInterface
    fun bioUnwrap(nonceB64: String, ctB64: String, token: String) {
        ui { a ->
            val nonce = KeystoreVault.b64decode(nonceB64)
            val ct = KeystoreVault.b64decode(ctB64)
            if (nonce == null || ct == null) {
                reply(token, null)
                return@ui
            }
            val cipher = KeystoreVault.decryptCipher(nonce)
            if (cipher == null) {
                reply(token, null)
                return@ui
            }
            prompt(a, cipher, R.string.bio_unwrap_title) { authed ->
                reply(
                    token,
                    authed?.let { runCatching { KeystoreVault.b64encode(it.doFinal(ct)) }.getOrNull() },
                )
            }
        }
    }

    // onAuthenticationFailed (a non-matching finger) keeps the prompt up and
    // stays silent; only a terminal error or a dismissal ends it. done always
    // runs exactly once, with null on those failure exits, so callers have a
    // single place to scrub secrets and answer the page.
    private fun prompt(
        a: MainActivity,
        cipher: javax.crypto.Cipher,
        titleRes: Int,
        done: (javax.crypto.Cipher?) -> Unit,
    ) {
        val info = BiometricPrompt.PromptInfo.Builder()
            .setTitle(a.getString(titleRes))
            .setNegativeButtonText(a.getString(R.string.bio_cancel))
            .setAllowedAuthenticators(BIOMETRIC_STRONG)
            .build()
        val prompt = BiometricPrompt(
            a,
            ContextCompat.getMainExecutor(a),
            object : BiometricPrompt.AuthenticationCallback() {
                override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                    done(result.cryptoObject?.cipher)
                }

                override fun onAuthenticationError(code: Int, msg: CharSequence) {
                    done(null)
                }
            },
        )
        prompt.authenticate(info, BiometricPrompt.CryptoObject(cipher))
    }

    private fun reply(token: String, payload: String?) = PageHost.bioReply(token, payload)
}
