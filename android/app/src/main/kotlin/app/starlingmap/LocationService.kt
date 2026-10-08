package app.starlingmap

import android.app.AlarmManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ServiceInfo
import android.hardware.Sensor
import android.hardware.SensorManager
import android.hardware.TriggerEvent
import android.hardware.TriggerEventListener
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.location.LocationRequest
import android.os.Build
import android.os.Bundle
import android.os.CancellationSignal
import android.os.Handler
import android.os.Looper
import android.os.IBinder
import android.os.PowerManager
import android.os.SystemClock
import android.provider.Settings
import androidx.core.app.ServiceCompat
import android.Manifest
import android.content.pm.PackageManager
import androidx.core.content.ContextCompat
import org.json.JSONObject

// Keeps location flowing while the screen is off or the app is backgrounded.
// Runs only between an explicit start from the page (user turned sharing on,
// app in the foreground, permission already granted) and the matching stop.
// The one start without a window is ShareResume's, behind a switch the person turned on.
//
// Swiping the task away ends the share, unless the person turned on "keep
// sharing when the app is closed". With that on, PageHost holds the page past
// the window, so there is still something alive to seal each position, and
// this service stays up and keeps feeding it.
class LocationService : Service(), LocationListener {

    companion object {
        // Also read by the panic wipe, which deletes the channel.
        const val CHANNEL = "share"
        private const val NOTIF_ID = 1
        internal const val ACTION_STOP = "app.starlingmap.STOP_SHARE"
        private const val ACTION_TICK = "app.starlingmap.SHARE_TICK"
        private const val ACTION_REPOST = "app.starlingmap.REPOST_SHARE_NOTIFICATION"
        private const val ACTION_RESUME = "app.starlingmap.RESUME_SHARE"
        private const val EXTRA_WHY = "why"
        // A phone lying still passes no distance filter, so without this the
        // page hears nothing and, with no window, its own send timer barely
        // runs: the share goes quiet and looks stopped to everyone watching.
        // This listener has no distance filter and wakes the page at least
        // once per send interval. 15 s is the floor; a circle can ask for a
        // slower heartbeat through setCadence, never a faster one.
        private const val HEARTBEAT_MS = 15000L
        private const val HEARTBEAT_MAX_MS = 300000L

        // How long one motion probe may wait for a fix.
        private const val PROBE_MS = 60000L

        // The active circle's cadence. The page sends it before every start
        // and whenever the setting changes, so nothing here persists it.
        @Volatile
        private var heartbeatMs = HEARTBEAT_MS

        // The heartbeat needs a fix to fire, and indoors on GPS alone there is none.
        // How often the alarm checks follows the heartbeat; see LocationPlan.tickMs.

        // The page's say: the switch is on, no SOS, no steady sending.
        @Volatile
        var stillWanted = false
            private set

        // Ceiling only: the page lets go as soon as its post settles.
        private const val FIX_WAKE_MS = 30000L

        // The activity plants a sink to push fixes into the page. Static is
        // fine: one process, one WebView.
        @Volatile
        var sink: ((String) -> Unit)? = null

        // Read by PageHost to decide whether a page with no window still has a
        // job. Set here rather than inferred from the notification, because the
        // question gets asked during teardown.
        @Volatile
        var running = false

        // Set by every stop this app asks for, so an unmarked stop is Android's.
        // Only the service clears it: start() clearing it misread a quick off and on.
        @Volatile
        private var stopAsked = false

        // A share still running that nobody has asked to stop.
        val live: Boolean get() = running && !stopAsked

        // "boot" or "update" until somebody opens the app.
        @Volatile
        var resumedWhy: String? = null

        @Volatile
        var waitingForTor = false

        // Your own server waits until the page says the share is really back.
        @Volatile
        var resumePending = false

        fun clearResume() {
            resumedWhy = null
            waitingForTor = false
            resumePending = false
        }

        // Sharing report counts. Never a position.
        @Volatile var startedAt = 0L
            private set
        @Volatile var lastFixAt = 0L
            private set
        @Volatile var fixes = 0
            private set
        @Volatile var gpsFixes = 0
            private set
        @Volatile var networkFixes = 0
            private set
        @Volatile var fusedFixes = 0
            private set
        @Volatile var ticks = 0
            private set
        @Volatile var rewatches = 0
            private set
        @Volatile var locationOff = false
            private set
        @Volatile var stillNow = false
            private set
        @Volatile var stillSpells = 0
            private set
        @Volatile var motionTriggers = 0
            private set
        @Volatile var probes = 0
            private set
        @Volatile var probeFixes = 0
            private set
        @Volatile var stillExits = 0
            private set
        @Volatile private var stillSince = 0L
        @Volatile private var stillDone = 0L

        fun stillMs(now: Long = SystemClock.elapsedRealtime()): Long =
            stillDone + if (stillSince > 0L) now - stillSince else 0L

        // A one-shot wake-up sensor: without one, still mode could not notice the phone moving.
        fun stillSupported(ctx: Context): Boolean = motionSensor(ctx) != null

        private fun motionSensor(ctx: Context): Sensor? =
            (ctx.getSystemService(SENSOR_SERVICE) as? SensorManager)?.getDefaultSensor(Sensor.TYPE_SIGNIFICANT_MOTION)

        private var wake: PowerManager.WakeLock? = null

        @Volatile
        private var instance: LocationService? = null

        // Only while a share runs: after it the notification must stay gone.
        fun refreshNotification() {
            val s = instance ?: return
            if (!running) return
            runCatching {
                (s.getSystemService(NOTIFICATION_SERVICE) as NotificationManager).notify(NOTIF_ID, s.buildNotification())
            }
        }

        fun start(ctx: Context) {
            ContextCompat.startForegroundService(ctx, Intent(ctx, LocationService::class.java))
        }

        // Off unless the person turns it on: a locked phone shows the clock too.
        fun clockShown(ctx: Context): Boolean =
            ctx.getSharedPreferences(MainActivity.PREFS, MODE_PRIVATE).getBoolean(MainActivity.PREF_SHARE_CLOCK, false)

        fun showClock(ctx: Context, on: Boolean) {
            ctx.getSharedPreferences(MainActivity.PREFS, MODE_PRIVATE).edit()
                .putBoolean(MainActivity.PREF_SHARE_CLOCK, on)
                .apply()
            refreshNotification()
        }

        fun startResumed(ctx: Context, why: String) {
            ContextCompat.startForegroundService(
                ctx,
                Intent(ctx, LocationService::class.java).setAction(ACTION_RESUME).putExtra(EXTRA_WHY, why),
            )
        }

        fun stop(ctx: Context) {
            stopAsked = true
            ctx.stopService(Intent(ctx, LocationService::class.java))
        }

        // Ends a share for a reason the person did not choose, leaving the same
        // trace a swipe or the notification's Stop leaves.
        fun endShare(ctx: Context, route: String, notify: Boolean = true) {
            recordEnded(ctx, route, notify)
            stop(ctx)
        }

        fun setCadence(seconds: Int) {
            val next = (seconds * 1000L).coerceIn(HEARTBEAT_MS, HEARTBEAT_MAX_MS)
            if (next == heartbeatMs) return
            heartbeatMs = next
            instance?.let { s -> ContextCompat.getMainExecutor(s).execute { s.rearmHeartbeat() } }
        }

        fun setStillMode(on: Boolean) {
            if (on == stillWanted) return
            stillWanted = on
            instance?.let { s -> ContextCompat.getMainExecutor(s).execute { s.stillWantedChanged() } }
        }

        // Not reference counted: each fix pushes the deadline out, one release ends it.
        // Never with no page: nothing would be left to post, or to let go.
        fun holdAwake(ctx: Context, ms: Long = FIX_WAKE_MS) {
            if (!running || sink == null) return
            synchronized(this) {
                val w = wake ?: (ctx.applicationContext.getSystemService(POWER_SERVICE) as PowerManager)
                    .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "starling:share")
                    .apply { setReferenceCounted(false) }
                    .also { wake = it }
                w.acquire(ms)
            }
        }

