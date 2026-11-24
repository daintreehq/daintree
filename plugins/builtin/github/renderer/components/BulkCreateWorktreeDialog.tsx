import { useCallback, useRef, useMemo, useEffect, useLayoutEffect, useState } from "react";
import { Avatar, Badge, Button, Checkbox, Dialog, Icon } from "@daintreehq/plugin-ui";
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
import { collectGitHubIssueNumbers, planIssueWorktrees, planPRWorktrees } from "./bulkCreateUtils";
import { startBulkCreateRun, useBulkCreateRunStore } from "./bulkCreateRunner";
import type { ForgeBulkCreateWorktreeDialogProps } from "@/types/forgeSlotProps";
import type { BranchInfo } from "@shared/types";
import { pluralize } from "@/lib/pluralize";

/** Conforms to the host's bulk-create slot contract (forge-normalized shapes). */
export type BulkCreateWorktreeDialogProps = ForgeBulkCreateWorktreeDialogProps;

export function BulkCreateWorktreeDialog({
  isOpen,
  onClose,
  mode,
  selectedIssues,
  selectedPRs,
  onComplete,
}: BulkCreateWorktreeDialogProps) {
  // The dialog only sets a batch up. Create hands the run to the toolbar's
  // activity chip, which shows it in every project view, and closes (#17086).
  // Set the moment Create starts a run, ahead of the close, so a second click
  // can't start another.
  const startedRef = useRef(false);
  const prevIsOpenRef = useRef(false);

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
  // Undefined until the lookup answers; null once it found no account.
  const viewerRef = useRef<{ login: string; avatarUrl?: string } | null | undefined>(undefined);
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
    viewerRef.current = undefined;
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
  // Items a run still going in this project is working on. Picking one again
  // would race that run for the same branch, so it is skipped like an item
  // that already has its worktree.
  const runs = useBulkCreateRunStore((state) => state.runs);
  const inFlightNumbers = useMemo(() => {
    const numbers = new Set<number>();
    for (const run of Object.values(runs)) {
      if (run.projectId !== projectId || run.mode !== mode) continue;
      const { phase } = run.progress;
      if (phase !== "executing" && phase !== "cancelling") continue;
      for (const number of run.progress.items.keys()) numbers.add(number);
    }
    return numbers;
  }, [runs, projectId, mode]);
  const planned = useMemo(() => {
    let plan;
    if (mode === "pr") {
      const existingPRNumbers = new Set<number>();
      for (const wt of worktreeMap.values()) {
        if (wt.prNumber) existingPRNumbers.add(wt.prNumber);
      }
      plan = planPRWorktrees(selectedPRs, existingPRNumbers);
    } else {
      plan = planIssueWorktrees(selectedIssues, collectGitHubIssueNumbers(worktreeMap.values()));
    }
    return plan.map((p) =>
      !p.skipped && inFlightNumbers.has(p.item.number)
        ? { ...p, skipped: true, skipReason: "Being created" }
        : p
    );
  }, [mode, selectedIssues, selectedPRs, worktreeMap, inFlightNumbers]);

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
      : // Create closes this and the batch carries on in the toolbar; say so
        // before the click, so the dialog vanishing doesn't read as nothing.
        // "selected" gives way to it: the title and the button already count.
        pluralize(selectedCount, itemNoun) +
        (creatableCount > 0 ? "" : " selected") +
        (skippedCount > 0 ? ` \u00b7 ${skippedCount.toLocaleString()} skipped` : "") +
        (creatableCount > 0 ? " \u00b7 runs in the background" : "");

  // Nothing to cut issue branches from yet (detached main worktree, list still
  // loading or empty): hold Create rather than fail every item.
  const createBlocked = creatableCount === 0 || (mode === "issue" && !baseBranch);

  useLayoutEffect(() => {
    if (isOpen && !prevIsOpenRef.current) {
      startedRef.current = false;
      setPickedBase(null);
      closeBaseBranchPicker(false);
    }
    prevIsOpenRef.current = isOpen;
  }, [isOpen, closeBaseBranchPicker]);

  const handleCreate = useCallback(() => {
    if (startedRef.current) return;
    const toCreate = planned.filter((p) => !p.skipped);
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
    startBulkCreateRun({
      projectId,
      rootPath: currentProject?.path,
      mode,
      plan: planned,
      recipeId: selectedRecipeId,
      recipe: selectedRecipe,
      // What the form showed: an unavailable account is unchecked there.
      assignToSelf: assignWorktreeToSelf && !assignUnavailable,
      getViewer: () => viewerRef.current,
      base: baseBranch,
      cloneTerminals,
    });
    startedRef.current = true;

    // The batch is committed, so its selection is spent: clear it the way a
    // finished run's Done always did. Captured before onClose(), which is
    // wired to closeBulkCreateDialog upstream and zeroes the stored callback.
    const storedOnComplete = useWorktreeSelectionStore.getState().bulkCreateDialog.onComplete;
    onComplete();
    onClose();
    storedOnComplete?.();
  }, [
    planned,
    selectedRecipeId,
    selectedRecipe,
    assignWorktreeToSelf,
    assignUnavailable,
    projectId,
    currentProject?.path,
    recipeSelectionTouchedRef,
    setLastSelectedWorktreeRecipeIdByProject,
    baseBranch,
    mode,
    onComplete,
    onClose,
  ]);

  // Closing without Create keeps the selection, so the user can reopen the
  // dropdown and finish picking.
  const handleClose = onClose;

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
      icon={<Icon name="worktree" className="w-5 h-5 text-text-secondary" />}
      title={<span className="tabular-nums">Create {pluralize(creatableCount, "worktree")}</span>}
      hint={batchSummary}
      footer={
        <>
          <Button variant="ghost" onClick={handleClose}>
            Cancel
          </Button>
          <Button
            aria-disabled={createBlocked || undefined}
            variant="contrast"
            onClick={createBlocked ? undefined : handleCreate}
            className={cn("min-w-[100px] tabular-nums", createBlocked && ARIA_DISABLED_CLASSES)}
            data-testid="bulk-create-confirm-button"
            icon="check"
          >
            Create {pluralize(creatableCount, "worktree")}
          </Button>
        </>
      }
    >
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
    </Dialog>
  );
}
