import { create } from "zustand";
import type { QuarantinedPanelSummary } from "@shared/types/ipc/crashRecovery";

export interface SafeModeMeta {
  crashCount?: number;
  skippedPanelCount?: number;
  lastCrashAt?: number;
  quarantinedPanels?: QuarantinedPanelSummary[];
}

export type QuarantineClearStatus = "clearing" | "cleared" | "failed";

interface SafeModeState extends SafeModeMeta {
  safeMode: boolean;
  /**
   * Per-panel restore progress. Lives here rather than in the row because the
   * details popover unmounts its rows on close, and a remounted row must keep
   * showing "Restoring on next launch" instead of offering a second clear.
   */
  clearStatus: Record<string, QuarantineClearStatus>;
  /** Session-only flag — re-surfaces on next boot until the user restarts normally. */
  dismissed: boolean;
  setSafeMode: (value: boolean, meta?: SafeModeMeta) => void;
  /**
   * Forward the request to the main process so the on-disk ledger drops the
   * record, and track the outcome in `clearStatus`. Restore is
   * next-restart-only — the panel does not re-hydrate in the current session.
   * A panel that is already cleared or mid-clear never reaches IPC again: the
   * ledger answers `false` for a record it no longer holds, which would turn a
   * successful restore into a stuck failure.
   */
  clearQuarantinedPanel: (panelId: string) => Promise<{ cleared: boolean }>;
  dismiss: () => void;
}

let clearEpoch = 0;

export const useSafeModeStore = create<SafeModeState>((set, get) => ({
  safeMode: false,
  dismissed: false,
  crashCount: undefined,
  skippedPanelCount: undefined,
  lastCrashAt: undefined,
  quarantinedPanels: undefined,
  clearStatus: {},
  setSafeMode: (value, meta) => {
    // Re-entering safe mode keeps `clearStatus`: a clear may be in flight, and
    // dropping its dedupe entry would allow a second IPC that the ledger
    // answers with `false`. Only leaving safe mode resets it.
    if (!value) clearEpoch += 1;
    set(
      value
        ? {
            safeMode: true,
            crashCount: meta?.crashCount,
            skippedPanelCount: meta?.skippedPanelCount,
            lastCrashAt: meta?.lastCrashAt,
            quarantinedPanels: meta?.quarantinedPanels,
          }
        : {
            safeMode: false,
            dismissed: false,
            crashCount: undefined,
            skippedPanelCount: undefined,
            lastCrashAt: undefined,
            quarantinedPanels: undefined,
            clearStatus: {},
          }
    );
  },
  clearQuarantinedPanel: async (panelId) => {
    const current = get().clearStatus[panelId];
    if (current === "cleared") return { cleared: true };
    if (current === "clearing") return { cleared: false };
    const epoch = clearEpoch;
    // A completion that lands after safe mode was left must not repopulate the
    // status that reset just cleared.
    const setStatus = (status: QuarantineClearStatus) => {
      if (epoch !== clearEpoch) return;
      set((state) => ({ clearStatus: { ...state.clearStatus, [panelId]: status } }));
    };
    setStatus("clearing");
    try {
      const result = await window.electron.app.clearQuarantinedPanel(panelId);
      setStatus(result.cleared ? "cleared" : "failed");
      return result;
    } catch (error) {
      setStatus("failed");
      throw error;
    }
  },
  dismiss: () => set({ dismissed: true }),
}));
