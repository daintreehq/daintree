import { useCallback, useRef, useMemo, useEffect, useLayoutEffect, useState } from "react";
import {
  Avatar,
  Badge,
  Button,
  Checkbox,
  Dialog,
  Icon,
  ProgressBar,
  Spinner,
} from "@daintreehq/plugin-ui";
// The primary stays focusable while unavailable (`aria-disabled`), and a kit
// Button can only be natively disabled, so it takes the host's disabled look.
import { ARIA_DISABLED_CLASSES } from "@/components/ui/ariaDisabled";
import { cn } from "@/lib/utils";
import { avatarUrlAtSize } from "@/components/ui/Avatar";
import { worktreeClient, forgeClient } from "@/clients";
import { logError } from "@/utils/logger";
import { usePreferencesStore } from "@/store/preferencesStore";
import { useRecipeStore } from "@/store/recipeStore";
import { useProjectStore } from "@/store/projectStore";
import { useWorktreeStore } from "@/hooks/useWorktreeStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import {
  useRecipePicker,
  resolveEligibleDefaultRecipeId,
  CLONE_LAYOUT_ID,
} from "@/components/Worktree/hooks/useRecipePicker";
import { RecipePickerPopover } from "@/components/Worktree/views/RecipePickerPopover";
import { BaseBranchCombobox } from "@/components/Worktree/views/BaseBranchCombobox";
import { useBranchPicker } from "@/components/Worktree/hooks/useBranchPicker";
import {
  deriveDefaultBaseBranch,
  type BranchOption,
  type BranchWorktreeRef,
} from "@/components/Worktree/branchPickerUtils";
import { FormGrid, FormRow, FormSection } from "@/components/Worktree/views/WorktreeFormLayout";
import { useNewWorktreeProjectSettings } from "@/components/Worktree/hooks/useNewWorktreeProjectSettings";
import { getStageLabel, type ProgressState } from "./bulkCreateReducer";
import { collectGitHubIssueNumbers, planIssueWorktrees, planPRWorktrees } from "./bulkCreateUtils";
import {
  cancelBulkCreateRun,
  dismissBulkCreateRun,
  findBulkCreateRunToShow,
  retryFailedBulkCreateRun,
  startBulkCreateRun,
  useBulkCreateRunStore,
} from "./bulkCreateRunner";
import type { ForgeBulkCreateWorktreeDialogProps } from "@/types/forgeSlotProps";
import type { BranchInfo } from "@shared/types";

/** Conforms to the host's bulk-create slot contract (forge-normalized shapes). */
export type BulkCreateWorktreeDialogProps = ForgeBulkCreateWorktreeDialogProps;

const IDLE_PROGRESS: ProgressState = { phase: "idle", total: 0, items: new Map() };

