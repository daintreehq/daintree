import { create, type StateCreator } from "zustand";
import type { ProjectSettings, RunCommand } from "@shared/types";
import type { NotificationSettings } from "@shared/types/ipc/api";
import { projectClient } from "@/clients";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { logError } from "@/utils/logger";

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
  /** Notification overrides by project ID, loaded in bulk for list UIs */
  notificationOverridesByProjectId: Record<string, Partial<NotificationSettings>>;
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
  /** Bulk-load notification overrides for a set of project IDs */
  loadNotificationOverridesForProjects: (projectIds: string[]) => Promise<void>;
}

/** Returns true when both completed and waiting notifications are explicitly suppressed. */
export function areProjectNotificationsMuted(overrides?: Partial<NotificationSettings>): boolean {
  return overrides?.completedEnabled === false && overrides?.waitingEnabled === false;
}

const initialState: ProjectSettingsState = {
  settings: null,
  detectedRunners: [],
  allDetectedRunners: [],
  projectId: null,
  isLoading: false,
  error: null,
  notificationOverridesByProjectId: {},
};

const MAX_SETTINGS_CACHE_SIZE = 3;

interface SettingsSnapshot {
  settings: ProjectSettings;
  detectedRunners: RunCommand[];
  allDetectedRunners: RunCommand[];
}

const settingsSnapshotCache = new Map<string, SettingsSnapshot>();

// Loads now also revalidate a project already on screen (the dev preview
// re-detects on open), so several can overlap: only the newest may land, and a
// save made while one was in flight must survive its older settings read.
let latestLoadRequest = 0;
let settingsRevision = 0;

// Patches made while a project's settings were still loading. The load in
// flight may have read the settings before the write a patch records, so it
// applies the ones made after it started; a later load reads them from disk.
const patchesAwaitingLoad = new Map<
  string,
  Array<{ patch: Partial<ProjectSettings>; revision: number }>
>();

function applyPatchesAwaitingLoad(
  projectId: string,
  settings: ProjectSettings,
  revisionAtStart: number
): ProjectSettings {
  const queued = patchesAwaitingLoad.get(projectId);
  if (!queued) return settings;
  patchesAwaitingLoad.delete(projectId);
  return queued.reduce(
    (merged, { patch, revision }) =>
      revision > revisionAtStart ? { ...merged, ...patch } : merged,
    settings
  );
}

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

    const isRevalidation = currentState.projectId === projectId && !!currentState.settings;

    // Only show loading state if no snapshot was pre-populated.
    if (!isRevalidation) {
      set({ isLoading: true, error: null, projectId });
    } else {
      set({ error: null });
    }

    const request = ++latestLoadRequest;
    const revisionAtStart = settingsRevision;

    try {
      const [data, detected] = await Promise.all([
        projectClient.getSettings(projectId),
        projectClient.detectRunners(projectId),
      ]);

      // Verify we're still loading for this project (handle race conditions)
      if (request !== latestLoadRequest || get().projectId !== projectId) {
        return;
      }

      const current = get().settings;
      const settings = applyPatchesAwaitingLoad(
        projectId,
        settingsRevision !== revisionAtStart && current ? current : data,
        revisionAtStart
      );
      const savedCommandStrings = new Set(settings.runCommands?.map((c) => c.command) || []);
      const newDetected = detected.filter((d) => !savedCommandStrings.has(d.command));

      set({
        settings,
        allDetectedRunners: detected,
        detectedRunners: newDetected,
        isLoading: false,
        error: null,
      });

      // Update the snapshot cache with fresh data
      settingsSnapshotCache.delete(projectId);
      settingsSnapshotCache.set(projectId, {
        settings,
        detectedRunners: newDetected,
        allDetectedRunners: detected,
      });
      evictOldestSettings();
    } catch (err) {
      logError("Failed to load project settings", err);

      // Verify we're still loading for this project
      if (request !== latestLoadRequest || get().projectId !== projectId) {
        return;
      }

      const error = formatErrorMessage(err, "Failed to load project settings");
      // A failed revalidation leaves the settings already on screen in place.
      if (isRevalidation && get().settings) {
        set({ error, isLoading: false });
        return;
      }

      set({
        error,
        settings: applyPatchesAwaitingLoad(projectId, { runCommands: [] }, revisionAtStart),
        detectedRunners: [],
        allDetectedRunners: [],
        isLoading: false,
      });
    }
  },

  setSettings: (settings: ProjectSettings) => {
    settingsRevision++;
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
    patchesAwaitingLoad.clear();
    set(initialState);
  },

  loadNotificationOverridesForProjects: async (projectIds: string[]) => {
    const unique = [...new Set(projectIds.filter((id) => typeof id === "string" && id.length > 0))];
    if (unique.length === 0) return;

    try {
      const record = await projectClient.getNotificationOverrides(unique);
      set((state) => {
        const next = { ...state.notificationOverridesByProjectId };
        let changed = false;
        for (const id of unique) {
          const incoming = record[id];
          const existing = next[id];
          if (!incoming) {
            if (existing) {
              delete next[id];
              changed = true;
            }
            continue;
          }
          if (
            existing?.completedEnabled !== incoming.completedEnabled ||
            existing?.waitingEnabled !== incoming.waitingEnabled
          ) {
            next[id] = incoming;
            changed = true;
          }
        }
        return changed ? { notificationOverridesByProjectId: next } : {};
      });
    } catch {
      // Best-effort — mute indicator is visual-only
    }
  },
});

export const useProjectSettingsStore = create<ProjectSettingsState & ProjectSettingsActions>()(
  createProjectSettingsStore
);

/**
 * Merge fields persisted outside the settings form into the cached settings.
 * Without this the cache keeps the pre-write values, and the next form save —
 * which spreads that cache — reverts them (#12326). No-op unless the store
 * still holds the project the write targeted. While that project's settings
 * are still loading, the patch waits for the load to land.
 */
export function patchCachedProjectSettings(
  projectId: string,
  patch: Partial<ProjectSettings>
): void {
  const state = useProjectSettingsStore.getState();
  if (state.projectId !== projectId) return;
  if (!state.settings) {
    settingsRevision++;
    const queued = patchesAwaitingLoad.get(projectId) ?? [];
    queued.push({ patch, revision: settingsRevision });
    patchesAwaitingLoad.set(projectId, queued);
    return;
  }
  state.setSettings({ ...state.settings, ...patch });
}

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
