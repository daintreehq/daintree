import { useCallback } from "react";
import type { WorktreeState, ProjectDevServerSettings, RecipeTerminal } from "@/types";
import type { AgentType } from "@/hooks/useAgentLauncher";
import { copyTreeClient, devServerClient, githubClient, systemClient } from "@/clients";
import { useErrorStore, type AppError } from "@/store";
import { useRecipeStore } from "@/store/recipeStore";
import { formatBytes } from "@/lib/formatBytes";

export interface UseWorktreeActionsOptions {
  projectSettings?: { devServer?: ProjectDevServerSettings };
  onOpenRecipeEditor?: (worktreeId: string, initialTerminals?: RecipeTerminal[]) => void;
  launchAgent?: (type: AgentType, options: { worktreeId: string; location: "grid" }) => void;
}

export interface WorktreeActions {
  handleCopyTree: (worktree: WorktreeState) => Promise<string | undefined>;
  handleOpenEditor: (worktree: WorktreeState) => void;
  handleToggleServer: (worktree: WorktreeState) => void;
  handleOpenIssue: (worktree: WorktreeState) => void;
  handleOpenPR: (worktree: WorktreeState) => void;
  handleCreateRecipe: (worktreeId: string) => void;
  handleSaveLayout: (worktree: WorktreeState) => void;
  handleLaunchAgent: (worktreeId: string, type: AgentType) => void;
}

export function useWorktreeActions({
  projectSettings,
  onOpenRecipeEditor,
  launchAgent,
}: UseWorktreeActionsOptions = {}): WorktreeActions {
  const addError = useErrorStore((state) => state.addError);

  const handleCopyTree = useCallback(
    async (worktree: WorktreeState): Promise<string | undefined> => {
      try {
        const isAvailable = await copyTreeClient.isAvailable();
        if (!isAvailable) {
          throw new Error(
            "CopyTree SDK not available. Please restart the application or check installation."
          );
        }

        const result = await copyTreeClient.generateAndCopyFile(worktree.id, {
          format: "xml",
        });

        if (result.error) {
          throw new Error(result.error);
        }

        console.log(`Copied ${result.fileCount} files as file reference`);
        const sizeStr = result.stats?.totalSize ? formatBytes(result.stats.totalSize) : "";

        return `Copied ${result.fileCount} files${sizeStr ? ` (${sizeStr})` : ""} to clipboard`;
      } catch (e) {
        const message = e instanceof Error ? e.message : "Failed to copy context to clipboard";
        const details = e instanceof Error ? e.stack : undefined;

        let errorType: AppError["type"] = "process";
        if (message.includes("not available") || message.includes("not installed")) {
          errorType = "config";
        } else if (
          message.includes("permission") ||
          message.includes("EACCES") ||
          message.includes("denied")
        ) {
          errorType = "filesystem";
        }

        addError({
          type: errorType,
          message: `Copy context failed: ${message}`,
          details,
          source: "WorktreeCard",
          context: {
            worktreeId: worktree.id,
          },
          isTransient: true,
          retryAction: "copytree",
          retryArgs: {
            worktreeId: worktree.id,
          },
        });

        console.error("Failed to copy context:", message);
        return undefined;
      }
    },
    [addError]
  );

  const handleOpenEditor = useCallback((worktree: WorktreeState) => {
    systemClient.openPath(worktree.path);
  }, []);

  const handleToggleServer = useCallback(
    (worktree: WorktreeState) => {
      const command = projectSettings?.devServer?.command;
      devServerClient.toggle(worktree.id, worktree.path, command);
    },
    [projectSettings]
  );

  const handleOpenIssue = useCallback((worktree: WorktreeState) => {
    if (worktree.issueNumber) {
      githubClient.openIssue(worktree.path, worktree.issueNumber);
    }
  }, []);

  const handleOpenPR = useCallback((worktree: WorktreeState) => {
    if (worktree.prUrl) {
      githubClient.openPR(worktree.prUrl);
    }
  }, []);

  const handleCreateRecipe = useCallback(
    (worktreeId: string) => {
      onOpenRecipeEditor?.(worktreeId, undefined);
    },
    [onOpenRecipeEditor]
  );

  const handleSaveLayout = useCallback(
    (worktree: WorktreeState) => {
      const terminals = useRecipeStore.getState().generateRecipeFromActiveTerminals(worktree.id);

      if (terminals.length === 0) {
        addError({
          type: "config",
          message: "No active terminals to save in this worktree.",
          source: "Save Layout",
          isTransient: true,
        });
        return;
      }

      onOpenRecipeEditor?.(worktree.id, terminals);
    },
    [addError, onOpenRecipeEditor]
  );

  const handleLaunchAgent = useCallback(
    (worktreeId: string, type: AgentType) => {
      launchAgent?.(type, { worktreeId, location: "grid" });
    },
    [launchAgent]
  );

  return {
    handleCopyTree,
    handleOpenEditor,
    handleToggleServer,
    handleOpenIssue,
    handleOpenPR,
    handleCreateRecipe,
    handleSaveLayout,
    handleLaunchAgent,
  };
}
