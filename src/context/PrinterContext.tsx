import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { createChannel, Importance, Visibility } from '@tauri-apps/plugin-notification';
import type { PrinterStatus } from '../vite-env';

// ── Types ─────────────────────────────────────────────────────────────────────

interface PrinterContextValue {
  /** Latest snapshot of printer state, null until first update arrives. */
  status: PrinterStatus | null;
  /** Latest camera frame as a data-URI, null until first frame arrives. */
  frameData: string | null;
  /** Re-fetch status from the Rust side (e.g. pull-to-refresh). */
  refresh: () => Promise<void>;
}

// ── Context ───────────────────────────────────────────────────────────────────

const PrinterContext = createContext<PrinterContextValue>({
  status: null,
  frameData: null,
  refresh: async () => {},
});

export function usePrinter() {
  return useContext(PrinterContext);
}

// ── Foreground-service notification helpers ───────────────────────────────────
//
// On Android these invoke the PrintNotificationPlugin which starts / updates /
// stops the PrinterForegroundService.  On every other platform the invoke
// throws (plugin not registered) and we silently swallow the error — no
// foreground service exists on desktop / iOS.

const NOTIF_PLUGIN = 'plugin:printNotification';

// Tauri IPC requires snake_case command names: it converts them to lowerCamelCase
// before dispatching to Android's PluginManager, where the Kotlin method names
// match the camelCase form (startNotification, updateNotification, stopNotification).
async function notifStart(title: string, body: string) {
  await invoke(`${NOTIF_PLUGIN}|start_notification`, { title, body }).catch((e) =>
    console.error('[PrintNotif] start_notification failed:', e),
  );
}

async function notifUpdate(title: string, body: string) {
  await invoke(`${NOTIF_PLUGIN}|update_notification`, { title, body }).catch((e) =>
    console.error('[PrintNotif] update_notification failed:', e),
  );
}

async function notifStop() {
  await invoke(`${NOTIF_PLUGIN}|stop_notification`).catch((e) =>
    console.error('[PrintNotif] stop_notification failed:', e),
  );
}

/**
 * Pre-create the print-progress notification channel so it is visible in
 * Android Settings → App → Notifications immediately on first launch,
 * not only after the first print starts (which is when the foreground service
 * would otherwise create it lazily).  No-op on desktop / iOS.
 */
async function ensurePrintChannel() {
  await createChannel({
    id: 'bamboo_print_progress',
    name: 'Print Progress',
    description: 'Ongoing print progress from BambooMobile',
    importance: Importance.Low,   // silent — no heads-up, no sound
    visibility: Visibility.Public,
    vibration: false,
  }).catch(() => {}); // swallow — non-Android platforms throw here, that's expected
}

/** Formats layer / progress / ETA into a compact notification body string. */
function buildNotifBody(s: PrinterStatus): string {
  const parts: string[] = [];
  if (s.total_layer_num > 0) {
    parts.push(`Layer ${s.layer_num}/${s.total_layer_num}`);
  }
  if (s.progress > 0) {
    parts.push(`${s.progress}%`);
  }
  if (s.remaining_mins > 0) {
    const h = Math.floor(s.remaining_mins / 60);
    const m = s.remaining_mins % 60;
    if (h > 0) {
      parts.push(m > 0 ? `${h}h ${m}m left` : `${h}h left`);
    } else {
      parts.push(`${m}m left`);
    }
  }
  return parts.join(' · ');
}

// ── Provider ──────────────────────────────────────────────────────────────────

/**
 * Mount once around the connected UI.  Subscribes to `printer-status` and
 * `camera-frame` exactly once for the lifetime of the provider, so navigating
 * between pages never causes a flash of stale / missing data.
 *
 * Also drives the Android foreground-service notification:
 *  • RUNNING  → start / update the persistent notification per layer change
 *  • PAUSE    → update the notification to show "Paused"
 *  • anything else after RUNNING/PAUSE → stop the notification
 */
