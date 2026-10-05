package app.starlingmap

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.annotation.StringRes

// A restart or an update kills the page that seals every position, and nothing
// can bring it back without a person: Android 11 and up give a location service
// started from the background no fixes, and 14 and up refuse to start it. So
// this offers the share back instead of taking it. The tap is an ordinary
// reopen, which resumes through the page (and through the app lock, if there
// is one) the way it always has.
//
// The page keeps the real armed record in its own storage, which this side
// cannot read before a page exists. It hands over a copy: when the share was
// armed and when its window ends. No position, no key, no circle.
object ShareResume {
    const val TAG = "resume"
    private const val PREF_AT = "resume_armed_at"
    private const val PREF_DEADLINE = "resume_deadline"

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

    fun offer(ctx: Context, @StringRes why: Int) {
        if (LocationService.running) return
        val p = prefs(ctx)
        val ok = due(
            p.getLong(PREF_AT, 0L),
            p.getLong(PREF_DEADLINE, 0L),
            p.getString(MainActivity.PREF_STOP_ROUTE, null),
            p.getLong(MainActivity.PREF_STOP_TS, 0L),
            System.currentTimeMillis(),
        )
        if (ok) Events.postShareResume(ctx, why)
    }

    private fun prefs(ctx: Context) = ctx.getSharedPreferences(MainActivity.PREFS, Context.MODE_PRIVATE)
}

class ShareResumeReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val why = when (intent.action) {
            Intent.ACTION_BOOT_COMPLETED -> R.string.notif_resume_boot_text
            Intent.ACTION_MY_PACKAGE_REPLACED -> R.string.notif_resume_update_text
            else -> return
        }
        ShareResume.offer(context, why)
    }
}
