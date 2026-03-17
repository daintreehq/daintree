import { useState, useEffect, useCallback } from "react";
import type { WebviewDialogRequest } from "@/components/Browser/WebviewDialog";

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
      window.electron.webview.registerPanel(webContentsId, panelId).catch(() => {
        // Registration failed — dialogs will fall back to native
      });
    } catch {
      // getWebContentsId() can throw if webview not attached
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
        .catch(() => {});

      setDialogQueue((prev) => prev.slice(1));
    },
    [dialogQueue]
  );

  return {
    currentDialog: dialogQueue[0] ?? null,
    handleDialogRespond,
  };
}
