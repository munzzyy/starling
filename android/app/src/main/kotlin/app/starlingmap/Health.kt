package app.starlingmap

import android.Manifest
import android.app.ActivityManager
import android.app.AppOpsManager
import android.app.usage.UsageStatsManager
import android.content.Context
import android.content.pm.PackageManager
import android.location.LocationManager
import android.os.Build
import android.os.PowerManager
import android.os.Process
import android.os.SystemClock
import android.webkit.WebView
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import org.json.JSONObject

// Settings, states, versions, counts and ages for the sharing report. The
// report gets pasted into bugs, so nothing here reads a position, key or name.
object Health {

    fun batteryState(ctx: Context): String {
        val am = ctx.getSystemService(ActivityManager::class.java)
        if (am?.isBackgroundRestricted == true) return "restricted"
        val pm = ctx.getSystemService(PowerManager::class.java)
        return if (pm?.isIgnoringBatteryOptimizations(ctx.packageName) == true) "unrestricted" else "optimized"
    }

    fun snapshot(ctx: Context): String {
        val o = JSONObject()
        val now = SystemClock.elapsedRealtime()
        fun ago(t: Long): Any = if (t > 0L) now - t else JSONObject.NULL

        o.put("app", runCatching { ctx.packageManager.getPackageInfo(ctx.packageName, 0).versionName }.getOrNull() ?: "unknown")
        o.put("android", Build.VERSION.RELEASE)
        o.put("sdk", Build.VERSION.SDK_INT)
        o.put("device", "${Build.MANUFACTURER} ${Build.MODEL}".trim())
        o.put("webview", runCatching { WebView.getCurrentWebViewPackage()?.let { "${it.packageName} ${it.versionName}" } }.getOrNull() ?: "unknown")

        fun granted(p: String) = ContextCompat.checkSelfPermission(ctx, p) == PackageManager.PERMISSION_GRANTED
        o.put("fine", granted(Manifest.permission.ACCESS_FINE_LOCATION))
        o.put("coarse", granted(Manifest.permission.ACCESS_COARSE_LOCATION))
        // What the location stack enforces right now, not just the grant.
        o.put("fineOp", runCatching {
            val ops = ctx.getSystemService(AppOpsManager::class.java)
            val mode = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                ops.unsafeCheckOpNoThrow(AppOpsManager.OPSTR_FINE_LOCATION, Process.myUid(), ctx.packageName)
            } else {
                @Suppress("DEPRECATION")
                ops.checkOpNoThrow(AppOpsManager.OPSTR_FINE_LOCATION, Process.myUid(), ctx.packageName)
            }
            when (mode) {
                AppOpsManager.MODE_ALLOWED -> "allowed"
                AppOpsManager.MODE_FOREGROUND -> "foreground"
                AppOpsManager.MODE_IGNORED -> "ignored"
                AppOpsManager.MODE_ERRORED -> "errored"
                else -> "default"
            }
        }.getOrDefault("unknown"))
        o.put("notifications", NotificationManagerCompat.from(ctx).areNotificationsEnabled())

        val lm = ctx.getSystemService(LocationManager::class.java)
        o.put("locationOn", runCatching { lm.isLocationEnabled }.getOrDefault(false))
        o.put("gpsOn", runCatching { lm.isProviderEnabled(LocationManager.GPS_PROVIDER) }.getOrDefault(false))
        o.put("networkOn", runCatching { lm.isProviderEnabled(LocationManager.NETWORK_PROVIDER) }.getOrDefault(false))

        val pm = ctx.getSystemService(PowerManager::class.java)
        o.put("battery", batteryState(ctx))
        o.put("powerSave", pm.isPowerSaveMode)
        o.put("saverLocationMode", pm.locationPowerSaveMode)
        o.put("deviceIdle", pm.isDeviceIdleMode)
        if (Build.VERSION.SDK_INT >= 33) o.put("lightIdle", pm.isDeviceLightIdleMode)
        o.put("standbyBucket", runCatching {
            ctx.getSystemService(UsageStatsManager::class.java).appStandbyBucket
        }.getOrDefault(-1))

        o.put("service", LocationService.running)
        o.put("sharingMs", if (LocationService.running) ago(LocationService.startedAt) else JSONObject.NULL)
        o.put("fixes", LocationService.fixes)
        o.put("gpsFixes", LocationService.gpsFixes)
        o.put("networkFixes", LocationService.networkFixes)
        o.put("fusedFixes", LocationService.fusedFixes)
        o.put("lastFixMs", ago(LocationService.lastFixAt))
        o.put("ticks", LocationService.ticks)
        o.put("rewatches", LocationService.rewatches)
        o.put("locationOff", LocationService.locationOff)
        o.put("stillSupported", LocationService.stillSupported(ctx))
        o.put("still", LocationService.stillNow)
        o.put("stillSpells", LocationService.stillSpells)
        o.put("stillMs", LocationService.stillMs(now))

        o.put("windowShown", PageHost.windowShown)
        o.put("headless", PageHost.activity == null)
        o.put("holding", PageHost.holding)
        o.put("holderFailed", PageHost.holderFailed)
        o.put("freezes", PageHost.freezes)
        o.put("nudges", PageHost.nudges)
        o.put("lastPulseMs", ago(PageHost.lastPulseAt))
        o.put("keepSharing", PageHost.keepSharing(ctx))
        o.put("autoBoot", ShareResume.autoBoot(ctx))
        o.put("autoUpdate", ShareResume.autoUpdate(ctx))
        o.put("background", ShareResume.backgroundState(ctx))
        o.put("resumedBy", ShareResume.headlessWhy ?: "")
        o.put("headlessResumes", ShareResume.resumes)
        o.put("headlessAbandons", ShareResume.abandons)
        o.put(
            "tor",
            ctx.getSharedPreferences(MainActivity.PREFS, Context.MODE_PRIVATE).getBoolean(MainActivity.PREF_TOR, false),
        )
        return o.toString()
    }
}
