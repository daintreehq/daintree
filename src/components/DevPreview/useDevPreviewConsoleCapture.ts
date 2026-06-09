import { useCallback, useEffect, useRef, useState } from "react";
import { useConsoleCaptureStore } from "@/store/consoleCaptureStore";
import { usePanelStore } from "@/store";
import { safeFireAndForget } from "@/utils/safeFireAndForget";

/**
 * Vite's HMR client logs these JS console errors when its WebSocket can't
 * connect (custom `server.hmr.host`/`clientPort`/`protocol` pointing the
 * browser socket off the stable proxy origin) or drops after connecting.
 * They arrive through the same CDP console-capture stream as every other
 * guest row, so matching them is the only browser-side signal we get that
 * live reload is dead while the server keeps logging `[vite] hmr update`
 * (which fires the misleading "Compiling" phase). Native Chromium socket
 * errors (`net::ERR_CONNECTION_REFUSED`) bypass the JS console channel, so
 * detection depends on Vite reaching the point of logging the failure.
 */
const VITE_HMR_FAILURE_PATTERN =
  /\[vite\] (failed to connect to websocket|server connection lost)/i;

function isViteHmrFailureMessage(summaryText: string): boolean {
  return VITE_HMR_FAILURE_PATTERN.test(summaryText);
}

export interface DevPreviewConsoleCapture {
  /**
   * `true` once Vite has reported its HMR socket as dead for this pane.
   * Sticky until `resetHmrDead` is called (on reload / restart / stop) so a
   * single failure row keeps the warning up while the webview stays stale.
   * Lives in component state, so it resets on a grid tab-switch unmount; the
   * captured rows survive in the store, and Vite re-logs on the next failed
   * poll, so the worst case is a transient gap in the warning, not a stuck
   * webview without any console trail.
   */
  hmrDead: boolean;
  resetHmrDead: () => void;
}

/**
 * Wires the main-process CDP console-capture pipeline to the renderer
 * `consoleCaptureStore` for a single dev-preview panel.
 *
 * Capture starts while the webview is mounted and stops on unmount or eviction.
 * `isWebviewReady` is a retry signal for the rare window where the element is
 * mounted but its WebContents ID is not available yet.
 *
 * Both IPC subscriptions filter by `paneId`: `onConsoleMessage` is a global
 * stream keyed by `row.paneId`, so an unfiltered handler in multiple mounted
 * panes would duplicate every row.
 */
export function useDevPreviewConsoleCapture(
  paneId: string,
  webviewElement: Electron.WebviewTag | null,
  isWebviewReady: boolean,
  isEvicted: boolean
): DevPreviewConsoleCapture {
  const [hmrDead, setHmrDead] = useState(false);
  const resetHmrDead = useCallback(() => setHmrDead(false), []);
  // The newest navigation generation observed for this pane. A dev-server
  // restart leaves the old guest page polling and logging `[vite] server
  // connection lost` from its now-defunct generation; once the page reloads
  // into the fresh server the context clears and this advances. Gating
  // `setHmrDead(true)` on the current generation keeps those stale, lower-
  // generation failures from resurrecting the banner over a healthy reload.
  const currentGenerationRef = useRef(0);
  const activeCaptureTokenRef = useRef<symbol | null>(null);

  useEffect(() => {
    if (!webviewElement || isEvicted) return;

    let webContentsId: number;
    try {
      webContentsId = webviewElement.getWebContentsId();
    } catch {
      // WebContents not attached yet — the next ready/evicted transition retries.
      return;
    }

    // The main-process capture handler rejects unregistered guest webContents
    // for ownership safety. Register here before starting capture instead of
    // relying on useWebviewDialog's separate effect ordering.
    // Chain stop after start settles so a fast ready→evict cycle can't let a
    // slow startConsoleCapture resolve after cleanup already fired, which
    // would leave a CDP session attached with nothing to detach it.
    const captureToken = Symbol("dev-preview-console-capture");
    activeCaptureTokenRef.current = captureToken;
    const started = window.electron.webview
      .registerPanel(webContentsId, paneId)
      .then(() => window.electron.webview.startConsoleCapture(webContentsId, paneId));
    safeFireAndForget(started, { context: "Starting dev-preview console capture" });

    const store = useConsoleCaptureStore.getState();

    const offMessage = window.electron.webview.onConsoleMessage((row) => {
      if (row.paneId !== paneId) return;
      if (
        isViteHmrFailureMessage(row.summaryText) &&
        row.navigationGeneration >= currentGenerationRef.current
      ) {
        setHmrDead(true);
      }
      store.addStructuredMessage(row);
    });

    const offCleared = window.electron.webview.onConsoleContextCleared(
      ({ paneId: clearedPaneId, navigationGeneration }) => {
        if (clearedPaneId !== paneId) return;
        // A cleared execution context means the guest page reloaded or
        // navigated, so any prior HMR-dead observation is stale. If the socket
        // is still misconfigured, Vite re-logs the failure in the new context
        // and we flip back. This is the reset point for user-driven reloads.
        // Advance the generation first so late stragglers from the old page
        // can't re-arm the banner after the reset.
        currentGenerationRef.current = navigationGeneration;
        setHmrDead(false);
        store.markStale(paneId, navigationGeneration);
      }
    );

    return () => {
      offMessage();
      offCleared();
      const stopped = started
        .catch(() => {
          // Start failure is already reported above; swallow it here so the
          // sequencing chain still reaches the stop call.
        })
        .then(() => {
          if (activeCaptureTokenRef.current !== captureToken) return;
          activeCaptureTokenRef.current = null;
          return window.electron.webview.stopConsoleCapture(webContentsId, paneId);
        });
      safeFireAndForget(stopped, { context: "Stopping dev-preview console capture" });
    };
  }, [paneId, webviewElement, isWebviewReady, isEvicted]);

  // Release the buffered rows while the pane is evicted. Capture is already
  // gated off above when evicted, so the 500-row buffer would otherwise sit in
  // the store referencing now-dead CDP objectIds for the duration of eviction.
  // Capture restarts fresh on de-eviction, so nothing is lost beyond the
  // eviction event itself.
  useEffect(() => {
    if (isEvicted) {
      useConsoleCaptureStore.getState().clearMessages(paneId);
    }
  }, [paneId, isEvicted]);

  // Drop this pane's buffered rows + counts only when the panel is gone for
  // good. Unmount alone is not deletion: a DevPreview panel in a grid tab
  // group fully unmounts when another tab is activated, and we must keep its
  // captured rows so they survive a tab switch. By cleanup time a deleted
  // panel is already absent from the panel registry, so its absence is the
  // signal that this is a real teardown rather than a deactivation.
  useEffect(() => {
    return () => {
      if (!usePanelStore.getState().panelsById?.[paneId]) {
        useConsoleCaptureStore.getState().removePane(paneId);
      }
    };
  }, [paneId]);

  return { hmrDead, resetHmrDead };
}
