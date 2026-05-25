package com.joelsgc.bamboomobile

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.os.Build
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin

/**
 * Tauri v2 plugin that bridges TypeScript / Rust → PrinterForegroundService.
 *
 * Registered from Rust via api.register_android_plugin() in the plugin setup.
 * Both TypeScript and Rust can call these commands via:
 *
 *   invoke('plugin:printNotification|startNotification',  { title, body, progress })
 *   invoke('plugin:printNotification|updateNotification', { title, body, progress })
 *   invoke('plugin:printNotification|stopNotification')
 *   invoke('plugin:printNotification|storeCredentials',   { ip, access_code, serial })
 *   invoke('plugin:printNotification|clearCredentials')
 *
 * Credentials are stored in SharedPreferences so PrinterForegroundService can
 * open its own MQTT connection when Android restarts it after the app is killed.
 */
@TauriPlugin
class PrintNotificationPlugin(private val activity: Activity) : Plugin(activity) {

    // ── Notification control ──────────────────────────────────────────────────

    @Command
    fun startNotification(invoke: Invoke) {
        val args     = invoke.getArgs()
        val title    = args.getString("title", "Print in progress")!!
        val body     = args.getString("body",  "")!!
        val progress = args.optInt("progress", 0)
        sendToService(title, body, progress)
        invoke.resolve()
    }

    @Command
    fun updateNotification(invoke: Invoke) {
        val args     = invoke.getArgs()
        val title    = args.getString("title", "Print in progress")!!
        val body     = args.getString("body",  "")!!
        val progress = args.optInt("progress", 0)
        sendToService(title, body, progress)
        invoke.resolve()
    }

    @Command
    fun stopNotification(invoke: Invoke) {
        val intent = Intent(activity, PrinterForegroundService::class.java).apply {
            action = PrinterForegroundService.ACTION_STOP
        }
        activity.stopService(intent)
        invoke.resolve()
    }

    // ── Credential storage ────────────────────────────────────────────────────
    //
    // Called by Rust immediately after a successful connect_printer so that
    // PrinterForegroundService can reconnect on its own when the process is
    // killed and restarted by Android's START_STICKY mechanism.

    @Command
    fun storeCredentials(invoke: Invoke) {
        val args       = invoke.getArgs()
        val ip         = args.getString("ip",          "")!!
        val accessCode = args.getString("access_code", "")!!
        val serial     = args.getString("serial",      "")!!

        prefs().edit()
            .putString("ip",          ip)
            .putString("access_code", accessCode)
            .putString("serial",      serial)
            .apply()

        // Tell the service to exit standalone mode if it happens to be running.
        // Use plain startService (NOT startForegroundService) so Android does not
        // require startForeground() within 5 s when the service wasn't already alive.
        val intent = Intent(activity, PrinterForegroundService::class.java).apply {
            action = PrinterForegroundService.ACTION_TAURI_CONNECTED
        }
        activity.startService(intent)

        invoke.resolve()
    }

    @Command
    fun clearCredentials(invoke: Invoke) {
        prefs().edit().clear().apply()
        invoke.resolve()
    }

    // ── Private ───────────────────────────────────────────────────────────────

    private fun prefs() =
        activity.getSharedPreferences(PrinterForegroundService.PREFS_NAME, Context.MODE_PRIVATE)

    private fun sendToService(title: String, body: String, progress: Int) {
        val intent = Intent(activity, PrinterForegroundService::class.java).apply {
            putExtra("title",    title)
            putExtra("body",     body)
            putExtra("progress", progress)
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            activity.startForegroundService(intent)
        } else {
            activity.startService(intent)
        }
    }
}
