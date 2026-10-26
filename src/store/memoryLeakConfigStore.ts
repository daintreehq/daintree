import { create } from "zustand";
import { DEFAULT_AUTO_RESTART_THRESHOLD_MB } from "@shared/config/memoryLeakPolicy";

export { DEFAULT_AUTO_RESTART_THRESHOLD_MB };

interface MemoryLeakConfigStore {
  enabled: boolean;
  autoRestartThresholdMb: number;
  setEnabled: (enabled: boolean) => void;
  setAutoRestartThresholdMb: (thresholdMb: number) => void;
}

export const useMemoryLeakConfigStore = create<MemoryLeakConfigStore>((set) => ({
  enabled: false,
  autoRestartThresholdMb: DEFAULT_AUTO_RESTART_THRESHOLD_MB,
  setEnabled: (enabled) => set({ enabled }),
  setAutoRestartThresholdMb: (autoRestartThresholdMb) => set({ autoRestartThresholdMb }),
}));
