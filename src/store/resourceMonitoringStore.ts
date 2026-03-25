import { create } from "zustand";
import type { TerminalResourceBatchPayload, TerminalResourceProcess } from "@shared/types/pty-host";

const CPU_HISTORY_SIZE = 30;

export interface TerminalResourceState {
  cpuPercent: number;
  memoryKb: number;
  cpuHistory: number[];
  breakdown: TerminalResourceProcess[];
}

interface ResourceMonitoringStore {
  enabled: boolean;
  metrics: Map<string, TerminalResourceState>;
  setEnabled: (enabled: boolean) => void;
  updateMetrics: (batch: TerminalResourceBatchPayload) => void;
  removeTerminal: (id: string) => void;
  clear: () => void;
}

export const useResourceMonitoringStore = create<ResourceMonitoringStore>((set) => ({
  enabled: false,
  metrics: new Map(),

  setEnabled: (enabled) =>
    set(() => {
      if (!enabled) {
        return { enabled, metrics: new Map() };
      }
      return { enabled };
    }),

  updateMetrics: (batch) =>
    set((state) => {
      const next = new Map(state.metrics);
      for (const [id, sample] of Object.entries(batch)) {
        const existing = next.get(id);
        const history = existing?.cpuHistory ?? [];
        const newHistory = [...history, sample.cpuPercent].slice(-CPU_HISTORY_SIZE);
        next.set(id, {
          cpuPercent: sample.cpuPercent,
          memoryKb: sample.memoryKb,
          cpuHistory: newHistory,
          breakdown: sample.breakdown,
        });
      }
      return { metrics: next };
    }),

  removeTerminal: (id) =>
    set((state) => {
      const next = new Map(state.metrics);
      next.delete(id);
      return { metrics: next };
    }),

  clear: () => set({ metrics: new Map() }),
}));
