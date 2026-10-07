package app.starlingmap

import android.annotation.SuppressLint
import android.app.Presentation
import android.content.Context
import android.content.Intent
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.view.ContextThemeWrapper
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.GeolocationPermissions
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.webkit.WebViewAssetLoader
import org.json.JSONObject

// The page, owned by the process instead of by the activity.
//
// Everything that seals a position and posts it lives in the page, so the
// share used to die the moment Android tore the activity down: swipe the app
// out of recents and the keys went with the WebView. With "keep sharing when
// the app is closed" on, the WebView is built on the application context and
// held here, the activity borrows it for as long as it exists, and a task
// removal takes the window without taking the page.
//
// It is released the moment it stops earning its keep: the share ends, or the
// switch is off and the activity is gone. A page held past that is a set of
// live keys in the memory of an app the person believes they closed.
//
// Chromium freezes a page hidden for a minute or five, and a frozen page takes
// fixes but never posts them. Only visibility thaws it; see nudge().
object PageHost {

    private var webView: WebView? = null
    private var bridge: StarlingBridge? = null
    private var loader: WebViewAssetLoader? = null
    private var appCtx: Context? = null
    private val main = Handler(Looper.getMainLooper())
    private var release: Runnable? = null

    private const val PULSE_WAIT_MS = 10000L
    private const val NUDGE_MS = 1000L
    private const val NUDGE_GAP_MS = 5000L
    // Silence, nudges and all, after which the share is ended out loud.
    private const val STALL_MS = 180000L
    private const val STALL_NUDGES = 3

    // The proxy config last handed to ProxyController in this process, or null
    // before the first. Applying one reloads the page, so an unchanged config
    // is never applied twice: reopening the app would otherwise reload the
    // page that has been carrying a share, and the share with it.
    var proxyApplied: String? = null

    // The activity currently borrowing the page, or null while it is running
    // headless behind the share service.
    var activity: MainActivity? = null
        private set

    // Started activity. document.visibilityState lies for the second a nudge lasts.
    @Volatile
    var windowShown = false
        private set

    val alive: Boolean get() = webView != null

    val barsLight: Boolean? get() = bridge?.barsLight

    // Sharing report counts since the app started.
    @Volatile var nudges = 0
        private set
    @Volatile var freezes = 0
        private set
    @Volatile var holderFailed = false
        private set
    val holding: Boolean get() = holderWindow != null

    @Volatile
    private var pulseAt = 0L
    val lastPulseAt: Long get() = pulseAt
    // Oldest unanswered push. Timing from the latest one starved the watchdog while driving.
    private var waitingSince = 0L
    private var quietSince = 0L
    private var quietNudges = 0
    private var checkQueued = false
    private var nudging = false
    private var lastNudgeAt = 0L
    private val check = Runnable {
        checkQueued = false
        checkPage()
    }

    private var holderDisplay: VirtualDisplay? = null
    private var holderWindow: Presentation? = null

    // Built once per process, on the application context so no activity can be
    // held past its death. Callers pass the activity they want it attached to.
    fun attach(host: MainActivity): WebView {
        release?.let { main.removeCallbacks(it) }
        release = null
        activity = host
        windowShown = false
        val app = host.applicationContext
        appCtx = app
        val existing = webView
        if (existing != null) {
            (existing.parent as? ViewGroup)?.removeView(existing)
            releaseHolder()
            bridge?.activity = host
            return existing
        }
        return build(app)
    }

