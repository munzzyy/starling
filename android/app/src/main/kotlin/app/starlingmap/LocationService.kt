package app.starlingmap

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Bundle
import android.os.IBinder
import androidx.core.content.ContextCompat
import org.json.JSONObject

// Keeps location flowing while the screen is off or the app is backgrounded.
// Runs only between an explicit start from the page (user turned sharing on,
// app in the foreground, permission already granted) and the matching stop.
// While-in-use only: the app never requests background location permission,
// and swiping the task away ends the share instead of tracking silently.
class LocationService : Service(), LocationListener {

    companion object {
        private const val CHANNEL = "share"
        private const val NOTIF_ID = 1
        private const val ACTION_STOP = "app.starlingmap.STOP_SHARE"
        private const val MIN_TIME_MS = 3000L
        private const val MIN_DIST_M = 5f

        // The activity plants a sink to push fixes into the page. Static is
        // fine: one process, one WebView.
        @Volatile
        var sink: ((String) -> Unit)? = null

        fun start(ctx: Context) {
            ContextCompat.startForegroundService(ctx, Intent(ctx, LocationService::class.java))
        }

        fun stop(ctx: Context) {
            ctx.stopService(Intent(ctx, LocationService::class.java))
        }
    }

    private var watching = false

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            // A user action, not a failure: the page turns sharing off cleanly.
            sink?.invoke(JSONObject().put("stopped", true).toString())
            stopSelf()
            return START_NOT_STICKY
        }
        // startForeground itself throws if location permission vanished between
        // the activity's check and this callback; that stack is the framework's,
        // not the activity's try/catch, so it must be handled here.
        try {
            startForeground(NOTIF_ID, buildNotification(), ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION)
        } catch (e: Exception) {
            sink?.invoke(JSONObject().put("error", "location service refused: ${e.message}").put("code", 2).toString())
            stopSelf()
            return START_NOT_STICKY
        }
        startWatching()
        return START_NOT_STICKY
    }

    private fun startWatching() {
        if (watching) return
        val lm = getSystemService(LOCATION_SERVICE) as LocationManager
        var any = false
        for (provider in listOf(LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER)) {
            if (!lm.allProviders.contains(provider)) continue
            try {
                lm.requestLocationUpdates(provider, MIN_TIME_MS, MIN_DIST_M, this, mainLooper)
                any = true
            } catch (e: SecurityException) {
                // permission revoked between the page's start call and here
            }
        }
        if (!any) {
            sink?.invoke(JSONObject().put("error", "no location provider").put("code", 2).toString())
            stopSelf()
            return
        }
        watching = true
    }

    override fun onLocationChanged(location: Location) {
        val fix = JSONObject()
            .put("lat", location.latitude)
            .put("lon", location.longitude)
            .put("ts", location.time)
        if (location.hasAccuracy()) fix.put("acc", location.accuracy.toDouble())
        if (location.hasSpeed()) fix.put("spd", location.speed.toDouble())
        if (location.hasBearing()) fix.put("hdg", location.bearing.toDouble())
        sink?.invoke(fix.toString())
    }

    @Deprecated("Deprecated in Java")
    override fun onStatusChanged(provider: String?, status: Int, extras: Bundle?) {
    }

    override fun onProviderEnabled(provider: String) {
    }

    override fun onProviderDisabled(provider: String) {
    }

    override fun onTaskRemoved(rootIntent: Intent?) {
        // The user swiped the app away: end the share, do not linger.
        stopSelf()
    }

    override fun onDestroy() {
        if (watching) {
            (getSystemService(LOCATION_SERVICE) as LocationManager).removeUpdates(this)
            watching = false
        }
        super.onDestroy()
    }

    private fun buildNotification(): Notification {
        val nm = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL, getString(R.string.notif_channel), NotificationManager.IMPORTANCE_LOW),
        )
        val open = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE,
        )
        val stop = PendingIntent.getService(
            this,
            1,
            Intent(this, LocationService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_IMMUTABLE,
        )
        return Notification.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_starling)
            .setContentTitle(getString(R.string.notif_title))
            .setContentText(getString(R.string.notif_text))
            .setContentIntent(open)
            .setOngoing(true)
            .addAction(Notification.Action.Builder(null, getString(R.string.notif_stop), stop).build())
            .build()
    }
}
