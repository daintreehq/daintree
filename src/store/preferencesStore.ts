import { create } from "zustand";
import { persist } from "zustand/middleware";
import { createSafeJSONStorage } from "./persistence/safeStorage";

interface PreferencesState {
  showProjectPulse: boolean;
  setShowProjectPulse: (show: boolean) => void;
  showDeveloperTools: boolean;
  setShowDeveloperTools: (show: boolean) => void;
  showGridAgentHighlights: boolean;
  setShowGridAgentHighlights: (show: boolean) => void;
  showDockAgentHighlights: boolean;
  setShowDockAgentHighlights: (show: boolean) => void;
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
      showGridAgentHighlights: false,
      setShowGridAgentHighlights: (show) => set({ showGridAgentHighlights: show }),
      showDockAgentHighlights: false,
      setShowDockAgentHighlights: (show) => set({ showDockAgentHighlights: show }),
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
      storage: createSafeJSONStorage(),
      version: 2,
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
        return persisted as PreferencesState;
      },
    }
  )
);
