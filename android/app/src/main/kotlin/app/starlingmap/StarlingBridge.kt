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
                reply(token, null)
                return@runOnUiThread
            }
            val cipher = KeystoreVault.encryptCipher()
            if (cipher == null) {
                reply(token, null)
                return@runOnUiThread
            }
            prompt(token, cipher, R.string.bio_wrap_title) { authed ->
                val out = runCatching {
                    val ct = authed.doFinal(vault)
                    JSONObject()
                        .put("nonce", KeystoreVault.b64encode(authed.iv))
                        .put("ct", KeystoreVault.b64encode(ct))
                        .toString()
                }.getOrNull()
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
            prompt(token, cipher, R.string.bio_unwrap_title) { authed ->
                reply(
                    token,
                    runCatching { KeystoreVault.b64encode(authed.doFinal(ct)) }.getOrNull(),
                )
            }
        }
    }

    // onAuthenticationFailed (a non-matching finger) keeps the prompt up and
    // stays silent; only a terminal error or a dismissal answers null.
    private fun prompt(
        token: String,
        cipher: javax.crypto.Cipher,
        titleRes: Int,
        done: (javax.crypto.Cipher) -> Unit,
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
                    val c = result.cryptoObject?.cipher
                    if (c != null) done(c) else reply(token, null)
                }

                override fun onAuthenticationError(code: Int, msg: CharSequence) {
                    reply(token, null)
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