    // Proxy before the WebView. With Tor on the page loads only from the proxy's listener; off, at once.
    fun bootHeadless(app: Context): Boolean {
        if (webView != null) return false
        release?.let { main.removeCallbacks(it) }
        release = null
        if (!SystemCheck.webViewOk(app)) return false
        val tor = TorProxy.enabled(app)
        if (tor && !TorProxy.supported()) return false
        activity = null
        windowShown = false
        appCtx = app
        val pending = TorProxy.apply(app, Runnable { if (tor) load(null) })
        build(app)
        hold()
        if (!tor || !pending) load(null)
        return true
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun build(app: Context): WebView {
        // Debuggable builds only, which release APKs are not: this is how the
        // e2e checks drive the real page inside the real WebView.
        if ((app.applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0) {
            WebView.setWebContentsDebuggingEnabled(true)
        }

        // WebView reads isLightTheme for prefers-color-scheme, and a bare app context's theme is always light.
        val view = WebView(ContextThemeWrapper(app, R.style.Theme_Starling))
        webView = view
        loader = WebViewAssetLoader.Builder()
            .addPathHandler("/", WebViewAssetLoader.AssetsPathHandler(app))
            .build()

        with(view.settings) {
            javaScriptEnabled = true
            domStorageEnabled = true
            // The system font-size setting reaches WebView content only
            // through textZoom, and it scales px-sized text too.
            textZoom = (app.resources.configuration.fontScale * 100).toInt()
            setGeolocationEnabled(true)
            allowFileAccess = false
            allowContentAccess = false
            setSupportMultipleWindows(false)
            // Belt and suspenders on top of allowFileAccess = false: these
            // default to false already at this targetSdk, but a page that can
            // never reach file:// has no business asking for cross-origin
            // reads from one either, and explicit here means a future
            // targetSdk bump cannot quietly change the default under us.
            allowFileAccessFromFileURLs = false
            allowUniversalAccessFromFileURLs = false
            // Each URL checked is a lookup Google could see; see the manifest.
            safeBrowsingEnabled = false
        }
        // Not waived when the page is off screen: the whole point of holding it
        // is that it keeps sealing and posting positions with no window.
        view.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false)

        val b = StarlingBridge(app)
        b.activity = activity
        bridge = b
        view.addJavascriptInterface(b, "StarlingNative")

        view.webViewClient = object : WebViewClient() {
            // Without this override, WebView takes the whole app down when its
            // renderer dies, and the low-memory killer will take a renderer
            // with no window before it takes much else. A share was ending as a
            // silent process death, with no record and no notification. Now
            // the app survives it: the dead page is dropped, the share ends
            // the way any other outside stop does, and an open window gets a
            // fresh page, which puts the share back on.
            override fun onRenderProcessGone(
                view: WebView,
                detail: android.webkit.RenderProcessGoneDetail,
            ): Boolean {
                if (view !== webView) return true
                val ui = activity
                val sharing = LocationService.running
                destroy()
                if (sharing) LocationService.endShare(app, "renderer")
                // Behind a stopped activity the fresh page's share start waits for the window.
                ui?.recreate()
                return true
            }

            override fun shouldInterceptRequest(
                view: WebView,
                request: WebResourceRequest,
            ): WebResourceResponse? = loader?.shouldInterceptRequest(request.url)

            // The WebView only ever navigates inside the bundled app. A
            // starlingmap.app link CARRYING A FRAGMENT is a deep link (an
            // invite, a help beacon) and stays internal; a bare site link is
            // a trip to the website, which is a different thing from the app
            // and belongs in the system browser. Everything else goes to the
            // system too.
            override fun shouldOverrideUrlLoading(
                view: WebView,
                request: WebResourceRequest,
            ): Boolean {
                val url = request.url
                if (url.host == MainActivity.ASSET_HOST) return false
                if (url.host == MainActivity.APP_HOST && url.scheme == "https" && !url.fragment.isNullOrEmpty()) {
                    load(url.fragment)
                    return true
                }
                // No window means no browser trip: a headless page has nobody
                // in front of it to have tapped a link.
                val ui = activity ?: return true
                runCatching { ui.startActivity(Intent(Intent.ACTION_VIEW, url)) }
                return true
            }
        }

        view.webChromeClient = object : WebChromeClient() {
            override fun onGeolocationPermissionsShowPrompt(
                origin: String,
                callback: GeolocationPermissions.Callback,
            ) {
                if (!AssetOrigin.isOurs(origin)) {
                    callback.invoke(origin, false, false)
                    return
                }
                val ui = activity
                if (ui == null) {
                    callback.invoke(origin, false, false)
                    return
                }
                if (ui.hasLocationPermission()) callback.invoke(origin, true, false)
                else ui.askGeolocation(origin, callback)
            }

            // The page's camera, for the safety number scan. Video capture
            // only, and only for the bundled page. The WebView never
            // navigates off the asset origin, but the check costs nothing
            // and a mistake elsewhere must not turn into a camera grant.
            override fun onPermissionRequest(request: PermissionRequest) {
                val ui = activity
                if (!AssetOrigin.cameraAllowed(request.origin.toString(), request.resources) || ui == null) {
                    request.deny()
                    return
                }
                ui.askCamera(request)
            }
        }

        LocationService.sink = { json -> deliverFix(json) }
        return view
    }

    fun setShown(host: MainActivity, shown: Boolean) {
        if (activity !== host) return
        windowShown = shown
        if (shown) {
            waitingSince = 0L
            quietSince = 0L
            quietNudges = 0
            // Mid-nudge the page already reads visible, so coming back would fire no
            // visibilitychange and its on-return work would never run. Hide it, then
            // hand it the window's real state; a window not back yet sends VISIBLE later.
            if (nudging) {
                nudging = false
                webView?.let { v ->
                    v.dispatchWindowVisibilityChanged(View.GONE)
                    v.dispatchWindowVisibilityChanged(v.windowVisibility)
                }
            }
        }
    }

    // The activity is going away. The page stays only while it is holding a
    // share up on its own; otherwise it goes with the window.
    fun detachFrom(host: MainActivity, keepAlive: Boolean) {
        if (activity !== host) return
        activity = null
        windowShown = false
        bridge?.activity = null
        (webView?.parent as? ViewGroup)?.removeView(webView)
        if (!keepAlive) destroy()
        // A configuration change hands the page straight to the next activity.
        else if (!host.isChangingConfigurations) hold()
    }

    // A WebView with no window can never be made visible, so a kept page gets one:
    // a presentation on a private virtual display, root GONE, never drawn.
    private fun hold() {
        val v = webView ?: return
        val app = appCtx ?: return
        if (holderWindow != null) return
        var vd: VirtualDisplay? = null
        try {
            val dm = app.getSystemService(DisplayManager::class.java)
            // A page booted with no window was never laid out, so it gets the phone's size.
            val metrics = app.resources.displayMetrics
            vd = dm.createVirtualDisplay(
                "starling-page",
                if (v.width > 0) v.width else metrics.widthPixels.coerceAtLeast(1),
                if (v.height > 0) v.height else metrics.heightPixels.coerceAtLeast(1),
                metrics.densityDpi,
                null,
                0,
            )
            val p = Presentation(app, vd.display)
            p.window?.apply {
                addFlags(
                    WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
                        WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE,
                )
                decorView.visibility = View.GONE
            }
            p.setContentView(v)
            p.show()
            holderDisplay = vd
            holderWindow = p
            holderFailed = false
        } catch (e: Exception) {
            // No window then; the watchdog ends the share out loud if it freezes.
            (v.parent as? ViewGroup)?.removeView(v)
            runCatching { vd?.release() }
            holderFailed = true
        }
        v.dispatchWindowVisibilityChanged(View.GONE)
    }

    private fun releaseHolder() {
        val p = holderWindow
        val d = holderDisplay
        holderWindow = null
        holderDisplay = null
        if (p != null) runCatching { p.dismiss() }
        if (d != null) runCatching { d.release() }
    }

    fun load(fragment: String?) {
        val url = if (fragment.isNullOrEmpty()) MainActivity.START_URL else "${MainActivity.START_URL}#$fragment"
        webView?.loadUrl(url)
    }

    fun reload() {
        val v = webView ?: return
        main.post { if (webView === v) v.reload() }
    }

    // Script is only ever a literal here plus JSONObject.quote of the data;
    // nothing interpolates a value into code.
    //
    // Through the main handler, never View.post: a view with no window queues
    // its posts until it is attached again, so every fix pushed at a headless
    // page sat there unrun until somebody reopened the app.
    fun eval(script: String) {
        val v = webView ?: return
        main.post { if (webView === v) v.evaluateJavascript(script, null) }
    }

    fun deliverFix(json: String) {
        eval("globalThis.__starlingFix && __starlingFix(${JSONObject.quote(json)})")
        main.post {
            expectPulse()
            // A post cannot run in a frozen page: wake it now rather than after the watchdog's wait.
            if (ThawPolicy.onWork(frozenNow)) nudge()
        }
    }

    fun notice(message: String) = eval("globalThis.__starlingNotice && __starlingNotice(${JSONObject.quote(message)})")

    fun hashChange(fragment: String) = eval("location.hash = ${JSONObject.quote("#$fragment")}")

    fun schemeChanged() = eval("globalThis.__starlingScheme && __starlingScheme()")

    fun cameraReply(token: String, granted: Boolean) =
        eval("globalThis.__starlingCamera && __starlingCamera(${JSONObject.quote(token)}, $granted)")

    fun backgroundReply(token: String, granted: Boolean) =
        eval("globalThis.__starlingBackground && __starlingBackground(${JSONObject.quote(token)}, $granted)")

    fun bioReply(token: String, payload: String?) {
        val p = if (payload == null) "null" else JSONObject.quote(payload)
        eval("globalThis.__starlingBio && __starlingBio(${JSONObject.quote(token)}, $p)")
    }

    // ------------------------------------------------------ keeping it awake

    // Sent from a page task, so it proves the event loop runs. Bridge thread.
    fun pulse() {
        pulseAt = SystemClock.elapsedRealtime()
    }

    // The page's freeze event. Bridge thread.
    fun frozen() {
        main.post {
            if (!LocationService.running) return@post
            freezes++
            frozenNow = true
            val workWaiting = waitingSince != 0L && pulseAt < waitingSince
            val wait = ThawPolicy.afterFreeze(LocationService.stillNow, workWaiting)
            if (wait == ThawPolicy.NOW) {
                nudge()
            } else {
                // Nothing for the page to do until the next fix: let it sleep, and wake it
                // later only to listen to the circle.
                main.removeCallbacks(listenNudge)
                main.postDelayed(listenNudge, wait)
            }
        }
    }

    // Main thread only. True from the page's freeze event until the next thaw.
    private var frozenNow = false

    private val listenNudge = Runnable { if (LocationService.running) nudge() }

    private fun expectPulse() {
        if (!LocationService.running) return
        if (waitingSince == 0L || pulseAt >= waitingSince) waitingSince = SystemClock.elapsedRealtime()
        queueCheck()
    }

    private fun queueCheck() {
        if (checkQueued) return
        checkQueued = true
        main.postDelayed(check, PULSE_WAIT_MS)
    }

    fun checkPage() {
        if (webView == null || !LocationService.running) {
            waitingSince = 0L
            quietSince = 0L
            quietNudges = 0
            // A share with no page left to post it would otherwise hold GPS until force stop.
            if (webView == null && LocationService.live) appCtx?.let { LocationService.endShare(it, "stalled") }
            return
        }
        if (waitingSince == 0L || pulseAt >= waitingSince) {
            waitingSince = 0L
            quietSince = 0L
            quietNudges = 0
            return
        }
        val now = SystemClock.elapsedRealtime()
        if (now - waitingSince < PULSE_WAIT_MS) {
            queueCheck()
            return
        }
        // A page on screen is never frozen, and a busy one is no reason to end a share.
        if (windowShown) return
        if (quietSince == 0L) quietSince = waitingSince
        val canNudge = webView?.isAttachedToWindow == true
        if (now - quietSince >= STALL_MS && (quietNudges >= STALL_NUDGES || !canNudge)) {
            stalled()
            return
        }
        if (nudge()) quietNudges++
        queueCheck()
    }

    // Visible for a second: Chromium thaws the page and restarts its freeze clock.
    // Nothing draws, the real window is still hidden. False with no window.
    private fun nudge(): Boolean {
        val v = webView ?: return false
        if (windowShown) return true
        if (!v.isAttachedToWindow) return false
        val now = SystemClock.elapsedRealtime()
        if (nudging || now - lastNudgeAt < NUDGE_GAP_MS) return true
        lastNudgeAt = now
        nudging = true
        nudges++
        frozenNow = false
        main.removeCallbacks(listenNudge)
        v.dispatchWindowVisibilityChanged(View.VISIBLE)
        main.postDelayed({
            nudging = false
            if (webView === v && !windowShown) v.dispatchWindowVisibilityChanged(View.GONE)
        }, NUDGE_MS)
        return true
    }

    private fun stalled() {
        waitingSince = 0L
        quietSince = 0L
        quietNudges = 0
        val app = appCtx ?: return
        // The synchronous part of the page's stop runs even in a frozen page.
        LocationService.sink?.invoke(JSONObject().put("stopped", true).put("route", "stalled").toString())
        LocationService.endShare(app, "stalled")
    }

    // Used by the activity for the Orbot-silence timer, which has to be
    // cancellable across an activity teardown.
    fun post(r: Runnable, delayMs: Long) {
        main.postDelayed(r, delayMs)
    }

    fun cancel(r: Runnable) {
        main.removeCallbacks(r)
    }

    // The share ended while nothing was on screen. Not immediate: the page's
    // own stop path still has a departure to get onto the relay, and killing
    // the WebView mid-flight would leave a live dot pointing at nobody.
    fun releaseSoon(delayMs: Long = 8000) {
        // A frozen page cannot get its departure out, window or not.
        nudge()
        if (webView == null || activity != null) return
        release?.let { main.removeCallbacks(it) }
        val r = Runnable { if (activity == null) destroy() }
        release = r
        main.postDelayed(r, delayMs)
    }

    fun destroy() {
        release?.let { main.removeCallbacks(it) }
        release = null
        main.removeCallbacks(check)
        main.removeCallbacks(listenNudge)
        checkQueued = false
        LocationService.sink = null
        val v = webView ?: return
        webView = null
        bridge = null
        loader = null
        activity = null
        windowShown = false
        (v.parent as? ViewGroup)?.removeView(v)
        releaseHolder()
        v.destroy()
    }

    // Does the page have a reason to outlive the window? Only a running share
    // with the switch on.
    fun shouldKeepAlive(ctx: Context): Boolean =
        LocationService.running && keepSharing(ctx)

    fun keepSharing(ctx: Context): Boolean =
        ctx.getSharedPreferences(MainActivity.PREFS, Context.MODE_PRIVATE)
            .getBoolean(MainActivity.PREF_KEEP_SHARING, false)

    fun setKeepSharing(ctx: Context, on: Boolean) {
        ctx.getSharedPreferences(MainActivity.PREFS, Context.MODE_PRIVATE).edit()
            .putBoolean(MainActivity.PREF_KEEP_SHARING, on)
            .apply()
        // The resume switches only make sense with this one on.
        if (!on) ShareResume.autoOff(ctx)
    }
}
