import { useState, useEffect, useCallback } from "react";
import type { WebviewDialogRequest } from "@/components/Browser/WebviewDialog";
import { logError, logWarn } from "@/utils/logger";
import { notify } from "@/lib/notify";

export function useWebviewDialog(
  panelId: string,
  webviewElement: Electron.WebviewTag | null,
  isWebviewReady: boolean
) {
  const [dialogQueue, setDialogQueue] = useState<WebviewDialogRequest[]>([]);

  // Register panel with main process when webview is ready
  useEffect(() => {
    if (!webviewElement || !isWebviewReady) return;
    try {
      const webContentsId = webviewElement.getWebContentsId();
      window.electron.webview.registerPanel(webContentsId, panelId).catch((err) => {
        // Registration failed — dialogs will fall back to native. Surface at
        // warn (not error) since native fallback is a working UX, not broken.
        logWarn("Webview dialog registration failed", {
          panelId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    } catch {
      // Intentional: getWebContentsId() throws when the webview isn't attached
      // yet — the next ready cycle re-runs this effect.
    }
  }, [panelId, webviewElement, isWebviewReady]);

  // Subscribe to dialog requests for this panel
  useEffect(() => {
    const cleanup = window.electron.webview.onDialogRequest((payload) => {
      if (payload.panelId === panelId) {
        setDialogQueue((prev) => [...prev, payload]);
      }
    });
    return cleanup;
  }, [panelId]);

  const handleDialogRespond = useCallback(
    (confirmed: boolean, response?: string) => {
      const current = dialogQueue[0];
      if (!current) return;

      window.electron.webview
        .respondToDialog(current.dialogId, confirmed, response)
        .catch((err) => {
          // The blocking JS dialog never gets answered if respondToDialog
          // rejects — the page hangs. Surface to the user with a sticky
          // error toast so they know the panel may need reloading.
          logError("Webview dialog response failed", err, {
            panelId,
            dialogId: current.dialogId,
          });
          notify({
            type: "error",
            title: "Dialog response failed",
            message:
              "Couldn't send a response to the page dialog. The page may be unresponsive — try reloading the panel.",
            priority: "high",
            duration: 0,
            context: { panelId },
          });
        });

      setDialogQueue((prev) => prev.slice(1));
    },
    [dialogQueue]
  );

  return {
    currentDialog: dialogQueue[0] ?? null,
    handleDialogRespond,
  };
}
