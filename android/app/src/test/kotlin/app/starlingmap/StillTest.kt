package app.starlingmap

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class StillTest {
    private val lat = 40.0
    private val lon = -75.0
    private val t0 = 1_000_000L
    private val minute = 60_000L

    private fun north(m: Double) = lat + m / 111_195.0

    @Test fun twoMinutesInsideTheRadiusIsStill() {
        val c = StillClock()
        assertFalse(c.fix(lat, lon, 8.0, t0, true))
        assertFalse(c.fix(north(10.0), lon, 8.0, t0 + minute, true))
        assertFalse(c.fix(north(12.0), lon, 8.0, t0 + 2 * minute - 1, true))
        assertTrue(c.fix(north(5.0), lon, 8.0, t0 + 2 * minute, true))
        assertTrue(c.on)
        assertFalse("said once", c.fix(north(5.0), lon, 8.0, t0 + 3 * minute, true))
    }

    @Test fun aFixOutsideTheRadiusLeavesStillAndStartsAgainFromThere() {
        val c = still()
        assertTrue(c.fix(north(40.0), lon, 5.0, t0 + 3 * minute, true))
        assertFalse(c.on)
        assertFalse(c.fix(north(45.0), lon, 5.0, t0 + 4 * minute, true))
        assertTrue("two minutes from the new spot", c.fix(north(45.0), lon, 5.0, t0 + 5 * minute, true))
    }

    @Test fun motionWhileStillOnlyAsksAndAFixAnswers() {
        val c = still()
        assertFalse(c.motion(t0 + 3 * minute))
        assertTrue(c.on)
        assertTrue(c.probing)
        assertFalse("inside the radius", c.fix(north(5.0), lon, 5.0, t0 + 3 * minute + 5_000L, true))
        assertTrue(c.on)
        assertFalse(c.probing)
    }

    @Test fun aProbeFixBeyondTheRadiusLeaves() {
        val c = still()
        c.motion(t0 + 3 * minute)
        assertTrue(c.fix(north(60.0), lon, 5.0, t0 + 3 * minute + 5_000L, true))
        assertFalse(c.on)
        assertFalse(c.probing)
        assertFalse("anchored there, window starts over", c.fix(north(60.0), lon, 5.0, t0 + 4 * minute, true))
        assertTrue(c.fix(north(60.0), lon, 5.0, t0 + 5 * minute + 5_000L, true))
    }

    @Test fun aVagueFixDuringAProbeLeavesItOpen() {
        val c = still()
        c.motion(t0 + 3 * minute)
        assertFalse(c.fix(north(3000.0), lon, 2000.0, t0 + 3 * minute + 5_000L, true))
        assertFalse(c.fix(lat, lon, null, t0 + 3 * minute + 6_000L, true))
        assertTrue(c.on)
        assertTrue(c.probing)
    }

    @Test fun leavingClearsTheProbe() {
        val c = still()
        c.motion(t0 + 3 * minute)
        assertTrue(c.leave())
        assertFalse(c.probing)
    }

    @Test fun motionWhileMovingDoesNotProbe() {
        val c = StillClock()
        c.fix(lat, lon, 5.0, t0, true)
        assertFalse(c.motion(t0 + minute))
        assertFalse(c.probing)
    }

    @Test fun motionBeforeTheWindowEndsKeepsItMoving() {
        val c = StillClock()
        c.fix(lat, lon, 5.0, t0, true)
        c.motion(t0 + 90_000L)
        assertFalse(c.fix(lat, lon, 5.0, t0 + 2 * minute, true))
        assertFalse(c.on)
        assertTrue(c.fix(lat, lon, 5.0, t0 + 90_000L + 2 * minute, true))
    }

    @Test fun neverStillWhileNotAllowed() {
        val c = StillClock()
        for (i in 0..20) assertFalse(c.fix(lat, lon, 5.0, t0 + i * minute, false))
        assertFalse(c.on)
    }

    @Test fun leavingBecauseItIsNoLongerAllowedIsImmediate() {
        val c = still()
        assertTrue(c.leave())
        assertFalse(c.on)
        assertFalse(c.leave())
        assertFalse("an SOS keeps it moving however still the phone is", c.fix(lat, lon, 5.0, t0 + 10 * minute, false))
    }

    @Test fun allowedAgainNeedsAWholeWindowFromThatMoment() {
        val c = StillClock()
        c.fix(lat, lon, 5.0, t0, false)
        c.fix(lat, lon, 5.0, t0 + 5 * minute, false)
        c.restart(t0 + 5 * minute)
        assertFalse(c.fix(lat, lon, 5.0, t0 + 6 * minute, true))
        assertTrue(c.fix(lat, lon, 5.0, t0 + 7 * minute, true))
    }

    @Test fun vagueFixesProveNothingEitherWay() {
        val c = StillClock()
        assertFalse(c.fix(lat, lon, 500.0, t0, true))
        assertFalse(c.fix(lat, lon, null, t0 + 3 * minute, true))
        assertFalse("the first good fix only anchors", c.fix(lat, lon, 5.0, t0 + 4 * minute, true))
        assertTrue(c.fix(lat, lon, 5.0, t0 + 6 * minute, true))
        assertFalse("a cell fix 3 km off does not end it", c.fix(north(3000.0), lon, 2000.0, t0 + 7 * minute, true))
        assertTrue(c.on)
    }

    @Test fun theRadiusGrowsWithTheWorseAccuracy() {
        val c = StillClock()
        c.fix(lat, lon, 30.0, t0, true)
        assertFalse("50 m is inside 2 x 30 m", c.fix(north(50.0), lon, 5.0, t0 + minute, true))
        assertTrue(c.fix(north(50.0), lon, 5.0, t0 + 2 * minute, true))
        assertTrue("70 m is not", c.fix(north(70.0), lon, 5.0, t0 + 3 * minute, true))
    }

    @Test fun metersIsAGreatCircleDistance() {
        assertEquals(111_195.0, StillClock.meters(0.0, 0.0, 1.0, 0.0), 1.0)
        assertEquals(0.0, StillClock.meters(lat, lon, lat, lon), 0.0)
    }

    private fun still(): StillClock {
        val c = StillClock()
        c.fix(lat, lon, 5.0, t0, true)
        assertTrue(c.fix(lat, lon, 5.0, t0 + 2 * minute, true))
        return c
    }
}