export function PrinterProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<PrinterStatus | null>(null);
  const [frameData, setFrameData] = useState<string | null>(null);

  // Stable reference so consumers (PullToRefresh etc.) don't re-render when
  // the component re-renders for unrelated reasons.
  const refresh = useCallback(async () => {
    await invoke<PrinterStatus>('get_status')
      .then(setStatus)
      .catch(() => {});
  }, []);

  // Track the refresh function in a ref so the visibility handler closure
  // always calls the latest version without needing to be recreated.
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  // Notification state tracking — refs so they don't trigger re-renders.
  const prevGcodeStateRef = useRef('');
  const prevLayerRef      = useRef(0);
  // Timestamp of the last time we called notifStart or notifUpdate.
  // Used to re-post the notification on a minimum interval so it reappears
  // quickly after the user swipes it away (Android 14+ allows dismissing
  // foreground-service notifications regardless of setOngoing(true)).
  const lastNotifAtRef    = useRef(0);

  // ── Foreground-service notification: driven by every status update ──────────
  useEffect(() => {
    if (!status) return;

    const prev  = prevGcodeStateRef.current;
    const next  = status.gcode_state;
    const layerChanged = status.layer_num !== prevLayerRef.current;

    prevGcodeStateRef.current = next;
    prevLayerRef.current      = status.layer_num;

    const jobName = status.subtask_name || 'Print in progress';

    if (next === 'RUNNING') {
      const body = buildNotifBody(status);
      const now  = Date.now();
      if (prev !== 'RUNNING') {
        // Just started (or resumed from pause) — spin up the service.
        notifStart(`Printing: ${jobName}`, body);
        lastNotifAtRef.current = now;
      } else if (layerChanged || now - lastNotifAtRef.current >= 10_000) {
        // Update on each new layer, OR at least every 10 seconds.
        //
        // The time-based trigger serves a second purpose: on Android 14+,
        // users can swipe away a foreground-service notification even when
        // setOngoing(true) is set.  Calling startForeground() via
        // notifUpdate() re-posts the notification, so the 10-second cadence
        // ensures it reappears within 10 s of being dismissed.
        notifUpdate(`Printing: ${jobName}`, body);
        lastNotifAtRef.current = now;
      }
    } else if (next === 'PAUSE') {
      const body = buildNotifBody(status);
      const now  = Date.now();
      if (prev !== 'PAUSE') {
        // Freshly paused — update title and reset the re-post timer.
        notifUpdate(`Paused: ${jobName}`, body || `${status.progress}%`);
        lastNotifAtRef.current = now;
      } else if (now - lastNotifAtRef.current >= 10_000) {
        // Re-post every 10 s while paused so a dismissed notification comes back.
        notifUpdate(`Paused: ${jobName}`, body || `${status.progress}%`);
        lastNotifAtRef.current = now;
      }
    } else if (
      next !== 'RUNNING' &&
      next !== 'PAUSE' &&
      (prev === 'RUNNING' || prev === 'PAUSE')
    ) {
      // Print ended (FINISH, FAILED, or unexpected) — tear down the service.
      notifStop();
    }
  }, [status]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    // Pre-create the notification channel so it appears in Android Settings
    // from the very first launch, before any print has ever started.
    ensurePrintChannel();

    // Populate status immediately — pages read a non-null value on first render.
    refresh();

    // Re-populate when the app returns to the foreground after being backgrounded.
    const onVisible = () => {
      if (document.visibilityState === 'visible') refreshRef.current();
    };
    document.addEventListener('visibilitychange', onVisible);

    // Subscribe to live MQTT events once for the lifetime of the provider.
    // Navigating between pages does NOT tear these down.
    const unlistenStatus = listen<PrinterStatus>('printer-status', (e) =>
      setStatus(e.payload),
    );
    const unlistenCamera = listen<string>('camera-frame', (e) =>
      setFrameData(`data:image/jpeg;base64,${e.payload}`),
    );

    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      unlistenStatus.then((f) => f());
      unlistenCamera.then((f) => f());
      // Clean up notification if the provider is ever torn down mid-print.
      notifStop();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <PrinterContext.Provider value={{ status, frameData, refresh }}>
      {children}
    </PrinterContext.Provider>
  );
}
