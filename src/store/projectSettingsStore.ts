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

const MAX_SETTINGS_CACHE_SIZE = 3;

interface SettingsSnapshot {
  settings: ProjectSettings;
  detectedRunners: RunCommand[];
  allDetectedRunners: RunCommand[];
}

const settingsSnapshotCache = new Map<string, SettingsSnapshot>();

function evictOldestSettings(): void {
  if (settingsSnapshotCache.size <= MAX_SETTINGS_CACHE_SIZE) return;
  const firstKey = settingsSnapshotCache.keys().next().value;
  if (firstKey !== undefined) {
    settingsSnapshotCache.delete(firstKey);
  }
}

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

    // Only show loading state if no snapshot was pre-populated.
    if (currentState.projectId !== projectId || !currentState.settings) {
      set({ isLoading: true, error: null, projectId });
    } else {
      set({ error: null });
    }

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

      // Update the snapshot cache with fresh data
      settingsSnapshotCache.delete(projectId);
      settingsSnapshotCache.set(projectId, {
        settings: data,
        detectedRunners: newDetected,
        allDetectedRunners: detected,
      });
      evictOldestSettings();
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

export function snapshotProjectSettings(projectId: string): void {
  const {
    settings,
    detectedRunners,
    allDetectedRunners,
    projectId: storeProjectId,
  } = useProjectSettingsStore.getState();
  if (!settings) return;
  if (storeProjectId && storeProjectId !== projectId) return;
  settingsSnapshotCache.delete(projectId);
  settingsSnapshotCache.set(projectId, {
    settings,
    detectedRunners,
    allDetectedRunners,
  });
  evictOldestSettings();
}

export function warmSettingsCache(
  projectId: string,
  settings: ProjectSettings,
  detectedRunners: RunCommand[],
  allDetectedRunners: RunCommand[]
): void {
  if (settingsSnapshotCache.has(projectId)) return;
  settingsSnapshotCache.set(projectId, { settings, detectedRunners, allDetectedRunners });
  evictOldestSettings();
}

export function prePopulateProjectSettings(projectId: string): void {
  const snapshot = settingsSnapshotCache.get(projectId);
  if (!snapshot) {
    // No cached settings — reset and let loadSettings fetch fresh
    useProjectSettingsStore.setState({ ...initialState, projectId });
    return;
  }
  useProjectSettingsStore.setState({
    settings: snapshot.settings,
    detectedRunners: snapshot.detectedRunners,
    allDetectedRunners: snapshot.allDetectedRunners,
    projectId,
    isLoading: false,
    error: null,
  });
}
