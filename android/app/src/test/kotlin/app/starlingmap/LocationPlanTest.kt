package app.starlingmap

import app.starlingmap.LocationPlan.FUSED
import app.starlingmap.LocationPlan.GPS
import app.starlingmap.LocationPlan.NETWORK
import app.starlingmap.LocationPlan.Quality
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class LocationPlanTest {
    private val both = listOf(GPS, NETWORK)
    private val s = 1000L

    @Test fun theFifteenSecondCircleKeepsTheFastHighAccuracyPath() {
        val p = LocationPlan.plan(15 * s, false, both, fused = true)
        assertEquals("both providers, moving and heartbeat each", 4, p.size)
        assertTrue(p.all { it.quality == Quality.HIGH && it.provider != FUSED })
        val moving = p.first { it.moving }
        assertEquals(3 * s, moving.intervalMs)
        assertEquals(5f, moving.minDistanceM)
        assertEquals(15 * s, p.first { !it.moving }.intervalMs)
    }

    @Test fun aMinuteOrFiveMinuteCircleDropsTheThreeSecondListener() {
        for (c in listOf(60 * s, 300 * s)) {
            val p = LocationPlan.plan(c, false, both, fused = false)
            assertFalse("no moving listener at $c", p.any { it.moving })
            assertTrue(p.all { it.intervalMs == c && it.quality == Quality.BALANCED })
            assertTrue("never a GPS wake faster than the circle posts", p.all { it.intervalMs >= 60 * s })
        }
    }

    @Test fun fusedReplacesThePairWhenTheCircleIsRelaxed() {
        val p = LocationPlan.plan(300 * s, false, both, fused = true)
        assertEquals(listOf(FUSED), p.map { it.provider })
        assertEquals(Quality.BALANCED, p[0].quality)
    }

    @Test fun fusedNeverReplacesTheFastPath() {
        val p = LocationPlan.plan(15 * s, false, both, fused = true)
        assertFalse(p.any { it.provider == FUSED })
    }

    @Test fun torOnLeavesGpsOnlyEvenWhenRelaxed() {
        val p = LocationPlan.plan(300 * s, false, listOf(GPS), fused = false)
        assertEquals(listOf(GPS), p.map { it.provider })
    }

    @Test fun onlyALongCadenceAllowsBatching() {
        assertEquals(0L, LocationPlan.plan(60 * s, false, both, false)[0].maxWaitMs)
        assertEquals(300 * s, LocationPlan.plan(300 * s, false, both, false)[0].maxWaitMs)
        assertEquals(0L, LocationPlan.plan(15 * s, false, both, false).maxOf { it.maxWaitMs })
    }

    @Test fun stillIsOneSlowRequestWhateverTheCadence() {
        for (c in listOf(15 * s, 60 * s, 300 * s)) {
            val p = LocationPlan.plan(c, true, both, fused = false)
            assertEquals(2, p.size)
            assertTrue(p.all { it.intervalMs == 300 * s && !it.moving && it.quality == Quality.BALANCED })
        }
    }

    @Test fun movingAgainGoesBackToTheCadencePlan() {
        val still = LocationPlan.plan(15 * s, true, both, false)
        val moving = LocationPlan.plan(15 * s, false, both, false)
        assertTrue(still.none { it.moving })
        assertTrue(moving.any { it.moving })
    }

    @Test fun aCadenceBelowTheFloorIsHeldAtTheFloor() {
        val p = LocationPlan.plan(1 * s, false, both, false)
        assertEquals(15 * s, p.first { !it.moving }.intervalMs)
    }

    @Test fun theAlarmFollowsTheHeartbeat() {
        assertEquals(60 * s, LocationPlan.tickMs(15 * s, false, false))
        assertEquals(60 * s, LocationPlan.tickMs(60 * s, false, false))
        assertEquals(375 * s, LocationPlan.tickMs(300 * s, false, false))
        assertEquals(375 * s, LocationPlan.tickMs(15 * s, true, false))
        assertEquals("a countdown needs the minute", 60 * s, LocationPlan.tickMs(300 * s, true, true))
    }

    @Test fun rewatchWaitsOutTwoHeartbeats() {
        assertEquals(300 * s, LocationPlan.rewatchMs(15 * s, false))
        assertEquals(600 * s, LocationPlan.rewatchMs(300 * s, false))
        assertEquals(600 * s, LocationPlan.rewatchMs(15 * s, true))
        assertTrue(LocationPlan.rewatchMs(300 * s, false) > LocationPlan.tickMs(300 * s, false, false))
    }
}
