import { useState, useEffect, useLayoutEffect, useCallback, useRef } from "react";
import type { WebviewDialogRequest } from "@/components/Browser/WebviewDialog";
import { restoreFocusTo } from "@/lib/accessibility";
import { logError, logWarn } from "@/utils/logger";
import { notify } from "@/lib/notify";
import { formatErrorMessage } from "@shared/utils/errorMessage";

export function useWebviewDialog(
  panelId: string,
  webviewElement: Electron.WebviewTag | null,
  isWebviewReady: boolean,
  kind?: string
) {
  const [dialogQueue, setDialogQueue] = useState<WebviewDialogRequest[]>([]);

  const previousActiveElementRef = useRef<HTMLElement | null>(null);
  const hadDialogRef = useRef(false);
  const webviewElementRef = useRef(webviewElement);
  const hasDialog = dialogQueue.length > 0;

  // Declared before the queue-transition effect below so a commit that swaps the
  // webview and drains the queue together restores to the current node.
  useLayoutEffect(() => {
    webviewElementRef.current = webviewElement;
  }, [webviewElement]);

  const restoreFocus = useCallback(() => {
    const previous = previousActiveElementRef.current;
    previousActiveElementRef.current = null;

    // Only restore if this dialog still owned focus. Tearing down the overlay
    // detaches whatever it had focused, which leaves activeElement on <body> —
    // that's the signal restoration is needed. Anything else connected means
    // focus already moved on (another pane, another dialog, a click elsewhere)
    // and dragging it back to our opener would steal it.
    const active = document.activeElement;
    if (active && active !== document.body && document.contains(active)) return;

    // Falls back to the webview so the guest page gets keyboard input back when
    // whatever opened the dialog is gone (guest crash, panel teardown).
    restoreFocusTo(previous, webviewElementRef.current);
  }, []);

  // A queue of dialogs is one modal session: capture on the empty -> non-empty
  // edge and restore on non-empty -> empty, so advancing between queued dialogs
  // neither recaptures (which would record the previous dialog's own OK button)
  // nor restores early. Layout effect so the capture reads document.activeElement
  // before WebviewDialog's rAF-deferred autofocus moves it into the overlay.
  useLayoutEffect(() => {
    if (hasDialog === hadDialogRef.current) return;
    hadDialogRef.current = hasDialog;

    if (hasDialog) {
      const active = document.activeElement;
      previousActiveElementRef.current =
        active instanceof HTMLElement && active !== document.body ? active : null;
    } else {
      restoreFocus();
    }
  }, [hasDialog, restoreFocus]);

  // Unmounting while a dialog is open skips the non-empty -> empty edge entirely,
  // stranding focus on a control that no longer exists. Kept separate from
  // `hasDialog` (a captured null is legitimate when focus was on <body>, so the
  // captured element can't double as the "restore armed" flag).
  useEffect(() => {
    return () => {
      if (!hadDialogRef.current) return;
      hadDialogRef.current = false;
      restoreFocus();
    };
  }, [restoreFocus]);

  // Register panel with main process when webview is ready
  useEffect(() => {
    if (!webviewElement || !isWebviewReady) return;
    try {
      const webContentsId = webviewElement.getWebContentsId();
      window.electron.webview.registerPanel(webContentsId, panelId, kind).catch((err) => {
        // Registration failed — dialogs will fall back to native. Surface at
        // warn (not error) since native fallback is a working UX, not broken.
        logWarn("Webview dialog registration failed", {
          panelId,
          error: formatErrorMessage(err, "Panel registration failed"),
        });
      });
    } catch {
      // Intentional: getWebContentsId() throws when the webview isn't attached
      // yet — the next ready cycle re-runs this effect.
    }
  }, [panelId, webviewElement, isWebviewReady, kind]);

  // Subscribe to dialog requests for this panel
  useEffect(() => {
    const cleanup = window.electron.webview.onDialogRequest((payload) => {
      if (payload.panelId === panelId) {
        setDialogQueue((prev) => [...prev, payload]);
      }
    });
    return cleanup;
  }, [panelId]);

  // Clear queued dialogs when the guest navigates away or its renderer crashes —
  // the page context backing those dialogs no longer exists, so their overlays
  // are stale and can never receive a meaningful response.
  useEffect(() => {
    const cleanup = window.electron.webview.onDialogDismiss((payload) => {
      if (payload.panelId === panelId) {
        setDialogQueue([]);
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
          // eslint-disable-next-line no-restricted-syntax -- notify-no-action: ok
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
    [dialogQueue, panelId]
  );

  return {
    currentDialog: dialogQueue[0] ?? null,
    handleDialogRespond,
  };
}
