import type { StateCreator } from "zustand";

const MRU_MAX_SIZE = 50;

export interface TerminalMruSlice {
  mruList: string[];
  recordMru: (id: string) => void;
  pruneMru: (validIds: Set<string>) => void;
  hydrateMru: (list: string[]) => void;
  clearMru: () => void;
}

export const createTerminalMruSlice: StateCreator<TerminalMruSlice, [], [], TerminalMruSlice> = (
  set
) => ({
  mruList: [],

  recordMru: (id) => {
    set((state) => {
      const next = [id, ...state.mruList.filter((x) => x !== id)].slice(0, MRU_MAX_SIZE);
      if (next[0] === state.mruList[0] && next.length === state.mruList.length) return state;
      return { mruList: next };
    });
  },

  pruneMru: (validIds) => {
    set((state) => {
      const next = state.mruList.filter((id) => validIds.has(id));
      if (next.length === state.mruList.length) return state;
      return { mruList: next };
    });
  },

  hydrateMru: (list) => {
    set({ mruList: list.slice(0, MRU_MAX_SIZE) });
  },

  clearMru: () => {
    set({ mruList: [] });
  },
});
