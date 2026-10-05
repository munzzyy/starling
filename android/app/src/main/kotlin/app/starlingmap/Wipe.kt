package app.starlingmap

import android.Manifest
import android.app.ActivityManager
import android.app.NotificationManager
import android.content.Context
import android.os.Build

// The one full-device wipe, shared by the PanicKit responder and the in-app
// panic bridge (which is also what the duress passcode fires). Kept in one
// place so the two triggers can never drift apart in what they erase.
// The bridge calls it on its own thread, so nothing here may touch a view.
object Wipe {
    fun everything(ctx: Context) {
        // First: a running share holds GPS and a wake lock, and its channel cannot be deleted.
        runCatching { LocationService.stop(ctx) }
        // The system clear also wipes this uid's Keystore namespace, but that
        // half runs fire-and-forget in system_server with errors swallowed.
        // Deleting the wrap key here is synchronous and in-process, so it is
        // done before the nuke rather than hoped for after it.
        KeystoreVault.deleteKey()
        runCatching { ShareReminder.cancel(ctx) }
        runCatching { ShareResume.disarm(ctx) }
        runCatching { ShareResume.forgetAuto(ctx) }
        // A wiped app, like the duress passcode's fresh install, keeps no all the time location.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            runCatching { ctx.revokeSelfPermissionsOnKill(listOf(Manifest.permission.ACCESS_BACKGROUND_LOCATION)) }
        }
        // Notification channels live in system settings, outside app data,
        // and their labels name the app's features. Remove the residue, each
        // on its own so one refusal cannot keep the others.
        val nm = ctx.getSystemService(NotificationManager::class.java)
        for (id in listOf(
            LocationService.CHANNEL,
            MainActivity.EVENTS_CHANNEL,
            MainActivity.SOS_CHANNEL,
            MainActivity.OLD_SOS_CHANNEL,
        )) {
            runCatching { nm.deleteNotificationChannel(id) }
        }
        // Kills the process and deletes all app data, WebView storage and
        // cookies included. Anything asynchronous queued before this line
        // would never have run anyway. That includes the share-stop trace:
        // it lives in a SharedPreferences file under this app's own data
        // directory, not in system settings like the channels above, so this
        // one call is also what erases it.
        (ctx.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager).clearApplicationUserData()
    }
}
