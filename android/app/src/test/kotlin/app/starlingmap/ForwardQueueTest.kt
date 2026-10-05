package app.starlingmap

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ForwardQueueTest {
    private val sent = mutableListOf<String>()

    private fun answering(vararg codes: Int?): (String) -> Int? {
        val left = ArrayDeque(codes.toList())
        return { body ->
            val code = if (left.isEmpty()) 200 else left.removeFirst()
            if (code != null) sent += body
            code
        }
    }

    private fun queueOf(vararg bodies: String, capacity: Int = 20) =
        ForwardQueue(capacity).apply { bodies.forEach { add(it) } }

    @Test fun pointsGoOutOldestFirst() {
        val q = queueOf("a", "b", "c")
        q.drain(answering())
        assertEquals(listOf("a", "b", "c"), sent)
        assertEquals(0, q.size)
    }

    @Test fun aFullQueueDropsTheOldest() {
        val q = queueOf("a", "b", "c", "d", capacity = 3)
        assertEquals(3, q.size)
        q.drain(answering())
        assertEquals(listOf("b", "c", "d"), sent)
    }

    @Test fun aFailureKeepsThePointForTheNextDrain() {
        val q = queueOf("a", "b")
        q.drain(answering(-1))
        assertEquals(listOf("a"), sent)
        assertEquals(2, q.size)
        q.drain(answering())
        assertEquals(listOf("a", "a", "b"), sent)
        assertEquals(0, q.size)
    }

    @Test fun busyAndServerErrorsAreRetried() {
        for (code in listOf(-1, 408, 429, 500, 502, 503)) {
            val q = queueOf("a")
            q.drain { code }
            assertEquals("$code", 1, q.size)
        }
    }

    @Test fun anAnswerThatWillNotChangeDropsThePoint() {
        for (code in listOf(400, 401, 403, 404, 410, 413, 301, 302)) {
            val q = queueOf("a", "b")
            q.drain(answering(code, -1))
            assertEquals("$code", 1, q.size)
        }
        assertFalse(ForwardQueue.retry(404))
        assertTrue(ForwardQueue.retry(503))
    }

    @Test fun nullHoldsEverythingAndSendsNothing() {
        val q = queueOf("a", "b")
        q.drain(answering(null))
        assertEquals(emptyList<String>(), sent)
        assertEquals(2, q.size)
    }

    @Test fun clearEmptiesIt() {
        val q = queueOf("a", "b")
        q.clear()
        assertEquals(0, q.size)
        q.drain(answering())
        assertEquals(emptyList<String>(), sent)
    }

    @Test fun aClearDuringASendKeepsWhatCameAfterIt() {
        val q = queueOf("a", "b")
        var first = true
        q.drain { body ->
            sent += body
            if (first) {
                first = false
                q.clear()
                q.add("x")
            }
            200
        }
        assertEquals(listOf("a", "x"), sent)
        assertEquals(0, q.size)
    }

    @Test fun onlyOneDrainWaitsAtATime() {
        val q = ForwardQueue()
        assertTrue(q.add("a"))
        assertFalse(q.add("b"))
        assertFalse(q.add("c"))
        var scheduled = 0
        q.drain { body ->
            if (body == "a" && q.add("d")) scheduled++
            if (body == "b" && q.add("e")) scheduled++
            200
        }
        assertEquals("a point added mid-drain schedules one more, not one per point", 1, scheduled)
        assertFalse(q.add("f"))
        q.drain(answering())
        assertTrue(q.add("g"))
    }
}
