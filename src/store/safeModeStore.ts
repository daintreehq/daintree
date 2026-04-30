import { create } from "zustand";

export interface SafeModeMeta {
  crashCount?: number;
  skippedPanelCount?: number;
  lastCrashAt?: number;
}

interface SafeModeState extends SafeModeMeta {
  safeMode: boolean;
  /** Session-only flag — re-surfaces on next boot until the user restarts normally. */
  dismissed: boolean;
  setSafeMode: (value: boolean, meta?: SafeModeMeta) => void;
  dismiss: () => void;
}

export const useSafeModeStore = create<SafeModeState>((set) => ({
  safeMode: false,
  dismissed: false,
  crashCount: undefined,
  skippedPanelCount: undefined,
  lastCrashAt: undefined,
  setSafeMode: (value, meta) =>
    set(
      value
        ? {
            safeMode: true,
            crashCount: meta?.crashCount,
            skippedPanelCount: meta?.skippedPanelCount,
            lastCrashAt: meta?.lastCrashAt,
          }
        : {
            safeMode: false,
            dismissed: false,
            crashCount: undefined,
            skippedPanelCount: undefined,
            lastCrashAt: undefined,
          }
    ),
  dismiss: () => set({ dismissed: true }),
}));
