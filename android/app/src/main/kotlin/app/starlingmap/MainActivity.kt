package app.starlingmap

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Bundle
import android.webkit.GeolocationPermissions
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import androidx.webkit.ProxyConfig
import androidx.webkit.ProxyController
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewFeature
import org.json.JSONObject

// One screen: the bundled web app in a WebView on the fixed asset origin.
// Everything the page cannot do itself (foreground location, Keystore
// biometrics, Tor proxying) arrives through the StarlingNative bridge.
class MainActivity : FragmentActivity() {

    companion object {
        const val ASSET_HOST = "appassets.androidplatform.net"
        const val START_URL = "https://$ASSET_HOST/index.html"
        const val APP_HOST = "starlingmap.app"
        const val PREFS = "starling"
        const val PREF_TOR = "tor"
    }

    lateinit var webView: WebView
        private set

    private lateinit var assetLoader: WebViewAssetLoader
    private lateinit var bridge: StarlingBridge

    // Set while a location permission request is in flight for the share flow.
    private var pendingShareStart = false
    private var pendingGeoCallback: Pair<String, GeolocationPermissions.Callback>? = null

    private val locationPermission = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions(),
    ) { grants ->
        val granted = grants[Manifest.permission.ACCESS_FINE_LOCATION] == true ||
            grants[Manifest.permission.ACCESS_COARSE_LOCATION] == true
        pendingGeoCallback?.let { (origin, cb) ->
            cb.invoke(origin, granted, false)
            pendingGeoCallback = null
        }
        if (pendingShareStart) {
            pendingShareStart = false
            if (granted) startShareService()
            else sendFixError("denied", 1)
        }
    }

    private val notifPermission = registerForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { /* the share notification is a courtesy; sharing works without it */ }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        applyTorPref()

        webView = WebView(this)
        setContentView(webView)

        assetLoader = WebViewAssetLoader.Builder()
            .addPathHandler("/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()

        with(webView.settings) {
            javaScriptEnabled = true
            domStorageEnabled = true
            setGeolocationEnabled(true)
            allowFileAccess = false
            allowContentAccess = false
            setSupportMultipleWindows(false)
        }
        // Keep the renderer running while the share service holds us alive in
        // the background; otherwise JS timers stop with the screen.
        webView.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false)

        bridge = StarlingBridge(this)
        webView.addJavascriptInterface(bridge, "StarlingNative")

        webView.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(
                view: WebView,
                request: WebResourceRequest,
            ): WebResourceResponse? = assetLoader.shouldInterceptRequest(request.url)

            // The WebView only ever navigates inside the bundled app. Real
            // starlingmap.app links (someone taps an invite inside the app)
            // stay internal too; everything else goes to the system.
            override fun shouldOverrideUrlLoading(
                view: WebView,
                request: WebResourceRequest,
            ): Boolean {
                val url = request.url
                if (url.host == ASSET_HOST) return false
                if (url.host == APP_HOST && url.scheme == "https") {
                    loadAppUrl(url.fragment)
                    return true
                }
                runCatching { startActivity(Intent(Intent.ACTION_VIEW, url)) }
                return true
            }
        }

        webView.webChromeClient = object : WebChromeClient() {
            override fun onGeolocationPermissionsShowPrompt(
                origin: String,
                callback: GeolocationPermissions.Callback,
            ) {
                if (origin != "https://$ASSET_HOST") {
                    callback.invoke(origin, false, false)
                    return
                }
                if (hasLocationPermission()) {
                    callback.invoke(origin, true, false)
                } else {
                    pendingGeoCallback = origin to callback
                    requestLocationPermission()
                }
            }
        }

        LocationService.sink = { json -> deliverFix(json) }

        loadAppUrl(intent?.takeIf { it.data?.host == APP_HOST }?.data?.fragment)
    }

    // Someone who turns Tor mode on and only then starts Orbot would other-
    // wise never hear the port, since a status broadcast is only trusted in
    // the window after we ask. Coming back to the app asks again.
    override fun onResume() {
        super.onResume()
        if (torEnabled()) OrbotStatus.ask(this)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        val fragment = intent.data?.takeIf { it.host == APP_HOST }?.fragment ?: return
        // The page is live: hand the invite over as a hash change, which the
        // app treats exactly like a fresh boot with a fragment.
        val quoted = JSONObject.quote("#$fragment")
        webView.evaluateJavascript("location.hash = $quoted", null)
    }

    private fun loadAppUrl(fragment: String?) {
        val url = if (fragment.isNullOrEmpty()) START_URL else "$START_URL#$fragment"
        webView.loadUrl(url)
    }

    override fun onDestroy() {
        LocationService.sink = null
        LocationService.stop(this)
        OrbotStatus.stop(this)
        super.onDestroy()
    }

    // ------------------------------------------------------------- location

    fun hasLocationPermission(): Boolean =
        ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) ==
            PackageManager.PERMISSION_GRANTED ||
            ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_COARSE_LOCATION) ==
            PackageManager.PERMISSION_GRANTED

    private fun requestLocationPermission() {
        locationPermission.launch(
            arrayOf(
                Manifest.permission.ACCESS_FINE_LOCATION,
                Manifest.permission.ACCESS_COARSE_LOCATION,
            ),
        )
    }

    // Called from the bridge when the page turns sharing on. Must run while
    // the app is foreground: a location foreground service cannot start from
    // the background without the background location permission we refuse to
    // ask for.
    fun startShareFlow() {
        if (hasLocationPermission()) {
            startShareService()
        } else {
            pendingShareStart = true
            requestLocationPermission()
        }
    }

    private fun startShareService() {
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) !=
            PackageManager.PERMISSION_GRANTED
        ) {
            notifPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
        try {
            LocationService.start(this)
        } catch (e: SecurityException) {
            sendFixError("location service refused: ${e.message}", 2)
        } catch (e: IllegalStateException) {
            sendFixError("location service refused: ${e.message}", 2)
        }
    }

    fun stopShareFlow() = LocationService.stop(this)

    private fun deliverFix(json: String) {
        runOnUiThread {
            val quoted = JSONObject.quote(json)
            webView.evaluateJavascript(
                "globalThis.__starlingFix && __starlingFix($quoted)",
                null,
            )
        }
    }

    private fun sendFixError(message: String, code: Int) {
        deliverFix(JSONObject().put("error", message).put("code", code).toString())
    }

    // ------------------------------------------------------------------ tor

    fun torSupported(): Boolean = WebViewFeature.isFeatureSupported(WebViewFeature.PROXY_OVERRIDE)

    fun torEnabled(): Boolean =
        getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean(PREF_TOR, false)

    fun setTorEnabled(on: Boolean) {
        getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putBoolean(PREF_TOR, on).apply()
        applyTorPref()
    }

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
    private fun applyTorPref() {
        if (!torSupported()) return
        val controller = ProxyController.getInstance()
        val reload = Runnable { if (::webView.isInitialized) webView.reload() }
        val executor = ContextCompat.getMainExecutor(this)
        if (torEnabled()) {
            OrbotStatus.start(this) { applyTorPref() }
            val config = ProxyConfig.Builder()
                .addProxyRule("socks5://127.0.0.1:${OrbotStatus.socksPort}")
                .build()
            controller.setProxyOverride(config, executor, reload)
        } else {
            OrbotStatus.stop(this)
            controller.clearProxyOverride(executor, reload)
        }
    }
}
