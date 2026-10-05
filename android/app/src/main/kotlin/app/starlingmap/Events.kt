package app.starlingmap

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.media.AudioAttributes
import android.media.RingtoneManager
import androidx.annotation.StringRes
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat

// Circle-event notifications, shared by the activity (bridge notify calls)
// and the location service (which needs to speak after the activity is gone,
// e.g. when the task is swiped away). One id, tag replaces within a channel.
// An active SOS gets its own channel (see MainActivity.SOS_CHANNEL) so it can
// carry a sound and a vibration pattern the routine channel does not, without
// touching either channel's settings after an existing install already
// created them.
object Events {

    private val SOS_VIBRATION = longArrayOf(0, 400, 200, 400, 200, 400, 200, 400)

    fun post(ctx: Context, title: String, body: String, tag: String, urgent: Boolean = false) {
        if (title.isEmpty()) return
        // title/body never reach a notification field; see the commit message for why.
        show(ctx, R.string.app_name, if (urgent) R.string.notif_sos_text else R.string.notif_locked_text, tag, urgent)
    }

    // The share reminder (ShareReminder). Its words say nothing about a circle or a person.
    fun postShareOff(ctx: Context) =
        show(ctx, R.string.notif_remind_title, R.string.notif_remind_text, ShareReminder.TAG, false)

    // After a restart or an update (ShareResume). Same rule: no circle, no person.
    fun postShareResume(ctx: Context, @StringRes textRes: Int) =
        show(ctx, R.string.notif_swiped_title, textRes, ShareResume.TAG, false)

    fun postShareResumed(ctx: Context, @StringRes textRes: Int) =
        show(ctx, R.string.notif_resumed_title, textRes, ShareResume.RESUMED_TAG, false)

    // String resources only, so nothing a caller was handed can reach a notification field.
    private fun show(ctx: Context, @StringRes titleRes: Int, @StringRes textRes: Int, tag: String, urgent: Boolean) {
        if (ContextCompat.checkSelfPermission(ctx, Manifest.permission.POST_NOTIFICATIONS) !=
            PackageManager.PERMISSION_GRANTED
        ) {
            return
        }
        val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        val channelId = if (urgent) ensureSosChannel(ctx) else MainActivity.EVENTS_CHANNEL
        if (!urgent) nm.createNotificationChannel(buildChannel(ctx, channelId, false))
        val open = PendingIntent.getActivity(
            ctx,
            0,
            Intent(ctx, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE,
        )
        val heading = ctx.getString(titleRes)
        val text = ctx.getString(textRes)
        val publicVersion = NotificationCompat.Builder(ctx, channelId)
            .setSmallIcon(R.drawable.ic_stat_starling)
            .setContentTitle(heading)
            .setContentText(text)
            .setContentIntent(open)
            .setAutoCancel(true)
            .build()
        val n = NotificationCompat.Builder(ctx, channelId)
            .setSmallIcon(R.drawable.ic_stat_starling)
            .setContentTitle(heading)
            .setContentText(text)
            .setContentIntent(open)
            .setAutoCancel(true)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setPublicVersion(publicVersion)
            .apply {
                if (urgent) {
                    priority = NotificationCompat.PRIORITY_HIGH
                    // Do Not Disturb lets alarms through by default and holds everything else back.
                    setCategory(NotificationCompat.CATEGORY_ALARM)
                }
            }
            .build()
        nm.notify(tag.ifEmpty { "event" }, MainActivity.EVENTS_NOTIF_ID, n)
    }

    private fun buildChannel(ctx: Context, channelId: String, urgent: Boolean): NotificationChannel {
        val name = ctx.getString(if (urgent) R.string.notif_sos_channel else R.string.notif_events_channel)
        val channel = NotificationChannel(channelId, name, NotificationManager.IMPORTANCE_HIGH)
        if (urgent) {
            // A ringtone, not the default notification ding, and a pattern
            // that keeps pulsing: this is the one channel in the app that
            // must not read like every other alert.
            val sound = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE)
            val attrs = AudioAttributes.Builder()
                // Alarm usage gets it through Do Not Disturb, at the alarm volume.
                .setUsage(AudioAttributes.USAGE_ALARM)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .build()
            channel.setSound(sound, attrs)
            channel.enableVibration(true)
            channel.vibrationPattern = SOS_VIBRATION
        }
        return channel
    }

    // A channel's sound attributes never change in place, so the pre-alarm channel is retired.
    fun ensureSosChannel(ctx: Context): String {
        val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        runCatching { nm.deleteNotificationChannel(MainActivity.OLD_SOS_CHANNEL) }
        nm.createNotificationChannel(buildChannel(ctx, MainActivity.SOS_CHANNEL, true))
        return MainActivity.SOS_CHANNEL
    }

    fun cancel(ctx: Context, tag: String) {
        val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        nm.cancel(tag.ifEmpty { "event" }, MainActivity.EVENTS_NOTIF_ID)
    }
}