        fun letSleep() {
            synchronized(this) {
                wake?.takeIf { it.isHeld }?.release()
            }
        }

        // The record goes down BEFORE the notification: that notification can
        // be swiped away with no unlock at all below Android 12, so it is the
        // record, not the notification, that has to survive. It lives in the
        // same private prefs file the whole app data directory does, so a panic
        // wipe's clearApplicationUserData takes it with everything else.
        private fun recordEnded(ctx: Context, route: String, notify: Boolean = true) {
            ctx.getSharedPreferences(MainActivity.PREFS, MODE_PRIVATE).edit()
                .putString(MainActivity.PREF_STOP_ROUTE, route)
                .putLong(MainActivity.PREF_STOP_TS, System.currentTimeMillis())
                .apply()
            if (!notify) return
            // Only a swipe closed the app. The card inside says what the other routes were.
            val text = if (route == "swipe") R.string.notif_swiped_text else R.string.notif_locked_text
            Events.post(
                ctx,
                ctx.getString(R.string.notif_swiped_title),
                ctx.getString(text),
                "share-ended",
            )
        }
    }

    private var watching = false
    private var providers: List<String> = emptyList()
    private var fusedOn = false
    private var platformProviders: List<String> = emptyList()
    private var tickArmed = false
    private var watchedAt = 0L

    @Volatile
    private var countingDown = false

    private val still = StillClock()
    private var motionArmed = false

    private var probeActive = false
    private var probeGen = 0
    private var probeSignal: CancellationSignal? = null
    private val probeHandler by lazy { Handler(Looper.getMainLooper()) }
    private val probeTimeout = Runnable { endProbe() }

    // Same spelled-out form as the heartbeat; requestSingleUpdate calls all of these on API 28 and 29.
    private val probeListener = object : LocationListener {
        override fun onLocationChanged(location: Location) = probeDone(probeGen, location)

        @Deprecated("Deprecated in Java")
        override fun onStatusChanged(provider: String?, status: Int, extras: Bundle?) {
        }

        override fun onProviderEnabled(provider: String) {
        }

        override fun onProviderDisabled(provider: String) {
        }
    }

    private val motion = object : TriggerEventListener() {
        override fun onTrigger(event: TriggerEvent?) {
            motionArmed = false
            onMotion()
        }
    }

    // Spelled out rather than a lambda: on API 29 the other callbacks are not
    // default methods yet, and the platform calls them.
    private val heartbeat = object : LocationListener {
        override fun onLocationChanged(location: Location) = this@LocationService.onLocationChanged(location)

        @Deprecated("Deprecated in Java")
        override fun onStatusChanged(provider: String?, status: Int, extras: Bundle?) {
        }

        override fun onProviderEnabled(provider: String) = providersChanged()

        override fun onProviderDisabled(provider: String) = providersChanged()
    }

    private val tickIntent by lazy {
        PendingIntent.getBroadcast(
            this,
            3,
            Intent(ACTION_TICK).setPackage(packageName),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
    }

    private val tickReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) = onTick()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            // A user action, not a failure: the page turns sharing off cleanly.
            stopAsked = true
            // Here as well as in the page, which may be frozen or gone.
            ShareResume.disarm(this)
            sink?.invoke(JSONObject().put("stopped", true).toString())
            postShareEnded("notif")
            stopSelf()
            return START_NOT_STICKY
        }
        if (intent?.action == ACTION_REPOST) {
            // Android 14 and up let a person swipe the notification away while the share runs on.
            if (live) {
                runCatching {
                    (getSystemService(NOTIFICATION_SERVICE) as NotificationManager).notify(NOTIF_ID, buildNotification())
                }
            } else if (!running) {
                // Started fresh by a swipe that raced the end of the share: leave no trace.
                stopAsked = true
                stopSelf(startId)
            }
            return START_NOT_STICKY
        }
        val resume = intent?.action == ACTION_RESUME
        if (resume) {
            if (running) return START_NOT_STICKY
            resumedWhy = if (intent?.getStringExtra(EXTRA_WHY) == "update") "update" else "boot"
            waitingForTor = TorProxy.enabled(this)
            resumePending = true
        }
        if (!running) {
            stopAsked = false
            Forward.shareStarted()
            startedAt = SystemClock.elapsedRealtime()
            lastFixAt = 0L
            fixes = 0
            gpsFixes = 0
            networkFixes = 0
            fusedFixes = 0
            ticks = 0
            rewatches = 0
            stillNow = false
            stillSpells = 0
            motionTriggers = 0
            probes = 0
            probeFixes = 0
            stillExits = 0
            stillSince = 0L
            stillDone = 0L
        }
        running = true
        instance = this
        // startForeground itself throws if location permission vanished between
        // the activity's check and this callback; that stack is the framework's,
        // not the activity's try/catch, so it must be handled here.
        try {
            ServiceCompat.startForeground(this, NOTIF_ID, buildNotification(), ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION)
        } catch (e: Exception) {
            stopAsked = true
            sink?.invoke(JSONObject().put("error", "location service refused: ${e.message}").put("code", 2).toString())
            if (resume) ShareResume.startFailed(this)
            stopSelf()
            return START_NOT_STICKY
        }
        startWatching()
        // A page that started over asks again and has to hear where things stand.
        if (still.on) sink?.invoke(JSONObject().put("still", true).toString())
        if (resume) {
            if (live) ShareResume.serviceUp(this) else ShareResume.startFailed(this)
        }
        return START_NOT_STICKY
    }

    private fun startWatching() {
        if (watching) return
        val lm = getSystemService(LOCATION_SERVICE) as LocationManager
        // The network provider resolves position by shipping nearby wifi and
        // cell identifiers to an off-device lookup service. With Tor mode on,
        // the user has asked for exactly not that, so fixes come from GPS
        // alone even when that means slower or no indoor lock.
        val torOn = getSharedPreferences(MainActivity.PREFS, MODE_PRIVATE)
            .getBoolean(MainActivity.PREF_TOR, false)
        val wanted =
            if (torOn) listOf(LocationManager.GPS_PROVIDER)
            else listOf(LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER)
        platformProviders = wanted.filter { lm.allProviders.contains(it) }
        // The fused provider batches and shares fixes with other apps, and costs far less
        // than GPS held on. It leans on network location, so never with Tor on. Absent
        // (a build with no fused implementation) or below Android 12, the platform
        // providers are the whole path, exactly as before.
        fusedOn = !torOn && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && lm.allProviders.contains(LocationPlan.FUSED)
        val got = request(lm)
        if (got.isEmpty()) {
            noProvider()
            return
        }
        providers = got
        watching = true
        ContextCompat.registerReceiver(
            this,
            tickReceiver,
            IntentFilter(ACTION_TICK),
            ContextCompat.RECEIVER_NOT_EXPORTED,
        )
        armTick()
        if (stillWanted) {
            still.restart(SystemClock.elapsedRealtime())
            armMotion()
        }
        // Location already off at the start is reported like a switch mid-share.
        providersChanged(force = true)
    }

    private fun request(lm: LocationManager): List<String> {
        val got = mutableListOf<String>()
        val cadence = if (still.on) LocationPlan.STILL_MS else heartbeatMs
        var reqs = LocationPlan.plan(cadence, still.on, platformProviders, fusedOn)
        try {
            for (r in reqs) register(lm, r)
            got += reqs.map { it.provider }
        } catch (e: SecurityException) {
            // permission revoked between the page's start call and here
        } catch (e: RuntimeException) {
            // A fused provider that is listed but refuses: fall back to the platform pair.
            if (!fusedOn) throw e
            fusedOn = false
            lm.removeUpdates(this)
            lm.removeUpdates(heartbeat)
            reqs = LocationPlan.plan(cadence, still.on, platformProviders, false)
            try {
                for (r in reqs) register(lm, r)
                got += reqs.map { it.provider }
            } catch (e2: SecurityException) {
                // as above
            }
        }
        watchedAt = SystemClock.elapsedRealtime()
        return got.distinct()
    }

    private fun register(lm: LocationManager, r: LocationPlan.Req) {
        // Lint wants the permission checked in the same method as the request; the
        // caller already treats a SecurityException as "revoked mid-share".
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED) {
            throw SecurityException("location permission not granted")
        }
        val listener = if (r.moving) this else heartbeat
        // The plan only names the fused provider on Android 12+, but lint needs the
        // version check next to the LocationRequest calls to accept them.
        if (r.provider == LocationPlan.FUSED && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            val quality = if (r.quality == LocationPlan.Quality.HIGH) {
                LocationRequest.QUALITY_HIGH_ACCURACY
            } else {
                LocationRequest.QUALITY_BALANCED_POWER_ACCURACY
            }
            val req = LocationRequest.Builder(r.intervalMs)
                .setQuality(quality)
                .setMinUpdateDistanceMeters(r.minDistanceM)
                .setMaxUpdateDelayMillis(maxOf(r.maxWaitMs, r.intervalMs))
                .build()
            lm.requestLocationUpdates(LocationPlan.FUSED, req, ContextCompat.getMainExecutor(this), listener)
        } else {
            lm.requestLocationUpdates(r.provider, r.intervalMs, r.minDistanceM, listener, mainLooper)
        }
    }

    private fun noProvider() {
        stopAsked = true
        sink?.invoke(JSONObject().put("error", "no location provider").put("code", 2).toString())
        stopSelf()
    }

    private fun rewatch() {
        val lm = getSystemService(LOCATION_SERVICE) as LocationManager
        lm.removeUpdates(this)
        lm.removeUpdates(heartbeat)
        rewatches++
        if (request(lm).isEmpty()) noProvider()
    }

    // The whole plan follows the cadence: a relaxed circle has no 3 second listener at all.
    private fun rearmHeartbeat() {
        if (!watching || still.on) return
        val lm = getSystemService(LOCATION_SERVICE) as LocationManager
        lm.removeUpdates(this)
        lm.removeUpdates(heartbeat)
        if (request(lm).isEmpty()) noProvider()
        armTick()
    }

    override fun onLocationChanged(location: Location) {
        // Android drops its own wake lock the moment this returns.
        holdAwake(this)
        lastFixAt = SystemClock.elapsedRealtime()
        fixes++
        when (location.provider) {
            LocationManager.GPS_PROVIDER -> gpsFixes++
            LocationManager.NETWORK_PROVIDER -> networkFixes++
            LocationPlan.FUSED -> fusedFixes++
        }
        val fix = JSONObject()
            .put("lat", location.latitude)
            .put("lon", location.longitude)
            .put("ts", location.time)
        if (location.hasAccuracy()) fix.put("acc", location.accuracy.toDouble())
        if (location.hasSpeed()) fix.put("spd", location.speed.toDouble())
        if (location.hasBearing()) fix.put("hdg", location.bearing.toDouble())
        val acc = if (location.hasAccuracy()) location.accuracy.toDouble() else null
        // Only with the motion sensor armed, so moving again is noticed; before the fix, so it goes on the right pace.
        if (still.fix(location.latitude, location.longitude, acc, lastFixAt, stillWanted && motionArmed)) stillChanged()
        sink?.invoke(fix.toString())
        if (!resumePending) Forward.maybeSend(this, location)
    }

    @Deprecated("Deprecated in Java")
    override fun onStatusChanged(provider: String?, status: Int, extras: Bundle?) {
    }

    // The requests pause and resume with the switch by themselves; this only says so.
    override fun onProviderEnabled(provider: String) = providersChanged()

    override fun onProviderDisabled(provider: String) = providersChanged()

    private fun providersChanged(force: Boolean = false) {
        if (!watching) return
        val lm = getSystemService(LOCATION_SERVICE) as LocationManager
        val on = providers.any { runCatching { lm.isProviderEnabled(it) }.getOrDefault(false) }
        if (!force && on == !locationOff) return
        locationOff = !on
        sink?.invoke(JSONObject().put("paused", if (locationOff) "location-off" else "").toString())
        val nm = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
        runCatching { nm.notify(NOTIF_ID, buildNotification()) }
    }

    private fun armTick() {
        val am = getSystemService(ALARM_SERVICE) as AlarmManager
        runCatching {
            am.setAndAllowWhileIdle(
                AlarmManager.ELAPSED_REALTIME_WAKEUP,
                SystemClock.elapsedRealtime() + tickMs(),
                tickIntent,
            )
            tickArmed = true
        }
    }

    private fun tickMs() = LocationPlan.tickMs(heartbeatMs, still.on, countingDown)

    private fun onTick() {
        if (!running || !watching) return
        // Only a tick with news takes the wake lock; never release one a post holds.
        val now = SystemClock.elapsedRealtime()
        if (now - lastFixAt >= tickMs()) {
            ticks++
            holdAwake(this)
            sink?.invoke(JSONObject().put("tick", true).toString())
        }
        val rewatchAfter = LocationPlan.rewatchMs(heartbeatMs, still.on)
        if (!locationOff && now - maxOf(lastFixAt, watchedAt) >= rewatchAfter) rewatch()
        // A frozen page misses its own timer, and the countdown would run on below zero.
        if (countingDown && System.currentTimeMillis() >= ShareResume.deadline(this)) refreshNotification()
        PageHost.checkPage()
        armTick()
    }

    private fun onMotion() {
        if (!watching) return
        motionTriggers++
        still.motion(SystemClock.elapsedRealtime())
        armMotion()
        if (still.on && still.probing) startProbe()
    }

    // One high accuracy fix through the normal fix path, so the clock decides if the phone really moved.
    private fun startProbe() {
        if (probeActive || !watching) return
        val provider = when {
            fusedOn -> LocationPlan.FUSED
            platformProviders.contains(LocationManager.GPS_PROVIDER) -> LocationManager.GPS_PROVIDER
            else -> platformProviders.firstOrNull()
        } ?: return
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED) return
        val lm = getSystemService(LOCATION_SERVICE) as LocationManager
        val gen = probeGen
        probeActive = true
        try {
            if (provider == LocationPlan.FUSED && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                val signal = CancellationSignal()
                probeSignal = signal
                val req = LocationRequest.Builder(0L)
                    .setQuality(LocationRequest.QUALITY_HIGH_ACCURACY)
                    .setDurationMillis(PROBE_MS)
                    .build()
                lm.getCurrentLocation(provider, req, signal, ContextCompat.getMainExecutor(this)) { loc -> probeDone(gen, loc) }
            } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                val signal = CancellationSignal()
                probeSignal = signal
                lm.getCurrentLocation(provider, signal, ContextCompat.getMainExecutor(this)) { loc -> probeDone(gen, loc) }
            } else {
                @Suppress("DEPRECATION")
                lm.requestSingleUpdate(provider, probeListener, mainLooper)
            }
        } catch (e: SecurityException) {
            endProbe()
            return
        } catch (e: RuntimeException) {
            endProbe()
            return
        }
        probes++
        probeHandler.postDelayed(probeTimeout, PROBE_MS)
    }

    private fun probeDone(gen: Int, location: Location?) {
        if (gen != probeGen || !probeActive) return
        endProbe()
        if (location == null) return
        probeFixes++
        onLocationChanged(location)
    }

    private fun endProbe() {
        probeGen++
        if (!probeActive) return
        probeActive = false
        probeHandler.removeCallbacks(probeTimeout)
        probeSignal?.cancel()
        probeSignal = null
        runCatching { (getSystemService(LOCATION_SERVICE) as LocationManager).removeUpdates(probeListener) }
    }

    private fun armMotion() {
        if (motionArmed || !stillWanted || !watching) return
        val sensor = motionSensor(this) ?: return
        motionArmed = (getSystemService(SENSOR_SERVICE) as SensorManager).requestTriggerSensor(motion, sensor)
    }

    private fun disarmMotion() {
        if (!motionArmed) return
        motionArmed = false
        val sensor = motionSensor(this) ?: return
        runCatching { (getSystemService(SENSOR_SERVICE) as SensorManager).cancelTriggerSensor(motion, sensor) }
    }

    private fun stillWantedChanged() {
        if (!watching) return
        if (stillWanted) {
            still.restart(SystemClock.elapsedRealtime())
            armMotion()
        } else {
            disarmMotion()
            if (still.leave()) stillChanged()
        }
    }

    // The page hears first, then the requests follow: one slow heartbeat while still, both listeners otherwise.
    private fun stillChanged() {
        val now = SystemClock.elapsedRealtime()
        endProbe()
        if (still.on) {
            stillSpells++
            stillSince = now
        } else {
            stillExits++
            if (stillSince > 0L) {
                stillDone += now - stillSince
                stillSince = 0L
            }
        }
        stillNow = still.on
        sink?.invoke(JSONObject().put("still", still.on).toString())
        val lm = getSystemService(LOCATION_SERVICE) as LocationManager
        lm.removeUpdates(this)
        lm.removeUpdates(heartbeat)
        if (request(lm).isEmpty()) noProvider()
    }

    // Swiping the app out of recents kills the page that encrypts and posts
    // positions, so the share is dead from that moment no matter what this
    // service does. It always ended the share here; now it also says so,
    // because a share that ends in silence looks like a working one.
    override fun onTaskRemoved(rootIntent: Intent?) {
        if (PageHost.keepSharing(this) && PageHost.alive) {
            // The window is gone and the share is not. Nothing to write down
            // and nothing to stop: the page is still here, still holding the
            // keys, and the fixes below still reach it.
            super.onTaskRemoved(rootIntent)
            return
        }
        stopAsked = true
        postShareEnded("swipe")
        stopSelf()
        super.onTaskRemoved(rootIntent)
    }

    // Shared with the Stop-button branch so both ways of ending a share leave
    // the same trace.
    private fun postShareEnded(route: String) = recordEnded(this, route)

    override fun onDestroy() {
        val byUs = stopAsked
        running = false
        Forward.shareEnded()
        if (instance === this) instance = null
        ShareResume.serviceGone()
        if (!byUs) {
            sink?.invoke(JSONObject().put("stopped", true).put("route", "system").toString())
            postShareEnded("system")
        }
        stopAsked = false
        // A share that ends with nothing on screen takes the page with it. Not
        // instantly: its stop path still has a departure to get onto the relay.
        PageHost.releaseSoon()
        if (watching) {
            val lm = getSystemService(LOCATION_SERVICE) as LocationManager
            lm.removeUpdates(this)
            lm.removeUpdates(heartbeat)
            runCatching { unregisterReceiver(tickReceiver) }
            watching = false
        }
        disarmMotion()
        endProbe()
        if (stillSince > 0L) stillDone += SystemClock.elapsedRealtime() - stillSince
        stillSince = 0L
        stillNow = false
        if (tickArmed) {
            runCatching { (getSystemService(ALARM_SERVICE) as AlarmManager).cancel(tickIntent) }
            tickArmed = false
        }
        locationOff = false
        letSleep()
        super.onDestroy()
    }

    // An activity intent, so a locked phone asks for the unlock before the settings open.
    private fun locationOnAction(): Notification.Action {
        val settings = PendingIntent.getActivity(
            this,
            4,
            Intent(Settings.ACTION_LOCATION_SOURCE_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            PendingIntent.FLAG_IMMUTABLE,
        )
        return Notification.Action.Builder(null, getString(R.string.notif_location_on), settings).apply {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) setAuthenticationRequired(true)
        }.build()
    }

    private fun buildNotification(): Notification {
        val nm = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL, getString(R.string.notif_channel), NotificationManager.IMPORTANCE_LOW),
        )
        val open = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE,
        )
        val stop = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            PendingIntent.getService(
                this,
                1,
                Intent(this, LocationService::class.java).setAction(ACTION_STOP),
                PendingIntent.FLAG_IMMUTABLE,
            )
        } else {
            PendingIntent.getActivity(
                this,
                1,
                Intent(this, StopShareActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                PendingIntent.FLAG_IMMUTABLE,
            )
        }
        val swiped = PendingIntent.getService(
            this,
            2,
            Intent(this, LocationService::class.java).setAction(ACTION_REPOST),
            PendingIntent.FLAG_IMMUTABLE,
        )
        val stopAction = Notification.Action.Builder(null, getString(R.string.notif_stop), stop).apply {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) setAuthenticationRequired(true)
        }.build()
        // Private version only; the public one stays generic.
        val forwardHost = if (Forward.torOn(this)) null else Forward.host(this)
        val title = when (resumedWhy) {
            "boot" -> getString(R.string.notif_title_resumed_boot)
            "update" -> getString(R.string.notif_title_resumed_update)
            else -> getString(R.string.notif_title)
        }
        val text = when {
            locationOff -> getString(R.string.notif_location_off)
            waitingForTor -> getString(R.string.notif_waiting_orbot)
            forwardHost != null -> getString(R.string.notif_text_forward, forwardHost)
            else -> getString(R.string.notif_text)
        }
        // Same strings both versions: already generic, nothing to redact here.
        val publicVersion = Notification.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_starling)
            .setContentTitle(title)
            .setContentText(getString(R.string.notif_text))
            .setContentIntent(open)
            .setOngoing(true)
            .setShowWhen(false)
            .build()
        val clock = if (clockShown(this)) {
            ShareResume.clock(System.currentTimeMillis(), SystemClock.elapsedRealtime(), startedAt, ShareResume.deadline(this))
        } else {
            null
        }
        countingDown = clock?.second == true
        return Notification.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_starling)
            .setContentTitle(title)
            .setContentText(text)
            .setContentIntent(open)
            .setOngoing(true)
            .setDeleteIntent(swiped)
            .setOnlyAlertOnce(true)
            .setVisibility(Notification.VISIBILITY_PRIVATE)
            .setPublicVersion(publicVersion)
            .addAction(stopAction)
            .apply { if (locationOff) addAction(locationOnAction()) }
            .apply {
                if (clock != null) {
                    setWhen(clock.first)
                    setShowWhen(true)
                    setUsesChronometer(true)
                    setChronometerCountDown(clock.second)
                }
            }
            .build()
    }
}
