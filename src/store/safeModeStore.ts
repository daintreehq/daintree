import { create } from "zustand";
import type { QuarantinedPanelInfo } from "@shared/types/ipc/crashRecovery";

export interface SafeModeMeta {
  crashCount?: number;
  skippedPanelCount?: number;
  lastCrashAt?: number;
  quarantinedPanels?: QuarantinedPanelInfo[];
}

interface SafeModeState extends SafeModeMeta {
  safeMode: boolean;
  /** Session-only flag — re-surfaces on next boot until the user restarts normally. */
  dismissed: boolean;
  setSafeMode: (value: boolean, meta?: SafeModeMeta) => void;
  setQuarantinedPanels: (panels: QuarantinedPanelInfo[]) => void;
  removeQuarantinedPanel: (panelId: string) => void;
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
  setQuarantinedPanels: (panels) =>
    set({ quarantinedPanels: panels.length > 0 ? panels : undefined }),
  removeQuarantinedPanel: (panelId) =>
    set((state) => {
      const remaining = (state.quarantinedPanels ?? []).filter((p) => p.id !== panelId);
      return { quarantinedPanels: remaining.length > 0 ? remaining : undefined };
    }),
  dismiss: () => set({ dismissed: true }),
}));
