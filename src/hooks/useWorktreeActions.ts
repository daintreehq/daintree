import { useCallback } from "react";
import type { WorktreeState, RecipeTerminal } from "@/types";
import { useErrorStore, type AppError } from "@/store";
import { useRecipeStore } from "@/store/recipeStore";
import { formatBytes } from "@/lib/formatBytes";
import { actionService } from "@/services/ActionService";

export interface UseWorktreeActionsOptions {
  onOpenRecipeEditor?: (worktreeId: string, initialTerminals?: RecipeTerminal[]) => void;
  launchAgent?: (agentId: string, options: { worktreeId: string; location: "grid" }) => void;
}

export interface WorktreeActions {
  handleCopyTree: (worktree: WorktreeState) => Promise<string | undefined>;
  handleOpenEditor: (worktree: WorktreeState) => void;
  handleOpenIssue: (worktree: WorktreeState) => void;
  handleOpenPR: (worktree: WorktreeState) => void;
  handleSaveLayout: (worktree: WorktreeState) => void;
  handleLaunchAgent: (worktreeId: string, agentId: string) => void;
}

export function useWorktreeActions({
  onOpenRecipeEditor,
  launchAgent,
}: UseWorktreeActionsOptions = {}): WorktreeActions {
  const addError = useErrorStore((state) => state.addError);

  const handleCopyTree = useCallback(
    async (worktree: WorktreeState): Promise<string | undefined> => {
      try {
        const result = await actionService.dispatch(
          "worktree.copyTree",
          { worktreeId: worktree.id, format: "xml" },
          { source: "user" }
        );
        if (!result.ok) {
          throw new Error(result.error.message);
        }

        if (!result.result) {
          return undefined;
        }

        const payload = result.result as {
          fileCount: number;
          stats?: { totalSize?: number } | null;
        };
        const stats = payload.stats ?? undefined;
        const sizeStr = stats?.totalSize ? formatBytes(stats.totalSize) : "";
        return `Copied ${payload.fileCount} files${sizeStr ? ` (${sizeStr})` : ""} to clipboard`;
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
        });

        console.error("Failed to copy context:", message);
        return undefined;
      }
    },
    [addError]
  );

  const handleOpenEditor = useCallback((worktree: WorktreeState) => {
    void actionService.dispatch(
      "worktree.openEditor",
      { worktreeId: worktree.id },
      { source: "user" }
    );
  }, []);

  const handleOpenIssue = useCallback((worktree: WorktreeState) => {
    if (worktree.issueNumber) {
      void actionService.dispatch(
        "worktree.openIssue",
        { worktreeId: worktree.id },
        { source: "user" }
      );
    }
  }, []);

  const handleOpenPR = useCallback((worktree: WorktreeState) => {
    if (worktree.prUrl) {
      void actionService.dispatch(
        "worktree.openPR",
        { worktreeId: worktree.id },
        { source: "user" }
      );
    }
  }, []);

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
    (worktreeId: string, agentId: string) => {
      launchAgent?.(agentId, { worktreeId, location: "grid" });
    },
    [launchAgent]
  );

  return {
    handleCopyTree,
    handleOpenEditor,
    handleOpenIssue,
    handleOpenPR,
    handleSaveLayout,
    handleLaunchAgent,
  };
}
