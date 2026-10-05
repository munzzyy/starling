package app.starlingmap

import android.Manifest
import android.app.NotificationManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.annotation.StringRes
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import org.json.JSONObject

// A restart or an update kills the page that seals every position. This
// offers the share back as a tap, which reopens through the app lock. With a
// resume switch on it brings the share back with no window instead, and any
// gate that fails gets the tap.
//
// The page keeps the real armed record in its own storage, which this side
// cannot read before a page exists. It hands over a copy: when the share was
// armed and when its window ends. No position, no key, no circle.
object ShareResume {
    const val TAG = "resume"
    const val RESUMED_TAG = "resumed"
    private const val PREF_AT = "resume_armed_at"
    private const val PREF_DEADLINE = "resume_deadline"
    private const val PREF_AUTO_BOOT = "resume_auto_boot"
    private const val PREF_AUTO_UPDATE = "resume_auto_update"
    private const val PREF_LAST_WHY = "resume_auto_last_why"
    private const val PREF_LAST_AT = "resume_auto_last_at"

    private const val CONFIRM_MS = 90_000L
    private const val ORBOT_WAIT_MS = 300_000L
    // Inside OrbotStatus's 30 second trust window, so every answer counts.
    private const val ORBOT_ASK_MS = 25_000L

    private val WHYS = setOf("boot", "update")
    private val PAGE_STATES = setOf("started", "delivered", "locked", "declined")

    enum class Path { NONE, OFFER, HEADLESS }

    // "boot" or "update" for as long as a share that came back by itself runs.
    @Volatile
    var headlessWhy: String? = null
        private set

    // A restart after an update can deliver both broadcasts; one start is enough.
    @Volatile
    private var starting = false
    private var alerted = false
    private var confirmTimer: Runnable? = null
    private var orbotTimer: Runnable? = null
    private var orbotAsk: Runnable? = null

    // Sharing report counts since the app started.
    @Volatile var resumes = 0
        private set
    @Volatile var abandons = 0
        private set

    fun arm(ctx: Context, at: Long, deadline: Long) {
        prefs(ctx).edit().putLong(PREF_AT, at).putLong(PREF_DEADLINE, deadline).apply()
        // A share is running again, so an offer still showing is not true anymore.
        runCatching { Events.cancel(ctx, TAG) }
        LocationService.refreshNotification()
    }

    fun deadline(ctx: Context): Long = prefs(ctx).getLong(PREF_DEADLINE, 0L)

    // What the notification's clock shows: a countdown to a window still open, or the time since the start.
    fun clock(nowWall: Long, nowElapsed: Long, startedAt: Long, deadline: Long): Pair<Long, Boolean> =
        if (deadline > nowWall) deadline to true else (nowWall - (nowElapsed - startedAt)) to false

    fun disarm(ctx: Context) {
        prefs(ctx).edit().remove(PREF_AT).remove(PREF_DEADLINE).apply()
        runCatching { Events.cancel(ctx, TAG) }
        runCatching { Events.cancel(ctx, RESUMED_TAG) }
    }

    // Same rules as the page's own resume: never a share the person stopped,
    // never one whose window ran out. An undated Stop counts as a decision,
    // because offering nothing is the safe way to be wrong.
    fun due(armedAt: Long, deadline: Long, stopRoute: String?, stopAt: Long, now: Long): Boolean {
        if (armedAt <= 0L) return false
        if (deadline > 0L && now >= deadline) return false
        if (stopRoute == "notif" && (stopAt <= 0L || stopAt >= armedAt)) return false
        return true
    }

    fun decide(
        due: Boolean,
        autoOn: Boolean,
        keepSharing: Boolean,
        background: Boolean,
        notifications: Boolean,
        webViewOk: Boolean,
        torOn: Boolean,
        torSupported: Boolean,
    ): Path {
        if (!due) return Path.NONE
        if (autoOn && keepSharing && background && notifications && webViewOk && (!torOn || torSupported)) return Path.HEADLESS
        return Path.OFFER
    }

    fun onSystemStart(ctx: Context, why: String) {
        if (why !in WHYS) return
        if (LocationService.running || starting) return
        val offer = offerText(why)
        val due = dueNow(ctx)
        val keep = PageHost.keepSharing(ctx)
        val background = backgroundHeld(ctx)
        val notifications = notificationsVisible(ctx)
        if (!(keep && background && notifications)) autoOff(ctx)
        val autoOn = if (why == "boot") autoBoot(ctx) else autoUpdate(ctx)
        val torOn = TorProxy.enabled(ctx)
        // Both load the WebView provider, so only once nothing cheaper has said no.
        val rest = due && autoOn && keep && background && notifications
        val webViewOk = rest && SystemCheck.webViewOk(ctx)
        val torSupported = webViewOk && torOn && runCatching { TorProxy.supported() }.getOrDefault(false)
        when (decide(due, autoOn, keep, background, notifications, webViewOk, torOn, torSupported)) {
            Path.NONE -> return
            Path.OFFER -> Events.postShareResume(ctx, offer)
            Path.HEADLESS -> try {
                starting = true
                LocationService.startResumed(ctx, why)
            } catch (e: Exception) {
                starting = false
                Events.postShareResume(ctx, offer)
            }
        }
    }

