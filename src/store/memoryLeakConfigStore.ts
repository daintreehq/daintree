import { create } from "zustand";

interface MemoryLeakConfigStore {
  enabled: boolean;
  autoRestartThresholdMb: number;
  setEnabled: (enabled: boolean) => void;
  setAutoRestartThresholdMb: (thresholdMb: number) => void;
}

export const DEFAULT_AUTO_RESTART_THRESHOLD_MB = 8192;

export const useMemoryLeakConfigStore = create<MemoryLeakConfigStore>((set) => ({
  enabled: false,
  autoRestartThresholdMb: DEFAULT_AUTO_RESTART_THRESHOLD_MB,
  setEnabled: (enabled) => set({ enabled }),
  setAutoRestartThresholdMb: (autoRestartThresholdMb) => set({ autoRestartThresholdMb }),
}));
