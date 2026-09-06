package app.starlingmap

import android.webkit.JavascriptInterface
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_STRONG
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import org.json.JSONObject

// The page's window into the platform. Only bundled app code can call this:
// the WebView never navigates off the asset origin, so every caller shipped
// in the APK. Async answers travel through __starlingBio(token, payload).
class StarlingBridge(private val activity: MainActivity) {

    @JavascriptInterface
    fun platform(): String = "android"

    @JavascriptInterface
    fun version(): String = runCatching {
        activity.packageManager.getPackageInfo(activity.packageName, 0).versionName
    }.getOrNull() ?: "unknown"

    // ---------------------------------------------------------------- events

    // Post a system notification for a circle event (a member's SOS, an
    // arrival at a place, a low battery). The page only calls this while it
    // is hidden; visible, its own toast already said it. Tag replaces, so a
    // member bouncing at a boundary edits one notification instead of
    // stacking twenty.
    @JavascriptInterface
    fun notify(title: String, body: String, tag: String) {
        activity.runOnUiThread { activity.postEventNotification(title.take(80), body.take(160), tag.take(64)) }
    }

    // The full-device panic wipe: Keystore wrap key, notification channels,
    // then clearApplicationUserData, which kills the process. Same wipe the
    // PanicKit trigger runs. The page's own storage wipe still runs in
    // parallel as the fallback for wrappers that predate this method.
    @JavascriptInterface
    fun panicWipe() {
        activity.runOnUiThread { Wipe.everything(activity) }
    }

    // ------------------------------------------------------------- clipboard

    // Clear the clipboard only if it still holds exactly the text the app put
    // there (an invite link is a credential; whatever the user copied since
    // is theirs). Reading our own clip is allowed while the app has focus;
    // without focus Android answers null and this quietly does nothing.
    @JavascriptInterface
    fun clearClipboardIf(expected: String) {
        activity.runOnUiThread {
            val cm = activity.getSystemService(android.content.ClipboardManager::class.java) ?: return@runOnUiThread
            val current = cm.primaryClip?.takeIf { it.itemCount > 0 }?.getItemAt(0)?.text?.toString()
            if (current == expected) cm.clearPrimaryClip()
        }
    }

    // ------------------------------------------------------------- location

    @JavascriptInterface
    fun startLocation() {
        activity.runOnUiThread { activity.startShareFlow() }
    }

    @JavascriptInterface
    fun stopLocation() {
        activity.runOnUiThread { activity.stopShareFlow() }
    }

    // ------------------------------------------------------------------ tor

    @JavascriptInterface
    fun torSupported(): Boolean = activity.torSupported()

    @JavascriptInterface
    fun torEnabled(): Boolean = activity.torEnabled()

    @JavascriptInterface
    fun setTor(on: Boolean) {
        activity.runOnUiThread { activity.setTorEnabled(on) }
    }

    // ------------------------------------------------------------ biometric

    @JavascriptInterface
    fun bioSupported(): Boolean =
        BiometricManager.from(activity).canAuthenticate(BIOMETRIC_STRONG) ==
            BiometricManager.BIOMETRIC_SUCCESS

    // Wrap the vault key K under a Keystore key the OS only unseals after a
    // biometric prompt. Returns {"nonce","ct"} as b64url, or null.
    @JavascriptInterface
    fun bioWrap(vaultB64: String, token: String) {
        activity.runOnUiThread {
            val vault = KeystoreVault.b64decode(vaultB64)
            if (vault == null || vault.size != 32) {
                vault?.fill(0)
                reply(token, null)
                return@runOnUiThread
            }
            val cipher = KeystoreVault.encryptCipher()
            if (cipher == null) {
                vault.fill(0)
                reply(token, null)
                return@runOnUiThread
            }
            // The zero runs on every exit from the prompt, dismissal and
            // error included, not only on success. (The b64 String argument
            // itself is immutable and beyond reach; this scrubs the copy this
            // side controls.)
            prompt(cipher, R.string.bio_wrap_title) { authed ->
                val out = authed?.let {
                    runCatching {
                        val ct = it.doFinal(vault)
                        JSONObject()
                            .put("nonce", KeystoreVault.b64encode(it.iv))
                            .put("ct", KeystoreVault.b64encode(ct))
                            .toString()
                    }.getOrNull()
                }
                vault.fill(0)
                reply(token, out)
            }
        }
    }

    // Recover K. Returns the key as b64url, or null on any failure: dismissed
    // prompt, invalidated key (new biometric enrollment), tampered record.
    @JavascriptInterface
    fun bioUnwrap(nonceB64: String, ctB64: String, token: String) {
        activity.runOnUiThread {
            val nonce = KeystoreVault.b64decode(nonceB64)
            val ct = KeystoreVault.b64decode(ctB64)
            if (nonce == null || ct == null) {
                reply(token, null)
                return@runOnUiThread
            }
            val cipher = KeystoreVault.decryptCipher(nonce)
            if (cipher == null) {
                reply(token, null)
                return@runOnUiThread
            }
            prompt(cipher, R.string.bio_unwrap_title) { authed ->
                reply(
                    token,
                    authed?.let { runCatching { KeystoreVault.b64encode(it.doFinal(ct)) }.getOrNull() },
                )
            }
        }
    }

    // onAuthenticationFailed (a non-matching finger) keeps the prompt up and
    // stays silent; only a terminal error or a dismissal ends it. done always
    // runs exactly once, with null on those failure exits, so callers have a
    // single place to scrub secrets and answer the page.
    private fun prompt(
        cipher: javax.crypto.Cipher,
        titleRes: Int,
        done: (javax.crypto.Cipher?) -> Unit,
    ) {
        val info = BiometricPrompt.PromptInfo.Builder()
            .setTitle(activity.getString(titleRes))
            .setNegativeButtonText(activity.getString(R.string.bio_cancel))
            .setAllowedAuthenticators(BIOMETRIC_STRONG)
            .build()
        val prompt = BiometricPrompt(
            activity,
            ContextCompat.getMainExecutor(activity),
            object : BiometricPrompt.AuthenticationCallback() {
                override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                    done(result.cryptoObject?.cipher)
                }

                override fun onAuthenticationError(code: Int, msg: CharSequence) {
                    done(null)
                }
            },
        )
        prompt.authenticate(info, BiometricPrompt.CryptoObject(cipher))
    }

    private fun reply(token: String, payload: String?) {
        val t = JSONObject.quote(token)
        val p = if (payload == null) "null" else JSONObject.quote(payload)
        activity.webView.evaluateJavascript(
            "globalThis.__starlingBio && __starlingBio($t, $p)",
            null,
        )
    }
}
