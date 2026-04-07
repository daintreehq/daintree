import { useEffect, useRef } from "react";
import { usePanelStore } from "@/store";

/**
 * Freezes a webview's JS execution via CDP when the panel is in the dock
 * and not the currently-open dock panel. Unfreezes immediately when the panel
 * becomes visible (dock popover opened or restored to grid).
 *
 * Uses `Page.setWebLifecycleState` via the main process CDP debugger because
 * it provides a full JS lifecycle freeze — stronger than the timer/frame
 * throttling that `webContents.setBackgroundThrottling` applies.
 */
export function useWebviewThrottle(
  panelId: string,
  location: string,
  webviewElement: Electron.WebviewTag | null,
  isWebviewReady: boolean
): void {
  const activeDockTerminalId = usePanelStore((s) => s.activeDockTerminalId);
  const freezeTimerRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    if (!webviewElement || !isWebviewReady) return;

    const shouldFreeze = location === "dock" && activeDockTerminalId !== panelId;

    if (freezeTimerRef.current) {
      clearTimeout(freezeTimerRef.current);
      freezeTimerRef.current = null;
    }

    if (!shouldFreeze) {
      // Unfreeze immediately so panel content is responsive when user sees it.
      let webContentsId: number;
      try {
        webContentsId = webviewElement.getWebContentsId();
      } catch {
        return;
      }
      void window.electron.webview.setLifecycleState(webContentsId, false);
      return;
    }

    // Delay freeze to avoid rapid churn during panel transitions.
    freezeTimerRef.current = setTimeout(() => {
      freezeTimerRef.current = null;
      let webContentsId: number;
      try {
        webContentsId = webviewElement.getWebContentsId();
      } catch {
        return;
      }
      void window.electron.webview.setLifecycleState(webContentsId, true);
    }, 500);

    return () => {
      if (freezeTimerRef.current) {
        clearTimeout(freezeTimerRef.current);
        freezeTimerRef.current = null;
      }
    };
  }, [panelId, location, activeDockTerminalId, webviewElement, isWebviewReady]);
}
