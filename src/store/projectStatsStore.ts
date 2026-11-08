import { create } from "zustand";
import type { ProjectStatusMap } from "@shared/types/ipc/project";
import { isSameProjectStatusMap } from "@/lib/projectStatusEntry";

interface ProjectStatsState {
  stats: ProjectStatusMap;
  /**
   * Pushes received so far, equal ones included. A read that went out before
   * a push landed can't tell whether its answer predates that push, because an
   * invoke reply and a broadcast share no ordering, so it compares this across
   * its await rather than the map.
   */
  pushCount: number;
  setStats: (stats: ProjectStatusMap) => void;
}

// An equal map keeps the current reference, so a replayed or repeated push
// rerenders nothing that selects the stats.
export const useProjectStatsStore = create<ProjectStatsState>((set) => ({
  stats: {},
  pushCount: 0,
  setStats: (stats) =>
    set((state) => (isSameProjectStatusMap(state.stats, stats) ? state : { stats })),
}));

let statsUnsubscribe: (() => void) | null = null;

export function setupProjectStatsListeners(): () => void {
  if (typeof window === "undefined") return () => {};
  if (statsUnsubscribe !== null) return cleanupProjectStatsListeners;

  statsUnsubscribe = window.electron.project.onStatsUpdated((stats) => {
    useProjectStatsStore.setState((state) => ({
      pushCount: state.pushCount + 1,
      ...(isSameProjectStatusMap(state.stats, stats) ? {} : { stats }),
    }));
  });

  return cleanupProjectStatsListeners;
}

export function cleanupProjectStatsListeners(): void {
  if (statsUnsubscribe) {
    statsUnsubscribe();
    statsUnsubscribe = null;
  }
}
