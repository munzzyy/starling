package app.starlingmap

// Positions waiting for the forward server. Memory only, and Forward empties it when the share ends.
class ForwardQueue(private val capacity: Int = 20) {
    private val items = ArrayDeque<String>()
    private var gen = 0
    private var pending = false

    val size: Int
        @Synchronized get() = items.size

    // True when the caller has to schedule a drain. At most one waits at a time.
    @Synchronized
    fun add(body: String): Boolean {
        if (items.size >= capacity) items.removeFirst()
        items.addLast(body)
        if (pending) return false
        pending = true
        return true
    }

    @Synchronized
    fun clear() {
        items.clear()
        gen++
    }

    // One thread only. send answers an HTTP status, -1 for no connection, or null to hold everything.
    fun drain(send: (String) -> Int?) {
        synchronized(this) { pending = false }
        while (true) {
            val body: String
            val at: Int
            synchronized(this) {
                body = items.firstOrNull() ?: return
                at = gen
            }
            val code = send(body) ?: return
            synchronized(this) {
                if (at == gen) {
                    if (retry(code)) return
                    // A full queue may have dropped it mid-send, and the new head was never sent.
                    if (items.firstOrNull() === body) items.removeFirst()
                }
            }
        }
    }

    companion object {
        fun retry(code: Int): Boolean = code == -1 || code == 408 || code == 429 || code >= 500
    }
}
