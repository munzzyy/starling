package app.starlingmap

import android.app.Activity
import android.app.ActivityManager
import android.os.Bundle
import android.webkit.CookieManager
import android.webkit.WebStorage
import android.widget.Button
import android.widget.TextView
import info.guardianproject.panic.Panic
import info.guardianproject.panic.PanicResponder

// PanicKit responder. CONNECT pairs a trigger app (Ripple) with the user's
// explicit consent; TRIGGER wipes immediately and headlessly, but only when
// it comes from the app the user paired. The wipe is the nuclear one: all app
// data, including IndexedDB and preferences, then the process dies. That is
// exactly the in-app panic wipe's promise, minus needing the app unlocked.
class PanicActivity : Activity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        when {
            PanicResponder.checkForDisconnectIntent(this) -> {
                setResult(RESULT_OK)
                finish()
            }
            Panic.isTriggerIntent(intent) -> {
                if (PanicResponder.receivedTriggerFromConnectedApp(this)) {
                    wipeEverything()
                    // not reached: the wipe kills the process
                }
                finish()
            }
            intent?.action == Panic.ACTION_CONNECT -> showConsent()
            else -> finish()
        }
    }

    private fun showConsent() {
        setContentView(R.layout.activity_panic)
        val caller = callingActivity?.packageName ?: getString(R.string.panic_unknown_app)
        findViewById<TextView>(R.id.panic_text).text = getString(R.string.panic_connect_text, caller)
        findViewById<Button>(R.id.panic_allow).setOnClickListener {
            PanicResponder.setTriggerPackageName(this)
            setResult(RESULT_OK)
            finish()
        }
        findViewById<Button>(R.id.panic_deny).setOnClickListener {
            PanicResponder.setTriggerPackageName(this, Panic.PACKAGE_NAME_NONE)
            setResult(RESULT_CANCELED)
            finish()
        }
    }

    private fun wipeEverything() {
        runCatching { WebStorage.getInstance().deleteAllData() }
        runCatching { CookieManager.getInstance().removeAllCookies(null) }
        (getSystemService(ACTIVITY_SERVICE) as ActivityManager).clearApplicationUserData()
    }
}
