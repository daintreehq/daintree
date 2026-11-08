import { BrowserWindow, dialog, type MessageBoxOptions } from "electron";
import { defineIpcNamespace, op } from "../define.js";
import { getPanelSuspectLedger } from "../../services/PanelSuspectLedgerService.js";
import { getCrashLoopGuard } from "../../services/CrashLoopGuardService.js";
import { relaunchApp } from "../../lifecycle/appRelaunch.js";
import { getActiveShutdown } from "../../lifecycle/shutdownCoordinator.js";
import { claimStartupWaitSnapshot } from "../startupInvokeTracker.js";
import { logWarn } from "../../utils/logger.js";
import { CHANNELS } from "../channels.js";
import { SAFE_MODE_METHOD_CHANNELS } from "./safeMode.preload.js";
import type { IpcContext } from "../types.js";

/**
 * What the renderer had reached when its stuck card appeared: `before-boot`
 * when this document never sent `app:boot` (its entry graph didn't run).
 */
const RENDERER_STARTUP_STAGES = new Set(["before-boot", "booting", "hydrating"]);

/**
 * The restart stops every terminal in every window, not just the stuck one, so
 * it is confirmed like the safe mode banner's "Restart normally". Native,
 * because the stuck card shows before React has mounted anything to confirm in.
 */
async function confirmSafeModeRestart(parent: BrowserWindow | null): Promise<boolean> {
  const options: MessageBoxOptions = {
    type: "question",
    title: "Restart Daintree in safe mode?",
    message: "Restart Daintree in safe mode?",
    detail:
      "Daintree restarts without restoring panels, so one that keeps startup from finishing can't hold it up again. Restart normally from the safe mode banner to bring them back. Whatever is running in a terminal stops, including a turn an agent is in the middle of.",
    buttons: ["Restart in safe mode", "Cancel"],
    defaultId: 0,
    cancelId: 1,
  };
  // On macOS a message box with no window runs synchronously and stalls main
  // until it is answered, so it sits on a window whenever there is one.
  const live = [parent, BrowserWindow.getFocusedWindow(), ...BrowserWindow.getAllWindows()].find(
    (win): win is BrowserWindow => win != null && !win.isDestroyed() && win.isVisible()
  );
  const { response } = live
    ? await dialog.showMessageBox(live, options)
    : await dialog.showMessageBox(options);
  return response === 0;
}

/**
 * Handlers for the safe mode recovery surfaces: `SafeModeBanner`'s per-row
 * "Restore panel", and the cold-start skeleton's stuck card (#16401).
 *
 * `clear-quarantined-panel` is next-restart-only: clearing a record removes it
 * from the ledger so the panel hydrates normally on the next boot. The current
 * session is unchanged.
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

    /**
     * Restart into the safe mode a crash loop would earn, without the crashes.
     * Main answers this while hydration is stuck on a wait of its own, which a
     * renderer reload lands straight back in. `started: false` means nothing
     * is restarting: the user cancelled, or a quit or restart already owns the
     * exit. A failed write of the request throws, so the card can say so.
     */
    restartInSafeMode: op(
      SAFE_MODE_METHOD_CHANNELS.restartInSafeMode,
      async (ctx: IpcContext): Promise<{ started: boolean }> => {
        if (!(await confirmSafeModeRestart(ctx.senderWindow))) return { started: false };
        // Checked after the dialog and before the write, with nothing awaited
        // between here and the relaunch: a request written while another exit
        // is in flight would be withdrawn by the refusal below, taking an
        // earlier accepted request (a second stuck window's) with it.
        if (getActiveShutdown() !== null) return { started: false };
        const guard = getCrashLoopGuard();
        guard.requestSafeModeBoot();
        if (relaunchApp("safe-mode-request") !== "started") {
          guard.cancelSafeModeBootRequest();
          return { started: false };
        }
        return { started: true };
      },
      { withContext: true }
    ),

    /**
     * Log, once per document, what a view whose stuck card just appeared was
     * still waiting on in main, so the next diagnostics bundle shows where
     * startup stopped. A view that finishes later still leaves this entry: it
     * records a delay, not a verdict.
     */
    reportStartupStuck: op(
      SAFE_MODE_METHOD_CHANNELS.reportStartupStuck,
      async (ctx: IpcContext, rendererStage: string): Promise<void> => {
        const sender = ctx.event?.sender;
        if (!sender) return;
        const stage = RENDERER_STARTUP_STAGES.has(rendererStage) ? rendererStage : "unknown";
        const snapshot = claimStartupWaitSnapshot(
          sender,
          CHANNELS.APP_REPORT_STARTUP_STUCK,
          stage !== "before-boot"
        );
        if (!snapshot) return;
        logWarn("Startup stuck card shown", {
          webContentsId: ctx.webContentsId,
          rendererStage: stage,
          ...snapshot,
        });
      },
      { withContext: true }
    ),
  },
});

export function registerSafeModeHandlers(): () => void {
  return safeModeNamespace.register();
}
