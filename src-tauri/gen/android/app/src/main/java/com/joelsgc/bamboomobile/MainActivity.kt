package com.joelsgc.bamboomobile

import android.os.Bundle
import androidx.activity.enableEdgeToEdge

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    // PrintNotificationPlugin is registered from Rust via
    // api.register_android_plugin() in the "printNotification" plugin setup.
    // No manual PluginManager.load() needed here.
  }
}
