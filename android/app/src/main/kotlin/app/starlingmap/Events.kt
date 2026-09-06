package app.starlingmap

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import androidx.core.content.ContextCompat

// Circle-event notifications, shared by the activity (bridge notify calls)
// and the location service (which needs to speak after the activity is gone,
// e.g. when the task is swiped away). One channel, one id, tag replaces.
object Events {

    fun post(ctx: Context, title: String, body: String, tag: String) {
        if (title.isEmpty()) return
        if (ContextCompat.checkSelfPermission(ctx, Manifest.permission.POST_NOTIFICATIONS) !=
            PackageManager.PERMISSION_GRANTED
        ) {
            return
        }
        val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        nm.createNotificationChannel(
            NotificationChannel(
                MainActivity.EVENTS_CHANNEL,
                ctx.getString(R.string.notif_events_channel),
                NotificationManager.IMPORTANCE_HIGH,
            ),
        )
        val open = PendingIntent.getActivity(
            ctx,
            0,
            Intent(ctx, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE,
        )
        val n = android.app.Notification.Builder(ctx, MainActivity.EVENTS_CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_starling)
            .setContentTitle(title)
            .apply { if (body.isNotEmpty()) setContentText(body) }
            .setContentIntent(open)
            .setAutoCancel(true)
            .build()
        nm.notify(tag.ifEmpty { "event" }, MainActivity.EVENTS_NOTIF_ID, n)
    }

    fun cancel(ctx: Context, tag: String) {
        val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        nm.cancel(tag.ifEmpty { "event" }, MainActivity.EVENTS_NOTIF_ID)
    }
}
