package app.starlingmap

import android.content.Context
import androidx.core.content.ContextCompat
import androidx.webkit.ProxyConfig
import androidx.webkit.ProxyController
import androidx.webkit.WebViewFeature

// All WebView traffic through Orbot's SOCKS port, with no direct fallback:
// if Orbot is not listening, requests fail instead of leaking. socks5://
// is explicit because it matters: Chromium resolves hostnames proxy-side
// for SOCKS5, so DNS rides through Tor too. The override only governs
// connections opened after it lands, so the listener reloads the page and
// strands whatever the old config had pooled.
//
// The port comes from Orbot itself when Orbot answers; 9050 is the
// default and the fallback. Watching for the answer means a user who
// moved Orbot's port gets working Tor instead of a share that fails
// closed for a reason nothing on screen could explain.
object TorProxy {

    fun supported(): Boolean = WebViewFeature.isFeatureSupported(WebViewFeature.PROXY_OVERRIDE)

    fun enabled(ctx: Context): Boolean =
        ctx.getSharedPreferences(MainActivity.PREFS, Context.MODE_PRIVATE).getBoolean(MainActivity.PREF_TOR, false)

    // True when a change is on its way and `then` will run from its listener.
    fun apply(ctx: Context, then: Runnable = Runnable { PageHost.reload() }): Boolean {
        if (!supported()) return false
        val app = ctx.applicationContext
        val controller = ProxyController.getInstance()
        val executor = ContextCompat.getMainExecutor(app)
        if (enabled(app)) {
            OrbotStatus.start(app) { apply(app) }
            val rule = "socks5://127.0.0.1:${OrbotStatus.socksPort}"
            if (PageHost.proxyApplied == rule) return false
            PageHost.proxyApplied = rule
            val config = ProxyConfig.Builder().addProxyRule(rule).build()
            controller.setProxyOverride(config, executor, then)
        } else {
            OrbotStatus.stop(app)
            if (PageHost.proxyApplied == "direct") return false
            PageHost.proxyApplied = "direct"
            controller.clearProxyOverride(executor, then)
        }
        return true
    }
}
