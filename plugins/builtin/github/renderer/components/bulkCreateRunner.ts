import PQueue from "p-queue";
import { create } from "zustand";
import { worktreeClient, forgeClient, agentSettingsClient, systemClient } from "@/clients";
import { bulkWorktreeRunsClient } from "@/clients/bulkWorktreeRunsClient";
import { patchIssueAssigneeCache } from "@/lib/forgeResourceCache";
import { linkProviderIssue } from "@/utils/linkProviderIssue";
import { buildSourcePrOptions, findUnambiguousPrRemoteBranch } from "@/utils/prWorktreeSource";
import { logError } from "@/utils/logger";
import { notify } from "@/lib/notify";
import { useRecipeStore, type RecipeSpawnResults } from "@/store/recipeStore";
import { isPtyPanel, type PanelInstance } from "@shared/types/panel";
import { getCurrentViewStore } from "@/store/createWorktreeStore";
import { usePanelStore } from "@/store/panelStore";
import { isTerminalRestarting } from "@/store/restartExitSuppression";
import { CLONE_LAYOUT_ID } from "@/components/Worktree/hooks/useRecipePicker";
import { spawnPanelsFromRecipe } from "@/components/Worktree/panelSpawning";
import { recipeApprovalDigest } from "@/utils/recipeApprovalDigest";
import type { BranchInfo, RecipeTerminal, TerminalRecipe } from "@shared/types";
import {
  BULK_RUN_HEARTBEAT_MS,
  type BulkWorktreeRunExecution,
  type BulkWorktreeRunPhase,
  type BulkWorktreeRunSnapshot,
} from "@shared/types/ipc/bulkWorktreeRuns";
import {
  attentionVerb,
  bulkRunItemStep,
  describeBulkRunNumbers,
  summarizeBulkRun,
} from "@/lib/bulkWorktreeRuns";
import { resolveIssuePrequeries } from "./bulkCreatePrequery";
import { progressReducer, type ProgressAction, type ProgressState } from "./bulkCreateReducer";
import {
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

/**
 * Bulk worktree creation runs, executed in this project view and owned by no
 * component (#17085). The dialog that starts a run only shows it: closing the
 * dialog leaves the run going, and reopening it shows the same run. Cancelling
 * is its own action. Each change is published to main, which holds every run
 * for every view and sends back cancel and retry asked for from any of them.
 */

/** What Create was pressed with. Retry reuses it, so nothing picked later moves a retried item. */
export interface BulkCreateRunInput {
  projectId: string;
  rootPath: string | undefined;
  mode: "issue" | "pr";
  /** The whole selection as planned at Create, skipped items included. */
  plan: PlannedWorktree[];
  recipeId: string | null;
  recipe: TerminalRecipe | undefined;
  assignToSelf: boolean;
  /**
   * Read per item, so an identity that lands mid-run still assigns. Null is a
   * lookup that found no account, which skips assignment; undefined is one
   * that hasn't answered, which the run then makes itself.
   */
  getViewer: () => { login: string; avatarUrl?: string } | null | undefined;
  /** The base issue branches are cut from. */
  base: { name: string; fromRemote: boolean } | null;
  /** The layout Clone was pressed with; null unless the recipe is Clone. */
  cloneTerminals: RecipeTerminal[] | null;
}

export interface BulkCreateRun {
  id: string;
  projectId: string;
  mode: "issue" | "pr";
  plan: PlannedWorktree[];
  progress: ProgressState;
  startedAt: number;
  /** Every pass over the run: its start, then each retry. */
  executions: BulkWorktreeRunExecution[];
}

interface BulkCreateRunState {
  runs: Record<string, BulkCreateRun>;
}

/** This view's runs. Main holds every view's; this is the one place a run here can change. */
export const useBulkCreateRunStore = create<BulkCreateRunState>(() => ({ runs: {} }));

interface BatchItemTracking {
  worktreeId?: string;
  worktreePath?: string;
  resolvedBranch?: string;
  // Keyed by the entry's index in the recipe or cloned layout, so a retry can
  // relaunch exactly the entries that are missing and leave the rest running.
  terminalIdByIndex: Map<number, string>;
  failedTerminalIndices: number[];
  // Once a launch has run, only failed entries launch again.
  terminalsLaunched: boolean;
  // The recipe this item's first launch ran, by id and digest. Its indices
  // mean those entries only, so every later launch must find the same recipe.
  launchedRecipe?: { id: string; terminalsDigest: string };
}

function newTerminalTracking(): Pick<
  BatchItemTracking,
  "terminalIdByIndex" | "failedTerminalIndices" | "terminalsLaunched"
> {
  return { terminalIdByIndex: new Map(), failedTerminalIndices: [], terminalsLaunched: false };
}

function recordTerminalLaunch(
  tracked: BatchItemTracking,
  spawned: ReadonlyArray<{ index: number; terminalId: string }>,
  failedIndices: number[]
) {
  for (const { index, terminalId } of spawned) tracked.terminalIdByIndex.set(index, terminalId);
  tracked.failedTerminalIndices = failedIndices;
  tracked.terminalsLaunched = true;
}

function exitedNonZero(panel: PanelInstance): boolean {
  return isPtyPanel(panel) && panel.exitCode !== undefined && panel.exitCode !== 0;
}

// A terminal mid-restart belongs to whoever is restarting it, and a restart
// that failed can't be told from one that left the old process running, so
// neither counts: Retry must never trash or duplicate a live terminal.
function terminalIsDead(panelId: string, panel: PanelInstance): boolean {
  if (!isPtyPanel(panel) || panel.isRestarting || isTerminalRestarting(panelId)) return false;
  return exitedNonZero(panel) || panel.spawnStatus === "failed";
}

/**
 * Settles, before a retry, which of an item's entries launch again. A dead
 * terminal still in this worktree goes to the trash (recoverable) and its
 * entry relaunches, so the replacement doesn't sit beside a dead copy of
 * itself; that covers entries that died after an earlier failure, not just the
 * ones verification flagged. A failed entry whose terminal is running again
 * stays as it is. One whose terminal is gone, already trashed or moved to
 * another worktree relaunches without touching that panel.
 */
function releaseDeadTerminals(
  tracked: BatchItemTracking,
  panelsById: Record<string, PanelInstance | undefined>,
  trashPanel: (id: string) => void
) {
  const failed = new Set(tracked.failedTerminalIndices);
  for (const [index, panelId] of [...tracked.terminalIdByIndex]) {
    const panel = panelsById[panelId];
    const owned =
      panel !== undefined && panel.location !== "trash" && panel.worktreeId === tracked.worktreeId;
    if (!owned) {
      // A healthy entry the user closed or moved stays that way.
      tracked.terminalIdByIndex.delete(index);
    } else if (terminalIsDead(panelId, panel)) {
      trashPanel(panelId);
      tracked.terminalIdByIndex.delete(index);
      failed.add(index);
    } else {
      failed.delete(index);
    }
  }
  tracked.failedTerminalIndices = [...failed].sort((a, b) => a - b);
}

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

interface RunRuntime {
  input: BulkCreateRunInput;
  // Lives as long as the run, so a retry reuses worktrees and healthy
  // terminals an earlier attempt made (#16834).
  tracking: Map<number, BatchItemTracking>;
  /** Bumped by a cancel: every checkpoint inside runBatch stops at its next chance. */
  generation: number;
  // Reaches the one callee that can stop mid-flight (spawnPanelsFromRecipe).
  controller: AbortController;
  queue: PQueue | null;
  cancelRequested: boolean;
  viewerLookup: Promise<{ login: string; avatarUrl?: string } | null> | null;
}

function lookUpViewer(
  rt: RunRuntime,
  rootPath: string
): Promise<{ login: string; avatarUrl?: string } | null> {
  rt.viewerLookup ??= forgeClient
    .getCurrentUser(rootPath)
    .then((user) => (user ? { login: user.login, avatarUrl: user.avatarUrl } : null))
    .catch(() => null);
  return rt.viewerLookup;
}

const runtimes = new Map<string, RunRuntime>();

function dispatchRun(runId: string, action: ProgressAction): void {
  const run = useBulkCreateRunStore.getState().runs[runId];
  if (!run) return;
  const progress = progressReducer(run.progress, action);
  if (progress === run.progress) return;
  const next: BulkCreateRun = { ...run, progress };
  // A pass ends when the run stops being live, stamped with the same change
  // that publishes it, so every view sees when it ended.
  if (isLive(run) && !isLive(next)) {
    const passes = [...run.executions];
    const last = passes[passes.length - 1];
    if (last && last.endedAt === undefined) {
      passes[passes.length - 1] = { ...last, endedAt: Date.now() };
    }
    next.executions = passes;
  }
  useBulkCreateRunStore.setState((state) => ({
    runs: { ...state.runs, [runId]: next },
  }));
  schedulePublish(runId);
  if (isLive(run) !== isLive(next)) syncHeartbeat();
}

function snapshotPhase(phase: ProgressState["phase"]): BulkWorktreeRunPhase {
  switch (phase) {
    case "cancelling":
    case "cancelled":
    case "done":
      return phase;
    default:
      return "running";
  }
}

export function toBulkWorktreeRunSnapshot(run: BulkCreateRun): BulkWorktreeRunSnapshot {
  const items: BulkWorktreeRunSnapshot["items"] = [];
  for (const planned of run.plan) {
    const status = run.progress.items.get(planned.item.number);
    if (!status) continue;
    items.push({
      number: planned.item.number,
      title: planned.item.title,
      stage: status.stage,
      attempt: status.attempt,
      ...(status.retried !== undefined ? { retried: status.retried } : {}),
      ...(status.error !== undefined ? { error: status.error } : {}),
      ...(status.failedStep !== undefined ? { failedStep: status.failedStep } : {}),
      ...(status.worktreeId !== undefined ? { worktreeId: status.worktreeId } : {}),
      ...(status.worktreePath !== undefined ? { worktreePath: status.worktreePath } : {}),
      ...(status.resolvedBranch !== undefined ? { branch: status.resolvedBranch } : {}),
    });
  }
  return {
    runId: run.id,
    projectId: run.projectId,
    mode: run.mode,
    phase: snapshotPhase(run.progress.phase),
    items,
    startedAt: run.startedAt,
    executions: run.executions.map((pass) => ({ ...pass })),
    updatedAt: Date.now(),
    controllable: true,
  };
}

function bridgeAvailable(): boolean {
  return typeof window !== "undefined" && typeof window.electron?.bulkWorktreeRuns === "object";
}

// One publish per run per tick: a burst of item updates goes out as the last one.
const publishPending = new Set<string>();

function schedulePublish(runId: string): void {
  if (!bridgeAvailable() || publishPending.has(runId)) return;
  publishPending.add(runId);
  queueMicrotask(() => {
    publishPending.delete(runId);
    const run = useBulkCreateRunStore.getState().runs[runId];
    if (!run) return;
    bulkWorktreeRunsClient.publish(toBulkWorktreeRunSnapshot(run)).catch((error: unknown) => {
      logError("Failed to publish bulk worktree run", error);
    });
  });
}

// While any run here is live, republish it now and then: a long step (a slow
// branch lookup, a transient retry) changes nothing, and main's hold on this
// view lapses without word from it.
let heartbeat: ReturnType<typeof setInterval> | null = null;

function isLive(run: BulkCreateRun | undefined): boolean {
  return run?.progress.phase === "executing" || run?.progress.phase === "cancelling";
}

function syncHeartbeat(): void {
  const live = Object.values(useBulkCreateRunStore.getState().runs).filter(isLive);
  if (live.length > 0 && heartbeat === null && bridgeAvailable()) {
    heartbeat = setInterval(() => {
      for (const run of Object.values(useBulkCreateRunStore.getState().runs)) {
        if (isLive(run)) schedulePublish(run.id);
      }
    }, BULK_RUN_HEARTBEAT_MS);
  } else if (live.length === 0 && heartbeat !== null) {
    clearInterval(heartbeat);
    heartbeat = null;
  }
}

let stopListeningForCommands: (() => void) | null = null;
let stopFollowingDismissals: (() => void) | null = null;

// Installed with the first run, so a view that never runs one listens for nothing.
function listenForCommands(): void {
  if (stopListeningForCommands || !bridgeAvailable()) return;
  stopListeningForCommands = bulkWorktreeRunsClient.onCommand(({ runId, kind }) => {
    const taken =
      kind === "cancel" ? cancelBulkCreateRun(runId) : retryFailedBulkCreateRun(runId) !== null;
    // Main held this view for the command; the run as it stands releases it.
    if (!taken) schedulePublish(runId);
  });
  // The toolbar dismisses a run through main from whichever view it is in, so
  // an ended run main no longer holds is forgotten here too. A live run is
  // never dropped: one main hasn't heard of yet is still on its way there.
  stopFollowingDismissals = bulkWorktreeRunsClient.onChanged(({ runs }) => {
    const held = new Set(runs.map((run) => run.runId));
    for (const run of Object.values(useBulkCreateRunStore.getState().runs)) {
      if (held.has(run.id) || isLive(run)) continue;
      forgetRun(run.id);
    }
  });
}

function forgetRun(runId: string): void {
  runtimes.delete(runId);
  useBulkCreateRunStore.setState((state) => {
    if (!(runId in state.runs)) return state;
    const { [runId]: _forgotten, ...runs } = state.runs;
    return { runs };
  });
}

/**
 * Files the outcome of an execution in the notification center, once, from
 * the view that ran it: every toast the run used to raise is gone (#17086),
 * and the toolbar chip is the live handle. Inbox only, so it never interrupts,
 * and a retry's outcome supersedes the attempt before it. The entry names each
 * failure and why, so dismissing the chip never loses what went wrong. When
 * the chip stops showing a clean finish is each view's call, from the snapshot.
 */
function settleRun(runId: string): void {
  const run = useBulkCreateRunStore.getState().runs[runId];
  if (!run) return;
  const snapshot = toBulkWorktreeRunSnapshot(run);
  const summary = summarizeBulkRun(snapshot);
  const unfinished = snapshot.items.filter(
    (item) => item.stage === "failed" || item.stage === "interrupted"
  );
  // The record outlives the chip, so it keeps every failure and its actual
  // error, not just a count: dismissing the chip must not lose what went wrong.
  let message: string;
  if (unfinished.length > 0 && summary.sharedFailure !== null) {
    // One reason for all of them: say it once, then every one it hit, since
    // after Dismiss this record is the only list of them left.
    const numbers = unfinished.map((item) => `#${item.number}`).join(", ");
    message = `${summary.detail}. ${summary.sharedFailureLead} ${summary.sharedFailure} (${numbers}).`;
  } else if (unfinished.length > 0) {
    const reasons = unfinished
      .map((item) => {
        const step = bulkRunItemStep(item, snapshot.mode).toLowerCase();
        return item.error ? `#${item.number} ${step}: ${item.error}` : `#${item.number} ${step}`;
      })
      .join("; ");
    message = `${summary.detail}. ${reasons}.`;
  } else if (run.progress.phase === "cancelled") {
    message = `${summary.detail}.`;
  } else {
    message = `For ${describeBulkRunNumbers(snapshot.items.map((item) => item.number))}.`;
  }
  const verb = attentionVerb(summary.facts);
  const title =
    summary.tone === "error"
      ? "Worktree creation failed"
      : summary.tone === "warning"
        ? `Worktree creation: ${unfinished.length} ${verb}`
        : summary.tone === "neutral"
          ? "Worktree creation cancelled"
          : summary.title;
  notify({
    type:
      summary.tone === "warning" || summary.tone === "error"
        ? "warning"
        : summary.tone === "success"
          ? "success"
          : "info",
    priority: "low",
    title,
    message,
    supersedeKey: `bulk-worktree-run:${runId}`,
    context: { projectId: run.projectId },
  });
}

async function execute(runId: string, rt: RunRuntime, toCreate: PlannedWorktree[]) {
  rt.cancelRequested = false;
  rt.controller = new AbortController();
  const gen = ++rt.generation;
  try {
    await runBatch(runId, rt, gen, toCreate);
  } catch (error) {
    logError("Bulk worktree run failed", error);
  } finally {
    rt.queue = null;
    if (rt.cancelRequested) {
      dispatchRun(runId, { type: "CANCELLED" });
    } else if (useBulkCreateRunStore.getState().runs[runId]?.progress.phase === "executing") {
      dispatchRun(runId, { type: "DONE" });
    }
    settleRun(runId);
  }
}

/** Start a run of every creatable item in `input.plan`. `done` settles when it ends. */
export function startBulkCreateRun(input: BulkCreateRunInput): {
  runId: string;
  done: Promise<void>;
} {
  const runId = crypto.randomUUID();
  const toCreate = input.plan.filter((p) => !p.skipped);
  const startedAt = Date.now();
  const run: BulkCreateRun = {
    id: runId,
    projectId: input.projectId,
    mode: input.mode,
    plan: input.plan,
    progress: progressReducer(
      { phase: "idle", total: 0, items: new Map() },
      { type: "START", issueNumbers: toCreate.map((p) => p.item.number) }
    ),
    startedAt,
    executions: [{ startedAt }],
  };
  const rt: RunRuntime = {
    input,
    tracking: new Map(),
    generation: 0,
    controller: new AbortController(),
    queue: null,
    cancelRequested: false,
    viewerLookup: null,
  };
  runtimes.set(runId, rt);
  useBulkCreateRunStore.setState((state) => ({ runs: { ...state.runs, [runId]: run } }));
  listenForCommands();
  schedulePublish(runId);
  syncHeartbeat();
  return { runId, done: execute(runId, rt, toCreate) };
}

/**
 * Stop a live run. Items still queued never start, and items already working
 * stop at their next checkpoint. A worktree create can't be called back, so
 * the run stays `cancelling` until those settle, and a worktree that lands
 * meanwhile is recorded as created. False when the run isn't live.
 */
export function cancelBulkCreateRun(runId: string): boolean {
  const run = useBulkCreateRunStore.getState().runs[runId];
  const rt = runtimes.get(runId);
  if (!run || !rt || run.progress.phase !== "executing") return false;
  rt.cancelRequested = true;
  rt.generation++;
  rt.controller.abort();
  rt.queue?.clear();
  dispatchRun(runId, { type: "CANCEL_REQUESTED" });
  return true;
}

/**
 * Run the failed items of an ended run again, a cancelled one included; what
 * a cancel stopped stays stopped. Worktrees already created are reused, and
 * only the terminals that are missing or dead launch again (#16834). Null
 * when the run has nothing to retry or is still running.
 */
export function retryFailedBulkCreateRun(runId: string): Promise<void> | null {
  const run = useBulkCreateRunStore.getState().runs[runId];
  const rt = runtimes.get(runId);
  const { phase } = run?.progress ?? {};
  if (!run || !rt || (phase !== "done" && phase !== "cancelled")) return null;
  const failedIssueNumbers = new Set<number>();
  for (const [issueNumber, item] of run.progress.items) {
    if (
      item.stage === "failed" ||
      item.stage === "terminals-error" ||
      item.stage === "worktree-error"
    ) {
      failedIssueNumbers.add(issueNumber);
    }
  }
  const toRetry = run.plan.filter((p) => failedIssueNumbers.has(p.item.number));
  if (toRetry.length === 0) return null;

  // Terminal tracking survives the retry: healthy terminals stay, and the
  // run relaunches only the entries still marked failed.
  const { panelsById, trashPanel } = usePanelStore.getState();
  for (const issueNumber of failedIssueNumbers) {
    const tracked = rt.tracking.get(issueNumber);
    if (tracked) releaseDeadTerminals(tracked, panelsById, trashPanel);
  }

  useBulkCreateRunStore.setState((state) => ({
    runs: {
      ...state.runs,
      [runId]: { ...run, executions: [...run.executions, { startedAt: Date.now() }] },
    },
  }));
  dispatchRun(runId, { type: "RETRY_FAILED" });
  return execute(runId, rt, toRetry);
}

/** Forget an ended run here and in main. A live run is never dropped. */
export function dismissBulkCreateRun(runId: string): boolean {
  const run = useBulkCreateRunStore.getState().runs[runId];
  if (!run) return false;
  const { phase } = run.progress;
  if (phase === "executing" || phase === "cancelling") return false;
  forgetRun(runId);
  if (bridgeAvailable()) {
    bulkWorktreeRunsClient.dismiss(runId).catch((error: unknown) => {
      logError("Failed to dismiss bulk worktree run", error);
    });
  }
  return true;
}

/** Test-only: forget every run and stop listening. */
export function _resetBulkCreateRunsForTests(): void {
  for (const rt of runtimes.values()) {
    rt.generation++;
    rt.controller.abort();
    rt.queue?.clear();
  }
  runtimes.clear();
  publishPending.clear();
  if (heartbeat !== null) clearInterval(heartbeat);
  heartbeat = null;
  stopListeningForCommands?.();
  stopListeningForCommands = null;
  stopFollowingDismissals?.();
  stopFollowingDismissals = null;
  useBulkCreateRunStore.setState({ runs: {} });
}

async function runBatch(
  runId: string,
  rt: RunRuntime,
  gen: number,
  toCreate: PlannedWorktree[]
): Promise<void> {
  const { input } = rt;
  const dispatch = (action: ProgressAction) => dispatchRun(runId, action);
  const runBase = input.base;
  const rootPath = input.rootPath;
  if (!rootPath) {
    // handleCreate already dispatched START, so returning bare would strand
    // phase: "executing" — header X hidden, Escape and backdrop blocked.
    // Fail the items instead so the dialog reaches a terminal state with a
    // reason and a Retry affordance.
    for (const planned of toCreate) {
      dispatch({
        type: "ITEM_FAILED",
        issueNumber: planned.item.number,
        error: "The current project path is unavailable",
        attempts: 1,
        failedStep: "worktree",
      });
    }
    dispatch({ type: "DONE" });
    return;
  }

  const createWorktree = (options: Parameters<typeof worktreeClient.create>[0]) =>
    worktreeClient.create(options, rootPath);

  const tracking = rt.tracking;
  // A retried item whose worktree already exists goes straight to its
  // terminals, so it needs no branch or path lookups — and a lookup that
  // timed out would fail an item that has nothing left to create.
  const needsWorktree = toCreate.filter((p) => !tracking.get(p.item.number)?.worktreeId);

  const cloneTerminals = input.recipeId === CLONE_LAYOUT_ID ? input.cloneTerminals : null;

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
      if (rt.generation !== gen) return;
      cloneAgentSettings = settings;
      cloneClipboardDirectory = tmpDir ? `${tmpDir}/daintree-clipboard` : undefined;
    } catch {
      if (rt.generation !== gen) return;
      // Non-fatal: agents fall back to generating with empty settings.
    }
  }

  const queue = new PQueue({
    concurrency: QUEUE_CONCURRENCY,
  });
  rt.queue = queue;
  const currentRunItems = new Set(toCreate.map((p) => p.item.number));
  // Size the admission batch off the recipe that will actually spawn: the
  // run path resolves a shadowed id to its winner, so planning from the
  // displayed row would budget for the wrong terminal count.
  const effectiveRecipe = input.recipe
    ? (useRecipeStore.getState().getRecipeById(input.recipe.id) ?? input.recipe)
    : undefined;
  const ptyTerminalsPerRecipe =
    effectiveRecipe?.terminals.filter((terminal) => terminal.type !== "dev-preview").length ?? 0;
  const recipeSpawnBatches = planBulkRecipeSpawnBatches(
    [...currentRunItems],
    ptyTerminalsPerRecipe,
    () => crypto.randomUUID()
  );
  const succeededItems = new Set<number>();
  const failedItems = new Set<number>();

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

  if (needsWorktree.some((p) => p.mode === "pr")) {
    try {
      sharedBranches = await worktreeClient.listBranches(rootPath);
      if (rt.generation !== gen) return;
    } catch (err) {
      if (rt.generation !== gen) return;
      const errorMsg = normalizeError(err);
      for (const planned of needsWorktree) {
        if (planned.mode !== "pr") continue;
        prequeryFailed.add(planned.item.number);
        failedItems.add(planned.item.number);
        dispatch({
          type: "ITEM_FAILED",
          issueNumber: planned.item.number,
          error: errorMsg,
          attempts: 1,
          failedStep: "worktree",
        });
      }
      if (toCreate.every((p) => failedItems.has(p.item.number))) {
        dispatch({ type: "DONE" });
        if (rt.queue === queue) rt.queue = null;
        return;
      }
    }
  }

  // Batch pre-queries: parallel branch/path resolution with bounded concurrency.
  // Two-phase approach: (1) resolve branch candidates with bounded concurrency,
  // (2) apply deterministic uniqueness suffixes in input order, (3) resolve paths
  // with bounded concurrency using final unique branch names.
  const prequeryInput = needsWorktree.filter((p) => p.mode === "issue");

  if (prequeryInput.length > 0) {
    const { results, failedItems: prequeryFailures } = await resolveIssuePrequeries({
      rootPath,
      items: prequeryInput,
      existingBranches: null,
      getAvailableBranch: worktreeClient.getAvailableBranch,
      getDefaultPath: worktreeClient.getDefaultPath,
      isStaleRun: () => rt.generation !== gen,
    });

    if (rt.generation !== gen) return;

    for (const [number, { branch, path }] of results) {
      precomputed.set(number, { branch, path });
    }

    for (const { number, error } of prequeryFailures) {
      prequeryFailed.add(number);
      failedItems.add(number);
      dispatch({
        type: "ITEM_FAILED",
        issueNumber: number,
        error: normalizeError(error),
        attempts: 1,
        failedStep: "worktree",
      });
    }
  }

  if (rt.generation !== gen) return;

  for (const planned of toCreate) {
    if (prequeryFailed.has(planned.item.number)) continue;
    void queue.add(async () => {
      if (rt.generation !== gen) return;

      const itemNumber = planned.item.number;
      let backoffDelay = BACKOFF_BASE_MS;
      // Per-item-total deadline shared across worktree creation, terminal
      // spawning, and assignment. Transient failures retry until this
      // elapses; permanent errors fail immediately (see #10128).
      const itemStart = performance.now();
      let attempt = 0;

      while (true) {
        if (rt.generation !== gen) return;
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
            const searchBranches = pre ? [pre.branch, planned.branchName] : [planned.branchName];
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
            dispatch({
              type: "ITEM_WORKTREE_CREATING",
              issueNumber: itemNumber,
              attempt,
            });

            if (planned.mode === "pr" && planned.headRefName) {
              // PR mode: resolve branch from headRefName. The initial
              // listBranches snapshot is hoisted into `sharedBranches`
              // above; only refetch after a fetchPRBranch mutation.
              const sourcePr = planned.item;
              if (!("headRef" in sourcePr)) {
                throw new Error(`Planned item #${itemNumber} is not a pull request.`);
              }
              const branches = sharedBranches ?? (await worktreeClient.listBranches(rootPath));
              // Same guard as the single-PR dialog: a head name two remotes
              // both carry can't be trusted, so it falls through to the
              // PR-number fetch below.
              const remoteBranch = findUnambiguousPrRemoteBranch(branches, planned.headRefName);
              const localBranch = branches.find((b) => b.name === planned.headRefName && !b.remote);

              let createFromRemote = false;
              let createUseExisting = false;
              let createBaseBranch: string;

              if (remoteBranch) {
                createFromRemote = true;
                createBaseBranch = remoteBranch.name;
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
              if (rt.generation !== gen) return;

              const created = await createWorktree({
                baseBranch: createBaseBranch,
                newBranch: planned.headRefName,
                path,
                fromRemote: createFromRemote,
                useExistingBranch: createUseExisting,
                // The host seeds the card's linked PR from these at creation
                // (#8888), so a fork or collision-suffixed branch keeps its PR.
                ...buildSourcePrOptions(sourcePr),
              });

              if (!created?.worktreeId) {
                throw new Error("Failed to create worktree: no ID returned");
              }

              worktreeId = created.worktreeId;
              worktreePath = path;
              // The branch the host landed on. In PR mode that is normally
              // the PR's head ref verbatim, but the host owns collision
              // handling and this is the only race-free way to know.
              resolvedBranch = created.branch;
            } else {
              // Issue mode: create new branch from base. Branch name and
              // path were resolved once in the pre-query phase; fall back
              // to a live lookup only for items that had no pre-query
              // result (e.g., retry after a worktree-store-detected
              // short-circuit branch was later removed).
              // Captured when this run started, so a pick made after the
              // run began can't move items still in the queue.
              if (!runBase) throw new Error("No base branch to create from");

              const pre = precomputed.get(itemNumber);
              const availableBranch =
                pre?.branch ??
                (await worktreeClient.getAvailableBranch(rootPath, planned.branchName));
              const path =
                pre?.path ?? (await worktreeClient.getDefaultPath(rootPath, availableBranch));

              // create() has no abort API, so this is the last chance to
              // keep a cancelled item from putting a worktree on disk.
              if (rt.generation !== gen) return;

              const created = await createWorktree({
                baseBranch: runBase.name,
                newBranch: availableBranch,
                path,
                fromRemote: runBase.fromRemote,
                useExistingBranch: false,
              });

              if (!created?.worktreeId) {
                throw new Error("Failed to create worktree: no ID returned");
              }

              worktreeId = created.worktreeId;
              worktreePath = path;
              // The branch the HOST landed on, not the name proposed above:
              // `getAvailableBranch` reserves nothing, so a bulk run racing
              // itself can have the host suffix past the candidate.
              resolvedBranch = created.branch;
              if (planned.mode === "issue" && "assignees" in planned.item) {
                linkProviderIssue(created.worktreeId, planned.item);
              }
            }

            tracking.set(itemNumber, {
              worktreeId,
              worktreePath: worktreePath!,
              resolvedBranch: resolvedBranch!,
              ...newTerminalTracking(),
            });

            dispatch({
              type: "ITEM_WORKTREE_CREATED",
              issueNumber: itemNumber,
              worktreeId,
              worktreePath: worktreePath!,
              branch: resolvedBranch!,
            });
          } else if (!tracked?.worktreeId) {
            tracking.set(itemNumber, {
              ...(tracked ?? newTerminalTracking()),
              worktreeId,
              worktreePath: worktreePath!,
              resolvedBranch: resolvedBranch!,
            });
            dispatch({
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
          if (rt.generation !== gen) return;

          // Step 2: Clone layout or run recipe. The first launch starts every
          // entry; after that only the entries still failed launch again, so
          // a retry never duplicates a terminal that is already running. A
          // fully healthy item (an assignment-only retry) launches nothing.
          const launchTracked = tracking.get(itemNumber);
          const pendingIndices = launchTracked?.terminalsLaunched
            ? launchTracked.failedTerminalIndices
            : undefined;
          const launchNeeded = pendingIndices === undefined || pendingIndices.length > 0;
          if (launchNeeded && cloneTerminals && worktreePath && worktreeId) {
            dispatch({
              type: "ITEM_TERMINALS_SPAWNING",
              issueNumber: itemNumber,
            });
            const launchIndices = pendingIndices ?? cloneTerminals.map((_, index) => index);
            const spawned: Array<{ index: number; terminalId: string }> = [];
            const failedIndices: number[] = [];
            await spawnPanelsFromRecipe({
              terminals: launchIndices.map((index) => cloneTerminals[index]!),
              worktreeId,
              cwd: worktreePath,
              agentSettings: cloneAgentSettings,
              clipboardDirectory: cloneClipboardDirectory,
              signal: rt.controller.signal,
              // Indices come back relative to the subset passed in.
              onPanelSpawned: (subsetIndex, panelId, _error) => {
                const index = launchIndices[subsetIndex]!;
                if (panelId != null) {
                  spawned.push({ index, terminalId: panelId });
                } else {
                  failedIndices.push(index);
                }
              },
            });
            // An aborted spawn reports no failures, just fewer panels, so a
            // cancelled run must not read its partial result as an outcome.
            if (rt.generation !== gen) return;
            const updatedTracked = tracking.get(itemNumber);
            if (updatedTracked) recordTerminalLaunch(updatedTracked, spawned, failedIndices);
            dispatch({
              type: "ITEM_TERMINALS_RESULT",
              issueNumber: itemNumber,
              spawnedTerminalIds: spawned.map((s) => s.terminalId),
              failedTerminalIndices: failedIndices,
            });

            if (failedIndices.length > 0) {
              const errorMsg = `${failedIndices.length} terminal(s) failed to spawn`;
              failedItems.add(itemNumber);
              dispatch({
                type: "ITEM_FAILED",
                issueNumber: itemNumber,
                error: errorMsg,
                attempts: attempt,
                failedStep: "terminals",
              });
              return;
            }
          } else if (
            launchNeeded &&
            input.recipeId &&
            input.recipeId !== CLONE_LAYOUT_ID &&
            worktreePath &&
            worktreeId
          ) {
            dispatch({
              type: "ITEM_TERMINALS_SPAWNING",
              issueNumber: itemNumber,
            });

            const recipeContext =
              planned.mode === "pr"
                ? { worktreePath, branchName: resolvedBranch!, prNumber: itemNumber }
                : { worktreePath, branchName: resolvedBranch!, issueNumber: itemNumber };

            // Pinned in the same tick as the launch that resolves it, so the
            // pin is the recipe this item actually ran; a relaunch by index
            // after an edit is refused rather than starting other entries.
            const pinTracked = tracking.get(itemNumber);
            if (pinTracked && !pinTracked.launchedRecipe) {
              const resolved = useRecipeStore.getState().getRecipeById(input.recipeId);
              if (resolved) {
                pinTracked.launchedRecipe = {
                  id: resolved.id,
                  terminalsDigest: recipeApprovalDigest(resolved.terminals),
                };
              }
            }
            const results: RecipeSpawnResults = await useRecipeStore
              .getState()
              .runRecipeWithResults(input.recipeId, worktreePath, worktreeId, recipeContext, {
                terminalIndices: pendingIndices,
                spawnBatch: recipeSpawnBatches.get(itemNumber),
                ...(pinTracked?.launchedRecipe
                  ? { expectedRecipe: pinTracked.launchedRecipe }
                  : {}),
              });

            // Defence in depth: the assignment and success gates below
            // already stop a cancelled run, but returning here keeps a
            // dead run from writing tracking and reducer state on its way
            // out, matching every other checkpoint in this loop.
            if (rt.generation !== gen) return;

            // Recorded before any transient backoff, so the next attempt
            // relaunches only what is still failed.
            const failedIndices = results.failed.map((f) => f.index);
            const updatedTracked = tracking.get(itemNumber);
            if (updatedTracked) {
              recordTerminalLaunch(updatedTracked, results.spawned, failedIndices);
            }

            dispatch({
              type: "ITEM_TERMINALS_RESULT",
              issueNumber: itemNumber,
              spawnedTerminalIds: results.spawned.map((s) => s.terminalId),
              failedTerminalIndices: failedIndices,
            });

            if (results.failed.length > 0) {
              const hasTransient = results.failed.some((f) => isTransientError(f.error));
              const remaining = MAX_TRANSIENT_RETRY_MS - (performance.now() - itemStart);
              if (hasTransient && remaining > 0) {
                backoffDelay = nextBackoffDelay(backoffDelay);
                await cancellableDelay(
                  Math.min(backoffDelay, remaining),
                  () => rt.generation !== gen
                );
                continue;
              }
              const errorMsg = `${results.failed.length} terminal(s) failed to spawn`;
              failedItems.add(itemNumber);
              dispatch({
                type: "ITEM_FAILED",
                issueNumber: itemNumber,
                error: errorMsg,
                attempts: attempt,
                failedStep: "terminals",
              });
              return;
            }
          }

          // Step 3: Issue assignment (issues only).
          // Retries transient failures using the same helpers as the outer loop, but
          // with an isolated 60s backoff cap so the assignment endpoint's secondary
          // rate limit (~60s) doesn't widen worktree/terminal retry delays.
          if (planned.mode === "issue" && input.assignToSelf && itemNumber) {
            // The dialog's lookup normally has the viewer by now; one closed
            // before its lookup landed leaves the run to look for itself.
            const known = input.getViewer();
            const viewer = known === undefined ? await lookUpViewer(rt, rootPath) : known;
            if (rt.generation !== gen) return;
            const username = viewer?.login;
            // Snap the avatar alongside the login before any async work so
            // the optimistic cache entry matches the user we assign to,
            // mirroring the single-create flow (#10529).
            const assignAvatarUrl = viewer?.avatarUrl;
            if (username) {
              dispatch({
                type: "ITEM_ASSIGNING",
                issueNumber: itemNumber,
              });
              let assignBackoff = BACKOFF_BASE_MS;
              let assignAttempt = 0;
              while (true) {
                if (rt.generation !== gen) return;
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
                      () => rt.generation !== gen
                    );
                    continue;
                  }
                  failedItems.add(itemNumber);
                  dispatch({
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

          if (rt.generation !== gen) return;

          succeededItems.add(itemNumber);
          dispatch({ type: "ITEM_SUCCEEDED", issueNumber: itemNumber });
          return;
        } catch (err) {
          if (rt.generation !== gen) return;
          const errorMsg = normalizeError(err);

          const remaining = MAX_TRANSIENT_RETRY_MS - (performance.now() - itemStart);
          if (isTransientError(errorMsg) && remaining > 0) {
            backoffDelay = nextBackoffDelay(backoffDelay);
            await cancellableDelay(Math.min(backoffDelay, remaining), () => rt.generation !== gen);
            continue;
          }

          failedItems.add(itemNumber);
          dispatch({
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
  if (rt.generation !== gen) return;
  // Identity-guarded so a run that went stale mid-await can't null out the
  // refs belonging to the run that replaced it.
  if (rt.queue === queue) rt.queue = null;

  // Post-batch verification: check terminal health for current run items only
  if (input.recipeId) {
    const verificationPanelIds = [...tracking]
      .filter(
        ([itemNumber, tracked]) =>
          currentRunItems.has(itemNumber) &&
          !failedItems.has(itemNumber) &&
          tracked.failedTerminalIndices.length === 0
      )
      .flatMap(([, tracked]) => [...tracked.terminalIdByIndex.values()]);
    await waitForPanelSpawns(verificationPanelIds, VERIFICATION_SPAWN_WAIT_MS);
    await delay(VERIFICATION_EXIT_SETTLE_MS);
    if (rt.generation !== gen) return;

    const { panelsById } = usePanelStore.getState();

    for (const [itemNumber, tracked] of tracking) {
      if (!currentRunItems.has(itemNumber)) continue;
      // Items that already failed (e.g. assignment) must not get their
      // ITEM_FAILED dispatch overwritten by a verification check.
      if (failedItems.has(itemNumber)) continue;
      if (!tracked.worktreeId || tracked.terminalIdByIndex.size === 0) continue;
      if (tracked.failedTerminalIndices.length > 0) continue;

      const crashedIndices: number[] = [];
      for (const [index, tid] of tracked.terminalIdByIndex) {
        const t = panelsById[tid];
        if (t && exitedNonZero(t)) crashedIndices.push(index);
      }
      const crashedCount = crashedIndices.length;

      if (crashedCount > 0) {
        // Marked as failed entries so Retry relaunches only these.
        tracked.failedTerminalIndices = crashedIndices;
        succeededItems.delete(itemNumber);
        failedItems.add(itemNumber);
        dispatch({ type: "ITEM_VERIFYING", issueNumber: itemNumber });
        dispatch({
          type: "ITEM_FAILED",
          issueNumber: itemNumber,
          error: `${crashedCount} terminal(s) crashed after spawn`,
          attempts: 1,
          failedStep: "verification",
        });
      }
    }
  }

  // The selection stays where the user left it: a batch that ends while they
  // work elsewhere must not move them (#17086). Each worktree is one click
  // away in the toolbar's run detail instead.
  dispatch({ type: "DONE" });
}