export function BulkCreateWorktreeDialog({
  isOpen,
  onClose,
  mode,
  selectedIssues,
  selectedPRs,
  onComplete,
}: BulkCreateWorktreeDialogProps) {
  // The run this dialog shows. The run lives in the runner, not here: closing
  // the dialog leaves it going, and reopening shows it again (#17085).
  const [boundRunId, setBoundRunId] = useState<string | null>(null);
  // Set the moment Create starts a run, ahead of the re-render, so a second
  // click can't start another.
  const boundRunIdRef = useRef<string | null>(null);
  const prevIsOpenRef = useRef(false);
  // An ended run the user has acknowledged. Dropped once the dialog closes or
  // unmounts, not on the click, so its summary stays up until the dialog goes.
  const acknowledgedRunIdRef = useRef<string | null>(null);
  const boundRun = useBulkCreateRunStore((state) =>
    boundRunId ? state.runs[boundRunId] : undefined
  );
  const progress = boundRun?.progress ?? IDLE_PROGRESS;

  // Shared preferences (same store as single create dialog)
  const assignWorktreeToSelf = usePreferencesStore((s) => s.assignWorktreeToSelf);
  const setAssignWorktreeToSelf = usePreferencesStore((s) => s.setAssignWorktreeToSelf);
  const lastSelectedWorktreeRecipeIdByProject = usePreferencesStore(
    (s) => s.lastSelectedWorktreeRecipeIdByProject
  );
  const setLastSelectedWorktreeRecipeIdByProject = usePreferencesStore(
    (s) => s.setLastSelectedWorktreeRecipeIdByProject
  );

  const { recipes } = useRecipeStore();
  const currentProject = useProjectStore((s) => s.currentProject);
  const projectId = currentProject?.id ?? "";
  const lastSelectedWorktreeRecipeId = lastSelectedWorktreeRecipeIdByProject[projectId];

  // Viewer identity through the forge identity capability — drives the
  // "assign to me" affordance and the run-loop assignment below.
  const [viewer, setViewer] = useState<{ login: string; avatarUrl?: string } | null>(null);
  // A null viewer means two different things — still looking, and looked and
  // found nothing — and only the second one should read as a dead end.
  const [viewerResolved, setViewerResolved] = useState(false);
  const viewerRef = useRef<{ login: string; avatarUrl?: string } | null>(null);
  const currentUser = viewer?.login;
  const currentUserAvatar = viewer?.avatarUrl;
  const assignUnavailable = viewerResolved && !currentUser;

  const { projectSettings } = useNewWorktreeProjectSettings({ isOpen });
  const persistedDefaultRecipeId = projectSettings?.defaultWorktreeRecipeId;
  const startingLayoutRecipes = useMemo(() => recipes.filter((r) => !r.worktreeId), [recipes]);
  const defaultRecipeId = useMemo(
    () => resolveEligibleDefaultRecipeId(startingLayoutRecipes, persistedDefaultRecipeId),
    [startingLayoutRecipes, persistedDefaultRecipeId]
  );

  // Recipe picker (shared preferences with single create)
  const {
    selectedRecipeId,
    setSelectedRecipeId,
    recipePickerOpen,
    setRecipePickerOpen,
    recipeSelectionTouchedRef,
    markRecipeSelectionTouched,
    selectedRecipe,
  } = useRecipePicker({
    isOpen,
    defaultRecipeId,
    startingLayoutRecipes,
    lastSelectedWorktreeRecipeId,
    projectId,
    setLastSelectedWorktreeRecipeIdByProject,
  });

  const projectPath = currentProject?.path;
  useEffect(() => {
    if (!isOpen || !projectPath) return;
    let cancelled = false;
    // Clear stale identity up front: until this fetch resolves the run loop
    // must not assign to the previous project's viewer. A viewer that resolves
    // to nothing skips self-assignment (visible: the "assign to me" row goes
    // disabled and unchecked) rather than assigning the wrong account.
    setViewer(null);
    viewerRef.current = null;
    setViewerResolved(false);
    void forgeClient
      .getCurrentUser(projectPath)
      .then((user) => {
        if (cancelled) return;
        const next = user ? { login: user.login, avatarUrl: user.avatarUrl } : null;
        setViewer(next);
        viewerRef.current = next;
        setViewerResolved(true);
      })
      .catch(() => {
        if (!cancelled) {
          setViewer(null);
          viewerRef.current = null;
          setViewerResolved(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [isOpen, projectPath]);

  // Plan worktrees
  const worktreeMap = useWorktreeStore((s) => s.worktrees);

  // Base branch for issue mode. PR mode checks out each PR's own head, so it
  // never loads or offers one.
  const [branches, setBranches] = useState<BranchInfo[]>([]);
  const [branchesLoading, setBranchesLoading] = useState(false);
  const [branchLoadFailed, setBranchLoadFailed] = useState(false);
  const [recentBranchNames, setRecentBranchNames] = useState<string[]>([]);
  const [pickedBase, setPickedBase] = useState<{ name: string; fromRemote: boolean } | null>(null);

  useEffect(() => {
    if (!isOpen || mode !== "issue" || !projectPath) return;
    let isCurrent = true;
    setBranches([]);
    setBranchesLoading(true);
    setBranchLoadFailed(false);
    setRecentBranchNames([]);
    worktreeClient
      .listBranches(projectPath)
      .then((list) => {
        if (isCurrent) setBranches(list);
      })
      .catch((err) => {
        if (!isCurrent) return;
        logError("Failed to load branches for bulk create", err);
        setBranchLoadFailed(true);
      })
      .finally(() => {
        if (isCurrent) setBranchesLoading(false);
      });
    worktreeClient
      .getRecentBranches(projectPath)
      .then((recent) => {
        if (isCurrent) setRecentBranchNames(recent);
      })
      .catch(() => {});
    return () => {
      isCurrent = false;
    };
  }, [isOpen, mode, projectPath]);

  const worktreeByBranch = useMemo(() => {
    const map = new Map<string, BranchWorktreeRef>();
    for (const wt of worktreeMap.values()) {
      if (wt.branch) map.set(wt.branch, { id: wt.id, name: wt.name });
    }
    return map;
  }, [worktreeMap]);

  // An untouched run cuts from the main worktree's checkout, exactly as before
  // the picker existed. It comes ahead of the list's own default so the base
  // can't shift under a run when the list lands — `current` there is whatever
  // the project path has checked out, which a project opened from a linked
  // worktree would get wrong. The list's default covers a main worktree with
  // no branch (detached HEAD).
  const mainWorktreeBranch = useMemo(() => {
    for (const wt of worktreeMap.values()) {
      if (wt.isMainWorktree) return wt.branch;
    }
    return undefined;
  }, [worktreeMap]);
  const baseBranch = useMemo(() => {
    if (pickedBase) return pickedBase;
    if (mainWorktreeBranch) return { name: mainWorktreeBranch, fromRemote: false };
    const derived = branches.length > 0 ? deriveDefaultBaseBranch(branches) : null;
    return derived?.name ? derived : null;
  }, [pickedBase, branches, mainWorktreeBranch]);

  const handleBaseBranchSelect = useCallback((option: BranchOption) => {
    setPickedBase({ name: option.name, fromRemote: option.isRemote });
  }, []);

  const baseBranchPicker = useBranchPicker({
    branches,
    selectedBranch: baseBranch?.name ?? "",
    recentBranchNames,
    worktreeByBranch,
    onSelect: handleBaseBranchSelect,
  });
  const closeBaseBranchPicker = baseBranchPicker.setOpen;
  const livePlan = useMemo(() => {
    if (mode === "pr") {
      const existingPRNumbers = new Set<number>();
      for (const wt of worktreeMap.values()) {
        if (wt.prNumber) existingPRNumbers.add(wt.prNumber);
      }
      return planPRWorktrees(selectedPRs, existingPRNumbers);
    }
    return planIssueWorktrees(selectedIssues, collectGitHubIssueNumbers(worktreeMap.values()));
  }, [mode, selectedIssues, selectedPRs, worktreeMap]);
  // Frozen at Create. Each worktree the run lands makes the live plan read its
  // item as "Has worktree" with no branch, which would shift the counts mid-run
  // and hand Retry an item with nothing to create from.
  const planned = boundRun?.plan ?? livePlan;

  const creatableCount = planned.filter((p) => !p.skipped).length;
  const selectedCount = planned.length;
  const skippedCount = selectedCount - creatableCount;
  const itemNoun = mode === "pr" ? "pull request" : "issue";

  // The footer says what the button can't: how much of the selection is coming
  // through. The button already names the worktree count, so restating it here
  // would spend the one summary line on a number the user is looking at.
  const batchSummary =
    selectedCount === 0
      ? `Select ${mode === "pr" ? "a pull request" : "an issue"} to continue`
      : `${selectedCount} ${selectedCount === 1 ? itemNoun : `${itemNoun}s`} selected` +
        (skippedCount > 0 ? ` \u00b7 ${skippedCount} skipped` : "");

  const isExecuting = progress.phase === "executing";
  const isCancelling = progress.phase === "cancelling";
  const isCancelled = progress.phase === "cancelled";
  // Nothing to cut issue branches from yet (detached main worktree, list still
  // loading or empty): hold Create rather than fail every item.
  const createBlocked = creatableCount === 0 || (mode === "issue" && !baseBranch);
  const isDone = progress.phase === "done";
  const isEnded = isDone || isCancelled;

  const { succeededCount, failedCount, stoppedCount, worktreesCreatedCount } = useMemo(() => {
    let succeeded = 0;
    let failed = 0;
    let stopped = 0;
    let created = 0;
    for (const item of progress.items.values()) {
      if (item.worktreeId) created++;
      if (item.stage === "succeeded") succeeded++;
      else if (item.stage === "failed") failed++;
      else if (item.stage === "cancelled" || item.stage === "interrupted") stopped++;
    }
    return {
      succeededCount: succeeded,
      failedCount: failed,
      stoppedCount: stopped,
      worktreesCreatedCount: created,
    };
  }, [progress.items]);

  const processedCount = succeededCount + failedCount + stoppedCount;
  // A cancel can leave worktrees made but never set up, and they exist all the
  // same: once cancelled, the count is of worktrees on disk.
  const createdCount = isCancelled ? worktreesCreatedCount : succeededCount;

  useLayoutEffect(() => {
    if (!isOpen && acknowledgedRunIdRef.current) {
      dismissBulkCreateRun(acknowledgedRunIdRef.current);
      acknowledgedRunIdRef.current = null;
    }
    if (isOpen && !prevIsOpenRef.current) {
      const existing = projectId ? findBulkCreateRunToShow(projectId) : undefined;
      boundRunIdRef.current = existing?.id ?? null;
      setBoundRunId(existing?.id ?? null);
      setPickedBase(null);
      closeBaseBranchPicker(false);
    }
    prevIsOpenRef.current = isOpen;
  }, [isOpen, projectId, closeBaseBranchPicker]);

  // ProjectDialogHost unmounts the dialog on close, so this is where an
  // acknowledged run is usually dropped. A run still going is left alone.
  useEffect(() => {
    return () => {
      if (acknowledgedRunIdRef.current) dismissBulkCreateRun(acknowledgedRunIdRef.current);
      acknowledgedRunIdRef.current = null;
    };
  }, []);

  const handleCreate = useCallback(async () => {
    if (boundRunIdRef.current) return;
    const toCreate = livePlan.filter((p) => !p.skipped);
    if (mode === "issue" && !baseBranch) return;
    if (toCreate.length === 0) {
      console.warn(
        "[BulkCreateWorktreeDialog] handleCreate called with no creatable items — guard fired"
      );
      return;
    }

    // Save recipe preference
    if (recipeSelectionTouchedRef.current && projectId) {
      setLastSelectedWorktreeRecipeIdByProject(projectId, selectedRecipeId);
    }

    // The layout Clone was pressed with. A finished run selects a worktree it
    // created, so regenerating on retry would clone that one instead, and the
    // indices of the entries still to launch would point into a different layout.
    const sourceWorktreeId = useWorktreeSelectionStore.getState().activeWorktreeId;
    const cloneTerminals =
      selectedRecipeId === CLONE_LAYOUT_ID && sourceWorktreeId
        ? useRecipeStore.getState().generateRecipeFromActiveTerminals(sourceWorktreeId)
        : null;
    const { runId, done } = startBulkCreateRun({
      projectId,
      rootPath: currentProject?.path,
      mode,
      plan: livePlan,
      recipeId: selectedRecipeId,
      recipe: selectedRecipe,
      assignToSelf: assignWorktreeToSelf,
      getViewer: () => viewerRef.current,
      base: baseBranch,
      cloneTerminals,
    });
    boundRunIdRef.current = runId;
    setBoundRunId(runId);
    await done;
  }, [
    livePlan,
    selectedRecipeId,
    selectedRecipe,
    assignWorktreeToSelf,
    projectId,
    currentProject?.path,
    recipeSelectionTouchedRef,
    setLastSelectedWorktreeRecipeIdByProject,
    baseBranch,
    mode,
  ]);

  const handleRetryFailed = useCallback(async () => {
    if (!boundRunId) return;
    await retryFailedBulkCreateRun(boundRunId);
  }, [boundRunId]);

  // Stops the run; the dialog stays to show what the cancel left behind.
  const handleCancelRun = useCallback(() => {
    if (boundRunId) cancelBulkCreateRun(boundRunId);
  }, [boundRunId]);

  const handleClose = useCallback(() => {
    // Closing never stops a run: one still going carries on and shows again
    // when the dialog reopens. Closing while idle or mid-run preserves the
    // bulk selection so the user can reopen the dropdown and finish picking.
    // Once the run has completed, dismissing via X/Escape/backdrop must run
    // the same selection cleanup as the Done button — otherwise the bulk
    // bar stays visible with the now-stale selection.
    //
    // Capture before onClose() — onClose is wired to closeBulkCreateDialog
    // upstream, which zeroes out the stored callback as part of its reset.
    const storedOnComplete = isDone
      ? useWorktreeSelectionStore.getState().bulkCreateDialog.onComplete
      : undefined;
    if (isEnded) acknowledgedRunIdRef.current = boundRunId;

    onClose();
    storedOnComplete?.();
  }, [isDone, isEnded, boundRunId, onClose]);

  const handleDone = useCallback(() => {
    acknowledgedRunIdRef.current = boundRunId;
    // A cancelled run keeps the selection, as a cancel always has.
    if (isCancelled) {
      onClose();
      return;
    }
    // Capture before onComplete()/onClose() — both are wired to closeBulkCreateDialog
    // upstream, which zeroes out the stored callback as part of its reset.
    const storedOnComplete = useWorktreeSelectionStore.getState().bulkCreateDialog.onComplete;
    onComplete();
    onClose();
    storedOnComplete?.();
  }, [boundRunId, isCancelled, onComplete, onClose]);

  const handleRecipeSelectCombined = useCallback(
    (recipeId: string | null) => {
      markRecipeSelectionTouched();
      setSelectedRecipeId(recipeId);
      if (projectId) setLastSelectedWorktreeRecipeIdByProject(projectId, recipeId);
      setRecipePickerOpen(false);
    },
    [
      setSelectedRecipeId,
      setRecipePickerOpen,
      markRecipeSelectionTouched,
      projectId,
      setLastSelectedWorktreeRecipeIdByProject,
    ]
  );

  return (
    <Dialog
      open={isOpen}
      onClose={handleClose}
      size="md"
      data-testid="bulk-create-worktree-dialog"
      icon={
        isExecuting || isCancelling ? (
          <Spinner size="lg" className="text-text-secondary" />
        ) : isCancelled ? (
          <Icon name="alert-triangle" className="w-5 h-5 text-status-warning" />
        ) : isDone ? (
          succeededCount === 0 && failedCount > 0 ? (
            <Icon name="circle-x" className="w-5 h-5 text-status-error" />
          ) : failedCount > 0 ? (
            <Icon name="alert-triangle" className="w-5 h-5 text-status-warning" />
          ) : (
            <Icon name="circle-check" className="w-5 h-5 text-status-success" />
          )
        ) : (
          <Icon name="worktree" className="w-5 h-5 text-text-muted" />
        )
      }
      title={
        isExecuting
          ? "Creating worktrees\u2026"
          : isCancelling
            ? "Cancelling\u2026"
            : isCancelled
              ? "Creation cancelled"
              : isDone
                ? succeededCount === 0 && failedCount > 0
                  ? "Couldn't create worktrees"
                  : "Creation complete"
                : `Create ${creatableCount} worktree${creatableCount !== 1 ? "s" : ""}`
      }
      // Only while idle: once the run starts, the body's own progress line is
      // the authority on counts and a second tally would drift from it.
      hint={progress.phase === "idle" ? batchSummary : undefined}
      footer={
        isEnded ? (
          <>
            {failedCount > 0 && (
              <Button
                variant="ghost"
                onClick={handleRetryFailed}
                data-testid="bulk-create-retry-button"
                icon="refresh"
              >
                Retry failed
              </Button>
            )}
            <Button
              variant="contrast"
              onClick={handleDone}
              data-testid="bulk-create-done-button"
              icon="check"
            >
              Done
            </Button>
          </>
        ) : (
          // The primary stays mounted while executing: dropping it made Cancel
          // the rightmost button, so it inherited the CTA's hit area one render
          // after the click that started the run. Mid-run, Cancel stops the
          // run; closing the dialog any other way leaves it going.
          <>
            {isExecuting || isCancelling ? (
              <Button
                variant="ghost"
                aria-disabled={isCancelling || undefined}
                onClick={isCancelling ? undefined : handleCancelRun}
                className={cn(isCancelling && ARIA_DISABLED_CLASSES)}
                data-testid="bulk-create-cancel-run-button"
              >
                Cancel run
              </Button>
            ) : (
              <Button variant="ghost" onClick={handleClose}>
                Cancel
              </Button>
            )}
            <Button
              aria-disabled={isExecuting || isCancelling || createBlocked || undefined}
              variant="contrast"
              onClick={isExecuting || isCancelling || createBlocked ? undefined : handleCreate}
              className={cn(
                "min-w-[100px]",
                (isExecuting || isCancelling || createBlocked) && ARIA_DISABLED_CLASSES
              )}
              data-testid="bulk-create-confirm-button"
              icon="check"
            >
              Create {creatableCount} worktree{creatableCount !== 1 ? "s" : ""}
            </Button>
          </>
        )
      }
    >
      {progress.phase === "idle" ? (
        <FormGrid>
          <FormSection title="Setup">
            {/* Rendered for every issue-mode batch, not just once identity
                  resolves: the row is the same height either way, so a viewer
                  arriving mid-open populates it instead of inserting it. The
                  toggle keeps tracking the preference while the lookup is in
                  flight — the run loop reads the viewer per item, so identity
                  landing mid-run still assigns — and only goes dead once the
                  lookup has come back with no account to assign to. */}
            {mode === "issue" && (
              <FormRow label="Assign to me" htmlFor="bulk-assign-to-self">
                <div className="flex items-center gap-2 text-xs text-text-secondary">
                  {/* A checkbox, not a switch: the value is committed by Create
                        with the rest of the batch, exactly as New Worktree offers it. */}
                  <Checkbox
                    id="bulk-assign-to-self"
                    checked={assignWorktreeToSelf && !assignUnavailable}
                    onCheckedChange={setAssignWorktreeToSelf}
                    disabled={assignUnavailable}
                  />
                  {currentUser ? (
                    <Avatar
                      src={avatarUrlAtSize(currentUserAvatar, 32)}
                      name={currentUser}
                      size="xs"
                      decorative
                    />
                  ) : (
                    <span
                      className="flex h-4 w-4 shrink-0 items-center justify-center"
                      aria-hidden="true"
                    >
                      <Icon name="user-plus" className="h-3.5 w-3.5" />
                    </span>
                  )}
                  {/* Blank while the lookup is still out: naming a failure
                        before there is one is worse than naming nothing. */}
                  {(currentUser || assignUnavailable) && (
                    <span className="truncate">
                      {currentUser ? `@${currentUser}` : "Account unavailable"}
                    </span>
                  )}
                </div>
              </FormRow>
            )}

            {mode === "issue" && (
              <FormRow
                label="Base"
                htmlFor="base-branch"
                hint={
                  branchLoadFailed ? (
                    <span className="text-xs text-text-secondary">
                      {baseBranch
                        ? `Couldn't load branches. Using ${baseBranch.name}.`
                        : "Couldn't load branches."}
                    </span>
                  ) : undefined
                }
              >
                <BaseBranchCombobox
                  baseBranch={baseBranch?.name ?? ""}
                  controller={baseBranchPicker}
                  disabled={branchesLoading || branchLoadFailed}
                  unavailableLabel={
                    branches.length === 0
                      ? (baseBranch?.name ??
                        (branchesLoading ? "Loading branches\u2026" : "No base branch"))
                      : undefined
                  }
                />
              </FormRow>
            )}

            <FormRow label="Recipe" htmlFor="bulk-recipe-selector-trigger">
              <RecipePickerPopover
                recipes={startingLayoutRecipes}
                selectedRecipeId={selectedRecipeId}
                selectedRecipe={selectedRecipe}
                defaultRecipeId={defaultRecipeId}
                open={recipePickerOpen}
                onOpenChange={setRecipePickerOpen}
                onSelectRecipe={handleRecipeSelectCombined}
                onMarkTouched={() => {}}
                listId="bulk-recipe-selector"
              />
            </FormRow>
          </FormSection>

          {/* Spans both columns: the batch preview is content, not a field, and
                a 300px scroller pinned beside a 4rem label rail would give up the
                width the branch names need. */}
          <FormSection title="Worktrees to create">
            <ul className="col-span-2 max-h-[300px] overflow-y-auto rounded-[var(--radius-md)] border border-border-strong bg-surface-canvas divide-y divide-border-default">
              {planned.map((item) => (
                <li
                  key={item.item.number}
                  className={cn(
                    "px-3 py-2 flex items-center gap-3 text-sm",
                    item.skipped && "opacity-50"
                  )}
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="text-text-secondary text-xs font-mono shrink-0">
                        #{item.item.number}
                      </span>
                      <span className="text-text-primary truncate">{item.item.title}</span>
                    </div>
                    {!item.skipped && (
                      <div className="flex items-center gap-1.5 mt-0.5">
                        <Icon name="worktree" className="w-3 h-3 text-text-secondary shrink-0" />
                        <span className="text-xs text-text-secondary font-mono truncate">
                          {item.branchName}
                        </span>
                      </div>
                    )}
                  </div>
                  {item.skipped && (
                    <Badge size="xs" tone="warning">
                      {item.skipReason}
                    </Badge>
                  )}
                </li>
              ))}
            </ul>
          </FormSection>
        </FormGrid>
      ) : (
        <div className="space-y-4">
          {/* Per-item status list */}
          <div className="max-h-[300px] overflow-y-auto rounded-[var(--radius-md)] border border-border-strong bg-surface-canvas divide-y divide-border-default">
            {planned
              .filter((p) => progress.items.has(p.item.number))
              .map((item) => {
                const itemStatus = progress.items.get(item.item.number);
                const stageLabel = getStageLabel(itemStatus);
                const isInProgress =
                  itemStatus &&
                  itemStatus.stage !== "pending" &&
                  itemStatus.stage !== "succeeded" &&
                  itemStatus.stage !== "failed" &&
                  itemStatus.stage !== "cancelled" &&
                  itemStatus.stage !== "interrupted";
                return (
                  <div key={item.item.number} className="px-3 py-2 flex items-start gap-3 text-sm">
                    <div className="mt-0.5 shrink-0">
                      {isInProgress ? (
                        <Spinner size="md" className="text-text-secondary" />
                      ) : itemStatus?.stage === "succeeded" ? (
                        <Icon name="circle-check" className="w-4 h-4 text-status-success" />
                      ) : itemStatus?.stage === "failed" ? (
                        <Icon name="circle-x" className="w-4 h-4 text-status-error" />
                      ) : (
                        <div className="w-4 h-4 rounded-full border border-border-default" />
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="text-text-secondary text-xs font-mono shrink-0">
                          #{item.item.number}
                        </span>
                        <span className="text-text-primary truncate">{item.item.title}</span>
                        {isInProgress && itemStatus.attempt > 1 && (
                          <Badge size="xs" tone="info">
                            retry {itemStatus.attempt - 1}
                          </Badge>
                        )}
                      </div>
                      {stageLabel && (
                        <p className="text-xs text-text-secondary mt-0.5">{stageLabel}</p>
                      )}
                      {itemStatus?.stage === "failed" && itemStatus.error && (
                        <p className="text-xs text-status-warning mt-0.5 break-words">
                          {itemStatus.error}
                        </p>
                      )}
                    </div>
                  </div>
                );
              })}
          </div>

          {/* Progress bar + summary */}
          <div className="space-y-2">
            <ProgressBar
              label="Creating worktrees"
              value={progress.items.size > 0 ? processedCount / progress.items.size : 0}
              valueText={`${processedCount} of ${progress.items.size}`}
            />
            <div className="flex items-center justify-center gap-1.5 text-sm tabular-nums text-text-secondary">
              <span>
                {createdCount} of {progress.items.size} created
              </span>
              {failedCount > 0 && (
                <span className="text-status-warning">&middot; {failedCount} failed</span>
              )}
              {stoppedCount > 0 && <span>&middot; {stoppedCount} cancelled</span>}
            </div>
          </div>
        </div>
      )}
    </Dialog>
  );
}
