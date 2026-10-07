package app.starlingmap

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ThawPolicyTest {
    @Test fun aMovingPhoneIsThawedAtOnce() {
        assertEquals(ThawPolicy.NOW, ThawPolicy.afterFreeze(still = false, workWaiting = false))
        assertEquals(ThawPolicy.NOW, ThawPolicy.afterFreeze(still = false, workWaiting = true))
    }

    @Test fun aStillPhoneWithNothingWaitingSleepsAWhile() {
        assertEquals(ThawPolicy.STILL_LISTEN_MS, ThawPolicy.afterFreeze(still = true, workWaiting = false))
    }

    @Test fun aStillPhoneWithAFixWaitingIsThawedAtOnce() {
        assertEquals(ThawPolicy.NOW, ThawPolicy.afterFreeze(still = true, workWaiting = true))
    }

    @Test fun workWakesOnlyAFrozenPage() {
        assertTrue(ThawPolicy.onWork(true))
        assertFalse(ThawPolicy.onWork(false))
    }

    @Test fun theListenWindowIsLongerThanTheFreezeDelayAndShorterThanTheStillHeartbeat() {
        assertTrue(ThawPolicy.STILL_LISTEN_MS > 60000L)
        assertTrue(ThawPolicy.STILL_LISTEN_MS < LocationPlan.STILL_MS)
    }
}
