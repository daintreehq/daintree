import { useState, useRef, useCallback, useReducer } from "react";
import PQueue from "p-queue";
import { X, GitBranch, Loader2 } from "lucide-react";
import { actionService } from "@/services/ActionService";
import { detectPrefixFromIssue, buildBranchName } from "@/components/Worktree/branchPrefixUtils";
import { generateBranchSlug } from "@/utils/textParsing";
import { notify } from "@/lib/notify";
import { useWorktreeDataStore } from "@/store/worktreeDataStore";
import { RecipePicker } from "./RecipePicker";
import type { GitHubIssue } from "@shared/types/github";

interface IssueBulkActionBarProps {
  selectedIssues: GitHubIssue[];
  onClear: () => void;
}

interface ProgressState {
  phase: "idle" | "executing" | "done";
  total: number;
  completed: number;
  failed: number;
}

type ProgressAction =
  | { type: "START"; total: number }
  | { type: "COMPLETED" }
  | { type: "FAILED" }
  | { type: "DONE" }
  | { type: "RESET" };

function progressReducer(state: ProgressState, action: ProgressAction): ProgressState {
  switch (action.type) {
    case "START":
      return { phase: "executing", total: action.total, completed: 0, failed: 0 };
    case "COMPLETED":
      return { ...state, completed: state.completed + 1 };
    case "FAILED":
      return { ...state, failed: state.failed + 1 };
    case "DONE":
      return { ...state, phase: "done" };
    case "RESET":
      return { phase: "idle", total: 0, completed: 0, failed: 0 };
  }
}

export function IssueBulkActionBar({ selectedIssues, onClear }: IssueBulkActionBarProps) {
  const [showRecipePicker, setShowRecipePicker] = useState(false);
  const [progress, dispatchProgress] = useReducer(progressReducer, {
    phase: "idle",
    total: 0,
    completed: 0,
    failed: 0,
  });
  const queueRef = useRef<PQueue | null>(null);
  const runIdRef = useRef(0);

  const executeBulkCreate = useCallback(
    async (recipeId: string | null) => {
      // Filter to open issues without existing worktrees
      const worktrees = useWorktreeDataStore.getState().worktrees;
      const issuesWithWorktree = new Set<number>();
      for (const wt of worktrees.values()) {
        if (wt.issueNumber) issuesWithWorktree.add(wt.issueNumber);
      }
      const issues = selectedIssues.filter(
        (i) => i.state === "OPEN" && !issuesWithWorktree.has(i.number)
      );
      if (issues.length === 0) {
        notify({
          type: "info",
          title: "Nothing to Create",
          message: "All selected issues already have worktrees or are closed",
        });
        return;
      }

      const currentRunId = ++runIdRef.current;
      dispatchProgress({ type: "START", total: issues.length });

      const queue = new PQueue({ concurrency: 4 });
      queueRef.current = queue;
      let succeeded = 0;
      let failed = 0;

      for (const issue of issues) {
        void queue.add(async () => {
          // Skip state updates if this run was dismissed
          if (runIdRef.current !== currentRunId) return;

          try {
            const prefix = detectPrefixFromIssue(issue) ?? "feature";
            const slug = generateBranchSlug(issue.title);
            const issuePrefix = `issue-${issue.number}-`;
            const branchName = buildBranchName(prefix, `${issuePrefix}${slug || "worktree"}`);

            const result = await actionService.dispatch(
              "worktree.createWithRecipe",
              {
                branchName,
                recipeId: recipeId ?? undefined,
                issueNumber: issue.number,
              },
              { source: "user", confirmed: true }
            );

            if (runIdRef.current !== currentRunId) return;

            if (result.ok) {
              succeeded++;
              dispatchProgress({ type: "COMPLETED" });
            } else {
              failed++;
              dispatchProgress({ type: "FAILED" });
            }
          } catch {
            if (runIdRef.current !== currentRunId) return;
            failed++;
            dispatchProgress({ type: "FAILED" });
          }
        });
      }

      await queue.onIdle();
      if (runIdRef.current !== currentRunId) return;
      queueRef.current = null;
      dispatchProgress({ type: "DONE" });

      if (failed === 0) {
        notify({
          type: "success",
          title: "Bulk Create Complete",
          message: `Created ${succeeded} worktree${succeeded !== 1 ? "s" : ""}`,
        });
      } else {
        notify({
          type: "error",
          title: "Bulk Create Partial Failure",
          message: `${succeeded} created, ${failed} failed`,
        });
      }
    },
    [selectedIssues]
  );

  const handleRecipeSelect = useCallback(
    (recipeId: string | null) => {
      setShowRecipePicker(false);
      void executeBulkCreate(recipeId);
    },
    [executeBulkCreate]
  );

  const handleDismiss = useCallback(() => {
    if (progress.phase === "executing") {
      runIdRef.current++; // Invalidate in-flight tasks
      queueRef.current?.clear();
      queueRef.current = null;
    }
    dispatchProgress({ type: "RESET" });
    onClear();
  }, [progress.phase, onClear]);

  if (selectedIssues.length === 0 && progress.phase === "idle") return null;

  const isExecuting = progress.phase === "executing";
  const isDone = progress.phase === "done";
  const processedCount = progress.completed + progress.failed;

  return (
    <div
      role="toolbar"
      aria-label="Bulk actions"
      className="border-t border-[var(--border-divider)] p-3 flex items-center gap-2 shrink-0 text-sm"
    >
      {isExecuting ? (
        <>
          <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
          <span className="text-canopy-text">
            Creating {processedCount}/{progress.total}...
          </span>
        </>
      ) : isDone ? (
        <>
          <GitBranch className="w-4 h-4 text-muted-foreground" />
          <span className="text-canopy-text">
            {progress.completed} created
            {progress.failed > 0 && `, ${progress.failed} failed`}
          </span>
        </>
      ) : (
        <>
          <span className="flex items-center justify-center min-w-[20px] h-5 px-1.5 rounded-full bg-canopy-accent text-white text-xs font-medium">
            {selectedIssues.length}
          </span>
          <button
            type="button"
            onClick={() => setShowRecipePicker(true)}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded bg-canopy-accent hover:bg-canopy-accent/90 text-white text-xs font-medium transition-colors"
          >
            <GitBranch className="w-3.5 h-3.5" />
            Create Worktrees
          </button>
        </>
      )}
      <div className="w-px h-4 bg-[var(--border-divider)]" />
      <button
        type="button"
        onClick={handleDismiss}
        aria-label={isDone ? "Dismiss" : "Clear selection"}
        className="flex items-center justify-center w-5 h-5 rounded hover:bg-tint/[0.06] transition-colors text-canopy-text/60"
      >
        <X className="w-3.5 h-3.5" />
      </button>
      <RecipePicker
        isOpen={showRecipePicker}
        onClose={() => setShowRecipePicker(false)}
        onSelect={handleRecipeSelect}
      />
    </div>
  );
}
