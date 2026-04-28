import { useCallback, useMemo } from "react";
import type { WorktreeSnapshot, RecipeTerminal } from "@/types";
import { useErrorStore, type AppError } from "@/store";
import { useRecipeStore } from "@/store/recipeStore";
import { logError } from "@/utils/logger";
import { useNotificationStore } from "@/store/notificationStore";
import { formatBytes } from "@/lib/formatBytes";
import { actionService } from "@/services/ActionService";
import { formatErrorMessage } from "@shared/utils/errorMessage";

export function formatCopyResultMessage(payload: {
  fileCount: number;
  stats?: { totalSize?: number } | null;
  format?: string;
}): string {
  const fileCount =
    typeof payload.fileCount === "number" && Number.isFinite(payload.fileCount)
      ? payload.fileCount
      : 0;
  const stats = payload.stats ?? undefined;
  const sizeStr = stats?.totalSize ? formatBytes(stats.totalSize) : "";
  const formatStr = payload.format ? ` as ${payload.format.toUpperCase()}` : "";
  return `Copied ${fileCount} files${sizeStr ? ` (${sizeStr})` : ""}${formatStr} to clipboard`;
}

export async function copyContextWithFeedback(
  worktreeId: string,
  options?: { modified?: boolean }
): Promise<void> {
  const store = useNotificationStore.getState();
  const toastId = store.addNotification({
    type: "info",
    message: options?.modified ? "Copying modified files…" : "Copying context…",
    priority: "high",
    duration: 0,
  });

  try {
    const result = await actionService.dispatch(
      "worktree.copyTree",
      { worktreeId, modified: options?.modified },
      { source: "context-menu" }
    );

    if (!result.ok) {
      throw new Error(result.error.message);
    }

    if (!result.result) {
      store.updateNotification(toastId, {
        type: "info",
        message: "No files to copy",
        duration: 3000,
        dismissed: false,
      });
      return;
    }

    const payload = result.result as {
      fileCount: number;
      stats?: { totalSize?: number } | null;
      format?: string;
    };

    store.updateNotification(toastId, {
      type: "success",
      message: formatCopyResultMessage(payload),
      duration: 3000,
      dismissed: false,
    });
  } catch (e) {
    const message = formatErrorMessage(e, "Failed to copy context to clipboard");
    store.updateNotification(toastId, {
      type: "error",
      message: `Copy context failed: ${message}`,
      duration: 5000,
      dismissed: false,
    });

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

    useErrorStore.getState().addError({
      type: errorType,
      message: `Copy context failed: ${message}`,
      details: e instanceof Error ? e.stack : undefined,
      source: "WorktreeCard",
      context: { worktreeId },
      isTransient: true,
      correlationId: crypto.randomUUID(),
    });
  }
}

export interface UseWorktreeActionsOptions {
  onOpenRecipeEditor?: (worktreeId: string, initialTerminals?: RecipeTerminal[]) => void;
}

export interface WorktreeActions {
  handleCopyTree: (worktree: WorktreeSnapshot) => Promise<string | undefined>;
  handleOpenEditor: (worktree: WorktreeSnapshot) => void;
  handleOpenIssue: (worktree: WorktreeSnapshot) => void;
  handleOpenPR: (worktree: WorktreeSnapshot) => void;
  handleSaveLayout: (worktree: WorktreeSnapshot) => void;
  handleLaunchAgent: (worktreeId: string, agentId: string) => void;
}

export function useWorktreeActions({
  onOpenRecipeEditor,
}: UseWorktreeActionsOptions = {}): WorktreeActions {
  const addError = useErrorStore((state) => state.addError);

  const handleCopyTree = useCallback(
    async (worktree: WorktreeSnapshot): Promise<string | undefined> => {
      try {
        const result = await actionService.dispatch(
          "worktree.copyTree",
          { worktreeId: worktree.id },
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
          format?: string;
        };
        return formatCopyResultMessage(payload);
      } catch (e) {
        const message = formatErrorMessage(e, "Failed to copy context to clipboard");
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
          correlationId: crypto.randomUUID(),
        });

        logError("Failed to copy context", undefined, { message });
        return undefined;
      }
    },
    [addError]
  );

  const handleOpenEditor = useCallback((worktree: WorktreeSnapshot) => {
    void actionService.dispatch(
      "worktree.openEditor",
      { worktreeId: worktree.id },
      { source: "user" }
    );
  }, []);

  const handleOpenIssue = useCallback((worktree: WorktreeSnapshot) => {
    if (worktree.issueNumber) {
      void actionService.dispatch(
        "worktree.openIssue",
        { worktreeId: worktree.id },
        { source: "user" }
      );
    }
  }, []);

  const handleOpenPR = useCallback((worktree: WorktreeSnapshot) => {
    if (worktree.prUrl) {
      void actionService.dispatch(
        "worktree.openPR",
        { worktreeId: worktree.id },
        { source: "user" }
      );
    }
  }, []);

  const handleSaveLayout = useCallback(
    (worktree: WorktreeSnapshot) => {
      const terminals = useRecipeStore.getState().generateRecipeFromActiveTerminals(worktree.id);

      if (terminals.length === 0) {
        addError({
          type: "config",
          message: "No active terminals to save in this worktree.",
          source: "Save Layout",
          isTransient: true,
          correlationId: crypto.randomUUID(),
        });
        return;
      }

      onOpenRecipeEditor?.(worktree.id, terminals);
    },
    [addError, onOpenRecipeEditor]
  );

  const handleLaunchAgent = useCallback((worktreeId: string, agentId: string) => {
    void actionService.dispatch(
      "agent.launch",
      { agentId, worktreeId, location: "grid" },
      { source: "user" }
    );
  }, []);

  return useMemo(
    () => ({
      handleCopyTree,
      handleOpenEditor,
      handleOpenIssue,
      handleOpenPR,
      handleSaveLayout,
      handleLaunchAgent,
    }),
    [
      handleCopyTree,
      handleOpenEditor,
      handleOpenIssue,
      handleOpenPR,
      handleSaveLayout,
      handleLaunchAgent,
    ]
  );
}
