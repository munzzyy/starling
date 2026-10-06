package app.starlingmap

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class EventsChannelTest {

    @Test fun arrivalsDeparturesAndCheckInsEachGetTheirOwnChannel() {
        assertEquals(MainActivity.ARRIVE_CHANNEL, Events.channelFor("arrive"))
        assertEquals(MainActivity.LEAVE_CHANNEL, Events.channelFor("leave"))
        assertEquals(MainActivity.CHECKIN_CHANNEL, Events.channelFor("checkin"))
        assertEquals(3, setOf(Events.channelFor("arrive"), Events.channelFor("leave"), Events.channelFor("checkin")).size)
    }

    @Test fun everythingElseStaysOnTheGeneralChannel() {
        for (kind in listOf("battery", "other", "", "ARRIVE", "arrive ", "share")) {
            assertEquals(kind, MainActivity.EVENTS_CHANNEL, Events.channelFor(kind))
        }
    }

    @Test fun onlyANewChannelTakesItsSettingsFromCircleAlerts() {
        for (id in listOf(MainActivity.ARRIVE_CHANNEL, MainActivity.LEAVE_CHANNEL, MainActivity.CHECKIN_CHANNEL)) {
            assertTrue(id, Events.startsAsEvents(id, exists = false))
            assertFalse("$id is left as the person set it", Events.startsAsEvents(id, exists = true))
        }
        assertFalse(Events.startsAsEvents(MainActivity.EVENTS_CHANNEL, exists = false))
        assertFalse(Events.startsAsEvents(MainActivity.EVENTS_CHANNEL, exists = true))
    }

    @Test fun noKindReachesTheSosChannel() {
        for (kind in listOf("sos", "urgent", "events_sos_alarm", MainActivity.SOS_CHANNEL, MainActivity.OLD_SOS_CHANNEL)) {
            assertNotEquals(kind, MainActivity.SOS_CHANNEL, Events.channelFor(kind))
            assertNotEquals(kind, MainActivity.OLD_SOS_CHANNEL, Events.channelFor(kind))
        }
    }
}
