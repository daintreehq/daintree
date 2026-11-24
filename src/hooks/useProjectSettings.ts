import { useState, useEffect, useCallback, useRef } from "react";
import type { ProjectSettings, RunCommand } from "../types";
import { useProjectStore } from "../store/projectStore";
import { useProjectSettingsStore } from "../store/projectSettingsStore";
import { projectClient } from "@/clients";
import { withProjectSettingsWrite } from "@/clients/projectClient";
import { logError } from "@/utils/logger";
import { updateBrandingCache } from "./useProjectBranding";
import { formatErrorMessage } from "@shared/utils/errorMessage";

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
  useEffect(() => {
    latestTargetIdRef.current = targetId;
  }, [targetId]);

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
      logError("Failed to load project settings", err);
      if (requestedProjectId === latestTargetIdRef.current) {
        setLocalError(formatErrorMessage(err, "Failed to load project settings"));
        setLocalSettings(null);
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
        void loadSettings(targetId);
      }
    } else {
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

        // Write-through: update branding cache so subscribers see the new icon immediately
        updateBrandingCache(targetId, newSettings.projectIconSvg);

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
        logError("Failed to save project settings", err);
        const errorMsg = formatErrorMessage(err, "Failed to save project settings");
        setLocalError(errorMsg);
        throw err;
      }
    },
    [targetId, useGlobalStore, setSettings, currentProject?.id, localAllDetectedRunners]
  );

  // Pins and unpins edit the commands of a fresh read inside the settings write
  // queue, not of this view's cached copy: other writers save to disk without
  // touching the cache, and a whole save of the cache would revert them (#17199).
  const editRunCommands = useCallback(
    async (edit: (commands: RunCommand[]) => RunCommand[], failure: string) => {
      const currentSettings = useGlobalStore ? storeSettings : localSettings;
      if (!currentSettings || !targetId) return;

      try {
        await withProjectSettingsWrite(targetId, async () => {
          const stored = await projectClient.getSettings(targetId);
          const commands = stored.runCommands ?? [];
          const updated = edit(commands);
          const newSettings = updated === commands ? stored : { ...stored, runCommands: updated };
          if (newSettings !== stored) {
            await projectClient.saveSettings(targetId, newSettings);
          }

          // Published before the queue moves on, so a later write's copy is never
          // followed by this older one.
          if (latestTargetIdRef.current !== targetId) return;

          if (useGlobalStore) {
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
        });

        setLocalError(null);
      } catch (err) {
        logError(failure, err);
        setLocalError(formatErrorMessage(err, failure));
        throw err;
      }
    },
    [useGlobalStore, storeSettings, localSettings, targetId, setSettings, localAllDetectedRunners]
  );

  const promoteToSaved = useCallback(
    (command: RunCommand) =>
      editRunCommands(
        (commands) =>
          commands.some((c) => c.command === command.command) ? commands : [...commands, command],
        "Failed to promote command"
      ),
    [editRunCommands]
  );

  const removeFromSaved = useCallback(
    (commandString: string) =>
      editRunCommands(
        (commands) =>
          commands.some((c) => c.command === commandString)
            ? commands.filter((c) => c.command !== commandString)
            : commands,
        "Failed to remove command"
      ),
    [editRunCommands]
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
