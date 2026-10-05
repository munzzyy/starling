package app.starlingmap

import android.content.Context
import android.location.Location
import android.os.BatteryManager
import android.os.PowerManager
import android.os.SystemClock
import org.json.JSONObject
import java.net.URI
import java.net.URL
import java.util.concurrent.Executors
import javax.net.ssl.HttpsURLConnection
import kotlin.math.roundToInt

// A second place a person's own position goes: a server they run, in OwnTracks'
// HTTP format (Reitti, Dawarich, Home Assistant, colota-forwarder). Only while a
// share runs, only over https, never under Tor mode, and never quietly: the
// notification and the line under their name both name the host.
object Forward {
    private const val PREF_URL = "forward_url"
    private const val PREF_TID = "forward_tid"
    private const val MAX_TID = 64
    private const val MIN_GAP_MS = 15000L
    private const val TIMEOUT_MS = 10000
    private const val MAX_URL = 2048
    private const val USER_AGENT = "Starling"

    private val sender = Executors.newSingleThreadExecutor()
    private val queue = ForwardQueue()

    @Volatile
    private var lastAt = 0L

    // Since the address was set, for the Settings line. Never a position.
    @Volatile var sent = 0
        private set
    @Volatile var failed = 0
        private set

    // The last answer: an HTTP status, 0 before the first, -1 for no connection.
    @Volatile var lastStatus = 0
        private set

    // The rule the page applies too; this one is the one that counts.
    fun normalize(raw: String?): String? {
        val s = raw?.trim().orEmpty()
        if (s.isEmpty() || s.length > MAX_URL) return null
        val u = try {
            URI(s)
        } catch (e: Exception) {
            return null
        }
        if (u.scheme?.lowercase() != "https" || u.host.isNullOrEmpty()) return null
        if (u.rawUserInfo != null || u.rawFragment != null) return null
        return s
    }

    // "" clears it; null means it fails the rule colota-forwarder applies to tid.
    fun normalizeTid(raw: String?): String? {
        val s = raw?.trim().orEmpty()
        if (s.isEmpty()) return ""
        if (s.length > MAX_TID || s.any { it.code < 0x20 || it.code == 0x7f }) return null
        return s
    }

    private fun prefs(ctx: Context) = ctx.getSharedPreferences(MainActivity.PREFS, Context.MODE_PRIVATE)

    private fun url(ctx: Context): String? = prefs(ctx).getString(PREF_URL, null)

    fun host(ctx: Context): String? = url(ctx)?.let { runCatching { URI(it).host }.getOrNull() }

    fun torOn(ctx: Context): Boolean = prefs(ctx).getBoolean(MainActivity.PREF_TOR, false)

    fun tid(ctx: Context): String? = prefs(ctx).getString(PREF_TID, null)

    fun setTid(ctx: Context, raw: String?): Boolean {
        val next = normalizeTid(raw) ?: return false
        val edit = prefs(ctx).edit()
        if (next.isEmpty()) edit.remove(PREF_TID) else edit.putString(PREF_TID, next)
        edit.apply()
        return true
    }

    // The host only, never the address: servers put their key in its query.
    fun status(ctx: Context): String = JSONObject()
        .put("host", host(ctx) ?: JSONObject.NULL)
        .put("tor", torOn(ctx))
        .put("sent", sent)
        .put("failed", failed)
        .put("last", lastStatus)
        .put("tid", tid(ctx) ?: JSONObject.NULL)
        .toString()

    // "" stops it. An address that fails normalize changes nothing.
    fun set(ctx: Context, raw: String?): Boolean {
        val next = if (raw.isNullOrBlank()) null else normalize(raw) ?: return false
        val edit = prefs(ctx).edit()
        if (next == null) edit.remove(PREF_URL) else edit.putString(PREF_URL, next)
        edit.apply()
        queue.clear()
        lastAt = 0L
        sent = 0
        failed = 0
        lastStatus = 0
        return true
    }

    // The first fix of a share goes out at once.
    fun shareStarted() {
        queue.clear()
        lastAt = 0L
    }

    fun shareEnded() = queue.clear()

    fun maybeSend(ctx: Context, location: Location) {
        if (url(ctx) == null) return
        if (torOn(ctx)) {
            queue.clear()
            return
        }
        val now = SystemClock.elapsedRealtime()
        if (lastAt != 0L && now - lastAt < MIN_GAP_MS) return
        lastAt = now
        val body = payload(location, battery(ctx), tid(ctx))
        val app = ctx.applicationContext
        if (queue.add(body)) sender.execute { drain(app) }
    }

    // A point the server could not take waits for the next fix, never for a timer.
    private fun drain(app: Context) = queue.drain { body ->
        val target = url(app)
        if (target == null || torOn(app)) {
            queue.clear()
            null
        } else {
            post(app, target, body)
        }
    }

    fun payload(l: Location, batt: Int?, tid: String? = null): String {
        val o = JSONObject()
            .put("_type", "location")
            .put("lat", l.latitude)
            .put("lon", l.longitude)
            .put("tst", l.time / 1000)
        if (l.hasAccuracy()) o.put("acc", l.accuracy.roundToInt())
        if (l.hasAltitude()) o.put("alt", l.altitude.roundToInt())
        if (l.hasSpeed()) o.put("vel", (l.speed * 3.6f).roundToInt())
        if (l.hasBearing()) o.put("cog", l.bearing.roundToInt())
        if (batt != null) o.put("batt", batt)
        if (tid != null) o.put("tid", tid)
        return o.toString()
    }

    private fun battery(ctx: Context): Int? = runCatching {
        (ctx.getSystemService(Context.BATTERY_SERVICE) as BatteryManager)
            .getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY)
            .takeIf { it in 0..100 }
    }.getOrNull()

    private fun post(app: Context, target: String, body: String): Int {
        val wake = (app.getSystemService(Context.POWER_SERVICE) as PowerManager)
            .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "starling:forward")
        wake.acquire(2L * TIMEOUT_MS + 5000)
        var c: HttpsURLConnection? = null
        try {
            c = URL(target).openConnection() as HttpsURLConnection
            c.requestMethod = "POST"
            c.connectTimeout = TIMEOUT_MS
            c.readTimeout = TIMEOUT_MS
            c.instanceFollowRedirects = false
            c.useCaches = false
            c.doOutput = true
            c.setRequestProperty("Content-Type", "application/json")
            // The default names the phone model and its build.
            c.setRequestProperty("User-Agent", USER_AGENT)
            c.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
            val code = c.responseCode
            lastStatus = code
            if (code in 200..299) sent++ else failed++
            return code
        } catch (e: Exception) {
            lastStatus = -1
            failed++
            return -1
        } finally {
            c?.disconnect()
            if (wake.isHeld) wake.release()
        }
    }
}
