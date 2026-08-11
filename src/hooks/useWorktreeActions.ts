import { useCallback, useMemo } from "react";
import type { WorktreeSnapshot, RecipeTerminal } from "@/types";
import { useErrorStore, type ErrorRecord } from "@/store";
import { useRecipeStore } from "@/store/recipeStore";
import { logError } from "@/utils/logger";
import { useNotificationStore } from "@/store/notificationStore";
import { describeEmptyFolderCopy, formatCopyResultMessage } from "@/lib/formatCopyResult";
import { actionService } from "@/services/ActionService";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import type { ActionSource } from "@shared/types/actions";
import type { CopyTreeRunSource } from "@shared/types";
import type { CopyTreeBudgetStats, CopyTreeOptions } from "@shared/types/ipc/copyTree";

// Both live in a leaf module: `formatCopyResultMessage` because the copyTree
// action definitions need it and importing it from here would close a cycle
// through `actionService` below (#11722), and `describeEmptyFolderCopy` to keep
// the two CopyTree result formatters together. Re-exported from their original
// public home so existing importers are unaffected.
export { describeEmptyFolderCopy, formatCopyResultMessage };

/**
 * Copy a worktree's context with an in-place spinner-to-result toast.
 *
 * `source` is narrowed to the literal `"context-menu"` rather than the full
 * `ActionSource` on purpose: `worktree.copyTree` raises its own completion
 * toast for every other dispatch source and skips this one precisely because
 * this helper already owns the feedback. Any other source would double-toast,
 * so the compiler — not a convention — is what rules it out (#11735).
 */
export async function copyContextWithFeedback(
  worktreeId: string,
  source: Extract<ActionSource, "context-menu">,
  options?: { modified?: boolean; includePaths?: string[]; scopePaths?: string[] },
  // Which surface this is. `source` can't answer it — the worktree card and the
  // file browser both dispatch as "context-menu" — so callers that know say so.
  copyTreeRunSource?: CopyTreeRunSource
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
      { source, copyTreeRunSource }
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
      // Same title every other copy-tree completion now uses, so the context
      // menu doesn't read as a different feature from the toolbar (#11735).
      title: "Context copied",
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
  handleCopyTree: (
    worktree: WorktreeSnapshot,
    copyTreeRunSource?: CopyTreeRunSource
  ) => Promise<void>;
  handleCopyTreeWithOptions: (
    worktree: WorktreeSnapshot,
    options: CopyTreeOptions,
    copyTreeRunSource?: CopyTreeRunSource
  ) => Promise<void>;
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

  // Shared failure path for both copy routes below. Classifying and recording
  // here rather than at each call site keeps a replayed recent reporting the
  // same way a full copy does — the user cannot tell the two routes apart, so
  // neither should the error surface.
  const reportCopyFailure = useCallback(
    (worktreeId: string, e: unknown, source = "WorktreeCard"): void => {
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
        source,
        context: {
          worktreeId,
        },
        retryability: "auto",
        correlationId: crypto.randomUUID(),
      });

      logError("Failed to copy context", undefined, { message });
    },
    [addError]
  );

  // Resolves once the copy has settled; the completion toast belongs to the
  // `worktree.copyTree` action so the keybinding and palette routes — which
  // never reach this hook — are covered by the same call (#11735).
  const handleCopyTree = useCallback(
    async (worktree: WorktreeSnapshot, copyTreeRunSource?: CopyTreeRunSource): Promise<void> => {
      try {
        const result = await actionService.dispatch(
          "worktree.copyTree",
          { worktreeId: worktree.id },
          { source: "user", copyTreeRunSource }
        );
        if (!result.ok) {
          throw new Error(result.error.message);
        }
      } catch (e) {
        reportCopyFailure(worktree.id, e);
      }
    },
    [reportCopyFailure]
  );

  /**
   * Re-run a stored option set — the toolbar's recents rows (#11733).
   *
   * Reported against the toolbar rather than the worktree card, which is the
   * only surface that reaches this path — the Problems panel shows that source
   * verbatim, so inheriting the full-copy helper's label would point at a
   * component the user never touched.
   *
   * Routed through `copyTree.generateAndCopyFile`, NOT `worktree.copyTree`:
   * that action's args schema is flat and narrow (`format`, `modified`,
   * `includePaths`, `scopePaths`), and Zod object parsing strips unknown keys
   * without erroring — so a record carrying `filter`, `exclude`, `always`,
   * `changed`, the size budgets, `withLineNumbers`, `charLimit` or `sort` would
   * replay as a quietly different copy. `generateAndCopyFile` takes the whole
   * nested options object and validates every field.
   *
   * `options` is passed through verbatim. An empty selection array reads as "no
   * filter" — i.e. the whole worktree — to the SDK, so the schema rejects those
   * at the validated boundary; normalizing them here would reintroduce exactly
   * the fail-open this repo already fixed once.
   *
   * The target is the worktree the caller hands over — the active one — rather
   * than `record.worktreeId`. The dedupe key covers options alone, so a record's
   * `worktreeId` adopts whichever worktree ran it last: it is provenance, not a
   * stable original target, and may name a worktree that no longer exists.
   */
  const handleCopyTreeWithOptions = useCallback(
    async (
      worktree: WorktreeSnapshot,
      options: CopyTreeOptions,
      copyTreeRunSource?: CopyTreeRunSource
    ): Promise<void> => {
      try {
        const result = await actionService.dispatch(
          "copyTree.generateAndCopyFile",
          { worktreeId: worktree.id, options },
          { source: "user", copyTreeRunSource }
        );
        if (!result.ok) {
          throw new Error(result.error.message);
        }
      } catch (e) {
        reportCopyFailure(worktree.id, e, "Toolbar");
      }
    },
    [reportCopyFailure]
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
      handleCopyTreeWithOptions,
      handleOpenEditor,
      handleOpenIssue,
      handleOpenPR,
      handleSaveLayout,
      handleLaunchAgent,
    }),
    [
      handleCopyTree,
      handleCopyTreeWithOptions,
      handleOpenEditor,
      handleOpenIssue,
      handleOpenPR,
      handleSaveLayout,
      handleLaunchAgent,
    ]
  );
}
