import {
  useCallback,
  useReducer,
  useRef,
  useMemo,
  useEffect,
  useLayoutEffect,
  useState,
} from "react";
import PQueue from "p-queue";
import { Check, AlertTriangle, UserPlus, RotateCcw } from "lucide-react";
import { Spinner } from "@/components/ui/Spinner";
import { FolderGit2 } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { AppDialog } from "@/components/ui/AppDialog";
import { cn } from "@/lib/utils";
import { worktreeClient, forgeClient, agentSettingsClient, systemClient } from "@/clients";
import { patchIssueAssigneeCache } from "@/lib/forgeResourceCache";
import { logError } from "@/utils/logger";
import { resolveIssuePrequeries } from "./bulkCreatePrequery";
import { notify } from "@/lib/notify";
import { usePreferencesStore } from "@/store/preferencesStore";
import { useRecipeStore, type RecipeSpawnResults } from "@/store/recipeStore";
import { useProjectStore } from "@/store/projectStore";
import { isPtyPanel } from "@shared/types/panel";
import { getCurrentViewStore } from "@/store/createWorktreeStore";
import { useWorktreeStore } from "@/hooks/useWorktreeStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { usePanelStore } from "@/store/panelStore";
import {
  useRecipePicker,
  resolveEligibleDefaultRecipeId,
  CLONE_LAYOUT_ID,
} from "@/components/Worktree/hooks/useRecipePicker";
import { RecipePickerPopover } from "@/components/Worktree/views/RecipePickerPopover";
import { FormGrid, FormRow, FormSection } from "@/components/Worktree/views/WorktreeFormLayout";
import { useNewWorktreeProjectSettings } from "@/components/Worktree/hooks/useNewWorktreeProjectSettings";
import { spawnPanelsFromRecipe } from "@/components/Worktree/panelSpawning";
import { progressReducer, getStageLabel } from "./bulkCreateReducer";
import {
  planIssueWorktrees,
  planPRWorktrees,
  isTransientError,
  normalizeError,
  delay,
  cancellableDelay,
  nextBackoffDelay,
  MAX_TRANSIENT_RETRY_MS,
  QUEUE_CONCURRENCY,
  BACKOFF_BASE_MS,
  ASSIGNMENT_BACKOFF_CAP_MS,
  VERIFICATION_EXIT_SETTLE_MS,
  VERIFICATION_SPAWN_WAIT_MS,
  planBulkRecipeSpawnBatches,
} from "./bulkCreateUtils";
import type { PlannedWorktree } from "./bulkCreateUtils";
import type { ForgeBulkCreateWorktreeDialogProps } from "@/types/forgeSlotProps";
import type { BranchInfo } from "@shared/types";

/** Conforms to the host's bulk-create slot contract (forge-normalized shapes). */
export type BulkCreateWorktreeDialogProps = ForgeBulkCreateWorktreeDialogProps;

function waitForPanelSpawns(panelIds: string[], timeoutMs: number): Promise<void> {
  if (panelIds.length === 0) return Promise.resolve();
  const allSettled = () => {
    const { panelsById } = usePanelStore.getState();
    return panelIds.every((panelId) => {
      const panel = panelsById[panelId];
      return !panel || !isPtyPanel(panel) || panel.spawnStatus !== "spawning";
    });
  };
  if (allSettled()) return Promise.resolve();

  return new Promise((resolve) => {
    let settled = false;
    let unsubscribe = () => {};
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      unsubscribe();
      resolve();
    };
    const timeout = setTimeout(finish, timeoutMs);
    unsubscribe = usePanelStore.subscribe(() => {
      if (allSettled()) finish();
    });
    if (allSettled()) finish();
  });
}

