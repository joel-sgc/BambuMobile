package com.joelsgc.bamboomobile

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationCompat
import org.eclipse.paho.client.mqttv3.IMqttDeliveryToken
import org.eclipse.paho.client.mqttv3.MqttCallbackExtended
import org.eclipse.paho.client.mqttv3.MqttClient
import org.eclipse.paho.client.mqttv3.MqttConnectOptions
import org.eclipse.paho.client.mqttv3.MqttMessage
import org.eclipse.paho.client.mqttv3.persist.MemoryPersistence
import org.json.JSONObject
import java.net.InetAddress
import java.net.Socket
import java.security.SecureRandom
import java.security.cert.X509Certificate
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLSocket
import javax.net.ssl.SSLSocketFactory
import javax.net.ssl.TrustManager
import javax.net.ssl.X509TrustManager

/**
 * Foreground service owning the persistent print-progress notification.
 *
 * ## Operating modes
 *
 * **Tauri mode** (normal): Rust calls startNotification / updateNotification.
 * This service just shows what it's told and keeps the process alive.
 *
 * **Standalone mode** (after swipe-away): Android kills the app but restarts
 * this service via START_STICKY (intent == null).  The service reads stored
 * credentials, opens a Paho MQTT connection to the printer, parses status, and
 * updates the notification entirely in Kotlin — no Tauri / WebView required.
 *
 * When Tauri reconnects it sends ACTION_TAURI_CONNECTED (via plain startService,
 * not startForegroundService) so we can cleanly exit standalone mode.
 * The same transition also happens implicitly when the first startNotification
 * intent arrives.
 */
class PrinterForegroundService : Service() {

    companion object {
        const val CHANNEL_ID             = "bamboo_print_progress"
        const val NOTIF_ID               = 42_001
        const val ACTION_STOP            = "STOP"
        const val ACTION_TAURI_CONNECTED = "TAURI_CONNECTED"
        const val PREFS_NAME             = "bamboo_printer"
        private const val TAG            = "PrinterForegroundSvc"
    }

    private lateinit var notifManager: NotificationManager

    private var mqttClient:      MqttClient? = null
    private var mqttThread:      Thread?     = null
    private var standaloneActive             = false

    // ── Service lifecycle ─────────────────────────────────────────────────────

