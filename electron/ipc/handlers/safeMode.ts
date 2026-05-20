import { defineIpcNamespace, op } from "../define.js";
import { getPanelSuspectLedger } from "../../services/PanelSuspectLedgerService.js";
import { CHANNELS } from "../channels.js";

/**
 * Handlers for renderer actions that mutate the per-panel suspect ledger.
 *
 * Currently exposes only `clear-quarantined-panel` — invoked from
 * `SafeModeBanner`'s per-row "Restore panel" affordance. The semantics are
 * next-restart-only: clearing a record removes it from the ledger so the
 * panel hydrates normally on the next boot. The current session is unchanged.
 */
export const safeModeNamespace = defineIpcNamespace({
  name: "safeMode",
  ops: {
    clearQuarantinedPanel: op(
      CHANNELS.APP_CLEAR_QUARANTINED_PANEL,
      async (panelId: string): Promise<{ cleared: boolean }> => {
        if (typeof panelId !== "string" || panelId.length === 0) {
          return { cleared: false };
        }
        const cleared = getPanelSuspectLedger().clearQuarantinedPanel(panelId);
        return { cleared };
      }
    ),
  },
});

export function registerSafeModeHandlers(): () => void {
  return safeModeNamespace.register();
}