    fun autoBoot(ctx: Context): Boolean = prefs(ctx).getBoolean(PREF_AUTO_BOOT, false)

    fun autoUpdate(ctx: Context): Boolean = prefs(ctx).getBoolean(PREF_AUTO_UPDATE, false)

    // A switch that can no longer be honoured is turned off, never left waiting.
    fun autoState(ctx: Context): String {
        if (!(PageHost.keepSharing(ctx) && backgroundHeld(ctx) && notificationsVisible(ctx))) autoOff(ctx)
        return JSONObject().put("boot", autoBoot(ctx)).put("update", autoUpdate(ctx)).toString()
    }

    // On needs a person at the window and every gate passed; off always works.
    fun setAuto(ctx: Context, boot: Boolean, update: Boolean): String {
        val ready = PageHost.windowShown && PageHost.keepSharing(ctx) && backgroundHeld(ctx) && notificationsVisible(ctx)
        val nextBoot = boot && (autoBoot(ctx) || ready)
        val nextUpdate = update && (autoUpdate(ctx) || ready)
        prefs(ctx).edit().putBoolean(PREF_AUTO_BOOT, nextBoot).putBoolean(PREF_AUTO_UPDATE, nextUpdate).commit()
        return autoState(ctx)
    }

    fun autoOff(ctx: Context) {
        if (!autoBoot(ctx) && !autoUpdate(ctx)) return
        prefs(ctx).edit().putBoolean(PREF_AUTO_BOOT, false).putBoolean(PREF_AUTO_UPDATE, false).commit()
    }

    fun forgetAuto(ctx: Context) {
        prefs(ctx).edit()
            .remove(PREF_AUTO_BOOT)
            .remove(PREF_AUTO_UPDATE)
            .remove(PREF_LAST_WHY)
            .remove(PREF_LAST_AT)
            .commit()
    }

    // Why and when, for the card in the app. Nothing else.
    fun lastRecord(ctx: Context): String? {
        val p = prefs(ctx)
        val why = p.getString(PREF_LAST_WHY, null)?.takeIf { it in WHYS } ?: return null
        return JSONObject().put("why", why).put("at", p.getLong(PREF_LAST_AT, 0L)).toString()
    }

    fun clearLastRecord(ctx: Context) {
        prefs(ctx).edit().remove(PREF_LAST_WHY).remove(PREF_LAST_AT).apply()
    }

    // Android 9 has no separate grant: the location permission covers all the time there.
    fun backgroundHeld(ctx: Context): Boolean {
        if (!locationHeld(ctx)) return false
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return true
        return granted(ctx, Manifest.permission.ACCESS_BACKGROUND_LOCATION)
    }

    fun backgroundState(ctx: Context): String = when {
        !locationHeld(ctx) -> "noLocation"
        Build.VERSION.SDK_INT < Build.VERSION_CODES.Q -> "notNeeded"
        granted(ctx, Manifest.permission.ACCESS_BACKGROUND_LOCATION) -> "granted"
        Build.VERSION.SDK_INT == Build.VERSION_CODES.Q -> "dialog"
        else -> "settings"
    }

    // Nothing comes back while Starling's notifications are hidden; a channel not made yet is shown.
    fun notificationsVisible(ctx: Context): Boolean {
        if (!NotificationManagerCompat.from(ctx).areNotificationsEnabled()) return false
        val nm = ctx.getSystemService(NotificationManager::class.java) ?: return false
        for (id in listOf(LocationService.CHANNEL, MainActivity.EVENTS_CHANNEL)) {
            val channel = nm.getNotificationChannel(id) ?: continue
            if (channel.importance == NotificationManager.IMPORTANCE_NONE) return false
        }
        return true
    }

    // From LocationService, on the main thread, once the service is in the foreground.
    fun serviceUp(ctx: Context) {
        starting = false
        val why = LocationService.resumedWhy ?: return
        val app = ctx.applicationContext
        // A window got there first, and it resumes the share by its own rules.
        if (PageHost.alive) {
            clear()
            LocationService.stop(app)
            return
        }
        headlessWhy = why
        resumes++
        if (!runCatching { PageHost.bootHeadless(app) }.getOrDefault(false)) {
            abandon(app, offerText(why))
            return
        }
        val confirm = Runnable { abandon(app, offerText(why)) }
        confirmTimer = confirm
        PageHost.post(confirm, CONFIRM_MS)
        if (LocationService.waitingForTor) {
            val wait = Runnable { abandon(app, R.string.notif_resume_orbot_text) }
            orbotTimer = wait
            PageHost.post(wait, ORBOT_WAIT_MS)
            val ask = object : Runnable {
                override fun run() {
                    OrbotStatus.ask(app)
                    PageHost.post(this, ORBOT_ASK_MS)
                }
            }
            orbotAsk = ask
            PageHost.post(ask, ORBOT_ASK_MS)
        }
    }