    override fun onCreate() {
        super.onCreate()
        notifManager = getSystemService(NotificationManager::class.java)
        ensureChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {

        // ── STOP ──────────────────────────────────────────────────────────────
        if (intent?.action == ACTION_STOP) {
            stopStandalone()
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
            return START_NOT_STICKY
        }

        // ── Tauri reconnected — exit standalone mode ───────────────────────────
        // This intent is sent via plain startService(), so the service may or may
        // not already be running. If it wasn't running Android starts it here in
        // background mode (no startForeground() required within 5 s).
        if (intent?.action == ACTION_TAURI_CONNECTED) {
            if (standaloneActive) {
                stopStandalone()
                // Keep the service alive — Tauri will send startNotification
                // when printing starts; until then it's a lightweight stub.
                return START_STICKY
            } else {
                // Service wasn't doing anything — no need to keep it running.
                stopSelf()
                return START_NOT_STICKY
            }
        }

        // ── Tauri-driven update (normal path) ─────────────────────────────────
        if (intent != null && intent.hasExtra("title")) {
            if (standaloneActive) stopStandalone()   // hand control back to Tauri

            val title    = intent.getStringExtra("title")     ?: "Print in progress"
            val body     = intent.getStringExtra("body")      ?: ""
            val progress = intent.getIntExtra("progress", 0)
            return startFgSafe(buildNotification(title, body, progress))
        }

        // ── Android restart via START_STICKY (intent == null) ─────────────────
        if (!standaloneActive) {
            standaloneActive = true
            val rc = startFgSafe(buildNotification("Reconnecting to printer…", "", 0))
            if (rc == START_NOT_STICKY) return rc
            startStandaloneMqtt()
        }

        return START_STICKY
    }

    override fun onDestroy() {
        super.onDestroy()
        stopStandalone()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    // ── Standalone MQTT ───────────────────────────────────────────────────────

    private fun startStandaloneMqtt() {
        val prefs      = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val ip         = prefs.getString("ip",          null)
        val accessCode = prefs.getString("access_code", null)
        val serial     = prefs.getString("serial",      null)

        if (ip == null || accessCode == null || serial == null) {
            Log.w(TAG, "No stored credentials — stopping")
            stopSelf()
            return
        }

        Log.i(TAG, "Standalone MQTT → $ip  serial=$serial")

        mqttThread = Thread {
            val reportTopic  = "device/$serial/report"
            val requestTopic = "device/$serial/request"
            val pushall      =
                """{"pushing":{"sequence_id":"0","command":"pushall","version":1}}"""

            // Status fields parsed from MQTT messages
            var gcodeState    = ""
            var prevGcodeState = ""
            var layerNum      = 0
            var prevLayer     = -1
            var totalLayers   = 0
            var progress      = 0
            var remainingMins = 0
            var subtaskName   = ""
            var lastUpdateMs  = 0L
            var firstStatus   = true   // first message received?

            try {
                val sslSocketFactory = trustAllSslSocketFactory()
                val clientId = "bamboo-svc-${System.currentTimeMillis() % 1_000_000}"
                val client   = MqttClient("ssl://$ip:8883", clientId, MemoryPersistence())
                mqttClient   = client

                client.setCallback(object : MqttCallbackExtended {
                    override fun connectComplete(reconnect: Boolean, serverURI: String?) {
                        Log.i(TAG, "Standalone MQTT connected (reconnect=$reconnect)")
                        try {
                            client.subscribe(reportTopic, 0)
                            client.publish(
                                requestTopic,
                                MqttMessage(pushall.toByteArray()).apply { qos = 0 }
                            )
                        } catch (e: Exception) {
                            Log.w(TAG, "subscribe/publish failed: ${e.message}")
                        }
                    }

                    override fun connectionLost(cause: Throwable?) {
                        Log.w(TAG, "Standalone MQTT lost: ${cause?.message}")
                        // isAutomaticReconnect handles the retry
                    }

                    override fun messageArrived(topic: String?, msg: MqttMessage?) {
                        val payload = msg?.payload ?: return
                        try {
                            val json  = JSONObject(String(payload))
                            val print = json.optJSONObject("print") ?: return

                            if (print.has("gcode_state"))       gcodeState    = print.getString("gcode_state")
                            if (print.has("layer_num"))         layerNum      = print.optInt("layer_num",         layerNum)
                            if (print.has("total_layer_num"))   totalLayers   = print.optInt("total_layer_num",   totalLayers)
                            if (print.has("mc_percent"))        progress      = print.optInt("mc_percent",        progress)
                            if (print.has("mc_remaining_time")) remainingMins = print.optInt("mc_remaining_time", remainingMins)
                            if (print.has("subtask_name"))      subtaskName   = print.optString("subtask_name",   subtaskName)

                            // On the very first status message: if the printer is idle,
                            // there's nothing to track — stop the service.
                            if (firstStatus) {
                                firstStatus = false
                                if (gcodeState != "RUNNING" && gcodeState != "PAUSE") {
                                    Log.i(TAG, "Printer idle on start ($gcodeState) — stopping")
                                    clearStoredCredentials()
                                    stopSelf()
                                    return
                                }
                            }

                            // Rate-limit: update on layer change or every 10 s
                            val now          = System.currentTimeMillis()
                            val layerChanged = layerNum != prevLayer
                            prevLayer        = layerNum

                            val jobName = if (subtaskName.isNotEmpty()) subtaskName
                                          else "Print in progress"

                            when (gcodeState) {
                                "RUNNING" -> {
                                    if (layerChanged || now - lastUpdateMs >= 10_000) {
                                        val body = buildBody(layerNum, totalLayers, progress, remainingMins)
                                        updateNotif("Printing: $jobName", body, progress)
                                        lastUpdateMs = now
                                    }
                                }
                                "PAUSE" -> {
                                    if (prevGcodeState != "PAUSE" || now - lastUpdateMs >= 10_000) {
                                        val body = buildBody(layerNum, totalLayers, progress, remainingMins)
                                        updateNotif("Paused: $jobName",
                                            body.ifEmpty { "$progress%" }, progress)
                                        lastUpdateMs = now
                                    }
                                }
                                else -> {
                                    // Print finished or cancelled
                                    if (prevGcodeState == "RUNNING" || prevGcodeState == "PAUSE") {
                                        Log.i(TAG, "Print ended ($gcodeState) — stopping service")
                                        clearStoredCredentials()
                                        stopSelf()
                                    }
                                }
                            }

                            prevGcodeState = gcodeState

                        } catch (e: Exception) {
                            Log.w(TAG, "MQTT message parse error: ${e.message}")
                        }
                    }

                    override fun deliveryComplete(token: IMqttDeliveryToken?) {}
                })

                val opts = MqttConnectOptions().apply {
                    userName             = "bblp"
                    password             = accessCode.toCharArray()
                    connectionTimeout    = 15
                    keepAliveInterval    = 15
                    socketFactory        = sslSocketFactory
                    isCleanSession       = true
                    isAutomaticReconnect = true
                    maxReconnectDelay    = 15_000
                }

                // Retry initial connection until interrupted.
                // Catch *all* exceptions so an SSLHandshakeException or similar
                // doesn't silently exit the loop on the first attempt.
                var connected = false
                while (!connected && !Thread.currentThread().isInterrupted) {
                    try {
                        client.connect(opts)
                        connected = true
                    } catch (ie: InterruptedException) {
                        break
                    } catch (e: Exception) {
                        Log.w(TAG, "MQTT connect failed (${e.javaClass.simpleName}): ${e.message}, retrying in 15 s")
                        try { Thread.sleep(15_000) }
                        catch (ie: InterruptedException) { break }
                    }
                }

                // Keep thread alive while MQTT runs (Paho callbacks on its own threads)
                while (!Thread.currentThread().isInterrupted) {
                    Thread.sleep(2_000)
                }

            } catch (e: InterruptedException) {
                Log.d(TAG, "MQTT thread interrupted")
            } catch (e: Exception) {
                Log.e(TAG, "MQTT thread fatal: ${e.message}", e)
            } finally {
                try { mqttClient?.disconnectForcibly(0, 500) } catch (_: Exception) {}
                mqttClient = null
            }
        }.also {
            it.isDaemon = true
            it.name     = "bamboo-mqtt-svc"
            it.start()
        }
    }

    private fun stopStandalone() {
        standaloneActive = false
        mqttThread?.interrupt()
        mqttThread = null
        try { mqttClient?.disconnectForcibly(0, 500) } catch (_: Exception) {}
        mqttClient = null
    }

    private fun clearStoredCredentials() {
        getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE).edit().clear().apply()
    }

    private fun updateNotif(title: String, body: String, progress: Int) {
        notifManager.notify(NOTIF_ID, buildNotification(title, body, progress))
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    private fun startFgSafe(notification: Notification): Int {
        return try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                startForeground(NOTIF_ID, notification,
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
            } else {
                startForeground(NOTIF_ID, notification)
            }
            START_STICKY
        } catch (e: Exception) {
            Log.e(TAG, "startForeground failed: ${e.message}", e)
            stopSelf()
            START_NOT_STICKY
        }
    }

    private fun buildBody(
        layer: Int, totalLayers: Int, progress: Int, remainingMins: Int
    ): String {
        val parts = mutableListOf<String>()
        if (totalLayers > 0)   parts.add("Layer $layer/$totalLayers")
        if (progress > 0)      parts.add("$progress%")
        if (remainingMins > 0) {
            val h = remainingMins / 60
            val m = remainingMins % 60
            parts.add(when {
                h > 0 && m > 0 -> "${h}h ${m}m left"
                h > 0          -> "${h}h left"
                else           -> "${m}m left"
            })
        }
        return parts.joinToString(" · ")
    }

    /**
     * SSLSocketFactory that accepts any certificate AND disables endpoint
     * identification (hostname verification).  Bambu printers use a self-signed
     * certificate issued to the printer serial number, not the IP address, so
     * standard hostname verification always fails.
     */
    private fun trustAllSslSocketFactory(): SSLSocketFactory {
        val trustAll = arrayOf<TrustManager>(object : X509TrustManager {
            override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) {}
            override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) {}
            override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
        })
        // Use TLSv1.2 explicitly — Bambu printers may not support TLS 1.3.
        val ctx = SSLContext.getInstance("TLSv1.2").also {
            it.init(null, trustAll, SecureRandom())
        }
        val base = ctx.socketFactory

