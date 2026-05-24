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

// ── Provider ──────────────────────────────────────────────────────────────────

/**
 * Mount once around the connected UI.  Subscribes to `printer-status` and
 * `camera-frame` exactly once for the lifetime of the provider, so navigating
 * between pages never causes a flash of stale / missing data.
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

  useEffect(() => {
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
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <PrinterContext.Provider value={{ status, frameData, refresh }}>
      {children}
    </PrinterContext.Provider>
  );
}
