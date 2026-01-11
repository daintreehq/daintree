import { create, type StateCreator } from "zustand";
import type { ProjectSettings, RunCommand } from "@shared/types";
import { projectClient } from "@/clients";

interface ProjectSettingsState {
  /** Cached settings for the current project */
  settings: ProjectSettings | null;
  /** Detected runners for the current project */
  detectedRunners: RunCommand[];
  /** All detected runners before filtering */
  allDetectedRunners: RunCommand[];
  /** Project ID these settings belong to */
  projectId: string | null;
  /** Whether settings are currently being loaded */
  isLoading: boolean;
  /** Error message if loading failed */
  error: string | null;
}

interface ProjectSettingsActions {
  /** Load settings for a project (used on project switch) */
  loadSettings: (projectId: string) => Promise<void>;
  /** Update cached settings after save */
  setSettings: (settings: ProjectSettings) => void;
  /** Update detected runners after filtering */
  setDetectedRunners: (runners: RunCommand[]) => void;
  /** Reset store state (used on project switch) */
  reset: () => void;
}

const initialState: ProjectSettingsState = {
  settings: null,
  detectedRunners: [],
  allDetectedRunners: [],
  projectId: null,
  isLoading: false,
  error: null,
};

const createProjectSettingsStore: StateCreator<ProjectSettingsState & ProjectSettingsActions> = (
  set,
  get
) => ({
  ...initialState,

  loadSettings: async (projectId: string) => {
    // Skip if already loading this project's settings
    const currentState = get();
    if (currentState.projectId === projectId && currentState.isLoading) {
      return;
    }

    set({ isLoading: true, error: null, projectId });

    try {
      const [data, detected] = await Promise.all([
        projectClient.getSettings(projectId),
        projectClient.detectRunners(projectId),
      ]);

      // Verify we're still loading for this project (handle race conditions)
      if (get().projectId !== projectId) {
        return;
      }

      const savedCommandStrings = new Set(data.runCommands?.map((c) => c.command) || []);
      const newDetected = detected.filter((d) => !savedCommandStrings.has(d.command));

      set({
        settings: data,
        allDetectedRunners: detected,
        detectedRunners: newDetected,
        isLoading: false,
        error: null,
      });
    } catch (err) {
      console.error("Failed to load project settings:", err);

      // Verify we're still loading for this project
      if (get().projectId !== projectId) {
        return;
      }

      set({
        error: err instanceof Error ? err.message : "Unknown error",
        settings: { runCommands: [] },
        detectedRunners: [],
        allDetectedRunners: [],
        isLoading: false,
      });
    }
  },

  setSettings: (settings: ProjectSettings) => {
    const savedCommandStrings = new Set(settings.runCommands?.map((c) => c.command) || []);
    set((state) => ({
      settings,
      detectedRunners: state.allDetectedRunners.filter((d) => !savedCommandStrings.has(d.command)),
      error: null,
    }));
  },

  setDetectedRunners: (runners: RunCommand[]) => {
    set({ detectedRunners: runners });
  },

  reset: () => {
    set(initialState);
  },
});

export const useProjectSettingsStore = create<ProjectSettingsState & ProjectSettingsActions>()(
  createProjectSettingsStore
);

/** Cleanup function for project switch */
export function cleanupProjectSettingsStore(): void {
  useProjectSettingsStore.getState().reset();
}