        // Wrap to clear endpointIdentificationAlgorithm on every socket so the
        // JVM's built-in hostname check is also bypassed.
        return object : SSLSocketFactory() {
            override fun getDefaultCipherSuites(): Array<String> = base.defaultCipherSuites
            override fun getSupportedCipherSuites(): Array<String> = base.supportedCipherSuites

            private fun configure(s: Socket): Socket {
                (s as? SSLSocket)?.sslParameters =
                    (s as? SSLSocket)?.sslParameters?.also {
                        it.endpointIdentificationAlgorithm = ""
                    }
                return s
            }

            override fun createSocket(): Socket =
                configure(base.createSocket())

            override fun createSocket(s: Socket, host: String, port: Int, autoClose: Boolean): Socket =
                configure(base.createSocket(s, host, port, autoClose))

            override fun createSocket(host: String, port: Int): Socket =
                configure(base.createSocket(host, port))

            override fun createSocket(host: String, port: Int, localHost: InetAddress, localPort: Int): Socket =
                configure(base.createSocket(host, port, localHost, localPort))

            override fun createSocket(host: InetAddress, port: Int): Socket =
                configure(base.createSocket(host, port))

            override fun createSocket(address: InetAddress, port: Int, localAddress: InetAddress, localPort: Int): Socket =
                configure(base.createSocket(address, port, localAddress, localPort))
        }
    }

    private fun ensureChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val ch = NotificationChannel(
                CHANNEL_ID,
                "Print Progress",
                NotificationManager.IMPORTANCE_LOW
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
            .setOngoing(true)
            .setSilent(true)
            .setContentIntent(pi)
            .setCategory(NotificationCompat.CATEGORY_PROGRESS)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)

        if (progress > 0) {
            builder.setProgress(100, progress, false)
        }

        return builder.build()
    }
}
