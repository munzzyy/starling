package app.starlingmap

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyPermanentlyInvalidatedException
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

// The hardware-backed half of the app lock's biometric path: an AES-256-GCM
// key that never leaves the Keystore and that the OS refuses to use without a
// fresh strong-biometric authentication. Enrolling a new fingerprint or face
// permanently invalidates it, which downgrades the lock to passcode-only
// instead of letting a newly enrolled stranger in.
object KeystoreVault {

    private const val ALIAS = "starling-bio-wrap"
    private const val STORE = "AndroidKeyStore"
    private const val B64 = Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP

    fun b64encode(bytes: ByteArray): String = Base64.encodeToString(bytes, B64)

    fun b64decode(s: String): ByteArray? = runCatching { Base64.decode(s, B64) }.getOrNull()

    private fun keystore(): KeyStore =
        KeyStore.getInstance(STORE).apply { load(null) }

    private fun getKey(): SecretKey? =
        runCatching { keystore().getKey(ALIAS, null) as? SecretKey }.getOrNull()

    private fun createKey(): SecretKey? = runCatching {
        val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, STORE)
        val spec = KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .setUserAuthenticationRequired(true)
            .setInvalidatedByBiometricEnrollment(true)
        if (android.os.Build.VERSION.SDK_INT >= 30) {
            spec.setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG)
        } else {
            // API 29 spelling of auth-per-use, biometric-gated.
            @Suppress("DEPRECATION")
            spec.setUserAuthenticationValidityDurationSeconds(-1)
        }
        gen.init(spec.build())
        gen.generateKey()
    }.getOrNull()

    // Also called by the panic wipe: the system's clear-data path clears the
    // Keystore namespace too, but does it best-effort in another process.
    fun deleteKey() {
        runCatching { keystore().deleteEntry(ALIAS) }
    }

    // A fresh wrap may mint a fresh key: an invalidated old key only mattered
    // for records it already wrapped, and those are unrecoverable by design.
    fun encryptCipher(): Cipher? {
        val cipher = runCatching { Cipher.getInstance("AES/GCM/NoPadding") }.getOrNull() ?: return null
        val key = getKey() ?: createKey() ?: return null
        return try {
            cipher.init(Cipher.ENCRYPT_MODE, key)
            cipher
        } catch (e: KeyPermanentlyInvalidatedException) {
            deleteKey()
            val fresh = createKey() ?: return null
            runCatching {
                cipher.init(Cipher.ENCRYPT_MODE, fresh)
                cipher
            }.getOrNull()
        } catch (e: Exception) {
            null
        }
    }

    // Unwrap must use the exact key that wrapped; an invalidated key means the
    // record is gone for good and the caller falls back to the passcode.
    fun decryptCipher(nonce: ByteArray): Cipher? {
        val key = getKey() ?: return null
        return runCatching {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, nonce))
            cipher
        }.getOrNull()
    }
}
