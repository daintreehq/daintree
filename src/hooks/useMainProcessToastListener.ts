import { useEffect } from "react";
import { notify } from "@/lib/notify";
import type { MainProcessToastPayload } from "@shared/types/ipc/maps";

export function useMainProcessToastListener(): void {
  useEffect(() => {
    if (!window.electron?.notification?.onShowToast) return;

    const cleanup = window.electron.notification.onShowToast(
      (payload: MainProcessToastPayload) => {
        const action = payload.action
          ? {
              label: payload.action.label,
              onClick: () => {
                if (payload.action!.ipcChannel === "update:check-for-updates") {
                  window.electron.update.checkForUpdates();
                } else {
                  console.warn(
                    `[MainProcessToast] Unknown IPC channel for action: ${payload.action!.ipcChannel}`
                  );
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
      }
    );

    return cleanup;
  }, []);
}