export function BulkCreateWorktreeDialog({
  isOpen,
  onClose,
  mode,
  selectedIssues,
  selectedPRs,
  onComplete,
}: BulkCreateWorktreeDialogProps) {
  const [progress, dispatchProgress] = useReducer(progressReducer, {
    phase: "idle",
    total: 0,
    items: new Map(),
  });
  const queueRef = useRef<PQueue | null>(null);
  const runIdRef = useRef(0);
  const isExecutingRef = useRef(false);
  const prevIsOpenRef = useRef(false);
  // The batch currently executing. `controller` reaches the one callee that can
  // stop mid-flight (spawnPanelsFromRecipe); `created`/`creating` count worktrees
  // this run made and calls still outstanding, so a cancel can report what
  // survived it.
  const activeRunRef = useRef<{
    controller: AbortController;
    created: number;
    creating: number;
    total: number;
  } | null>(null);

  // Invalidate the in-flight batch. Bumping the run ID makes every stale-run
  // checkpoint inside runBatch return at its next opportunity, clear() drops
  // whatever never started, and abort() stops clone-layout spawning between its
  // own checkpoints. Idempotent: explicit Cancel runs it, then the unmount that
  // Cancel triggers runs it again.
  const invalidateActiveRun = useCallback(() => {
    runIdRef.current++;
    activeRunRef.current?.controller.abort();
    activeRunRef.current = null;
    queueRef.current?.clear();
    queueRef.current = null;
  }, []);

  // SidebarContent renders this dialog only while `isOpen`, so every close
  // unmounts it. Without this, a close that bypasses handleClose (parent
  // teardown, error boundary reset) leaves the batch spawning into a detached
  // component.
  useEffect(() => {
    return () => {
      invalidateActiveRun();
    };
  }, [invalidateActiveRun]);

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
  const planned = useMemo(() => {
    if (mode === "pr") {
      const existingPRNumbers = new Set<number>();
      for (const wt of worktreeMap.values()) {
        if (wt.prNumber) existingPRNumbers.add(wt.prNumber);
      }
      return planPRWorktrees(selectedPRs, existingPRNumbers);
    }
    const existingIssueNumbers = new Set<number>();
    for (const wt of worktreeMap.values()) {
      if (wt.issueNumber) existingIssueNumbers.add(wt.issueNumber);
    }
    return planIssueWorktrees(selectedIssues, existingIssueNumbers);
  }, [mode, selectedIssues, selectedPRs, worktreeMap]);

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
  const isDone = progress.phase === "done";

  const { succeededCount, failedCount } = useMemo(() => {
    let succeeded = 0;
    let failed = 0;
    for (const item of progress.items.values()) {
      if (item.stage === "succeeded") succeeded++;
      else if (item.stage === "failed") failed++;
    }
    return { succeededCount: succeeded, failedCount: failed };
  }, [progress.items]);

  const processedCount = succeededCount + failedCount;

  // Local tracking map shared across runBatch calls — survives stale closures
  const batchTrackingRef = useRef(
    new Map<
      number,
      {
        worktreeId?: string;
        worktreePath?: string;
        resolvedBranch?: string;
        spawnedTerminalIds: string[];
        failedTerminalIndices: number[];
        cloneComplete?: boolean;
      }
    >()
  );

  useLayoutEffect(() => {
    if (isOpen && !prevIsOpenRef.current) {
      dispatchProgress({ type: "RESET" });
      batchTrackingRef.current = new Map();
    }
    prevIsOpenRef.current = isOpen;
  }, [isOpen]);

  const runBatch = useCallback(
    async (toCreate: PlannedWorktree[]) => {
      activeRunRef.current?.controller.abort();
      const currentRunId = ++runIdRef.current;
      const activeRun = {
        controller: new AbortController(),
        created: 0,
        creating: 0,
        total: toCreate.length,
      };
      activeRunRef.current = activeRun;

      const rootPath = currentProject?.path;
      if (!rootPath) {
        // handleCreate already dispatched START, so returning bare would strand
        // phase: "executing" — header X hidden, Escape and backdrop blocked.
        // Fail the items instead so the dialog reaches a terminal state with a
        // reason and a Retry affordance.
        for (const planned of toCreate) {
          dispatchProgress({
            type: "ITEM_FAILED",
            issueNumber: planned.item.number,
            error: "The current project path is unavailable",
            attempts: 1,
            failedStep: "worktree",
          });
        }
        dispatchProgress({ type: "DONE" });
        activeRunRef.current = null;
        return;
      }

      // Counts create() calls that haven't settled. PQueue.pending counts whole
      // queue callbacks — which may be fetching branches, running a recipe, or
      // sleeping in backoff — so it can't stand in for "worktrees still coming".
      const createWorktree = async (options: Parameters<typeof worktreeClient.create>[0]) => {
        activeRun.creating++;
        try {
          return await worktreeClient.create(options, rootPath);
        } finally {
          activeRun.creating--;
        }
      };

      const tracking = batchTrackingRef.current;

      const sourceWorktreeId = useWorktreeSelectionStore.getState().activeWorktreeId;
      const cloneTerminals =
        selectedRecipeId === CLONE_LAYOUT_ID && sourceWorktreeId
          ? useRecipeStore.getState().generateRecipeFromActiveTerminals(sourceWorktreeId)
          : null;

      // Pre-fetch agent settings once so each cloned agent panel can regenerate
      // its spawn command from current config (mirrors recipeStore.ts). Source
      // RecipeTerminal.command is not reused for agents — it may embed a
      // path-scoped session ID from the source worktree (see #5179, PR #4781).
      let cloneAgentSettings: Awaited<ReturnType<typeof agentSettingsClient.get>> | null = null;
      let cloneClipboardDirectory: string | undefined;
      if (
        cloneTerminals &&
        cloneTerminals.some((t) => t.type !== "terminal" && t.type !== "dev-preview")
      ) {
        try {
          const [settings, tmpDir] = await Promise.all([
            agentSettingsClient.get(),
            systemClient.getTmpDir().catch(() => ""),
          ]);
          if (runIdRef.current !== currentRunId) return;
          cloneAgentSettings = settings;
          cloneClipboardDirectory = tmpDir ? `${tmpDir}/daintree-clipboard` : undefined;
        } catch {
          if (runIdRef.current !== currentRunId) return;
          // Non-fatal: agents fall back to generating with empty settings.
        }
      }

      const queue = new PQueue({
        concurrency: QUEUE_CONCURRENCY,
      });
      queueRef.current = queue;
      const currentRunItems = new Set(toCreate.map((p) => p.item.number));
      // Size the admission batch off the recipe that will actually spawn: the
      // run path resolves a shadowed id to its winner, so planning from the
      // displayed row would budget for the wrong terminal count.
      const effectiveRecipe = selectedRecipe
        ? (useRecipeStore.getState().getRecipeById(selectedRecipe.id) ?? selectedRecipe)
        : undefined;
      const ptyTerminalsPerRecipe =
        effectiveRecipe?.terminals.filter((terminal) => terminal.type !== "dev-preview").length ??
        0;
      const recipeSpawnBatches = planBulkRecipeSpawnBatches(
        [...currentRunItems],
        ptyTerminalsPerRecipe,
        () => crypto.randomUUID()
      );
      const succeededItems = new Set<number>();
      const failedItems = new Set<number>();
      let lastSuccessfulWorktreeId: string | null = null;

      // Batch pre-queries: hoist read-only IPC calls out of the per-item queue
      // so N items don't produce N×IPC round-trips before any worktree creates.
      // Sequential traversal is required — the backend findAvailableBranchName /
      // findAvailablePath are pure snapshot reads with no reservation, so
      // parallel Promise.all would race to the same resolved names for items
      // sharing a base branch. The `assignedBranches` set below adds a
      // client-side collision guard for the rare same-slug case.
      let sharedBranches: BranchInfo[] | null = null;
      const precomputed = new Map<number, { branch: string; path: string }>();
      const prequeryFailed = new Set<number>();

      if (toCreate.some((p) => p.mode === "pr")) {
        try {
          sharedBranches = await worktreeClient.listBranches(rootPath);
          if (runIdRef.current !== currentRunId) return;
        } catch (err) {
          if (runIdRef.current !== currentRunId) return;
          const errorMsg = normalizeError(err);
          for (const planned of toCreate) {
            if (planned.mode !== "pr") continue;
            failedItems.add(planned.item.number);
            dispatchProgress({
              type: "ITEM_FAILED",
              issueNumber: planned.item.number,
              error: errorMsg,
              attempts: 1,
              failedStep: "worktree",
            });
          }
          if (toCreate.every((p) => p.mode === "pr")) {
            dispatchProgress({ type: "DONE" });
            if (queueRef.current === queue) queueRef.current = null;
            if (activeRunRef.current === activeRun) activeRunRef.current = null;

            notify({
              type: "error",
              title: "Some worktrees couldn't be created",
              message: `0 created, ${failedItems.size} failed`,
            });
            return;
          }
        }
      }

      // Batch pre-queries: parallel branch/path resolution with bounded concurrency.
      // Two-phase approach: (1) resolve branch candidates with bounded concurrency,
      // (2) apply deterministic uniqueness suffixes in input order, (3) resolve paths
      // with bounded concurrency using final unique branch names.
      const prequeryInput = toCreate.filter((p) => p.mode === "issue");

      if (prequeryInput.length > 0) {
        const { results, failedItems: prequeryFailures } = await resolveIssuePrequeries({
          rootPath,
          items: prequeryInput,
          existingBranches: null,
          getAvailableBranch: worktreeClient.getAvailableBranch,
          getDefaultPath: worktreeClient.getDefaultPath,
          isStaleRun: () => runIdRef.current !== currentRunId,
        });

        if (runIdRef.current !== currentRunId) return;

        for (const [number, { branch, path }] of results) {
          precomputed.set(number, { branch, path });
        }

        for (const { number, error } of prequeryFailures) {
          prequeryFailed.add(number);
          failedItems.add(number);
          dispatchProgress({
            type: "ITEM_FAILED",
            issueNumber: number,
            error: normalizeError(error),
            attempts: 1,
            failedStep: "worktree",
          });
        }
      }

      if (runIdRef.current !== currentRunId) return;

      for (const planned of toCreate) {
        if (prequeryFailed.has(planned.item.number)) continue;
        void queue.add(async () => {
          if (runIdRef.current !== currentRunId) return;

          const itemNumber = planned.item.number;
          let backoffDelay = BACKOFF_BASE_MS;
          // Per-item-total deadline shared across worktree creation, terminal
          // spawning, and assignment. Transient failures retry until this
          // elapses; permanent errors fail immediately (see #10128).
          const itemStart = performance.now();
          let attempt = 0;

          while (true) {
            if (runIdRef.current !== currentRunId) return;
            attempt++;
            // Re-read tracking each iteration: a prior attempt may have created
            // the worktree or spawned terminals, so the snapshot must reflect
            // that to avoid duplicate creation on retry.
            const tracked = tracking.get(itemNumber);

            try {
              // Step 1: Worktree creation (skip if already created)
              let worktreeId = tracked?.worktreeId;
              let worktreePath = tracked?.worktreePath;
              let resolvedBranch = tracked?.resolvedBranch;

              if (!worktreeId) {
                const worktrees = getCurrentViewStore().getState().worktrees;
                const pre = precomputed.get(itemNumber);
                const searchBranches = pre
                  ? [pre.branch, planned.branchName]
                  : [planned.branchName];
                for (const wt of worktrees.values()) {
                  if (wt.branch && searchBranches.includes(wt.branch)) {
                    worktreeId = wt.worktreeId;
                    worktreePath = wt.path;
                    resolvedBranch = wt.branch;
                    break;
                  }
                }
              }

              if (!worktreeId) {
                dispatchProgress({
                  type: "ITEM_WORKTREE_CREATING",
                  issueNumber: itemNumber,
                  attempt,
                });

                if (planned.mode === "pr" && planned.headRefName) {
                  // PR mode: resolve branch from headRefName. The initial
                  // listBranches snapshot is hoisted into `sharedBranches`
                  // above; only refetch after a fetchPRBranch mutation.
                  const branches = sharedBranches ?? (await worktreeClient.listBranches(rootPath));
                  const remoteBranchName = `origin/${planned.headRefName}`;
                  const remoteBranch = branches.find((b) => b.name === remoteBranchName);
                  const localBranch = branches.find(
                    (b) => b.name === planned.headRefName && !b.remote
                  );

                  let createFromRemote = false;
                  let createUseExisting = false;
                  let createBaseBranch: string;

                  if (remoteBranch) {
                    createFromRemote = true;
                    createBaseBranch = remoteBranchName;
                  } else if (localBranch) {
                    createUseExisting = true;
                    createBaseBranch = localBranch.name;
                  } else {
                    // Branch not found — fetch from the provider's PR refs
                    await worktreeClient.fetchPRBranch(
                      rootPath,
                      planned.item.number,
                      planned.headRefName
                    );
                    // Re-check after fetch
                    const updatedBranches = await worktreeClient.listBranches(rootPath);
                    const fetchedLocal = updatedBranches.find(
                      (b) => b.name === planned.headRefName && !b.remote
                    );
                    if (fetchedLocal) {
                      createUseExisting = true;
                      createBaseBranch = fetchedLocal.name;
                    } else {
                      throw new Error(
                        `Branch "${planned.headRefName}" could not be fetched from the remote.`
                      );
                    }
                  }

                  const path = await worktreeClient.getDefaultPath(rootPath, planned.headRefName);

                  // create() has no abort API, so this is the last chance to
                  // keep a cancelled item from putting a worktree on disk.
                  if (runIdRef.current !== currentRunId) return;

                  const createdId = await createWorktree({
                    baseBranch: createBaseBranch,
                    newBranch: planned.headRefName,
                    path,
                    fromRemote: createFromRemote,
                    useExistingBranch: createUseExisting,
                  });

                  if (!createdId) throw new Error("Failed to create worktree: no ID returned");
                  activeRun.created++;

                  worktreeId = createdId;
                  worktreePath = path;
                  resolvedBranch = planned.headRefName;
                } else {
                  // Issue mode: create new branch from base. Branch name and
                  // path were resolved once in the pre-query phase; fall back
                  // to a live lookup only for items that had no pre-query
                  // result (e.g., retry after a worktree-store-detected
                  // short-circuit branch was later removed).
                  const mainWorktree = Array.from(
                    getCurrentViewStore().getState().worktrees.values()
                  ).find((w) => w.isMainWorktree);
                  const baseBranch = mainWorktree?.branch;
                  if (!baseBranch) throw new Error("No main worktree found for base branch");

                  const pre = precomputed.get(itemNumber);
                  const availableBranch =
                    pre?.branch ??
                    (await worktreeClient.getAvailableBranch(rootPath, planned.branchName));
                  const path =
                    pre?.path ?? (await worktreeClient.getDefaultPath(rootPath, availableBranch));

                  // create() has no abort API, so this is the last chance to
                  // keep a cancelled item from putting a worktree on disk.
                  if (runIdRef.current !== currentRunId) return;

                  const createdId = await createWorktree({
                    baseBranch,
                    newBranch: availableBranch,
                    path,
                    fromRemote: false,
                    useExistingBranch: false,
                  });

                  if (!createdId) throw new Error("Failed to create worktree: no ID returned");
                  activeRun.created++;

                  worktreeId = createdId;
                  worktreePath = path;
                  resolvedBranch = availableBranch;
                }

                tracking.set(itemNumber, {
                  worktreeId,
                  worktreePath: worktreePath!,
                  resolvedBranch: resolvedBranch!,
                  spawnedTerminalIds: [],
                  failedTerminalIndices: [],
                });

                dispatchProgress({
                  type: "ITEM_WORKTREE_CREATED",
                  issueNumber: itemNumber,
                  worktreeId,
                  worktreePath: worktreePath!,
                  branch: resolvedBranch!,
                });
              } else if (!tracked?.worktreeId) {
                tracking.set(itemNumber, {
                  worktreeId,
                  worktreePath: worktreePath!,
                  resolvedBranch: resolvedBranch!,
                  spawnedTerminalIds: tracked?.spawnedTerminalIds ?? [],
                  failedTerminalIndices: tracked?.failedTerminalIndices ?? [],
                });
                dispatchProgress({
                  type: "ITEM_WORKTREE_CREATED",
                  issueNumber: itemNumber,
                  worktreeId,
                  worktreePath: worktreePath!,
                  branch: resolvedBranch!,
                });
              }

              // Cancel lands most often inside Step 1, whose IPC calls can't be
              // interrupted. Stop here so an item whose worktree finished after
              // the click doesn't go on to start terminals or agents in it.
              if (runIdRef.current !== currentRunId) return;

              // Step 2: Clone layout or run recipe
              const currentItem = tracking.get(itemNumber);
              if (cloneTerminals && worktreePath && worktreeId && !currentItem?.cloneComplete) {
                dispatchProgress({
                  type: "ITEM_TERMINALS_SPAWNING",
                  issueNumber: itemNumber,
                });
                const spawnedIds: string[] = [];
                const failedIndices: number[] = [];
                await spawnPanelsFromRecipe({
                  terminals: cloneTerminals,
                  worktreeId,
                  cwd: worktreePath,
                  agentSettings: cloneAgentSettings,
                  clipboardDirectory: cloneClipboardDirectory,
                  signal: activeRun.controller.signal,
                  onPanelSpawned: (index, panelId, _error) => {
                    if (panelId != null) {
                      spawnedIds.push(panelId);
                    } else {
                      failedIndices.push(index);
                    }
                  },
                });
                // An aborted spawn reports no failures, just fewer panels, so a
                // cancelled run must not read its partial result as an outcome.
                if (runIdRef.current !== currentRunId) return;
                const updatedTracked = tracking.get(itemNumber);
                if (updatedTracked) {
                  updatedTracked.spawnedTerminalIds = [
                    ...updatedTracked.spawnedTerminalIds,
                    ...spawnedIds,
                  ];
                  updatedTracked.failedTerminalIndices = failedIndices;
                  updatedTracked.cloneComplete = failedIndices.length === 0;
                }
                dispatchProgress({
                  type: "ITEM_TERMINALS_RESULT",
                  issueNumber: itemNumber,
                  spawnedTerminalIds: spawnedIds,
                  failedTerminalIndices: failedIndices,
                });

                if (failedIndices.length > 0) {
                  const errorMsg = `${failedIndices.length} terminal(s) failed to spawn`;
                  failedItems.add(itemNumber);
                  dispatchProgress({
                    type: "ITEM_FAILED",
                    issueNumber: itemNumber,
                    error: errorMsg,
                    attempts: attempt,
                    failedStep: "terminals",
                  });
                  return;
                }
              } else if (
                selectedRecipeId &&
                selectedRecipeId !== CLONE_LAYOUT_ID &&
                worktreePath &&
                worktreeId
              ) {
                const currentTracked = tracking.get(itemNumber);
                const failedIndices = currentTracked?.failedTerminalIndices;
                const shouldRetryTerminals =
                  failedIndices && failedIndices.length > 0 ? failedIndices : undefined;
                // Skip the recipe when terminals are already healthy (e.g. an assignment-only
                // retry preserved its terminal tracking). Otherwise retrying after a 403 from
                // POST /assignees would re-spawn the recipe and duplicate every terminal.
                const allTerminalsHealthy =
                  currentTracked != null &&
                  currentTracked.spawnedTerminalIds.length > 0 &&
                  (!failedIndices || failedIndices.length === 0);
                if (allTerminalsHealthy) {
                  // fall through to step 3 without re-running the recipe
                } else {
                  dispatchProgress({
                    type: "ITEM_TERMINALS_SPAWNING",
                    issueNumber: itemNumber,
                  });

                  const recipeContext =
                    planned.mode === "pr"
                      ? { worktreePath, branchName: resolvedBranch!, prNumber: itemNumber }
                      : { worktreePath, branchName: resolvedBranch!, issueNumber: itemNumber };

                  const results: RecipeSpawnResults = await useRecipeStore
                    .getState()
                    .runRecipeWithResults(
                      selectedRecipeId,
                      worktreePath,
                      worktreeId,
                      recipeContext,
                      {
                        terminalIndices: shouldRetryTerminals,
                        spawnBatch: recipeSpawnBatches.get(itemNumber),
                      }
                    );

                  // Defence in depth: the assignment and success gates below
                  // already stop a cancelled run, but returning here keeps a
                  // dead run from writing tracking and reducer state on its way
                  // out, matching every other checkpoint in this loop.
                  if (runIdRef.current !== currentRunId) return;

                  const updatedTracked = tracking.get(itemNumber);
                  if (updatedTracked) {
                    updatedTracked.spawnedTerminalIds = [
                      ...updatedTracked.spawnedTerminalIds,
                      ...results.spawned.map((s) => s.terminalId),
                    ];
                    updatedTracked.failedTerminalIndices = results.failed.map((f) => f.index);
                  }

                  dispatchProgress({
                    type: "ITEM_TERMINALS_RESULT",
                    issueNumber: itemNumber,
                    spawnedTerminalIds: results.spawned.map((s) => s.terminalId),
                    failedTerminalIndices: results.failed.map((f) => f.index),
                  });

                  if (results.failed.length > 0) {
                    const hasTransient = results.failed.some((f) => isTransientError(f.error));
                    const remaining = MAX_TRANSIENT_RETRY_MS - (performance.now() - itemStart);
                    if (hasTransient && remaining > 0) {
                      backoffDelay = nextBackoffDelay(backoffDelay);
                      await cancellableDelay(
                        Math.min(backoffDelay, remaining),
                        () => runIdRef.current !== currentRunId
                      );
                      continue;
                    }
                    const errorMsg = `${results.failed.length} terminal(s) failed to spawn`;
                    failedItems.add(itemNumber);
                    dispatchProgress({
                      type: "ITEM_FAILED",
                      issueNumber: itemNumber,
                      error: errorMsg,
                      attempts: attempt,
                      failedStep: "terminals",
                    });
                    return;
                  }
                }
              }

              // Step 3: Issue assignment (issues only).
              // Retries transient failures using the same helpers as the outer loop, but
              // with an isolated 60s backoff cap so the assignment endpoint's secondary
              // rate limit (~60s) doesn't widen worktree/terminal retry delays.
              if (planned.mode === "issue" && assignWorktreeToSelf && itemNumber) {
                const username = viewerRef.current?.login;
                // Snap the avatar alongside the login before any async work so
                // the optimistic cache entry matches the user we assign to,
                // mirroring the single-create flow (#10529).
                const assignAvatarUrl = viewerRef.current?.avatarUrl;
                if (username) {
                  dispatchProgress({
                    type: "ITEM_ASSIGNING",
                    issueNumber: itemNumber,
                  });
                  let assignBackoff = BACKOFF_BASE_MS;
                  let assignAttempt = 0;
                  while (true) {
                    if (runIdRef.current !== currentRunId) return;
                    assignAttempt++;
                    try {
                      await forgeClient.assignIssue(rootPath, itemNumber, username);
                      // Optimistically patch every cached issue-list slot so the
                      // open issues dropdown reflects the assignment immediately
                      // instead of waiting for the next SWR revalidate (#10667).
                      // Mirrors the single-create flow (#10529). The dedup guard
                      // inside the helper makes a re-assign a no-op, and the
                      // forge refresh remains the correctness backstop.
                      try {
                        patchIssueAssigneeCache(
                          rootPath,
                          itemNumber,
                          { login: username, avatarUrl: assignAvatarUrl },
                          true
                        );
                      } catch (cacheErr) {
                        // A cache-layer throw must not masquerade as an assignment
                        // failure: the server-side assign already succeeded here.
                        logError("Failed to patch issue cache after bulk self-assign", cacheErr);
                      }
                      break;
                    } catch (err) {
                      const assignErr = normalizeError(err);
                      const remaining = MAX_TRANSIENT_RETRY_MS - (performance.now() - itemStart);
                      if (isTransientError(assignErr) && remaining > 0) {
                        assignBackoff = nextBackoffDelay(assignBackoff, ASSIGNMENT_BACKOFF_CAP_MS);
                        await cancellableDelay(
                          Math.min(assignBackoff, remaining),
                          () => runIdRef.current !== currentRunId
                        );
                        continue;
                      }
                      failedItems.add(itemNumber);
                      dispatchProgress({
                        type: "ITEM_FAILED",
                        issueNumber: itemNumber,
                        error: assignErr,
                        attempts: assignAttempt,
                        failedStep: "assignment",
                      });
                      return;
                    }
                  }
                }
              }

              if (runIdRef.current !== currentRunId) return;

              lastSuccessfulWorktreeId = worktreeId!;
              succeededItems.add(itemNumber);
              dispatchProgress({ type: "ITEM_SUCCEEDED", issueNumber: itemNumber });
              return;
            } catch (err) {
              if (runIdRef.current !== currentRunId) return;
              const errorMsg = normalizeError(err);

              const remaining = MAX_TRANSIENT_RETRY_MS - (performance.now() - itemStart);
              if (isTransientError(errorMsg) && remaining > 0) {
                backoffDelay = nextBackoffDelay(backoffDelay);
                await cancellableDelay(
                  Math.min(backoffDelay, remaining),
                  () => runIdRef.current !== currentRunId
                );
                continue;
              }

              failedItems.add(itemNumber);
              dispatchProgress({
                type: "ITEM_FAILED",
                issueNumber: itemNumber,
                error: errorMsg,
                attempts: attempt,
                failedStep: "worktree",
              });
              return;
            }
          }
        });
      }

      await queue.onIdle();
      if (runIdRef.current !== currentRunId) return;
      // Identity-guarded so a run that went stale mid-await can't null out the
      // refs belonging to the run that replaced it.
      if (queueRef.current === queue) queueRef.current = null;

      // Post-batch verification: check terminal health for current run items only
      if (selectedRecipeId) {
        const verificationPanelIds = [...tracking]
          .filter(
            ([itemNumber, tracked]) =>
              currentRunItems.has(itemNumber) &&
              !failedItems.has(itemNumber) &&
              tracked.failedTerminalIndices.length === 0
          )
          .flatMap(([, tracked]) => tracked.spawnedTerminalIds);
        await waitForPanelSpawns(verificationPanelIds, VERIFICATION_SPAWN_WAIT_MS);
        await delay(VERIFICATION_EXIT_SETTLE_MS);
        if (runIdRef.current !== currentRunId) return;

        const { panelsById } = usePanelStore.getState();

        for (const [itemNumber, tracked] of tracking) {
          if (!currentRunItems.has(itemNumber)) continue;
          // Items that already failed (e.g. assignment) must not get their
          // ITEM_FAILED dispatch overwritten by a verification check.
          if (failedItems.has(itemNumber)) continue;
          if (!tracked.worktreeId || tracked.spawnedTerminalIds.length === 0) continue;
          if (tracked.failedTerminalIndices.length > 0) continue;

          const crashedCount = tracked.spawnedTerminalIds.filter((tid) => {
            const t = panelsById[tid];
            return t && isPtyPanel(t) && t.exitCode !== undefined && t.exitCode !== 0;
          }).length;

          if (crashedCount > 0) {
            succeededItems.delete(itemNumber);
            failedItems.add(itemNumber);
            dispatchProgress({ type: "ITEM_VERIFYING", issueNumber: itemNumber });
            dispatchProgress({
              type: "ITEM_FAILED",
              issueNumber: itemNumber,
              error: `${crashedCount} terminal(s) crashed after spawn`,
              attempts: 1,
              failedStep: "verification",
            });
          }
        }
      }

      if (lastSuccessfulWorktreeId) {
        useWorktreeSelectionStore.getState().setPendingWorktree(lastSuccessfulWorktreeId);
        useWorktreeSelectionStore.getState().selectWorktree(lastSuccessfulWorktreeId);
      }

      dispatchProgress({ type: "DONE" });
      if (activeRunRef.current === activeRun) activeRunRef.current = null;
    },
    [selectedRecipeId, selectedRecipe, assignWorktreeToSelf, currentProject?.path]
  );

  const handleCreate = useCallback(async () => {
    if (isExecutingRef.current) return;
    isExecutingRef.current = true;
    try {
      const toCreate = planned.filter((p) => !p.skipped);
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

      batchTrackingRef.current = new Map();
      dispatchProgress({
        type: "START",
        issueNumbers: toCreate.map((p) => p.item.number),
      });
      await runBatch(toCreate);
    } finally {
      isExecutingRef.current = false;
    }
  }, [
    planned,
    selectedRecipeId,
    projectId,
    recipeSelectionTouchedRef,
    setLastSelectedWorktreeRecipeIdByProject,
    runBatch,
  ]);

  const handleRetryFailed = useCallback(async () => {
    if (isExecutingRef.current) return;
    isExecutingRef.current = true;
    try {
      const failedIssueNumbers = new Set<number>();
      for (const [issueNumber, item] of progress.items) {
        if (
          item.stage === "failed" ||
          item.stage === "terminals-error" ||
          item.stage === "worktree-error"
        ) {
          failedIssueNumbers.add(issueNumber);
        }
      }
      if (failedIssueNumbers.size === 0) return;

      const toRetry = planned.filter(
        (p) => progress.items.has(p.item.number) && failedIssueNumbers.has(p.item.number)
      );
      if (toRetry.length === 0) return;

      // Reset terminal tracking for retried items so verification doesn't use stale data.
      // cloneComplete is also cleared so retry re-enters the clone branch — otherwise a
      // post-success verification failure silently short-circuits to ITEM_SUCCEEDED.
      // Assignment-only failures keep their terminal tracking: the worktree and terminals
      // are healthy, only the GitHub assign call needs to retry.
      for (const issueNumber of failedIssueNumbers) {
        if (progress.items.get(issueNumber)?.failedStep === "assignment") continue;
        const tracked = batchTrackingRef.current.get(issueNumber);
        if (tracked) {
          tracked.spawnedTerminalIds = [];
          tracked.failedTerminalIndices = [];
          tracked.cloneComplete = false;
        }
      }

      dispatchProgress({ type: "RETRY_FAILED" });
      await runBatch(toRetry);
    } finally {
      isExecutingRef.current = false;
    }
  }, [progress.items, planned, runBatch]);

  const handleClose = useCallback(() => {
    // Cancel/Escape/backdrop while idle or mid-execution preserves the bulk
    // selection so the user can reopen the dropdown and finish picking.
    // Once the run has completed, dismissing via X/Escape/backdrop must run
    // the same selection cleanup as the Done button — otherwise the bulk
    // bar stays visible with the now-stale selection.
    if (isExecuting) {
      // Snapshot first: invalidating drops the run record.
      const activeRun = activeRunRef.current;
      const created = activeRun?.created ?? 0;
      const creating = activeRun?.creating ?? 0;
      const total = activeRun?.total ?? progress.total;

      invalidateActiveRun();

      // Cancelling can't unwind an item already past its last checkpoint, and
      // the dialog is gone before those settle — so report what survived it.
      // Silent when nothing was created and nothing is mid-creation: closing the
      // dialog is its own confirmation that no work escaped.
      if (created > 0 || creating > 0) {
        notify({
          type: "warning",
          title: "Worktree creation cancelled",
          message: `${created} of ${total} worktree${total !== 1 ? "s" : ""} created.${
            creating > 0 ? ` ${creating} already underway may still land.` : ""
          }`,
        });
      }
    }
    isExecutingRef.current = false;

    // Capture before onClose() — onClose is wired to closeBulkCreateDialog
    // upstream, which zeroes out the stored callback as part of its reset.
    const storedOnComplete =
      progress.phase === "done"
        ? useWorktreeSelectionStore.getState().bulkCreateDialog.onComplete
        : undefined;

    onClose();
    storedOnComplete?.();
  }, [isExecuting, onClose, progress.phase, progress.total, invalidateActiveRun]);

  const handleDone = useCallback(() => {
    // Capture before onComplete()/onClose() — both are wired to closeBulkCreateDialog
    // upstream, which zeroes out the stored callback as part of its reset.
    const storedOnComplete = useWorktreeSelectionStore.getState().bulkCreateDialog.onComplete;
    onComplete();
    onClose();
    storedOnComplete?.();
  }, [onComplete, onClose]);

  const handleRecipeSelectCombined = useCallback(
    (recipeId: string | null) => {
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
              <Spinner size="lg" className="text-activity-working" />
            ) : isDone ? (
              failedCount > 0 ? (
                <AlertTriangle className="w-5 h-5 text-status-warning" />
              ) : (
                <Check className="w-5 h-5 text-status-success" />
              )
            ) : (
              <FolderGit2 className="w-5 h-5 text-text-muted" />
            )
          }
        >
          {isExecuting
            ? "Creating worktrees\u2026"
            : isDone
              ? "Creation complete"
              : `Create ${creatableCount} worktree${creatableCount !== 1 ? "s" : ""}`}
        </AppDialog.Title>
        {!isExecuting && <AppDialog.CloseButton />}
      </AppDialog.Header>

      <AppDialog.Body>
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
                    <span className="relative inline-flex shrink-0">
                      <input
                        id="bulk-assign-to-self"
                        type="checkbox"
                        checked={assignWorktreeToSelf && !assignUnavailable}
                        onChange={(e) => setAssignWorktreeToSelf(e.target.checked)}
                        disabled={assignUnavailable}
                        className={cn(
                          "h-4 w-7 appearance-none rounded-full border transition-colors duration-150 ease-out",
                          "focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:outline-offset-2",
                          assignWorktreeToSelf && !assignUnavailable
                            ? "border-text-primary bg-text-primary"
                            : "border-border-strong bg-surface-inset",
                          assignUnavailable && "cursor-not-allowed opacity-50"
                        )}
                      />
                      <span
                        className={cn(
                          "pointer-events-none absolute top-1/2 h-3 w-3 -translate-y-1/2 rounded-full",
                          "transition-[left] duration-150 ease-out",
                          assignWorktreeToSelf && !assignUnavailable
                            ? "left-[0.875rem] bg-text-inverse"
                            : "left-0.5 bg-text-secondary"
                        )}
                        aria-hidden="true"
                      />
                    </span>
                    {currentUserAvatar ? (
                      <img
                        src={`${currentUserAvatar}${currentUserAvatar.includes("?") ? "&" : "?"}s=48`}
                        alt=""
                        className="h-4 w-4 shrink-0 rounded-full"
                      />
                    ) : (
                      <UserPlus className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
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
                          <FolderGit2 className="w-3 h-3 text-daintree-text/40 shrink-0" />
                          <span className="text-xs text-text-secondary font-mono truncate">
                            {item.branchName}
                          </span>
                        </div>
                      )}
                    </div>
                    {item.skipped && (
                      <span className="text-3xs px-1.5 py-0.5 rounded bg-status-warning/10 text-status-warning shrink-0">
                        {item.skipReason}
                      </span>
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
                    itemStatus.stage !== "failed";
                  return (
                    <div
                      key={item.item.number}
                      className="px-3 py-2 flex items-start gap-3 text-sm"
                    >
                      <div className="mt-0.5 shrink-0">
                        {isInProgress ? (
                          <Spinner size="md" className="text-activity-working" />
                        ) : itemStatus?.stage === "succeeded" ? (
                          <Check className="w-4 h-4 text-status-success" />
                        ) : itemStatus?.stage === "failed" ? (
                          <AlertTriangle className="w-4 h-4 text-status-warning" />
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
                            <span className="text-3xs px-1.5 py-0.5 rounded bg-status-info/10 text-status-info shrink-0">
                              retry {itemStatus.attempt - 1}
                            </span>
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
              <div className="h-2 rounded-full bg-overlay-soft overflow-hidden">
                <div
                  className="h-full rounded-full bg-status-info transition-[width] duration-300"
                  style={{
                    width: `${progress.items.size > 0 ? (processedCount / progress.items.size) * 100 : 0}%`,
                  }}
                />
              </div>
              <div className="flex items-center justify-center gap-1.5 text-sm tabular-nums text-text-secondary">
                <span>
                  {succeededCount} of {progress.items.size} created
                </span>
                {failedCount > 0 && (
                  <span className="text-status-warning">&middot; {failedCount} failed</span>
                )}
              </div>
            </div>
          </div>
        )}
      </AppDialog.Body>

      {/* Only while idle: once the run starts, the body's own progress line is
          the authority on counts and a second tally would drift from it. */}
      <AppDialog.Footer hint={progress.phase === "idle" ? batchSummary : undefined}>
        {/* One container, because a hint switches the footer to justify-between
            and loose button children would scatter across it. */}
        <div className="flex items-center gap-3">
          {isDone ? (
            <>
              {failedCount > 0 && (
                <Button
                  variant="ghost"
                  onClick={handleRetryFailed}
                  data-testid="bulk-create-retry-button"
                >
                  <RotateCcw />
                  Retry failed
                </Button>
              )}
              <Button variant="contrast" onClick={handleDone} data-testid="bulk-create-done-button">
                <Check />
                Done
              </Button>
            </>
          ) : (
            // The primary stays mounted while executing: dropping it made Cancel
            // the rightmost button, so it inherited the CTA's hit area one render
            // after the click that started the run.
            <>
              <Button variant="ghost" onClick={handleClose}>
                Cancel
              </Button>
              <Button
                variant="contrast"
                onClick={handleCreate}
                disabled={isExecuting || creatableCount === 0}
                className="min-w-[100px]"
                data-testid="bulk-create-confirm-button"
              >
                <Check />
                Create {creatableCount} worktree{creatableCount !== 1 ? "s" : ""}
              </Button>
            </>
          )}
        </div>
      </AppDialog.Footer>
    </AppDialog>
  );
}
