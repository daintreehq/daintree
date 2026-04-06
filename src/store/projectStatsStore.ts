import { create } from "zustand";
import type { ProjectStatusMap } from "@shared/types/ipc/project";

interface ProjectStatsState {
  stats: ProjectStatusMap;
  setStats: (stats: ProjectStatusMap) => void;
}

export const useProjectStatsStore = create<ProjectStatsState>((set) => ({
  stats: {},
  setStats: (stats) => set({ stats }),
}));

let statsUnsubscribe: (() => void) | null = null;

export function setupProjectStatsListeners(): () => void {
  if (typeof window === "undefined") return () => {};
  if (statsUnsubscribe !== null) return cleanupProjectStatsListeners;

  statsUnsubscribe = window.electron.project.onStatsUpdated((stats) => {
    useProjectStatsStore.getState().setStats(stats);
  });

  return cleanupProjectStatsListeners;
}

export function cleanupProjectStatsListeners(): void {
  if (statsUnsubscribe) {
    statsUnsubscribe();
    statsUnsubscribe = null;
  }
}
