import { useCallback, useReducer, useRef, useMemo, useEffect, useLayoutEffect } from "react";
import PQueue from "p-queue";
import { Check, AlertTriangle, UserPlus, RotateCcw } from "lucide-react";
import { Spinner } from "@/components/ui/Spinner";
import { FolderGit2 } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { AppDialog } from "@/components/ui/AppDialog";
import { cn } from "@/lib/utils";
import { worktreeClient, githubClient, agentSettingsClient, systemClient } from "@/clients";
import { resolveIssuePrequeries } from "./bulkCreatePrequery";
import { notify } from "@/lib/notify";
import { usePreferencesStore } from "@/store/preferencesStore";
import { useGitHubConfigStore } from "../stores/githubConfigStore";
import { useRecipeStore, type RecipeSpawnResults } from "@/store/recipeStore";
import { useProjectStore } from "@/store/projectStore";
import { getCurrentViewStore } from "@/store/createWorktreeStore";
import { useWorktreeStore } from "@/hooks/useWorktreeStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { usePanelStore } from "@/store/panelStore";
import { useRecipePicker, CLONE_LAYOUT_ID } from "@/components/Worktree/hooks/useRecipePicker";
import { RecipePickerPopover } from "@/components/Worktree/views/RecipePickerPopover";
import { useNewWorktreeProjectSettings } from "@/components/Worktree/hooks/useNewWorktreeProjectSettings";
import { spawnPanelsFromRecipe } from "@/components/Worktree/panelSpawning";
import { progressReducer, getStageLabel } from "./bulkCreateReducer";
import {
  planIssueWorktrees,
  planPRWorktrees,
  isTransientError,
  normalizeError,
  delay,
  nextBackoffDelay,
  MAX_AUTO_RETRIES,
  QUEUE_CONCURRENCY,
  BACKOFF_BASE_MS,
  VERIFICATION_SETTLE_MS,
} from "./bulkCreateUtils";
import type { PlannedWorktree } from "./bulkCreateUtils";
import type { GitHubIssue, GitHubPR } from "@shared/types/github";
import type { BranchInfo } from "@shared/types";

type BulkCreateMode = "issue" | "pr";

export interface BulkCreateWorktreeDialogProps {
  isOpen: boolean;
  onClose: () => void;
  mode: BulkCreateMode;
  selectedIssues: GitHubIssue[];
  selectedPRs: GitHubPR[];
  onComplete: () => void;
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
      const currentRunId = ++runIdRef.current;
      const rootPath = currentProject?.path;
      if (!rootPath) return;

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
            queueRef.current = null;

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
          const tracked = tracking.get(itemNumber);
          let backoffDelay = BACKOFF_BASE_MS;

