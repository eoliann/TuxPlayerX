package com.eoliann.tuxplayerx

import android.content.res.Configuration
import android.os.Bundle
import android.view.View
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat

class MainActivity : TauriActivity() {
  private var webView: WebView? = null

  /** Camera cutout sizes in CSS pixels; the web interface keeps lists and buttons clear of it. */
  @Volatile private var cutoutJson = """{"top":0,"right":0,"bottom":0,"left":0}"""

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    // A TV player: keep the screen on while the app is in front.
    window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    // Draw under the camera cutout on the short edges (the left/right side in landscape).
    if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.P) {
      window.attributes = window.attributes.apply {
        layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
      }
    }
    // The status and navigation bars are kept clear natively (they are hidden in landscape, so the content
    // then fills the screen). The camera cutout is not padded here: the video should run under it, so its
    // size goes to the web interface instead (see SafeArea below).
    val content = findViewById<View>(android.R.id.content)
    ViewCompat.setOnApplyWindowInsetsListener(content) { view, insets ->
      val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
      val cutout = insets.getInsets(WindowInsetsCompat.Type.displayCutout())
      view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
      val density = resources.displayMetrics.density
      fun css(cut: Int, bar: Int) = (maxOf(0, cut - bar) / density).toInt()
      cutoutJson = """{"top":${css(cutout.top, bars.top)},"right":${css(cutout.right, bars.right)},""" +
        """"bottom":${css(cutout.bottom, bars.bottom)},"left":${css(cutout.left, bars.left)}}"""
      webView?.post { webView?.evaluateJavascript("window.dispatchEvent(new Event('tux-safe-area'))", null) }
      WindowInsetsCompat.CONSUMED
    }
    applySystemBars(resources.configuration)
  }

  override fun onWebViewCreate(webView: WebView) {
    this.webView = webView
    webView.addJavascriptInterface(SafeArea(), "TuxSafeArea")
  }

  inner class SafeArea {
    @JavascriptInterface
    fun insets(): String = cutoutJson
  }

  override fun onConfigurationChanged(newConfig: Configuration) {
    super.onConfigurationChanged(newConfig)
    applySystemBars(newConfig)
  }

  override fun onWindowFocusChanged(hasFocus: Boolean) {
    super.onWindowFocusChanged(hasFocus)
    if (hasFocus) applySystemBars(resources.configuration)
  }

  /** Landscape (phone turned sideways, tablets, TVs): immersive full screen; a swipe shows the bars briefly. */
  private fun applySystemBars(config: Configuration) {
    val controller = WindowCompat.getInsetsController(window, window.decorView)
    if (config.orientation == Configuration.ORIENTATION_LANDSCAPE) {
      controller.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
      controller.hide(WindowInsetsCompat.Type.systemBars())
    } else {
      controller.show(WindowInsetsCompat.Type.systemBars())
    }
  }
}
