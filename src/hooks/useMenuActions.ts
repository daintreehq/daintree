import { useEffect } from "react";
import { isElectronAvailable } from "./useElectron";
import { actionService } from "@/services/ActionService";
import { logError } from "@/utils/logger";

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
        if (!result.ok) {
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
