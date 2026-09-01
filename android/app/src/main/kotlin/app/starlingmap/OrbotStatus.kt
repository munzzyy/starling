package app.starlingmap

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import androidx.core.content.ContextCompat

// Asks Orbot which SOCKS port it is actually listening on.
//
// 9050 is Orbot's default and is right almost every time, so it stays the
// fallback and nothing here is required for Tor mode to work. But the port is
// configurable, and a wrong port fails closed: traffic stops rather than
// leaking, which is safe and also indistinguishable from the app being
// broken. Asking costs one broadcast.
//
// Orbot answers ACTION_START with a status broadcast carrying the live ports.
// NetCipher used to be the polite way to do this; it has been unmaintained
// since 2020 and never read the port extra it declared constants for, so this
// talks to Orbot directly. The receiver must be registered EXPORTED: Orbot is
// a separate app, and a not-exported receiver silently never fires.
object OrbotStatus {

    const val DEFAULT_SOCKS_PORT = 9050

    private const val ORBOT_PACKAGE = "org.torproject.android"
    private const val ACTION_START = "org.torproject.android.intent.action.START"
    private const val ACTION_STATUS = "org.torproject.android.intent.action.STATUS"
    private const val EXTRA_PACKAGE_NAME = "org.torproject.android.intent.extra.PACKAGE_NAME"
    private const val EXTRA_STATUS = "org.torproject.android.intent.extra.STATUS"
    private const val EXTRA_SOCKS_PORT = "org.torproject.android.intent.extra.SOCKS_PROXY_PORT"
    private const val STATUS_ON = "ON"

    // A status broadcast can only be trusted for this long after we asked for
    // one. The receiver has to be exported, because Orbot is a separate app,
    // and a receiver cannot see who sent it an intent, so any app on the
    // device can send this one a status with a port of its choosing. Nothing
    // catastrophic follows from believing it (traffic to a port that is not
    // Tor fails closed, and what would reach a local listener is TLS to the
    // relay carrying already-encrypted payloads), but there is no reason to
    // accept an answer to a question nobody asked.
    private const val TRUST_WINDOW_MS = 30_000L

    private var receiver: BroadcastReceiver? = null

    @Volatile
    private var askedAt = 0L

    // Last port Orbot reported, or the default until it says otherwise.
    @Volatile
    var socksPort: Int = DEFAULT_SOCKS_PORT
        private set

    // onPort fires only when Orbot reports a running Tor on a port that is
    // not the one already in use, so the caller re-applies the proxy exactly
    // when the answer changes something.
    fun start(context: Context, onPort: (Int) -> Unit) {
        if (receiver != null) return
        val ctx = context.applicationContext
        val r = object : BroadcastReceiver() {
            override fun onReceive(c: Context, intent: Intent) {
                if (intent.action != ACTION_STATUS) return
                if (android.os.SystemClock.elapsedRealtime() - askedAt > TRUST_WINDOW_MS) return
                if (intent.getStringExtra(EXTRA_STATUS) != STATUS_ON) return
                // Absent or -1 means Orbot has not configured a port yet;
                // keep whatever is in use rather than proxying to port -1.
                val port = intent.getIntExtra(EXTRA_SOCKS_PORT, -1)
                if (port <= 0 || port > 65535 || port == socksPort) return
                socksPort = port
                onPort(port)
            }
        }
        ContextCompat.registerReceiver(ctx, r, IntentFilter(ACTION_STATUS), ContextCompat.RECEIVER_EXPORTED)
        receiver = r
        ask(ctx)
    }

    // Also the way to re-ask: Orbot replies with current status and ports
    // every time, and starting an already-running Tor does nothing.
    fun ask(context: Context) {
        if (receiver == null) return
        askedAt = android.os.SystemClock.elapsedRealtime()
        val intent = Intent(ACTION_START)
            .setPackage(ORBOT_PACKAGE)
            .putExtra(EXTRA_PACKAGE_NAME, context.packageName)
        runCatching { context.applicationContext.sendBroadcast(intent) }
    }

    fun stop(context: Context) {
        val r = receiver ?: return
        receiver = null
        runCatching { context.applicationContext.unregisterReceiver(r) }
    }
}
