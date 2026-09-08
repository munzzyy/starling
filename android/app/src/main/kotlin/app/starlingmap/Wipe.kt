package app.starlingmap

import android.app.ActivityManager
import android.app.NotificationManager
import android.content.Context

// The one full-device wipe, shared by the PanicKit responder and the in-app
// panic bridge (which is also what the duress passcode fires). Kept in one
// place so the two triggers can never drift apart in what they erase.
object Wipe {
    fun everything(ctx: Context) {
        // The system clear also wipes this uid's Keystore namespace, but that
        // half runs fire-and-forget in system_server with errors swallowed.
        // Deleting the wrap key here is synchronous and in-process, so it is
        // done before the nuke rather than hoped for after it.
        KeystoreVault.deleteKey()
        // Notification channels live in system settings, outside app data,
        // and their labels name the app's features. Remove the residue.
        runCatching {
            val nm = ctx.getSystemService(NotificationManager::class.java)
            nm.deleteNotificationChannel(LocationService.CHANNEL)
            nm.deleteNotificationChannel(MainActivity.EVENTS_CHANNEL)
            nm.deleteNotificationChannel(MainActivity.SOS_CHANNEL)
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
