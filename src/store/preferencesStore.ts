import { create } from "zustand";
import { persist } from "zustand/middleware";
import { createSafeJSONStorage } from "./persistence/safeStorage";
import { registerPersistedStore } from "./persistence/persistedStoreRegistry";

export type DockDensity = "compact" | "normal" | "comfortable";

interface PreferencesState {
  showProjectPulse: boolean;
  setShowProjectPulse: (show: boolean) => void;
  showDeveloperTools: boolean;
  setShowDeveloperTools: (show: boolean) => void;
  showGridAgentHighlights: boolean;
  setShowGridAgentHighlights: (show: boolean) => void;
  showDockAgentHighlights: boolean;
  setShowDockAgentHighlights: (show: boolean) => void;
  dockDensity: DockDensity;
  setDockDensity: (density: DockDensity) => void;
  assignWorktreeToSelf: boolean;
  setAssignWorktreeToSelf: (value: boolean) => void;
  reduceAnimations: boolean;
  setReduceAnimations: (value: boolean) => void;
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
      showGridAgentHighlights: false,
      setShowGridAgentHighlights: (show) => set({ showGridAgentHighlights: show }),
      showDockAgentHighlights: false,
      setShowDockAgentHighlights: (show) => set({ showDockAgentHighlights: show }),
      dockDensity: "normal",
      setDockDensity: (density) => set({ dockDensity: density }),
      assignWorktreeToSelf: false,
      setAssignWorktreeToSelf: (value) => set({ assignWorktreeToSelf: value }),
      reduceAnimations: false,
      setReduceAnimations: (value) => set({ reduceAnimations: value }),
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
      name: "daintree-preferences",
      storage: createSafeJSONStorage(),
      version: 4,
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
        if (version < 2) {
          if (persisted && typeof persisted === "object") {
            const state = persisted as Record<string, unknown>;
            state.showGridAgentHighlights ??= false;
            state.showDockAgentHighlights ??= false;
          }
        }
        if (version < 3) {
          if (persisted && typeof persisted === "object") {
            const state = persisted as Record<string, unknown>;
            state.dockDensity ??= "normal";
          }
        }
        if (version < 4) {
          if (persisted && typeof persisted === "object") {
            const state = persisted as Record<string, unknown>;
            state.reduceAnimations ??= false;
          }
        }
        return persisted as PreferencesState;
      },
    }
  )
);

registerPersistedStore({
  storeId: "preferencesStore",
  store: usePreferencesStore,
  persistedStateType:
    "{ showProjectPulse: boolean; showDeveloperTools: boolean; showGridAgentHighlights: boolean; showDockAgentHighlights: boolean; dockDensity: DockDensity; assignWorktreeToSelf: boolean; reduceAnimations: boolean; lastSelectedWorktreeRecipeIdByProject: Record<string, string | null | undefined> }",
});
