import type { StateCreator } from "zustand";

const MRU_MAX_SIZE = 20;

export interface ActionMruSlice {
  actionMruList: string[];
  recordActionMru: (id: string) => void;
  hydrateActionMru: (list: string[]) => void;
  clearActionMru: () => void;
}

export const createActionMruSlice: StateCreator<ActionMruSlice, [], [], ActionMruSlice> = (
  set
) => ({
  actionMruList: [],

  recordActionMru: (id) => {
    set((state) => {
      const next = [id, ...state.actionMruList.filter((x) => x !== id)].slice(0, MRU_MAX_SIZE);
      if (next[0] === state.actionMruList[0] && next.length === state.actionMruList.length)
        return state;
      return { actionMruList: next };
    });
  },

  hydrateActionMru: (list) => {
    set({ actionMruList: list.slice(0, MRU_MAX_SIZE) });
  },

  clearActionMru: () => {
    set({ actionMruList: [] });
  },
});
