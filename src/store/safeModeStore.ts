import { create } from "zustand";
import type { QuarantinedPanelSummary } from "@shared/types/ipc/crashRecovery";

export interface SafeModeMeta {
  crashCount?: number;
  skippedPanelCount?: number;
  lastCrashAt?: number;
  quarantinedPanels?: QuarantinedPanelSummary[];
}

interface SafeModeState extends SafeModeMeta {
  safeMode: boolean;
  /** Session-only flag — re-surfaces on next boot until the user restarts normally. */
  dismissed: boolean;
  setSafeMode: (value: boolean, meta?: SafeModeMeta) => void;
  /**
   * Optimistically remove a panel from the local quarantine list and forward
   * the request to the main process so the on-disk ledger drops the record.
   * Restore is next-restart-only — the panel does not re-hydrate in the
   * current session. Returns the IPC promise so the caller can react to
   * failures (the row stays optimistically removed; the next launch picks up
   * the real ledger state regardless).
   */
  clearQuarantinedPanel: (panelId: string) => Promise<{ cleared: boolean }>;
  dismiss: () => void;
}

export const useSafeModeStore = create<SafeModeState>((set) => ({
  safeMode: false,
  dismissed: false,
  crashCount: undefined,
  skippedPanelCount: undefined,
  lastCrashAt: undefined,
  quarantinedPanels: undefined,
  setSafeMode: (value, meta) =>
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
          }
    ),
  clearQuarantinedPanel: async (panelId) => {
    // Leave `quarantinedPanels` in place — each row owns its own "Restoring on
    // next launch" cleared state so the popover stays consistent for the
    // remainder of the session. The on-disk ledger is the source of truth on
    // next launch, where the row will be absent on hydration.
    return window.electron.app.clearQuarantinedPanel(panelId);
  },
  dismiss: () => set({ dismissed: true }),
}));
