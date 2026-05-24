package com.joelsgc.bamboomobile

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationCompat

/**
 * Foreground service that owns the persistent print-progress notification.
 *
 * Running as a foreground service keeps the app process alive while a print
 * is in progress, so the Tauri/Rust MQTT loop continues to receive status
 * updates even when the user has switched to another app.
 *
 * Start / update: send an intent with action "START" (or null) and extras
 *   "title" / "body" / "progress" (0-100, shows native progress bar when > 0).
 *   If the service is already running, onStartCommand is called again and
 *   simply refreshes the notification — no new instance.
 *
 * Stop: send an intent with action "STOP", or call stopService().
 *
 * Android 14+ note: when foregroundServiceType is declared in the manifest
 * the matching type MUST also be passed to startForeground(); omitting it
 * throws ForegroundServiceTypeException and kills the service silently.
 */
class PrinterForegroundService : Service() {

    companion object {
        const val CHANNEL_ID  = "bamboo_print_progress"
        const val NOTIF_ID    = 42_001
        const val ACTION_STOP = "STOP"
        private const val TAG = "PrinterForegroundSvc"
    }

    private lateinit var notifManager: NotificationManager

    override fun onCreate() {
        super.onCreate()
        notifManager = getSystemService(NotificationManager::class.java)
        ensureChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
            return START_NOT_STICKY
        }

        val title    = intent?.getStringExtra("title")      ?: "Print in progress"
        val body     = intent?.getStringExtra("body")       ?: ""
        val progress = intent?.getIntExtra("progress", 0)  ?: 0

        // startForeground must be called within 5 s of service creation.
        // Subsequent calls with the same ID just update the notification.
        //
        // Android 14+ (API 34): the 3-arg overload is required when the manifest
        // declares foregroundServiceType.  We use FOREGROUND_SERVICE_TYPE_DATA_SYNC
        // because the printer is connected over Wi-Fi (TCP/IP).  On Android 15+
        // (API 35) the connectedDevice type is restricted to Bluetooth/NFC/USB;
        // using it for a network device causes ForegroundServiceStartNotAllowedException
        // which would crash the app.  The 3-arg overload exists from API 29.
        //
        // The try/catch below is a safety net: if startForeground() throws for any
        // reason (permission issue, Android version quirk, etc.) we log the error
        // and stop the service gracefully instead of crashing the whole app.
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                startForeground(
                    NOTIF_ID,
                    buildNotification(title, body, progress),
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
                )
            } else {
                startForeground(NOTIF_ID, buildNotification(title, body, progress))
            }
        } catch (e: Exception) {
            Log.e(TAG, "startForeground failed — stopping service: ${e.message}", e)
            stopSelf()
            return START_NOT_STICKY
        }
        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    // ── Helpers ───────────────────────────────────────────────────────────────

    private fun ensureChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val ch = NotificationChannel(
                CHANNEL_ID,
                "Print Progress",
                NotificationManager.IMPORTANCE_LOW   // silent, no heads-up
            ).apply {
                description  = "Ongoing print progress from BambooMobile"
                setShowBadge(false)
                setSound(null, null)
                enableVibration(false)
            }
            notifManager.createNotificationChannel(ch)
        }
    }

    private fun buildNotification(title: String, body: String, progress: Int): Notification {
        // Tap → bring the app to the foreground
        val launchIntent = packageManager
            .getLaunchIntentForPackage(packageName)
            ?.apply { flags = Intent.FLAG_ACTIVITY_SINGLE_TOP }
        val pi = PendingIntent.getActivity(
            this, 0, launchIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val builder = NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle(title)
            .setContentText(body)
            .setSmallIcon(R.drawable.ic_notification)
            .setOngoing(true)          // can't be swiped away
            .setSilent(true)           // no sound / vibration on update
            .setContentIntent(pi)
            .setCategory(NotificationCompat.CATEGORY_PROGRESS)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)

        // Show a native progress bar when we have a real percentage.
        // progress == 0 means the printer hasn't reported progress yet
        // (e.g. bed leveling, heatbed preheat) so we skip the bar rather
        // than showing a misleading empty one.
        if (progress > 0) {
            builder.setProgress(100, progress, false)
        }

        return builder.build()
    }
}