          for (let attempt = 1; attempt <= MAX_AUTO_RETRIES + 1; attempt++) {
            if (runIdRef.current !== currentRunId) return;

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
                    // Branch not found — fetch from GitHub's PR refs
                    const prItem = planned.item as GitHubPR;
                    await worktreeClient.fetchPRBranch(
                      rootPath,
                      prItem.number,
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

                  const createdId = await worktreeClient.create(
                    {
                      baseBranch: createBaseBranch,
                      newBranch: planned.headRefName,
                      path,
                      fromRemote: createFromRemote,
                      useExistingBranch: createUseExisting,
                    },
                    rootPath
                  );

                  if (!createdId) throw new Error("Failed to create worktree: no ID returned");

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

                  const createdId = await worktreeClient.create(
                    {
                      baseBranch,
                      newBranch: availableBranch,
                      path,
                      fromRemote: false,
                      useExistingBranch: false,
                    },
                    rootPath
                  );

                  if (!createdId) throw new Error("Failed to create worktree: no ID returned");

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
                  onPanelSpawned: (index, panelId, _error) => {
                    if (panelId != null) {
                      spawnedIds.push(panelId);
                    } else {
                      failedIndices.push(index);
                    }
                  },
                });
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
                  .runRecipeWithResults(selectedRecipeId, worktreePath, worktreeId, recipeContext, {
                    terminalIndices: shouldRetryTerminals,
                  });

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
                  if (attempt <= MAX_AUTO_RETRIES && hasTransient) {
                    backoffDelay = nextBackoffDelay(backoffDelay);
                    await delay(backoffDelay);
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

              // Step 3: Issue assignment (best-effort, issues only).
              // Retries transient failures using the same helpers as the outer loop, but
              // with isolated backoff so step-3 delays don't contaminate sibling items.
              // Permanent failures (401/403/404/422) and exhausted retries fall through
              // silently — assignment is never surfaced as an item failure.
              if (planned.mode === "issue" && assignWorktreeToSelf && itemNumber) {
                const username = useGitHubConfigStore.getState().config?.username;
                if (username) {
                  dispatchProgress({
                    type: "ITEM_ASSIGNING",
                    issueNumber: itemNumber,
                  });
                  let assignBackoff = BACKOFF_BASE_MS;
                  for (
                    let assignAttempt = 1;
                    assignAttempt <= MAX_AUTO_RETRIES + 1;
                    assignAttempt++
                  ) {
                    if (runIdRef.current !== currentRunId) return;
                    try {
                      await githubClient.assignIssue(rootPath, itemNumber, username);
                      break;
                    } catch (err) {
                      const assignErr = normalizeError(err);
                      if (assignAttempt <= MAX_AUTO_RETRIES && isTransientError(assignErr)) {
                        assignBackoff = nextBackoffDelay(assignBackoff);
                        await delay(assignBackoff);
                        continue;
                      }
                      break;
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

              if (attempt <= MAX_AUTO_RETRIES && isTransientError(errorMsg)) {
                backoffDelay = nextBackoffDelay(backoffDelay);
                await delay(backoffDelay);
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
      queueRef.current = null;

      // Post-batch verification: check terminal health for current run items only
      if (selectedRecipeId) {
        await delay(VERIFICATION_SETTLE_MS);
        if (runIdRef.current !== currentRunId) return;

        const { panelsById } = usePanelStore.getState();

        for (const [itemNumber, tracked] of tracking) {
          if (!currentRunItems.has(itemNumber)) continue;
          if (!tracked.worktreeId || tracked.spawnedTerminalIds.length === 0) continue;
          if (tracked.failedTerminalIndices.length > 0) continue;

          const crashedCount = tracked.spawnedTerminalIds.filter((tid) => {
            const t = panelsById[tid];
            return t && t.exitCode !== undefined && t.exitCode !== 0;
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
    },
    [selectedRecipeId, assignWorktreeToSelf, currentProject?.path]
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
      for (const issueNumber of failedIssueNumbers) {
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
      runIdRef.current++;
      queueRef.current?.clear();
      queueRef.current = null;
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
  }, [isExecuting, onClose, progress.phase]);

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
          <div className="space-y-4">
            {/* Assign to self (issues only) */}
            {mode === "issue" && currentUser && (
              <div className="flex items-center gap-3 px-3 py-2.5 rounded-[var(--radius-md)] border bg-daintree-bg/50 border-daintree-border transition-colors">
                {currentUserAvatar ? (
                  <img
                    src={`${currentUserAvatar}${currentUserAvatar.includes("?") ? "&" : "?"}s=64`}
                    alt={currentUser}
                    className="w-8 h-8 rounded-full shrink-0"
                  />
                ) : (
                  <div className="flex items-center justify-center w-8 h-8 rounded-full shrink-0 bg-overlay-medium text-daintree-text/60">
                    <UserPlus className="w-4 h-4" />
                  </div>
                )}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-daintree-text">Assign to me</span>
                    <span className="text-xs text-daintree-text/50 font-mono">@{currentUser}</span>
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
                      "peer-focus-visible:ring-2 peer-focus-visible:ring-daintree-accent",
                      "after:content-[''] after:absolute after:top-0.5 after:left-0.5",
                      "after:rounded-full after:h-4 after:w-4",
                      "after:transition-transform after:duration-150",
                      assignWorktreeToSelf
                        ? "bg-daintree-accent after:translate-x-4 after:bg-text-inverse"
                        : "bg-daintree-border after:translate-x-0 after:bg-daintree-text"
                    )}
                  />
                </label>
              </div>
            )}

            <RecipePickerPopover
              recipes={globalRecipes}
              selectedRecipeId={selectedRecipeId}
              selectedRecipe={selectedRecipe}
              defaultRecipeId={defaultRecipeId}
              open={recipePickerOpen}
              onOpenChange={setRecipePickerOpen}
              onSelectRecipe={handleRecipeSelectCombined}
              onMarkTouched={() => {}}
              label="Starting Layout"
              listId="bulk-recipe-selector"
            />

            {/* Worktree list */}
            <div className="space-y-2">
              <label className="block text-sm font-medium text-daintree-text">
                Worktrees to create
              </label>
              <div className="max-h-[300px] overflow-y-auto rounded-[var(--radius-md)] border border-daintree-border divide-y divide-daintree-border">
                {planned.map((item) => (
                  <div
                    key={item.item.number}
                    className={cn(
                      "px-3 py-2 flex items-center gap-3 text-sm",
                      item.skipped && "opacity-50"
                    )}
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="text-daintree-text/50 text-xs font-mono shrink-0">
                          #{item.item.number}
                        </span>
                        <span className="text-daintree-text truncate">{item.item.title}</span>
                      </div>
                      {!item.skipped && (
                        <div className="flex items-center gap-1.5 mt-0.5">
                          <FolderGit2 className="w-3 h-3 text-daintree-text/40 shrink-0" />
                          <span className="text-xs text-daintree-text/50 font-mono truncate">
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
          <div className="space-y-4">
            {/* Per-item status list */}
            <div className="max-h-[300px] overflow-y-auto rounded-[var(--radius-md)] border border-daintree-border divide-y divide-daintree-border">
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
                          <div className="w-4 h-4 rounded-full border border-daintree-border" />
                        )}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="text-daintree-text/50 text-xs font-mono shrink-0">
                            #{item.item.number}
                          </span>
                          <span className="text-daintree-text truncate">{item.item.title}</span>
                          {isInProgress && itemStatus.attempt > 1 && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-status-info/10 text-status-info shrink-0">
                              retry {itemStatus.attempt - 1}
                            </span>
                          )}
                        </div>
                        {stageLabel && (
                          <p className="text-xs text-daintree-text/50 mt-0.5">{stageLabel}</p>
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
              <div className="flex items-center justify-center gap-1.5 text-sm tabular-nums text-daintree-text/70">
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

      <AppDialog.Footer>
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
            <Button onClick={handleDone} data-testid="bulk-create-done-button">
              <Check />
              Done
            </Button>
          </>
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
              Create {creatableCount} worktree{creatableCount !== 1 ? "s" : ""}
            </Button>
          </>
        )}
      </AppDialog.Footer>
    </AppDialog>
  );
}
