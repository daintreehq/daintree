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
}

export const usePreferencesStore = create<PreferencesState>()(
  persist(
    (set) => ({
      showProjectPulse: true,
      setShowProjectPulse: (show) => set({ showProjectPulse: show }),
      showDeveloperTools: false,
      setShowDeveloperTools: (show) => set({ showDeveloperTools: show }),
    }),
    {
      name: "canopy-preferences",
      storage: createJSONStorage(() => getSafeStorage()),
    }
  )
);
