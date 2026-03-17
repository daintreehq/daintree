import { useState, useEffect, useMemo } from "react";
import { projectClient } from "@/clients";
import { useRecipeStore } from "@/store/recipeStore";
import { useProjectStore } from "@/store/projectStore";
import type { ProjectSettings } from "@/types";

export interface UseNewWorktreeProjectSettingsResult {
  projectSettings: ProjectSettings | null;
  gitUsername: string | null;
  configuredBranchPrefix: string;
}

export function useNewWorktreeProjectSettings({
  isOpen,
}: {
  isOpen: boolean;
}): UseNewWorktreeProjectSettingsResult {
  const [projectSettings, setProjectSettings] = useState<ProjectSettings | null>(null);
  const [gitUsername, setGitUsername] = useState<string | null>(null);

  const { recipes, loadRecipes } = useRecipeStore();
  const currentProject = useProjectStore((s) => s.currentProject);

  useEffect(() => {
    if (!isOpen) {
      setProjectSettings(null);
      setGitUsername(null);
      return;
    }

    if (!currentProject) return;

    const requestedProjectId = currentProject.id;
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
      .catch((err) => console.error("Failed to load project settings:", err));

    if (recipes.length === 0 && currentProject?.id) {
      loadRecipes(currentProject.id).catch((err) => console.error("Failed to load recipes:", err));
    }
  }, [isOpen, currentProject, recipes.length, loadRecipes]);

  const configuredBranchPrefix = useMemo(() => {
    if (!projectSettings) return "";
    const mode = projectSettings.branchPrefixMode ?? "none";
    if (mode === "none") return "";
    if (mode === "username") return gitUsername ? `${gitUsername}/` : "";
    if (mode === "custom") return projectSettings.branchPrefixCustom?.trim() ?? "";
    return "";
  }, [projectSettings, gitUsername]);

  return { projectSettings, gitUsername, configuredBranchPrefix };
}
