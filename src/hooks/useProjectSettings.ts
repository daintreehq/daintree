import { useState, useEffect, useCallback, useRef } from "react";
import type { ProjectSettings, RunCommand } from "../types";
import { useProjectStore } from "../store/projectStore";
import { useProjectSettingsStore } from "../store/projectSettingsStore";
import { projectClient } from "@/clients";

interface UseProjectSettingsReturn {
  settings: ProjectSettings | null;
  detectedRunners: RunCommand[];
  allDetectedRunners: RunCommand[];
  isLoading: boolean;
  error: string | null;
  saveSettings: (settings: ProjectSettings) => Promise<void>;
  promoteToSaved: (command: RunCommand) => Promise<void>;
  removeFromSaved: (commandString: string) => Promise<void>;
  refresh: () => Promise<void>;
}

export function useProjectSettings(projectId?: string): UseProjectSettingsReturn {
  const currentProject = useProjectStore((state) => state.currentProject);
  const targetId = projectId || currentProject?.id;

  // Get store state and actions
  const storeSettings = useProjectSettingsStore((state) => state.settings);
  const storeDetectedRunners = useProjectSettingsStore((state) => state.detectedRunners);
  const storeAllDetectedRunners = useProjectSettingsStore((state) => state.allDetectedRunners);
  const storeProjectId = useProjectSettingsStore((state) => state.projectId);
  const storeIsLoading = useProjectSettingsStore((state) => state.isLoading);
  const storeError = useProjectSettingsStore((state) => state.error);
  const loadSettings = useProjectSettingsStore((state) => state.loadSettings);
  const setSettings = useProjectSettingsStore((state) => state.setSettings);

  // Determine if we should use the global store or fetch locally
  // Use global store only when targeting the current project (no explicit projectId or same as current)
  const useGlobalStore = !projectId || projectId === currentProject?.id;

  // Local state for when fetching settings for a different project (e.g., ProjectSettingsDialog with explicit ID)
  const [localSettings, setLocalSettings] = useState<ProjectSettings | null>(null);
  const [localDetectedRunners, setLocalDetectedRunners] = useState<RunCommand[]>([]);
  const [localAllDetectedRunners, setLocalAllDetectedRunners] = useState<RunCommand[]>([]);
  const [localIsLoading, setLocalIsLoading] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  const latestTargetIdRef = useRef(targetId);
  latestTargetIdRef.current = targetId;

  const fetchLocalSettings = useCallback(async () => {
    if (!targetId) {
      setLocalSettings({ runCommands: [] });
      setLocalDetectedRunners([]);
      setLocalAllDetectedRunners([]);
      return;
    }

    setLocalIsLoading(true);
    setLocalError(null);

    const requestedProjectId = targetId;
    try {
      const [data, detected] = await Promise.all([
        projectClient.getSettings(requestedProjectId),
        projectClient.detectRunners(requestedProjectId),
      ]);

      if (requestedProjectId === latestTargetIdRef.current) {
        setLocalSettings(data);
        setLocalAllDetectedRunners(detected);

        const savedCommandStrings = new Set(data.runCommands?.map((c) => c.command) || []);
        const newDetected = detected.filter((d) => !savedCommandStrings.has(d.command));
        setLocalDetectedRunners(newDetected);
      }
    } catch (err) {
      console.error("Failed to load project settings:", err);
      if (requestedProjectId === latestTargetIdRef.current) {
        setLocalError(err instanceof Error ? err.message : "Unknown error");
        setLocalSettings({ runCommands: [] });
        setLocalDetectedRunners([]);
        setLocalAllDetectedRunners([]);
      }
    } finally {
      if (requestedProjectId === latestTargetIdRef.current) {
        setLocalIsLoading(false);
      }
    }
  }, [targetId]);

  // Fetch from global store if needed (when store is for wrong project or not loaded)
  useEffect(() => {
    if (!targetId) return;

    if (useGlobalStore) {
      // Check if store has correct data
      if (storeProjectId !== targetId && !storeIsLoading) {
        // Store is for a different project, trigger a load
        void loadSettings(targetId);
      }
    } else {
      // Using local state for different project
      void fetchLocalSettings();
    }
  }, [targetId, useGlobalStore, storeProjectId, storeIsLoading, loadSettings, fetchLocalSettings]);

  const saveSettings = useCallback(
    async (newSettings: ProjectSettings) => {
      if (!targetId) {
        console.warn("Cannot save settings: no project ID");
        return;
      }

      try {
        await projectClient.saveSettings(targetId, newSettings);

        // Guard against race condition: verify project hasn't changed during save
        if (latestTargetIdRef.current !== targetId) {
          return;
        }

        // Update global store if saving to current project
        if (useGlobalStore) {
          // Double-check store still belongs to this project after await
          if (useProjectSettingsStore.getState().projectId === targetId) {
            setSettings(newSettings);
          }
        } else {
          // Update local state - recompute detected runners from full list
          setLocalSettings(newSettings);
          const savedCommandStrings = new Set(newSettings.runCommands?.map((c) => c.command) || []);
          setLocalDetectedRunners(
            localAllDetectedRunners.filter((d) => !savedCommandStrings.has(d.command))
          );
        }

        // Also update global store if this is the current project
        // (handles case where dialog opens with explicit projectId for current project)
        if (targetId === currentProject?.id) {
          if (useProjectSettingsStore.getState().projectId === targetId) {
            setSettings(newSettings);
          }
        }

        setLocalError(null);
      } catch (err) {
        console.error("Failed to save project settings:", err);
        const errorMsg = err instanceof Error ? err.message : "Unknown error";
        setLocalError(errorMsg);
        throw err;
      }
    },
    [targetId, useGlobalStore, setSettings, currentProject?.id, localAllDetectedRunners]
  );

  const promoteToSaved = useCallback(
    async (command: RunCommand) => {
      const currentSettings = useGlobalStore ? storeSettings : localSettings;
      if (!currentSettings || !targetId) return;
      if (currentSettings.runCommands.some((c) => c.command === command.command)) return;

      const updated = [...currentSettings.runCommands, command];

      try {
        await projectClient.saveSettings(targetId, {
          ...currentSettings,
          runCommands: updated,
        });

        // Guard against race condition: verify project hasn't changed
        if (latestTargetIdRef.current !== targetId) {
          return;
        }

        const newSettings = {
          ...currentSettings,
          runCommands: updated,
        };

        if (useGlobalStore) {
          // Double-check store still belongs to this project
          if (useProjectSettingsStore.getState().projectId === targetId) {
            setSettings(newSettings);
          }
        } else {
          setLocalSettings(newSettings);
          const savedCommandStrings = new Set(updated.map((c) => c.command));
          setLocalDetectedRunners(
            localAllDetectedRunners.filter((d) => !savedCommandStrings.has(d.command))
          );
        }

        // Also update global store if this is the current project
        if (targetId === currentProject?.id) {
          if (useProjectSettingsStore.getState().projectId === targetId) {
            setSettings(newSettings);
          }
        }

        setLocalError(null);
      } catch (err) {
        console.error("Failed to promote command:", err);
        setLocalError(err instanceof Error ? err.message : "Unknown error");
        throw err;
      }
    },
    [
      useGlobalStore,
      storeSettings,
      localSettings,
      targetId,
      setSettings,
      currentProject?.id,
      localAllDetectedRunners,
    ]
  );

  const removeFromSaved = useCallback(
    async (commandString: string) => {
      const currentSettings = useGlobalStore ? storeSettings : localSettings;
      if (!currentSettings || !targetId) return;

      const updated = currentSettings.runCommands.filter((c) => c.command !== commandString);

      try {
        await projectClient.saveSettings(targetId, {
          ...currentSettings,
          runCommands: updated,
        });

        // Guard against race condition: verify project hasn't changed
        if (latestTargetIdRef.current !== targetId) {
          return;
        }

        const newSettings = {
          ...currentSettings,
          runCommands: updated,
        };

        if (useGlobalStore) {
          // Double-check store still belongs to this project
          if (useProjectSettingsStore.getState().projectId === targetId) {
            setSettings(newSettings);
          }
        } else {
          setLocalSettings(newSettings);
          // Recompute detected runners after removal
          const savedCommandStrings = new Set(updated.map((c) => c.command));
          setLocalDetectedRunners(
            localAllDetectedRunners.filter((d) => !savedCommandStrings.has(d.command))
          );
        }

        // Also update global store if this is the current project
        if (targetId === currentProject?.id) {
          if (useProjectSettingsStore.getState().projectId === targetId) {
            setSettings(newSettings);
          }
        }

        setLocalError(null);
      } catch (err) {
        console.error("Failed to remove command:", err);
        setLocalError(err instanceof Error ? err.message : "Unknown error");
        throw err;
      }
    },
    [
      useGlobalStore,
      storeSettings,
      localSettings,
      targetId,
      setSettings,
      currentProject?.id,
      localAllDetectedRunners,
    ]
  );

  const refresh = useCallback(async () => {
    if (!targetId) return;

    if (useGlobalStore) {
      await loadSettings(targetId);
    } else {
      await fetchLocalSettings();
    }
  }, [targetId, useGlobalStore, loadSettings, fetchLocalSettings]);

  // Return appropriate state based on whether using global store or local state
  if (useGlobalStore) {
    return {
      settings: storeSettings,
      detectedRunners: storeDetectedRunners,
      allDetectedRunners: storeAllDetectedRunners,
      isLoading: storeIsLoading,
      error: storeError,
      saveSettings,
      promoteToSaved,
      removeFromSaved,
      refresh,
    };
  }

  return {
    settings: localSettings,
    detectedRunners: localDetectedRunners,
    allDetectedRunners: localAllDetectedRunners,
    isLoading: localIsLoading,
    error: localError,
    saveSettings,
    promoteToSaved,
    removeFromSaved,
    refresh,
  };
}
