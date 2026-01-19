import { create } from "zustand";
import { persist, createJSONStorage, type StateStorage } from "zustand/middleware";

const memoryStorage: StateStorage = (() => {
  const storage = new Map<string, string>();
  return {
    getItem: (name) => storage.get(name) ?? null,
    setItem: (name, value) => {
      storage.set(name, value);
    },
    removeItem: (name) => {
      storage.delete(name);
    },
  };
})();

function getSafeStorage(): StateStorage {
  if (typeof localStorage !== "undefined") {
    try {
      localStorage.getItem("__test__");
      return localStorage;
    } catch {
      return memoryStorage;
    }
  }
  return memoryStorage;
}

export interface TwoPaneSplitConfig {
  enabled: boolean;
  defaultRatio: number;
  preferPreview: boolean;
}

interface TwoPaneSplitState {
  config: TwoPaneSplitConfig;
  ratioByWorktreeId: Record<string, number>;

  setEnabled: (enabled: boolean) => void;
  setDefaultRatio: (ratio: number) => void;
  setPreferPreview: (prefer: boolean) => void;
  setWorktreeRatio: (worktreeId: string, ratio: number) => void;
  getWorktreeRatio: (worktreeId: string | null) => number;
  resetWorktreeRatio: (worktreeId: string) => void;
  resetAllWorktreeRatios: () => void;
}

const DEFAULT_CONFIG: TwoPaneSplitConfig = {
  enabled: true,
  defaultRatio: 0.5,
  preferPreview: true,
};

export const useTwoPaneSplitStore = create<TwoPaneSplitState>()(
  persist(
    (set, get) => ({
      config: DEFAULT_CONFIG,
      ratioByWorktreeId: {},

      setEnabled: (enabled) =>
        set((state) => ({
          config: { ...state.config, enabled },
        })),

      setDefaultRatio: (ratio) =>
        set((state) => ({
          config: { ...state.config, defaultRatio: Math.max(0.2, Math.min(0.8, ratio)) },
        })),

      setPreferPreview: (prefer) =>
        set((state) => ({
          config: { ...state.config, preferPreview: prefer },
        })),

      setWorktreeRatio: (worktreeId, ratio) =>
        set((state) => ({
          ratioByWorktreeId: {
            ...state.ratioByWorktreeId,
            [worktreeId]: Math.max(0.2, Math.min(0.8, ratio)),
          },
        })),

      getWorktreeRatio: (worktreeId) => {
        const state = get();
        if (worktreeId && worktreeId in state.ratioByWorktreeId) {
          return state.ratioByWorktreeId[worktreeId];
        }
        return state.config.defaultRatio;
      },

      resetWorktreeRatio: (worktreeId) =>
        set((state) => {
          const { [worktreeId]: _, ...rest } = state.ratioByWorktreeId;
          return { ratioByWorktreeId: rest };
        }),

      resetAllWorktreeRatios: () => set({ ratioByWorktreeId: {} }),
    }),
    {
      name: "canopy-two-pane-split",
      storage: createJSONStorage(() => getSafeStorage()),
    }
  )
);
