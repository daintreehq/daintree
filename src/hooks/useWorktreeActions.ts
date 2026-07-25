import { useCallback, useMemo } from "react";
import type { WorktreeSnapshot, RecipeTerminal } from "@/types";
import { useErrorStore, type ErrorRecord } from "@/store";
import { useRecipeStore } from "@/store/recipeStore";
import { logError } from "@/utils/logger";
import { useNotificationStore } from "@/store/notificationStore";
import { formatBytes } from "@/lib/formatBytes";
import { actionService } from "@/services/ActionService";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import type { ActionSource } from "@shared/types/actions";
import type { CopyTreeBudgetStats, CopyTreeExclusionReason } from "@shared/types/ipc/copyTree";

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

/**
 * Reasons that mean "a rule the project already lives by kept this out", as
 * opposed to a limit the user set in Daintree's own context settings. Only
 * used to explain a zero-file folder copy — the SDK's `scopeFilter` reason is
 * declared but never emitted, so nothing may wait on it.
 */
const IGNORE_RULE_REASONS: CopyTreeExclusionReason[] = [
  "gitignore",
  "copytreeignore",
  "globalGitignore",
  "gitInfoExclude",
  "configExclude",
];

/**
 * Why a folder copy came back empty. Without this the toast reports "Copied 0
 * files", which reads as a failure for the common case of right-clicking a
 * folder that the project ignores wholesale (`node_modules`, `dist`).
 */
export function describeEmptyFolderCopy(stats?: CopyTreeBudgetStats | null): string {
  const byReason = stats?.excluded?.byReason;
  const total = stats?.excluded?.total ?? 0;

  if (total <= 0) {
    return "This folder doesn't contain any files";
  }

  // Nothing was ruled out — the files couldn't be opened at all, which usually
  // means the folder moved or its permissions changed since the tree was read.
  if ((byReason?.unreadable ?? 0) === total) {
    return "The files in this folder couldn't be read";
  }

  const ignored = IGNORE_RULE_REASONS.reduce((sum, reason) => sum + (byReason?.[reason] ?? 0), 0);

  // Only claim a single cause when it accounts for every exclusion; a mixed set
  // gets the neutral wording rather than a confident half-truth.
  return ignored === total
    ? "Every file in this folder is excluded by an ignore rule"
    : "Every file in this folder was excluded by ignore rules or context settings";
}

export async function copyContextWithFeedback(
  worktreeId: string,
  source: ActionSource,
  options?: { modified?: boolean; includePaths?: string[]; scopePaths?: string[] }
): Promise<void> {
  // Direct store call: this is a spinner-then-update pattern that depends on
  // an unconditional toast id. notify() returns "" when notifications are
  // disabled (or quiet hours apply), which would silently break the
  // updateNotification handoff below. The user just clicked "copy context",
  // so feedback is required regardless of quiet-hour preferences.
  const store = useNotificationStore.getState();
  const isFolderCopy = Boolean(options?.scopePaths?.length || options?.includePaths?.length);
  const toastId = store.addNotification({
    type: "info",
    message: options?.modified
      ? "Copying modified files…"
      : isFolderCopy
        ? "Copying folder context…"
        : "Copying context…",
    priority: "high",
    duration: 0,
  });

  try {
    const result = await actionService.dispatch(
      "worktree.copyTree",
      {
        worktreeId,
        modified: options?.modified,
        includePaths: options?.includePaths,
        scopePaths: options?.scopePaths,
      },
      { source }
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
      stats?: (CopyTreeBudgetStats & { totalSize?: number }) | null;
      format?: string;
    };

    // A folder the project ignores wholesale still resolves and copies cleanly,
    // it just yields nothing — so say why instead of reporting a bare zero.
    if (isFolderCopy && payload.fileCount === 0) {
      store.updateNotification(toastId, {
        type: "info",
        title: "No files copied",
        message: describeEmptyFolderCopy(payload.stats),
        duration: 5000,
        dismissed: false,
      });
      return;
    }

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

    let errorType: ErrorRecord["type"] = "process";
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
      retryability: "auto",
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

        let errorType: ErrorRecord["type"] = "process";
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
          retryability: "auto",
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
    if (worktree.linked?.pr?.url) {
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
          retryability: "auto",
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
