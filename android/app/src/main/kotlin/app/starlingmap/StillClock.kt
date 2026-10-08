package app.starlingmap

import kotlin.math.asin
import kotlin.math.cos
import kotlin.math.max
import kotlin.math.sin
import kotlin.math.sqrt

// No Android in here, so the JVM tests can drive it with plain numbers and times.
class StillClock(private val afterMs: Long = AFTER_MS) {

    companion object {
        const val AFTER_MS = 2 * 60000L
        const val RADIUS_M = 25.0

        // A fix this vague can neither prove the phone still nor prove it moved.
        const val VAGUE_M = 100.0

        fun meters(lat1: Double, lon1: Double, lat2: Double, lon2: Double): Double {
            val r = 6371008.8
            val p1 = Math.toRadians(lat1)
            val p2 = Math.toRadians(lat2)
            val dp = p2 - p1
            val dl = Math.toRadians(lon2 - lon1)
            val h = sin(dp / 2) * sin(dp / 2) + cos(p1) * cos(p2) * sin(dl / 2) * sin(dl / 2)
            return 2 * r * asin(sqrt(h.coerceIn(0.0, 1.0)))
        }
    }

    var on = false
        private set

    // Motion said something may have changed; one good fix has to say what.
    var probing = false
        private set

    private var anchored = false
    private var lat = 0.0
    private var lon = 0.0
    private var acc = 0.0

    // Start of the stretch with no move and no motion; still once it is afterMs long.
    private var since = Long.MIN_VALUE

    // Each of these returns true when `on` changed.

    fun fix(lat: Double, lon: Double, acc: Double?, at: Long, allowed: Boolean): Boolean {
        if (acc == null || !acc.isFinite() || acc > VAGUE_M) return false
        if (!anchored) {
            anchor(lat, lon, acc, at)
            return false
        }
        if (on) probing = false
        if (meters(this.lat, this.lon, lat, lon) > max(RADIUS_M, 2 * max(this.acc, acc))) {
            anchor(lat, lon, acc, at)
            return leave()
        }
        if (!on && allowed && at - since >= afterMs) {
            on = true
            return true
        }
        return false
    }

    fun motion(at: Long): Boolean {
        if (on) {
            probing = true
            return false
        }
        since = max(since, at)
        return false
    }

    // Nothing watched for motion before `at`, so the stretch starts over there.
    fun restart(at: Long) {
        probing = false
        since = max(since, at)
    }

    fun leave(): Boolean {
        probing = false
        if (!on) return false
        on = false
        return true
    }

    private fun anchor(lat: Double, lon: Double, acc: Double, at: Long) {
        this.lat = lat
        this.lon = lon
        this.acc = acc
        anchored = true
        since = max(since, at)
    }
}
