package com.joelsgc.bamboomobile

import android.app.Activity
import android.content.Intent
import android.os.Build
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin

/**
 * Tauri v2 plugin that bridges TypeScript / Rust → PrinterForegroundService.
 *
 * Registered from Rust via api.register_android_plugin() in the plugin setup,
 * so no manual PluginManager.load() is needed in MainActivity.  Both TypeScript
 * and Rust can call these commands via:
 *
 *   invoke('plugin:printNotification|startNotification',  { title, body, progress })
 *   invoke('plugin:printNotification|updateNotification', { title, body, progress })
 *   invoke('plugin:printNotification|stopNotification')
 *
 * `progress` is 0-100.  When > 0 the notification shows a native progress bar.
 */
@TauriPlugin
class PrintNotificationPlugin(private val activity: Activity) : Plugin(activity) {

    /** Start (or update) the foreground service with a new title / body / progress. */
    @Command
    fun startNotification(invoke: Invoke) {
        val args     = invoke.getArgs()
        val title    = args.getString("title", "Print in progress")!!
        val body     = args.getString("body",  "")!!
        val progress = args.optInt("progress", 0)
        sendToService(title, body, progress)
        invoke.resolve()
    }

    /** Update the notification text on an already-running service. */
    @Command
    fun updateNotification(invoke: Invoke) {
        val args     = invoke.getArgs()
        val title    = args.getString("title", "Print in progress")!!
        val body     = args.getString("body",  "")!!
        val progress = args.optInt("progress", 0)
        sendToService(title, body, progress)
        invoke.resolve()
    }

    /** Stop the foreground service and remove the notification. */
    @Command
    fun stopNotification(invoke: Invoke) {
        val intent = Intent(activity, PrinterForegroundService::class.java).apply {
            action = PrinterForegroundService.ACTION_STOP
        }
        activity.stopService(intent)
        invoke.resolve()
    }

    // ── Private ───────────────────────────────────────────────────────────────

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