    fun startFailed(ctx: Context) {
        val why = LocationService.resumedWhy ?: "boot"
        starting = false
        abandons++
        clear()
        offerIfDue(ctx, offerText(why))
    }

    fun serviceGone() {
        starting = false
        clear()
    }

    // Bridge thread.
    fun pageSaid(ctx: Context, state: String) {
        if (state !in PAGE_STATES) return
        val app = ctx.applicationContext
        PageHost.post(Runnable { onPage(app, state) }, 0)
    }

    private fun onPage(ctx: Context, state: String) {
        val why = headlessWhy ?: return
        when (state) {
            "started" -> {
                cancel(confirmTimer)
                confirmTimer = null
                LocationService.resumePending = false
                // A reload says started again; the record a person dismissed stays dismissed.
                if (alerted) return
                alerted = true
                Events.postShareResumed(
                    ctx,
                    if (why == "update") R.string.notif_resumed_update_text else R.string.notif_resumed_boot_text,
                )
                prefs(ctx).edit().putString(PREF_LAST_WHY, why).putLong(PREF_LAST_AT, System.currentTimeMillis()).apply()
            }
            "delivered" -> {
                if (!LocationService.waitingForTor) return
                cancelOrbot()
                LocationService.waitingForTor = false
                LocationService.refreshNotification()
            }
            else -> {
                val alone = PageHost.activity == null
                if (alone) {
                    PageHost.destroy()
                    abandons++
                }
                clear()
                LocationService.stop(ctx)
                // A page that threw says declined too; a share it rightly refused is no longer due.
                if (alone) offerIfDue(ctx, offerText(why))
            }
        }
    }

    // The page goes first so nothing more is posted; the armed record stays for the tap.
    fun abandon(ctx: Context, @StringRes offer: Int) {
        if (PageHost.activity != null) return
        if (headlessWhy == null) return
        abandons++
        PageHost.destroy()
        clear()
        LocationService.stop(ctx)
        runCatching { Events.cancel(ctx, RESUMED_TAG) }
        offerIfDue(ctx, offer)
    }

    // Nothing is given up behind the back of a person who is looking.
    fun windowOpened() {
        cancel(confirmTimer)
        confirmTimer = null
        cancelOrbot()
        if (LocationService.resumedWhy == null) return
        LocationService.resumedWhy = null
        LocationService.refreshNotification()
    }

    private fun clear() {
        cancel(confirmTimer)
        confirmTimer = null
        cancelOrbot()
        headlessWhy = null
        alerted = false
        LocationService.clearResume()
    }

    private fun cancelOrbot() {
        cancel(orbotTimer)
        cancel(orbotAsk)
        orbotTimer = null
        orbotAsk = null
    }

    private fun cancel(r: Runnable?) {
        if (r != null) PageHost.cancel(r)
    }

    @StringRes
    private fun offerText(why: String): Int =
        if (why == "update") R.string.notif_resume_update_text else R.string.notif_resume_boot_text

    private fun dueNow(ctx: Context): Boolean {
        val p = prefs(ctx)
        return due(
            p.getLong(PREF_AT, 0L),
            p.getLong(PREF_DEADLINE, 0L),
            p.getString(MainActivity.PREF_STOP_ROUTE, null),
            p.getLong(MainActivity.PREF_STOP_TS, 0L),
            System.currentTimeMillis(),
        )
    }

    // No running check: a service on its way down still reads as running.
    private fun offerIfDue(ctx: Context, @StringRes text: Int) {
        if (dueNow(ctx)) Events.postShareResume(ctx, text)
    }

    private fun locationHeld(ctx: Context): Boolean =
        granted(ctx, Manifest.permission.ACCESS_FINE_LOCATION) || granted(ctx, Manifest.permission.ACCESS_COARSE_LOCATION)

    private fun granted(ctx: Context, permission: String): Boolean =
        ContextCompat.checkSelfPermission(ctx, permission) == PackageManager.PERMISSION_GRANTED

    private fun prefs(ctx: Context) = ctx.getSharedPreferences(MainActivity.PREFS, Context.MODE_PRIVATE)
}

class ShareResumeReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val why = when (intent.action) {
            Intent.ACTION_BOOT_COMPLETED -> "boot"
            Intent.ACTION_MY_PACKAGE_REPLACED -> "update"
            else -> return
        }
        ShareResume.onSystemStart(context, why)
    }
}
