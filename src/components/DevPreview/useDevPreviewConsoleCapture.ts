import { useEffect } from "react";
import { useConsoleCaptureStore } from "@/store/consoleCaptureStore";
import { usePanelStore } from "@/store";
import { safeFireAndForget } from "@/utils/safeFireAndForget";

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
): void {
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
    const started = window.electron.webview
      .registerPanel(webContentsId, paneId)
      .then(() => window.electron.webview.startConsoleCapture(webContentsId, paneId));
    safeFireAndForget(started, { context: "Starting dev-preview console capture" });

    const store = useConsoleCaptureStore.getState();

    const offMessage = window.electron.webview.onConsoleMessage((row) => {
      if (row.paneId !== paneId) return;
      store.addStructuredMessage(row);
    });

    const offCleared = window.electron.webview.onConsoleContextCleared(
      ({ paneId: clearedPaneId, navigationGeneration }) => {
        if (clearedPaneId !== paneId) return;
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
        .then(() => window.electron.webview.stopConsoleCapture(webContentsId, paneId));
      safeFireAndForget(stopped, { context: "Stopping dev-preview console capture" });
    };
  }, [paneId, webviewElement, isWebviewReady, isEvicted]);

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
}
