package app.starlingmap

import android.app.Activity
import android.content.Intent
import android.os.Bundle

// Stop on the sharing notification below Android 12, where only an activity makes a locked phone ask for the unlock.
class StopShareActivity : Activity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        startService(Intent(this, LocationService::class.java).setAction(LocationService.ACTION_STOP))
        finish()
    }
}
