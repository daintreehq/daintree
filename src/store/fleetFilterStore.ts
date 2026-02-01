import { create } from "zustand";
import type { AgentState } from "@shared/types/domain";

export type FleetStateFilter = Extract<
  AgentState,
  "working" | "running" | "waiting" | "completed" | "failed"
>;

interface FleetFilterState {
  stateFilters: Set<FleetStateFilter>;
  worktreeFilter: string | "all";
}

interface FleetFilterActions {
  toggleStateFilter: (filter: FleetStateFilter) => void;
  setWorktreeFilter: (worktreeId: string | "all") => void;
  clearAll: () => void;
}

type FleetFilterStore = FleetFilterState & FleetFilterActions;

export const useFleetFilterStore = create<FleetFilterStore>()((set) => ({
  stateFilters: new Set<FleetStateFilter>(),
  worktreeFilter: "all",

  toggleStateFilter: (filter) =>
    set((state) => {
      // Create a new Set to ensure immutability
      const newSet = new Set(state.stateFilters);
      if (newSet.has(filter)) {
        newSet.delete(filter);
      } else {
        newSet.add(filter);
      }
      return { stateFilters: newSet };
    }),

  setWorktreeFilter: (worktreeId) => set({ worktreeFilter: worktreeId }),

  clearAll: () =>
    set({
      stateFilters: new Set(),
      worktreeFilter: "all",
    }),
}));
