import { useEffect } from "react";
import { notify } from "@/lib/notify";
import { safeFireAndForget } from "@/utils/safeFireAndForget";
import type { MainProcessToastPayload } from "@shared/types/ipc/maps";
import { useDistributionStore } from "@/store/distributionStore";

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
                if (useDistributionStore.getState().isWindowsStore) return;
                safeFireAndForget(window.electron.update.checkForUpdates(), {
                  context: "Checking for updates from toast action",
                });
              } else if (ipcChannel === "clipboard:write-text") {
                // Guard against a main-process payload that forgot `data` —
                // silently clearing the clipboard would be a footgun.
                if (!data) {
                  console.warn("[MainProcessToast] clipboard:write-text missing data payload");
                  return;
                }
                safeFireAndForget(window.electron.clipboard.writeText(data), {
                  context: "Writing clipboard text from toast action",
                });
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
        rateLimitKey: payload.rateLimitKey,
        action,
      });
    });

    return cleanup;
  }, []);
}
