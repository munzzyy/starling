package app.starlingmap

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
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

    @Test fun noKindReachesTheSosChannel() {
        for (kind in listOf("sos", "urgent", "events_sos_alarm", MainActivity.SOS_CHANNEL, MainActivity.OLD_SOS_CHANNEL)) {
            assertNotEquals(kind, MainActivity.SOS_CHANNEL, Events.channelFor(kind))
            assertNotEquals(kind, MainActivity.OLD_SOS_CHANNEL, Events.channelFor(kind))
        }
    }
}
