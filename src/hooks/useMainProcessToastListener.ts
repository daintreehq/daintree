import { useEffect } from "react";
import { notify } from "@/lib/notify";
import type { MainProcessToastPayload } from "@shared/types/ipc/maps";

export function useMainProcessToastListener(): void {
  useEffect(() => {
    if (!window.electron?.notification?.onShowToast) return;

    const cleanup = window.electron.notification.onShowToast((payload: MainProcessToastPayload) => {
      const action = payload.action
        ? {
            label: payload.action.label,
            onClick: () => {
              const { ipcChannel, data } = payload.action!;
              if (ipcChannel === "update:check-for-updates") {
                window.electron.update.checkForUpdates();
              } else if (ipcChannel === "clipboard:write-text") {
                // Guard against a main-process payload that forgot `data` —
                // silently clearing the clipboard would be a footgun.
                if (!data) {
                  console.warn("[MainProcessToast] clipboard:write-text missing data payload");
                  return;
                }
                void window.electron.clipboard.writeText(data);
              } else {
                console.warn(`[MainProcessToast] Unknown IPC channel for action: ${ipcChannel}`);
              }
            },
          }
        : undefined;

      notify({
        type: payload.type,
        title: payload.title,
        message: payload.message,
        action,
      });
    });

    return cleanup;
  }, []);
}
