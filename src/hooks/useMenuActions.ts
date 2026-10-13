import { useEffect } from "react";
import { isElectronAvailable } from "./useElectron";
import { actionService } from "@/services/ActionService";
import { logError } from "@/utils/logger";
import { isStagedConfirmation } from "@/services/actions/confirmationStaged";
import { keybindingService } from "@/services/KeybindingService";

// Main takes the terminal-cycle keys before the page sees them, so it cannot
// know the portal has focus. It names the portal action the same keystroke is
// bound to, and the renderer, which knows the scope, picks between them.
function resolveMenuActionId(payload: { actionId: string; portalActionId?: string }): string {
  return payload.portalActionId && keybindingService.getScope() === "portal"
    ? payload.portalActionId
    : payload.actionId;
}

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

        const actionId = resolveMenuActionId(payload);
        const result = await actionService.dispatch(actionId, payload.args, {
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
