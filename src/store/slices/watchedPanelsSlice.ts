import type { StateCreator } from "zustand";

export interface WatchedPanelsSlice {
  watchedPanels: Set<string>;
  watchPanel: (id: string) => void;
  unwatchPanel: (id: string) => void;
}

export function createWatchedPanelsSlice(): StateCreator<WatchedPanelsSlice> {
  return (set) => ({
    watchedPanels: new Set(),

    watchPanel: (id) => {
      set((state) => ({
        watchedPanels: new Set(state.watchedPanels).add(id),
      }));
    },

    unwatchPanel: (id) => {
      set((state) => {
        const next = new Set(state.watchedPanels);
        next.delete(id);
        return { watchedPanels: next };
      });
    },
  });
}
