package app.starlingmap

import org.junit.Assert.assertEquals
import org.junit.Test

class ShareClockTest {
    private val wall = 1_800_000_000_000L
    private val elapsed = 50_000_000L
    private val startedAt = elapsed - 600_000L

    private fun clock(deadline: Long) = ShareResume.clock(wall, elapsed, startedAt, deadline)

    @Test fun aWindowStillOpenCountsDownToItsEnd() =
        assertEquals(wall + 90_000L to true, clock(wall + 90_000L))

    @Test fun anOpenShareCountsUpFromItsStart() =
        assertEquals(wall - 600_000L to false, clock(0L))

    @Test fun aWindowThatRanOutCountsUpInsteadOfBelowZero() =
        assertEquals(wall - 600_000L to false, clock(wall - 1L))

    @Test fun aWindowEndingThisMillisecondCountsUp() =
        assertEquals(wall - 600_000L to false, clock(wall))
}
