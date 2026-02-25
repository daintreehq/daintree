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
    return localStorage;
  }
  return memoryStorage;
}

interface PreferencesState {
  showProjectPulse: boolean;
  setShowProjectPulse: (show: boolean) => void;
  showDeveloperTools: boolean;
  setShowDeveloperTools: (show: boolean) => void;
  assignWorktreeToSelf: boolean;
  setAssignWorktreeToSelf: (value: boolean) => void;
  lastSelectedWorktreeRecipeIdByProject: Record<string, string | null | undefined>;
  setLastSelectedWorktreeRecipeIdByProject: (
    projectId: string,
    id: string | null | undefined
  ) => void;
}

export const usePreferencesStore = create<PreferencesState>()(
  persist(
    (set) => ({
      showProjectPulse: true,
      setShowProjectPulse: (show) => set({ showProjectPulse: show }),
      showDeveloperTools: false,
      setShowDeveloperTools: (show) => set({ showDeveloperTools: show }),
      assignWorktreeToSelf: false,
      setAssignWorktreeToSelf: (value) => set({ assignWorktreeToSelf: value }),
      lastSelectedWorktreeRecipeIdByProject: {},
      setLastSelectedWorktreeRecipeIdByProject: (projectId, id) =>
        set((state) => ({
          lastSelectedWorktreeRecipeIdByProject: {
            ...state.lastSelectedWorktreeRecipeIdByProject,
            [projectId]: id,
          },
        })),
    }),
    {
      name: "canopy-preferences",
      storage: createJSONStorage(() => getSafeStorage()),
      version: 1,
      migrate: (persisted, version) => {
        if (version === 0 || version === undefined) {
          if (persisted && typeof persisted === "object") {
            const state = persisted as Record<string, unknown>;
            delete state.lastSelectedWorktreeRecipeId;
            state.lastSelectedWorktreeRecipeIdByProject = {};
          } else {
            return { lastSelectedWorktreeRecipeIdByProject: {} } as PreferencesState;
          }
        }
        return persisted as PreferencesState;
      },
    }
  )
);
