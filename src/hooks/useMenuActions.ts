import { useEffect } from "react";
import { isElectronAvailable } from "./useElectron";
import { actionService } from "@/services/ActionService";
import { logError } from "@/utils/logger";
import { isStagedConfirmation } from "@/services/actions/confirmationStaged";

export function useMenuActions(): void {
  useEffect(() => {
    if (!isElectronAvailable()) return;
    if (typeof window.electron?.app?.onMenuAction !== "function") return;

    const unsubscribe = window.electron.app.onMenuAction(async (payload) => {
      try {
        if (!payload || typeof payload.actionId !== "string") {
          console.warn("[Menu] Invalid action payload:", payload);
          return;
        }

        const result = await actionService.dispatch(payload.actionId, payload.args, {
          source: "menu",
        });
        // A destructive action that parked a confirmation reports
        // CONFIRMATION_REQUIRED rather than resolving ok on a no-op (#12120).
        // From a menu that is the intended outcome — the dialog is open — so it
        // is not a failure to log.
        if (!result.ok && !isStagedConfirmation(result.error)) {
          logError(`[Menu] Action "${payload.actionId}" failed`, undefined, {
            error: result.error,
          });
        }
      } catch (error) {
        logError("[Menu] Failed to process action", error, { payload });
      }
    });

    return () => unsubscribe();
  }, []);
}
