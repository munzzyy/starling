package app.starlingmap

// What to ask the platform for, as plain numbers, so the JVM tests can pin it.
// The service turns each Req into a request; nothing here touches Android.
//
// The expensive thing on a phone is not a fix, it is the GPS chip staying
// powered between fixes. Android runs it continuously for any interval under
// about ten seconds, so a 3 second listener costs the same whether the circle
// posts every 15 seconds or every five minutes. Everything below follows from
// asking for no more often than the circle will post.
object LocationPlan {

    const val GPS = "gps"
    const val NETWORK = "network"
    const val FUSED = "fused"

    // The page never posts faster than this, and an SOS goes out on it.
    const val FLOOR_MS = 15000L

    // From here the circle has chosen a slow pace and a fix every 3 seconds is waste.
    const val RELAXED_FROM_MS = 60000L

    // From here Android may hold fixes back and hand them over together.
    const val BATCH_FROM_MS = 120000L

    const val MOVING_MS = 3000L
    const val MOVING_M = 5f

    // A phone lying still passes no distance filter, so the heartbeat has none.
    const val NO_DISTANCE = 0f

    // Still mode's one slow heartbeat.
    const val STILL_MS = 5 * 60000L

    const val TICK_MIN_MS = 60000L
    const val REWATCH_MIN_MS = 5 * 60000L

    enum class Quality { HIGH, BALANCED }

    data class Req(
        val provider: String,
        val intervalMs: Long,
        val minDistanceM: Float,
        // 0 means deliver each fix as it comes.
        val maxWaitMs: Long,
        val quality: Quality,
        // The distance-filtered listener, as opposed to the heartbeat.
        val moving: Boolean,
    )

    // `platform` is what the phone offers and the privacy settings allow (never the
    // network provider with Tor on). `fused` only says the platform's fused provider
    // exists, and is never passed with Tor on, because fused falls back on network
    // location: an off-device lookup.
    fun plan(cadenceMs: Long, still: Boolean, platform: List<String>, fused: Boolean): List<Req> {
        val every = cadenceMs.coerceAtLeast(FLOOR_MS)
        if (still || every >= RELAXED_FROM_MS) {
            val gap = if (still) STILL_MS else every
            val wait = if (gap >= BATCH_FROM_MS) gap else 0L
            val names = if (fused) listOf(FUSED) else platform
            return names.map { Req(it, gap, NO_DISTANCE, wait, Quality.BALANCED, moving = false) }
        }
        // The 15 second circle and the SOS: the fast path, unchanged and always high accuracy.
        return platform.flatMap {
            listOf(
                Req(it, MOVING_MS, MOVING_M, 0L, Quality.HIGH, moving = true),
                Req(it, every, NO_DISTANCE, 0L, Quality.HIGH, moving = false),
            )
        }
    }

    // The alarm only has to catch a heartbeat that never came, so it need not run
    // faster than the heartbeat. A countdown in the notification wants the minute.
    fun tickMs(cadenceMs: Long, still: Boolean, countdown: Boolean): Long {
        if (countdown) return TICK_MIN_MS
        val every = if (still) STILL_MS else cadenceMs
        return if (every <= TICK_MIN_MS) TICK_MIN_MS else every + every / 4
    }

    // Silence this long with location on renews the requests: never shorter than
    // two heartbeats, or a normal quiet stretch would read as a dead listener.
    fun rewatchMs(cadenceMs: Long, still: Boolean): Long {
        val every = if (still) STILL_MS else cadenceMs
        return maxOf(REWATCH_MIN_MS, 2 * every)
    }
}
