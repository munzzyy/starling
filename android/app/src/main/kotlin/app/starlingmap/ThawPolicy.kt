package app.starlingmap

// When to wake a frozen page, as numbers, so the JVM tests can pin it.
//
// Thawing costs a visibility flip and a minute of a running renderer before Chromium
// freezes the page again. A page that freezes and is thawed on the spot never sleeps.
object ThawPolicy {

    // How long a still phone's page sleeps after a freeze before it is woken to listen to
    // the circle. Short enough that an SOS from someone else is heard within a few
    // minutes, long enough that the renderer is not kept running all day.
    const val STILL_LISTEN_MS = 120000L

    const val NOW = 0L

    // What to do when the page reports it just froze: wake it after the returned delay.
    // `workWaiting` is a fix handed to the page that it has not answered yet; that one
    // always goes at once, and so does any phone that is not lying still.
    fun afterFreeze(still: Boolean, workWaiting: Boolean): Long =
        if (still && !workWaiting) STILL_LISTEN_MS else NOW

    // A fix or a tick arriving at a page known to be frozen wakes it now: the post it
    // starts cannot run until it is thawed, and waiting for the watchdog costs seconds
    // with the CPU held.
    fun onWork(frozenNow: Boolean): Boolean = frozenNow
}
