package app.starlingmap

import android.app.Activity
import android.app.AlertDialog
import android.content.Context
import android.content.pm.ApplicationInfo
import android.graphics.Typeface
import android.os.Build
import android.util.TypedValue
import android.view.ViewGroup
import android.webkit.WebSettings
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

object SystemCheck {
    // The newest browser feature the page can't do without: Ed25519 signatures; an older WebView silently drops every member on a newer phone.
    const val MIN_WEBVIEW = 137

    // Debug builds only need the page to parse, so the AOSP emulator images (WebView 133) still run the e2e checks.
    private const val MIN_WEBVIEW_DEBUG = 80

    fun minWebView(ctx: Context): Int =
        if ((ctx.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0) MIN_WEBVIEW_DEBUG else MIN_WEBVIEW

    private const val PREFS = "system_check"
    private const val PREF_ANDROID9_NOTED = "android9_noted"

    // Chrome/NN from the user agent: some WebView packages use their own version numbers. null = no working WebView.
    fun webViewMajor(ctx: Context): Int? = try {
        val ua = WebSettings.getDefaultUserAgent(ctx)
        Regex("""Chrome/(\d+)""").find(ua)?.groupValues?.get(1)?.toIntOrNull() ?: 0
    } catch (e: RuntimeException) {
        null
    }

    fun webViewOk(ctx: Context): Boolean {
        val major = webViewMajor(ctx)
        return major != null && (major == 0 || major >= minWebView(ctx))
    }

    fun blockIfWebViewTooOld(activity: Activity): Boolean {
        if (webViewOk(activity)) return false
        val major = webViewMajor(activity)
        val min = minWebView(activity)
        val body = if (major == null) {
            activity.getString(R.string.webview_missing)
        } else {
            activity.getString(R.string.webview_too_old, min, major)
        }
        val color = activity.getColor(R.color.check_text)
        val pad = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, 24f, activity.resources.displayMetrics).toInt()
        val title = TextView(activity).apply {
            text = activity.getString(R.string.webview_title)
            setTextColor(color)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 22f)
            setTypeface(typeface, Typeface.BOLD)
        }
        ViewCompat.setAccessibilityHeading(title, true)
        val text = TextView(activity).apply {
            this.text = body
            setTextColor(color)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 17f)
            setLineSpacing(0f, 1.3f)
            setPadding(0, pad / 2, 0, 0)
        }
        val column = LinearLayout(activity).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(pad, pad, pad, pad)
            addView(title)
            addView(text)
        }
        val root = ScrollView(activity)
        root.addView(column, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        activity.setContentView(root)
        ViewCompat.setOnApplyWindowInsetsListener(root) { view, insets ->
            val safe = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            view.setPadding(safe.left, safe.top, safe.right, safe.bottom)
            insets
        }
        return true
    }

    fun noteAndroid9(activity: Activity) {
        if (Build.VERSION.SDK_INT != Build.VERSION_CODES.P) return
        val prefs = activity.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        if (prefs.getBoolean(PREF_ANDROID9_NOTED, false)) return
        val noted = { prefs.edit().putBoolean(PREF_ANDROID9_NOTED, true).apply() }
        val theme = android.R.style.Theme_Material_Dialog_Alert
        AlertDialog.Builder(activity, theme)
            .setTitle(R.string.android9_title)
            .setMessage(R.string.android9_body)
            .setPositiveButton(android.R.string.ok) { _, _ -> noted() }
            .setOnCancelListener { noted() }
            .show()
    }
}
