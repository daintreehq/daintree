import { useCallback, useReducer, useRef, useMemo, useEffect } from "react";
import PQueue from "p-queue";
import {
  GitBranch,
  Loader2,
  Check,
  AlertTriangle,
  UserPlus,
  Play,
  ChevronsUpDown,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { AppDialog } from "@/components/ui/AppDialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { actionService } from "@/services/ActionService";
import { detectPrefixFromIssue, buildBranchName } from "@/components/Worktree/branchPrefixUtils";
import { generateBranchSlug } from "@/utils/textParsing";
import { notify } from "@/lib/notify";
import { usePreferencesStore } from "@/store/preferencesStore";
import { useGitHubConfigStore } from "@/store/githubConfigStore";
import { useRecipeStore } from "@/store/recipeStore";
import { useProjectStore } from "@/store/projectStore";
import { useWorktreeDataStore } from "@/store/worktreeDataStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { useRecipePicker } from "@/components/Worktree/hooks/useRecipePicker";
import { useNewWorktreeProjectSettings } from "@/components/Worktree/hooks/useNewWorktreeProjectSettings";
import type { GitHubIssue } from "@shared/types/github";

interface BulkCreateWorktreeDialogProps {
  isOpen: boolean;
  onClose: () => void;
  selectedIssues: GitHubIssue[];
  onComplete: () => void;
}

interface ProgressState {
  phase: "idle" | "executing" | "done";
  total: number;
  completed: number;
  failed: number;
  currentItem: { issueNumber: number; title: string } | null;
}

type ProgressAction =
  | { type: "START"; total: number }
  | { type: "ITEM_STARTED"; issueNumber: number; title: string }
  | { type: "COMPLETED" }
  | { type: "FAILED" }
  | { type: "DONE" }
  | { type: "RESET" };

function progressReducer(state: ProgressState, action: ProgressAction): ProgressState {
  switch (action.type) {
    case "START":
      return { phase: "executing", total: action.total, completed: 0, failed: 0, currentItem: null };
    case "ITEM_STARTED":
      return { ...state, currentItem: { issueNumber: action.issueNumber, title: action.title } };
    case "COMPLETED":
      return { ...state, completed: state.completed + 1 };
    case "FAILED":
      return { ...state, failed: state.failed + 1 };
    case "DONE":
      return { ...state, phase: "done", currentItem: null };
    case "RESET":
      return { phase: "idle", total: 0, completed: 0, failed: 0, currentItem: null };
  }
}

interface PlannedWorktree {
  issue: GitHubIssue;
  branchName: string;
  prefix: string;
  skipped: boolean;
  skipReason?: string;
}

function planWorktrees(
  issues: GitHubIssue[],
  existingIssueNumbers: Set<number>
): PlannedWorktree[] {
  return issues.map((issue) => {
    if (issue.state !== "OPEN") {
      return {
        issue,
        branchName: "",
        prefix: "",
        skipped: true,
        skipReason: "Closed",
      };
    }
    if (existingIssueNumbers.has(issue.number)) {
      return {
        issue,
        branchName: "",
        prefix: "",
        skipped: true,
        skipReason: "Has worktree",
      };
    }

    const prefix = detectPrefixFromIssue(issue) ?? "feature";
    const slug = generateBranchSlug(issue.title);
    const issuePrefix = `issue-${issue.number}-`;
    const branchName = buildBranchName(prefix, `${issuePrefix}${slug || "worktree"}`);

    return { issue, branchName, prefix, skipped: false };
  });
}

export function BulkCreateWorktreeDialog({
  isOpen,
  onClose,
  selectedIssues,
  onComplete,
}: BulkCreateWorktreeDialogProps) {
  const [progress, dispatchProgress] = useReducer(progressReducer, {
    phase: "idle",
    total: 0,
    completed: 0,
    failed: 0,
    currentItem: null,
  });
  const queueRef = useRef<PQueue | null>(null);
  const runIdRef = useRef(0);

  // Shared preferences (same store as single create dialog)
  const assignWorktreeToSelf = usePreferencesStore((s) => s.assignWorktreeToSelf);
  const setAssignWorktreeToSelf = usePreferencesStore((s) => s.setAssignWorktreeToSelf);
  const lastSelectedWorktreeRecipeIdByProject = usePreferencesStore(
    (s) => s.lastSelectedWorktreeRecipeIdByProject
  );
  const setLastSelectedWorktreeRecipeIdByProject = usePreferencesStore(
    (s) => s.setLastSelectedWorktreeRecipeIdByProject
  );

  const githubConfig = useGitHubConfigStore((s) => s.config);
  const initializeGitHubConfig = useGitHubConfigStore((s) => s.initialize);
  const { recipes } = useRecipeStore();
  const currentProject = useProjectStore((s) => s.currentProject);
  const projectId = currentProject?.id ?? "";
  const lastSelectedWorktreeRecipeId = lastSelectedWorktreeRecipeIdByProject[projectId];

  const currentUser = githubConfig?.username;
  const currentUserAvatar = githubConfig?.avatarUrl;

  const { projectSettings } = useNewWorktreeProjectSettings({ isOpen });
  const defaultRecipeId = projectSettings?.defaultWorktreeRecipeId;
  const globalRecipes = useMemo(() => recipes.filter((r) => !r.worktreeId), [recipes]);

  // Recipe picker (shared preferences with single create)
  const {
    selectedRecipeId,
    setSelectedRecipeId,
    recipePickerOpen,
    setRecipePickerOpen,
    recipeSelectionTouchedRef,
    selectedRecipe,
  } = useRecipePicker({
    isOpen,
    defaultRecipeId,
    globalRecipes,
    lastSelectedWorktreeRecipeId,
    projectId,
    setLastSelectedWorktreeRecipeIdByProject,
  });

  useEffect(() => {
    initializeGitHubConfig();
  }, [initializeGitHubConfig]);

  // Plan worktrees
  const planned = useMemo(() => {
    const worktrees = useWorktreeDataStore.getState().worktrees;
    const existingIssueNumbers = new Set<number>();
    for (const wt of worktrees.values()) {
      if (wt.issueNumber) existingIssueNumbers.add(wt.issueNumber);
    }
    return planWorktrees(selectedIssues, existingIssueNumbers);
  }, [selectedIssues]);

  const creatableCount = planned.filter((p) => !p.skipped).length;

  const isExecuting = progress.phase === "executing";
  const isDone = progress.phase === "done";
  const processedCount = progress.completed + progress.failed;

  const handleCreate = useCallback(async () => {
    const toCreate = planned.filter((p) => !p.skipped);
    if (toCreate.length === 0) {
      notify({
        type: "info",
        title: "Nothing to Create",
        message: "All selected issues already have worktrees or are closed",
      });
      return;
    }

    // Save recipe preference
    if (recipeSelectionTouchedRef.current && projectId) {
      setLastSelectedWorktreeRecipeIdByProject(projectId, selectedRecipeId);
    }

    const currentRunId = ++runIdRef.current;
    dispatchProgress({ type: "START", total: toCreate.length });

    const queue = new PQueue({ concurrency: 4 });
    queueRef.current = queue;
    let succeeded = 0;
    let failed = 0;
    let lastSuccessfulWorktreeId: string | null = null;

    for (const item of toCreate) {
      void queue.add(async () => {
        if (runIdRef.current !== currentRunId) return;
        dispatchProgress({ type: "ITEM_STARTED", issueNumber: item.issue.number, title: item.issue.title });

        try {
          const result = await actionService.dispatch(
            "worktree.createWithRecipe",
            {
              branchName: item.branchName,
              recipeId: selectedRecipeId ?? undefined,
              issueNumber: item.issue.number,
              assignToSelf: assignWorktreeToSelf,
            },
            { source: "user", confirmed: true }
          );

          if (runIdRef.current !== currentRunId) return;

          if (result.ok) {
            const { worktreeId } = result.result as { worktreeId: string };
            lastSuccessfulWorktreeId = worktreeId;
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

    if (lastSuccessfulWorktreeId) {
      useWorktreeSelectionStore.getState().setPendingWorktree(lastSuccessfulWorktreeId);
      useWorktreeSelectionStore.getState().selectWorktree(lastSuccessfulWorktreeId);
    }

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
  }, [
    planned,
    selectedRecipeId,
    assignWorktreeToSelf,
    projectId,
    recipeSelectionTouchedRef,
    setLastSelectedWorktreeRecipeIdByProject,
  ]);

  const handleClose = useCallback(() => {
    if (isExecuting) {
      runIdRef.current++;
      queueRef.current?.clear();
      queueRef.current = null;
    }
    dispatchProgress({ type: "RESET" });
    onClose();
  }, [isExecuting, onClose]);

  const handleDone = useCallback(() => {
    dispatchProgress({ type: "RESET" });
    onComplete();
    onClose();
  }, [onComplete, onClose]);

  const handleRecipeSelect = useCallback(
    (recipeId: string) => {
      recipeSelectionTouchedRef.current = true;
      setSelectedRecipeId(recipeId);
      if (projectId) setLastSelectedWorktreeRecipeIdByProject(projectId, recipeId);
      setRecipePickerOpen(false);
    },
    [
      setSelectedRecipeId,
      setRecipePickerOpen,
      recipeSelectionTouchedRef,
      projectId,
      setLastSelectedWorktreeRecipeIdByProject,
    ]
  );

  const handleRecipeSelectNone = useCallback(() => {
    recipeSelectionTouchedRef.current = true;
    setSelectedRecipeId(null);
    if (projectId) setLastSelectedWorktreeRecipeIdByProject(projectId, null);
    setRecipePickerOpen(false);
  }, [
    setSelectedRecipeId,
    setRecipePickerOpen,
    recipeSelectionTouchedRef,
    projectId,
    setLastSelectedWorktreeRecipeIdByProject,
  ]);

  return (
    <AppDialog
      isOpen={isOpen}
      onClose={handleClose}
      size="md"
      dismissible={!isExecuting}
      data-testid="bulk-create-worktree-dialog"
    >
      <AppDialog.Header>
        <AppDialog.Title
          icon={
            isExecuting ? (
              <Loader2 className="w-5 h-5 text-canopy-accent animate-spin" />
            ) : isDone ? (
              progress.failed > 0 ? (
                <AlertTriangle className="w-5 h-5 text-status-warning" />
              ) : (
                <Check className="w-5 h-5 text-status-success" />
              )
            ) : (
              <GitBranch className="w-5 h-5 text-canopy-accent" />
            )
          }
        >
          {isExecuting
            ? "Creating Worktrees\u2026"
            : isDone
              ? "Creation Complete"
              : `Create ${creatableCount} Worktree${creatableCount !== 1 ? "s" : ""}`}
        </AppDialog.Title>
        {!isExecuting && <AppDialog.CloseButton />}
      </AppDialog.Header>

      <AppDialog.Body>
        {progress.phase === "idle" ? (
          <div className="space-y-4">
            {/* Assign to self */}
            {currentUser && (
              <div className="flex items-center gap-3 px-3 py-2.5 rounded-[var(--radius-md)] border bg-canopy-bg/50 border-canopy-border transition-colors">
                {currentUserAvatar ? (
                  <img
                    src={`${currentUserAvatar}${currentUserAvatar.includes("?") ? "&" : "?"}s=64`}
                    alt={currentUser}
                    className="w-8 h-8 rounded-full shrink-0"
                  />
                ) : (
                  <div className="flex items-center justify-center w-8 h-8 rounded-full shrink-0 bg-canopy-accent/10 text-canopy-accent">
                    <UserPlus className="w-4 h-4" />
                  </div>
                )}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-canopy-text">Assign to me</span>
                    <span className="text-xs text-canopy-text/50 font-mono">@{currentUser}</span>
                  </div>
                </div>
                <label className="relative inline-flex items-center cursor-pointer">
                  <input
                    type="checkbox"
                    checked={assignWorktreeToSelf}
                    onChange={(e) => setAssignWorktreeToSelf(e.target.checked)}
                    className="sr-only peer"
                    aria-label="Assign issues to me when creating worktrees"
                  />
                  <div
                    className={cn(
                      "w-9 h-5 rounded-full transition-colors",
                      "peer-focus-visible:ring-2 peer-focus-visible:ring-canopy-accent",
                      "after:content-[''] after:absolute after:top-0.5 after:left-0.5",
                      "after:bg-white after:rounded-full after:h-4 after:w-4",
                      "after:transition-transform after:duration-200",
                      assignWorktreeToSelf
                        ? "bg-canopy-accent after:translate-x-4"
                        : "bg-canopy-border after:translate-x-0"
                    )}
                  />
                </label>
              </div>
            )}

            {/* Recipe picker */}
            {globalRecipes.length > 0 && (
              <div className="space-y-2">
                <label
                  htmlFor="bulk-recipe-selector"
                  className="block text-sm font-medium text-canopy-text"
                >
                  Run Recipe (Optional)
                </label>
                <Popover open={recipePickerOpen} onOpenChange={setRecipePickerOpen}>
                  <PopoverTrigger asChild>
                    <Button
                      id="bulk-recipe-selector"
                      variant="outline"
                      role="combobox"
                      aria-expanded={recipePickerOpen}
                      aria-haspopup="listbox"
                      aria-controls="bulk-recipe-list"
                      className="w-full justify-between bg-canopy-bg border-canopy-border text-canopy-text hover:bg-canopy-bg hover:text-canopy-text"
                    >
                      <span className="flex items-center gap-2 truncate">
                        <Play className="shrink-0 text-canopy-accent" />
                        {selectedRecipe ? (
                          <>
                            <span>{selectedRecipe.name}</span>
                            <span className="text-xs text-canopy-text/50">
                              ({selectedRecipe.terminals.length} terminal
                              {selectedRecipe.terminals.length !== 1 ? "s" : ""})
                            </span>
                          </>
                        ) : (
                          <span className="text-canopy-text/60">No recipe</span>
                        )}
                      </span>
                      <ChevronsUpDown className="opacity-50 shrink-0" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent
                    className="w-[400px] p-0"
                    align="start"
                    onEscapeKeyDown={(e) => e.stopPropagation()}
                  >
                    <div
                      id="bulk-recipe-list"
                      role="listbox"
                      className="max-h-[300px] overflow-y-auto p-1"
                    >
                      <div
                        role="option"
                        aria-selected={selectedRecipeId === null}
                        tabIndex={0}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            handleRecipeSelectNone();
                          }
                        }}
                        onClick={handleRecipeSelectNone}
                        className={cn(
                          "flex items-center justify-between gap-2 px-2 py-1.5 text-sm rounded-[var(--radius-sm)] cursor-pointer hover:bg-canopy-border",
                          selectedRecipeId === null && "bg-canopy-border"
                        )}
                      >
                        <span className="text-canopy-text/60">No recipe</span>
                        {selectedRecipeId === null && (
                          <Check className="h-4 w-4 shrink-0 text-canopy-accent" />
                        )}
                      </div>
                      {globalRecipes.map((recipe) => (
                        <div
                          key={recipe.id}
                          role="option"
                          aria-selected={recipe.id === selectedRecipeId}
                          tabIndex={0}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              handleRecipeSelect(recipe.id);
                            }
                          }}
                          onClick={() => handleRecipeSelect(recipe.id)}
                          className={cn(
                            "flex items-center justify-between gap-2 px-2 py-1.5 text-sm rounded-[var(--radius-sm)] cursor-pointer hover:bg-canopy-border",
                            recipe.id === selectedRecipeId && "bg-canopy-border"
                          )}
                        >
                          <div className="flex items-center gap-2 min-w-0">
                            <span className="truncate">{recipe.name}</span>
                            <span className="text-xs text-canopy-text/50 shrink-0">
                              {recipe.terminals.length} terminal
                              {recipe.terminals.length !== 1 ? "s" : ""}
                            </span>
                            {recipe.id === defaultRecipeId && (
                              <span className="text-xs text-canopy-accent shrink-0">(default)</span>
                            )}
                          </div>
                          {recipe.id === selectedRecipeId && (
                            <Check className="h-4 w-4 shrink-0 text-canopy-accent" />
                          )}
                        </div>
                      ))}
                    </div>
                  </PopoverContent>
                </Popover>
              </div>
            )}

            {/* Worktree list */}
            <div className="space-y-2">
              <label className="block text-sm font-medium text-canopy-text">
                Worktrees to create
              </label>
              <div className="rounded-[var(--radius-md)] border border-canopy-border overflow-hidden divide-y divide-canopy-border">
                {planned.map((item) => (
                  <div
                    key={item.issue.number}
                    className={cn(
                      "px-3 py-2 flex items-center gap-3 text-sm",
                      item.skipped && "opacity-50"
                    )}
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="text-canopy-text/50 text-xs font-mono shrink-0">
                          #{item.issue.number}
                        </span>
                        <span className="text-canopy-text truncate">{item.issue.title}</span>
                      </div>
                      {!item.skipped && (
                        <div className="flex items-center gap-1.5 mt-0.5">
                          <GitBranch className="w-3 h-3 text-canopy-text/40 shrink-0" />
                          <span className="text-xs text-canopy-text/50 font-mono truncate">
                            {item.branchName}
                          </span>
                        </div>
                      )}
                    </div>
                    {item.skipped && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-status-warning/10 text-status-warning shrink-0">
                        {item.skipReason}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center py-8 space-y-6">
            {/* Current item indicator */}
            {isExecuting && progress.currentItem && (
              <div className="flex items-center gap-2.5 text-sm text-canopy-text max-w-full px-4">
                <Loader2 className="w-4 h-4 animate-spin text-canopy-accent shrink-0" />
                <span className="text-canopy-text/50 font-mono shrink-0">
                  #{progress.currentItem.issueNumber}
                </span>
                <span className="truncate">{progress.currentItem.title}</span>
              </div>
            )}

            {/* Done summary icon */}
            {isDone && (
              <div
                className={cn(
                  "flex items-center justify-center w-12 h-12 rounded-full",
                  progress.failed > 0
                    ? "bg-status-warning/10 text-status-warning"
                    : "bg-status-success/10 text-status-success"
                )}
              >
                {progress.failed > 0 ? (
                  <AlertTriangle className="w-6 h-6" />
                ) : (
                  <Check className="w-6 h-6" />
                )}
              </div>
            )}

            {/* Progress bar */}
            <div className="w-full max-w-xs space-y-2">
              <div className="h-2 rounded-full bg-overlay-soft overflow-hidden">
                <div
                  className="h-full rounded-full bg-canopy-accent transition-all duration-300"
                  style={{
                    width: `${progress.total > 0 ? (processedCount / progress.total) * 100 : 0}%`,
                  }}
                />
              </div>

              {/* Numeric progress */}
              <div className="flex items-center justify-center gap-1.5 text-sm text-canopy-text/70">
                <span>
                  {processedCount} of {progress.total} created
                </span>
                {progress.failed > 0 && (
                  <span className="text-status-warning">
                    &middot; {progress.failed} failed
                  </span>
                )}
              </div>
            </div>
          </div>
        )}
      </AppDialog.Body>

      <AppDialog.Footer>
        {isDone ? (
          <Button onClick={handleDone} data-testid="bulk-create-done-button">
            <Check />
            Done
          </Button>
        ) : isExecuting ? (
          <Button variant="ghost" onClick={handleClose}>
            Cancel
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={handleClose}>
              Cancel
            </Button>
            <Button
              onClick={handleCreate}
              disabled={creatableCount === 0}
              className="min-w-[100px]"
              data-testid="bulk-create-confirm-button"
            >
              <Check />
              Create {creatableCount} Worktree{creatableCount !== 1 ? "s" : ""}
            </Button>
          </>
        )}
      </AppDialog.Footer>
    </AppDialog>
  );
}
