import { useState, useEffect, useMemo } from "react";
import { projectClient, worktreeClient } from "@/clients";
import { usableEnvironmentKeys } from "@/lib/resourceEnvironments";
import { logError } from "@/utils/logger";
import { useRecipeStore } from "@/store/recipeStore";
import { useProjectStore } from "@/store/projectStore";
import type { ProjectSettings } from "@/types";

export interface UseNewWorktreeProjectSettingsResult {
  projectSettings: ProjectSettings | null;
  gitUsername: string | null;
  configuredBranchPrefix: string;
  /**
   * The environments a worktree can be created in: Project settings' own,
   * or, when it has none, the ones the workspace host reads from a settings
   * file, which it falls back to in the same order.
   */
  resourceEnvironments: Record<string, unknown> | undefined;
  /** Both lists have answered (or failed), so `resourceEnvironments` is the whole of it. */
  environmentsLoaded: boolean;
}

export function useNewWorktreeProjectSettings({
  isOpen,
}: {
  isOpen: boolean;
}): UseNewWorktreeProjectSettingsResult {
  const [projectSettings, setProjectSettings] = useState<ProjectSettings | null>(null);
  const [gitUsername, setGitUsername] = useState<string | null>(null);
  const [hostEnvironmentKeys, setHostEnvironmentKeys] = useState<string[]>([]);
  const [hostEnvironmentsAnswered, setHostEnvironmentsAnswered] = useState(false);
  // Answered or failed: a failed read lists nothing more later, so nothing waits on it.
  const [settingsAnswered, setSettingsAnswered] = useState(false);

  const { recipes, loadRecipes } = useRecipeStore();
  const currentProject = useProjectStore((s) => s.currentProject);

  useEffect(() => {
    if (!isOpen) {
      setProjectSettings(null);
      setGitUsername(null);
      setSettingsAnswered(false);
      return;
    }

    if (!currentProject) return;

    const requestedProjectId = currentProject.id;
    let current = true;
    projectClient
      .getSettings(requestedProjectId)
      .then((settings) => {
        if (currentProject?.id === requestedProjectId) {
          setProjectSettings(settings);
          if (settings.branchPrefixMode === "username") {
            window.electron.git
              .getUsername(currentProject.path)
              .then((username) => {
                if (!username) {
                  setGitUsername(null);
                  return;
                }
                const slug = username
                  .toLowerCase()
                  .replace(/[^a-z0-9-]/g, "-")
                  .replace(/-+/g, "-")
                  .replace(/^-|-$/g, "");
                setGitUsername(slug || null);
              })
              .catch(() => setGitUsername(null));
          }
        }
      })
      .catch((err) => logError("Failed to load project settings", err))
      .finally(() => {
        if (current) setSettingsAnswered(true);
      });

    if (recipes.length === 0 && currentProject?.id) {
      loadRecipes(currentProject.id).catch((err) => logError("Failed to load recipes", err));
    }
    return () => {
      current = false;
    };
  }, [isOpen, currentProject, recipes.length, loadRecipes]);

  useEffect(() => {
    setHostEnvironmentsAnswered(false);
    if (!isOpen || !currentProject) {
      setHostEnvironmentKeys([]);
      return;
    }
    let current = true;
    worktreeClient
      .hasResourceConfig(currentProject.path)
      .then(({ environmentKeys }) => {
        if (current) setHostEnvironmentKeys(environmentKeys ?? []);
      })
      // Project settings' own list still stands.
      .catch((err) => logError("Failed to read the host's resource environments", err))
      .finally(() => {
        if (current) setHostEnvironmentsAnswered(true);
      });
    return () => {
      current = false;
    };
  }, [isOpen, currentProject]);

  const resourceEnvironments = useMemo(() => {
    const saved = projectSettings?.resourceEnvironments;
    if (usableEnvironmentKeys(saved).length > 0 || hostEnvironmentKeys.length === 0) return saved;
    return Object.fromEntries(hostEnvironmentKeys.map((key) => [key, {}]));
  }, [projectSettings, hostEnvironmentKeys]);

  const configuredBranchPrefix = useMemo(() => {
    if (!projectSettings) return "";
    const mode = projectSettings.branchPrefixMode ?? "none";
    if (mode === "none") return "";
    if (mode === "username") return gitUsername ? `${gitUsername}/` : "";
    if (mode === "custom") return projectSettings.branchPrefixCustom?.trim() ?? "";
    return "";
  }, [projectSettings, gitUsername]);

  return {
    projectSettings,
    gitUsername,
    configuredBranchPrefix,
    resourceEnvironments,
    environmentsLoaded: settingsAnswered && hostEnvironmentsAnswered,
  };
}
