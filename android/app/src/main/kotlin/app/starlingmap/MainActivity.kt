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
        private const val PREFS = "starling"
        private const val PREF_TOR = "tor"
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
    // if Orbot is not listening, requests fail instead of leaking.
    private fun applyTorPref() {
        if (!torSupported()) return
        val controller = ProxyController.getInstance()
        if (torEnabled()) {
            val config = ProxyConfig.Builder()
                .addProxyRule("socks://127.0.0.1:9050")
                .build()
            controller.setProxyOverride(config, { }, { })
        } else {
            controller.clearProxyOverride({ }, { })
        }
    }
}
