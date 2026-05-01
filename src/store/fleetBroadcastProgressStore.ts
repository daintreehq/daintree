import { create } from "zustand";

export interface FleetBroadcastProgressState {
  completed: number;
  total: number;
  failed: number;
  isActive: boolean;
  init: (total: number) => void;
  advance: (batchSize: number, batchFailures: number) => void;
  finish: () => void;
}

export const useFleetBroadcastProgressStore = create<FleetBroadcastProgressState>((set) => ({
  completed: 0,
  total: 0,
  failed: 0,
  isActive: false,
  init: (total) => set({ total, completed: 0, failed: 0, isActive: true }),
  advance: (batchSize, batchFailures) =>
    set((s) => {
      const completed = Math.min(s.completed + batchSize, s.total);
      const failed = Math.min(s.failed + batchFailures, completed);
      return { completed, failed };
    }),
  finish: () => set({ isActive: false }),
}));
