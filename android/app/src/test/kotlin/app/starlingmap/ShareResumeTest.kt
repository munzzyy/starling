package app.starlingmap

import app.starlingmap.ShareResume.Path
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ShareResumeTest {
    private val now = 1_800_000_000_000L
    private val armedAt = now - 3_600_000L

    private fun due(armedAt: Long = this.armedAt, deadline: Long = 0L, route: String? = null, stopAt: Long = 0L) =
        ShareResume.due(armedAt, deadline, route, stopAt, now)

    @Test fun anArmedShareIsOffered() = assertTrue(due())

    @Test fun nothingArmedIsNotOffered() = assertFalse(due(armedAt = 0L))

    @Test fun aWindowStillOpenIsOffered() = assertTrue(due(deadline = now + 60_000L))

    @Test fun aWindowThatRanOutIsNot() = assertFalse(due(deadline = now - 1L))

    @Test fun aWindowEndingThisMillisecondIsNot() = assertFalse(due(deadline = now))

    @Test fun aStopOnTheNotificationAfterTheArmIsADecision() =
        assertFalse(due(route = "notif", stopAt = armedAt + 1L))

    @Test fun anUndatedStopOnTheNotificationIsADecisionToo() =
        assertFalse(due(route = "notif", stopAt = 0L))

    @Test fun aStopFromBeforeThisShareDoesNotVetoIt() =
        assertTrue(due(route = "notif", stopAt = armedAt - 1L))

    @Test fun stopsNobodyChoseAreOffered() {
        for (route in listOf("swipe", "system", "stalled", "renderer", "lock")) {
            assertTrue(route, due(route = route, stopAt = armedAt + 1L))
        }
    }

    private fun decide(
        due: Boolean = true,
        autoOn: Boolean = true,
        keepSharing: Boolean = true,
        background: Boolean = true,
        notifications: Boolean = true,
        webViewOk: Boolean = true,
        torOn: Boolean = false,
        torSupported: Boolean = false,
    ) = ShareResume.decide(due, autoOn, keepSharing, background, notifications, webViewOk, torOn, torSupported)

    @Test fun everyGateOpenComesBackByItself() = assertEquals(Path.HEADLESS, decide())

    @Test fun nothingDueIsNothingAtAll() {
        assertEquals(Path.NONE, decide(due = false))
        assertEquals(Path.NONE, decide(due = false, autoOn = false))
    }

    @Test fun eachClosedGateFallsBackToTheTap() {
        assertEquals(Path.OFFER, decide(autoOn = false))
        assertEquals(Path.OFFER, decide(keepSharing = false))
        assertEquals(Path.OFFER, decide(background = false))
        assertEquals(Path.OFFER, decide(notifications = false))
        assertEquals(Path.OFFER, decide(webViewOk = false))
    }

    @Test fun torOnComesBackOnlyBehindTheProxy() {
        assertEquals(Path.OFFER, decide(torOn = true, torSupported = false))
        assertEquals(Path.HEADLESS, decide(torOn = true, torSupported = true))
        assertEquals(Path.HEADLESS, decide(torOn = false, torSupported = false))
    }
}
