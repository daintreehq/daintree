import { access } from "fs/promises";
import type { WslGitInvocation } from "../utils/hardenedGit.js";
import type PQueue from "p-queue";
import type { WorktreeChanges } from "../../shared/types/git.js";
import type {
  Worktree,
  WorktreeMood,
  WorktreeLifecycleStatus,
  WorktreeLifecyclePhaseResult,
  WslGitEligibility,
} from "../../shared/types/worktree.js";
import type { CIStatusState } from "../../shared/types/forge.js";
import type { WorktreeSnapshot } from "../../shared/types/workspace-host.js";
import { invalidateGitStatusCache } from "../utils/git.js";
import { AdaptivePollingStrategy, NoteFileReader } from "../services/worktree/index.js";
import { deriveIssueTitleFromBranch } from "../services/issueExtractor.js";
import { FetchScheduler, type FetchSchedulerHost } from "./FetchScheduler.js";
import { ResourcePollTimer, type ResourcePollTimerHost } from "./ResourcePollTimer.js";
import { WatcherController, type WatcherControllerHost } from "./WatcherController.js";
import { SnapshotBuilder, type SnapshotBuilderHost } from "./SnapshotBuilder.js";
import { StatPrecheck, type StatPrecheckHost } from "./StatPrecheck.js";
import { BaseDivergence, type BaseDivergenceHost } from "./BaseDivergence.js";
import { GitStatusPass, type GitStatusPassHost } from "./GitStatusPass.js";
import { withTimeout } from "../utils/withTimeout.js";

// Hard ceiling for individual filesystem syscalls on the poll path. On a
// healthy disk these return in well under a millisecond; on a stalled mount
// (disconnected NFS/SMB, sleeping external drive) they would otherwise block
// forever with no abort, pinning a libuv threadpool slot. Passed as an
// AbortSignal so the syscall is actually cancelled, not merely abandoned.
const FS_OP_TIMEOUT_MS = 5_000;

// Backstop watchdog around a full git-status pass. The git calls inside carry a
// 30s simple-git block timeout and the fs calls are bounded above, so a normal
// pass settles well under this; the watchdog only catches an await we didn't
// individually bound, guaranteeing the poll loop always reschedules.
const POLL_WATCHDOG_TIMEOUT_MS = 40_000;
const RESOURCE_POLL_DEFAULT_ACTIVE_MS = 30_000;
const RESOURCE_POLL_DEFAULT_BACKGROUND_MS = 300_000;
const HEARTBEAT_GAP_MULTIPLIER = 3;
const HEARTBEAT_GAP_FLOOR_MS = 30_000;
// Cap on the heartbeat-gap stale threshold. Keeps suspend/wake detection
// bounded as the base poll interval grows: with the 300s watcher-fallback
// cadence the raw 3x threshold would balloon to 900s. The ceiling must sit
// above the largest base interval (300s) so a normal heartbeat fire on a
// quiet repo doesn't false-positive — 360s leaves ~60s of headroom for
// timer drift past the expected fire time.
const HEARTBEAT_GAP_CEILING_MS = 360_000;
// Startup jitter for the initial git-status poll. Mirrors the
// FETCH_INITIAL_DELAY_* pattern in FetchScheduler so N background monitors
// starting together don't all fire updateGitStatus at t=0. Foreground
// (isCurrent=true) monitors still run immediately so the active card has
// fresh data on app launch.
const STATUS_INITIAL_DELAY_MIN_MS = 2_000;
const STATUS_INITIAL_DELAY_MAX_MS = 5_000;

function randomBetween(minMs: number, maxMs: number): number {
  if (maxMs <= minMs) return minMs;
  return minMs + Math.floor(Math.random() * (maxMs - minMs));
}

export interface WorktreeMonitorConfig {
  basePollingInterval: number;
  adaptiveBackoff: boolean;
  pollIntervalMax: number;
  circuitBreakerThreshold: number;
  gitWatchEnabled?: boolean;
  gitWatchDebounceMs?: number;
  fetchIntervalActiveMs?: number;
  fetchIntervalBackgroundMs?: number;
}

export interface WorktreeMonitorCallbacks {
  onUpdate: (snapshot: WorktreeSnapshot) => void;
  onRemoved?: (worktreeId: string) => void;
  onError?: (worktreeId: string, error: Error) => void;
  onBranchChanged?: (worktreeId: string, newBranch: string) => void;
  onExternalRemoval?: (worktreeId: string) => void;
  onResourceStatusPoll?: (worktreeId: string) => Promise<unknown> | void;
  onInotifyLimitReached?: (worktreeId: string) => void;
  onEmfileLimitReached?: (worktreeId: string) => void;
  onWatcherRecovered?: (worktreeId: string) => void;
  /**
   * Schedule a background `git fetch` for this worktree's repo. Routed through
   * `WorkspaceService` so per-repo serialization and failure-cache state are
   * shared across sibling monitors. Resolves regardless of fetch outcome.
   * `force` bypasses the per-repo failure cache (manual user-triggered refresh).
   */
  onScheduleFetch?: (
    worktreeId: string,
    isCurrent: boolean,
    force: boolean
  ) => Promise<void> | void;
}

export class WorktreeMonitor {
  readonly id: string;
  readonly path: string;

  private _name: string;
  private _branch: string | undefined;
  private _gitDir: string | undefined;
  private _isCurrent: boolean;
  // True while an agent is actively producing work in this worktree (set by
  // WorkspaceService from the renderer's agent-activity broadcast). Feeds the
  // elevation tier alongside `_isCurrent` so agent worktrees keep recursive
  // working-tree watching while backgrounded.
  private _agentActive: boolean = false;
  private _isMainWorktree: boolean;

  // State — `worktreeChanges`/`mood`/`summary` stay here (written from
  // `poll()`/`scheduleNextPoll()` too, not just the git-status pass); the
  // rest of the pass's output (modifiedCount, notes, plan file, upstream and
  // base-branch divergence, activity timestamp) is owned by `gitStatusPass`.
  private worktreeChanges: WorktreeChanges | null = null;
  private mood: WorktreeMood = "stable";
  private summary: string | undefined;

  // Issue/PR state
  private _issueNumber: number | undefined;
  private prNumber: number | undefined;
  private prUrl: string | undefined;
  private prState: import("../../shared/types/forge.js").NormalizedPRState | undefined;
  private prCiStatus: CIStatusState | undefined;
  private prTitle: string | undefined;
  private issueTitle: string | undefined;
  private _branchDerivedTitle: string | undefined;
  private _sourcePrNumber: number | undefined;
  private prLastUpdatedAt: number | undefined;
  private issueLastUpdatedAt: number | undefined;

  // Provider-agnostic forge linkage (populated alongside legacy fields).
  // Tri-state: `undefined` = PR service hasn't run yet (renderer preserves
  // its prior value), `null` = ran and found no link (clears renderer),
  // object = linked. Initial `undefined` avoids racing `pr-detected` state
  // the renderer holds from a prior session.
  private _linked: import("../../shared/types/plugin.js").PluginWorktreeLinked | null | undefined =
    undefined;

  // Polling state
  private pollingTimer: NodeJS.Timeout | null = null;
  private resumeTimer: NodeJS.Timeout | null = null;
  private _isRunning: boolean = false;
  private _isUpdating: boolean = false;
  private pollingEnabled: boolean = true;
  private _hasInitialStatus: boolean = false;

  // File watcher state — owned by `watcherController`. The remaining fields
  // here are inputs to the controller's host interface (read by the watcher
  // but written by the monitor or its callers).
  private readonly watcherController: WatcherController;
  private gitWatchEnabled: boolean;
  // Per-view budget gate layered on top of `gitWatchEnabled`. When the
  // WorkspaceService LRU evicts this (background) worktree past the watcher
  // cap, it sets this false; the combined `gitWatchEnabled && gitWatchBudgetAllowed`
  // signal the watcher controller observes then stops the watcher and the
  // monitor falls back to adaptive polling. Always true for the focused
  // worktree (which is never counted against the cap).
  private gitWatchBudgetAllowed: boolean = true;
  private gitWatchDebounceMs: number;
  private lastGitStatusCompletedAt: number = 0;
  // Stamped by the watcher's onTriggerUpdate hook before a forced refresh
  // fires. The stat pre-check compares against `lastStatBaselineAt` to know
  // whether an event arrived since the baseline was captured — if so, the
  // skip is invalid and we must run the full git check.
  private lastWatcherEventAt: number = 0;
  // Timer used to defer the initial `updateGitStatus` call for background
  // monitors so N monitors starting together don't fork git simultaneously.
  // Cleared by `clearTimers()` so `stop()` cancels the deferred poll.
  private initialStatusTimer: NodeJS.Timeout | null = null;

  // Extra state
  private _createdAt: number | undefined;
  private _lifecycleStatus: WorktreeLifecycleStatus | undefined;
  // Accumulated per-phase teardown results. Lifecycle owned by
  // WorktreeLifecycleService.runLifecycleTeardown (cleared at run start, upserted
  // per phase) so a later phase no longer overwrites an earlier phase's outcome.
  private _lifecyclePhaseResults: WorktreeLifecyclePhaseResult[] = [];

  // Git operation state
  private _isDetached: boolean = false;
  private _head: string | undefined;
  private _repoState: import("../../shared/types/git.js").RepoState | undefined;

  // Previously emitted git state for change detection (avoid suppressing
  // detached↔branch transitions that don't touch file state).
  private _prevEmittedIsDetached: boolean = false;
  private _prevEmittedHead: string | undefined;
  private _prevEmittedRepoState: import("../../shared/types/git.js").RepoState | undefined;

  // Resource state
  private _resourceStatus:
    | import("../../shared/types/worktree.js").WorktreeResourceStatus
    | undefined;
  private _resourceConnectCommand: string | undefined;
  private _resourceProvider: string | undefined;
  private _hasResourceConfig: boolean = false;
  private _hasStatusCommand: boolean = false;
  private _hasPauseCommand: boolean = false;
  private _hasResumeCommand: boolean = false;
  private _hasTeardownCommand: boolean = false;
  private _hasProvisionCommand: boolean = false;
  private _worktreeMode: string = "local";
  private _worktreeEnvironmentLabel: string | undefined;

  // Resource status auto-polling — owned by `resourcePollTimer`.
  private readonly resourcePollTimer: ResourcePollTimer;
  private resourcePollIntervalMs: number = 0; // 0 = disabled
  // True when a recipe / config supplied an explicit `statusInterval`. Guards
  // the focus-flip auto-adapt in the `isCurrent` setter so user values aren't
  // silently overwritten when they happen to equal a default constant.
  private resourcePollIntervalExplicit: boolean = false;

  // Background fetch scheduler — separate from the local-status poll so a
  // stuck remote can't poison local-status updates. Cadence flips based on
  // `_isCurrent`; rescheduling happens in the `isCurrent` setter.
  private readonly fetchScheduler: FetchScheduler;

  // Fetch freshness state — surfaced to the renderer via the snapshot so the
  // worktree card can show "Last fetched X ago", an in-flight pulse, and an
  // auth-failure affordance. `_lastFetchedAt` and `_fetchAuthFailed` are
  // pushed in via `setFetchState` from `WorkspaceService` (which receives
  // them on every coordinator round-trip and fans them out to siblings
  // sharing the commondir). `_remoteFetchUrl` is probed once at monitor
  // start; `_matchedForgeProviderId` is resolved from it against the relayed
  // provider-matcher table and re-resolved whenever the table changes.
  private _lastFetchedAt: number | null = null;
  private _fetchAuthFailed: boolean = false;
  private _fetchNetworkFailed: boolean = false;
  private _remoteFetchUrl: string | undefined;
  private _matchedForgeProviderId: string | null = null;

  // Poll queue concurrency
  private _pendingPollPromise: Promise<void> | null = null;
  private _pollAbortController: AbortController = new AbortController();

  // WSL routing state (Windows only)
  private _isWslPath: boolean = false;
  private _wslDistro: string | undefined;
  private _wslGitEligible: WslGitEligibility = "unprobed";
  private _wslGitOptIn: boolean = false;
  private _wslGitDismissed: boolean = false;
  private _wslPosixPath: string | undefined;

  // Components
  private pollingStrategy: AdaptivePollingStrategy;
  private noteReader: NoteFileReader;
  private pollQueue?: PQueue;
  private readonly snapshotBuilder: SnapshotBuilder;
  private readonly statPrecheck: StatPrecheck;
  private readonly baseDivergence: BaseDivergence;
  private readonly gitStatusPass: GitStatusPass;

  // Test-only backdoors preserving pre-split field access onto the stat
  // baseline cache StatPrecheck now owns for real callers. Not private: the
  // only caller is a type-erased `(monitor as unknown as {...})` cast in
  // WorktreeMonitor.test.ts, which tsc's unused-private-member check can't
  // see — declaring these public keeps that check from flagging them dead.
  get lastStatBaselineAt(): number {
    return this.statPrecheck.baselineCapturedAt;
  }
  set lastFullStatusAt(value: number) {
    this.statPrecheck.fullStatusCapturedAt = value;
  }

  constructor(
    worktree: Worktree,
    private config: WorktreeMonitorConfig,
    private callbacks: WorktreeMonitorCallbacks,
    private mainBranch: string,
    pollQueue?: PQueue
  ) {
    this.id = worktree.id;
    this.path = worktree.path;
    this._name = worktree.name;
    this._branch = worktree.branch;
    this._branchDerivedTitle = worktree.branch
      ? deriveIssueTitleFromBranch(worktree.branch)
      : undefined;
    this._gitDir = worktree.gitDir;
    this._isCurrent = worktree.isCurrent;
    this._isMainWorktree = Boolean(worktree.isMainWorktree);
    this._isDetached = Boolean(worktree.isDetached);
    this._head = worktree.head;
    this.gitWatchEnabled = config.gitWatchEnabled ?? true;
    this.gitWatchDebounceMs = config.gitWatchDebounceMs ?? 100;
    this.pollQueue = pollQueue;

    this.pollingStrategy = new AdaptivePollingStrategy({
      baseInterval: config.basePollingInterval,
    });
    this.pollingStrategy.updateConfig(
      config.adaptiveBackoff,
      config.pollIntervalMax,
      config.circuitBreakerThreshold
    );

    this.noteReader = new NoteFileReader(worktree.path);

    // Each controller's host is a thin live-getter view onto monitor state.
    // Aliasing `this` keeps the getter syntax compact (object-literal
    // getters can't be arrow functions, and we need a fresh read on each
    // access).
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const monitor = this;
    const fetchHost: FetchSchedulerHost = {
      get isRunning() {
        return monitor._isRunning;
      },
      get isCurrent() {
        return monitor._isCurrent;
      },
      get hasInitialStatus() {
        return monitor._hasInitialStatus;
      },
      get hasFetchCallback() {
        return Boolean(monitor.callbacks.onScheduleFetch);
      },
      onExecuteFetch: (force: boolean) => {
        const cb = monitor.callbacks.onScheduleFetch;
        if (!cb) return;
        return cb(monitor.id, monitor._isCurrent, force);
      },
      onUpdate: () => monitor.emitUpdate(),
    };
    this.fetchScheduler = new FetchScheduler(fetchHost);

    const resourceHost: ResourcePollTimerHost = {
      get isRunning() {
        return monitor._isRunning;
      },
      get hasResourceConfig() {
        return monitor._hasResourceConfig;
      },
      get hasStatusCommand() {
        return monitor._hasStatusCommand;
      },
      get resourcePollIntervalMs() {
        return monitor.resourcePollIntervalMs;
      },
      get worktreeId() {
        return monitor.id;
      },
      onResourceStatusPoll: (worktreeId: string) =>
        monitor.callbacks.onResourceStatusPoll?.(worktreeId),
    };
    this.resourcePollTimer = new ResourcePollTimer(resourceHost);

    const watcherHost: WatcherControllerHost = {
      get isRunning() {
        return monitor._isRunning;
      },
      get isElevated() {
        return monitor._isCurrent || monitor._agentActive;
      },
      get gitWatchEnabled() {
        // Combined gate: the per-view watcher budget can suppress the watcher
        // for an evicted background worktree without touching the user/config
        // `gitWatchEnabled` flag. The controller observes only this single
        // signal, so budget enforcement stays transparent to it.
        return monitor.gitWatchEnabled && monitor.gitWatchBudgetAllowed;
      },
      get gitWatchDebounceMs() {
        return monitor.gitWatchDebounceMs;
      },
      get worktreeId() {
        return monitor.id;
      },
      get worktreePath() {
        return monitor.path;
      },
      get branch() {
        return monitor._branch;
      },
      get isUpdating() {
        return monitor._isUpdating;
      },
      get lastGitStatusCompletedAt() {
        return monitor.lastGitStatusCompletedAt;
      },
      onTriggerUpdate: () => {
        // Stamp the watcher event time before triggering so the stat
        // pre-check on the next timed poll knows to invalidate any baseline
        // captured before this event.
        monitor.lastWatcherEventAt = Date.now();
        monitor.pollingStrategy.recordStateChange();
        void monitor.updateGitStatus(true);
      },
      onInotifyLimitReached: (worktreeId: string) =>
        monitor.callbacks.onInotifyLimitReached?.(worktreeId),
      onEmfileLimitReached: (worktreeId: string) =>
        monitor.callbacks.onEmfileLimitReached?.(worktreeId),
      onWatcherRecovered: () => monitor.callbacks.onWatcherRecovered?.(monitor.id),
    };
    this.watcherController = new WatcherController(watcherHost);

    const snapshotHost: SnapshotBuilderHost = {
      get id() {
        return monitor.id;
      },
      get path() {
        return monitor.path;
      },
      get name() {
        return monitor._name;
      },
      get branch() {
        return monitor._branch;
      },
      get isCurrent() {
        return monitor._isCurrent;
      },
      get isMainWorktree() {
        return monitor._isMainWorktree;
      },
      get gitDir() {
        return monitor._gitDir;
      },
      get summary() {
        return monitor.summary;
      },
      get modifiedCount() {
        return monitor.gitStatusPass.modifiedCount;
      },
      get mood() {
        return monitor.mood;
      },
      get lastActivityTimestamp() {
        return monitor.gitStatusPass.lastActivityTimestamp;
      },
      get createdAt() {
        return monitor._createdAt;
      },
      get aiNote() {
        return monitor.gitStatusPass.aiNote;
      },
      get aiNoteTimestamp() {
        return monitor.gitStatusPass.aiNoteTimestamp;
      },
      get issueNumber() {
        return monitor._issueNumber;
      },
      get prNumber() {
        return monitor.prNumber;
      },
      get prUrl() {
        return monitor.prUrl;
      },
      get prState() {
        return monitor.prState;
      },
      get prCiStatus() {
        return monitor.prCiStatus;
      },
      get prTitle() {
        return monitor.prTitle;
      },
      get issueTitle() {
        return monitor.issueTitle;
      },
      get branchDerivedTitle() {
        return monitor._branchDerivedTitle;
      },
      get sourcePrNumber() {
        return monitor._sourcePrNumber;
      },
      get prLastUpdatedAt() {
        return monitor.prLastUpdatedAt;
      },
      get issueLastUpdatedAt() {
        return monitor.issueLastUpdatedAt;
      },
      get worktreeChanges() {
        return monitor.worktreeChanges;
      },
      get lifecycleStatus() {
        return monitor._lifecycleStatus;
      },
      get lifecyclePhaseResults() {
        return monitor._lifecyclePhaseResults;
      },
      get resourceStatus() {
        return monitor._resourceStatus;
      },
      get resourceConnectCommand() {
        return monitor._resourceConnectCommand;
      },
      get resourceProvider() {
        return monitor._resourceProvider;
      },
      get hasResourceConfig() {
        return monitor._hasResourceConfig;
      },
      get hasStatusCommand() {
        return monitor._hasStatusCommand;
      },
      get hasPauseCommand() {
        return monitor._hasPauseCommand;
      },
      get hasResumeCommand() {
        return monitor._hasResumeCommand;
      },
      get hasTeardownCommand() {
        return monitor._hasTeardownCommand;
      },
      get hasProvisionCommand() {
        return monitor._hasProvisionCommand;
      },
      get worktreeMode() {
        return monitor._worktreeMode;
      },
      get worktreeEnvironmentLabel() {
        return monitor._worktreeEnvironmentLabel;
      },
      get hasPlanFile() {
        return monitor.gitStatusPass.hasPlanFile;
      },
      get planFilePath() {
        return monitor.gitStatusPass.planFilePath;
      },
      get aheadCount() {
        return monitor.gitStatusPass.aheadCount;
      },
      get behindCount() {
        return monitor.gitStatusPass.behindCount;
      },
      get baseBranchName() {
        return monitor.gitStatusPass.baseBranchName;
      },
      get baseAheadCount() {
        return monitor.gitStatusPass.baseAheadCount;
      },
      get baseBehindCount() {
        return monitor.gitStatusPass.baseBehindCount;
      },
      get baseMatchesUpstream() {
        return monitor.gitStatusPass.baseMatchesUpstream;
      },
      get lastFetchedAt() {
        return monitor._lastFetchedAt;
      },
      get lastGitStatusCheckedAt() {
        return monitor.lastGitStatusCompletedAt;
      },
      get fetchAuthFailed() {
        return monitor._fetchAuthFailed;
      },
      get fetchNetworkFailed() {
        return monitor._fetchNetworkFailed;
      },
      get isFetchInFlight() {
        return monitor.fetchScheduler.isFetchInFlight;
      },
      get matchedForgeProviderId() {
        return monitor._matchedForgeProviderId;
      },
      get isWslPath() {
        return monitor._isWslPath;
      },
      get wslDistro() {
        return monitor._wslDistro;
      },
      get wslPosixPath() {
        return monitor._wslPosixPath;
      },
      get wslGitEligible() {
        return monitor._wslGitEligible;
      },
      get wslGitOptIn() {
        return monitor._wslGitOptIn;
      },
      get wslGitDismissed() {
        return monitor._wslGitDismissed;
      },
      get linked() {
        return monitor._linked;
      },
      get repoState() {
        return monitor._repoState;
      },
      get isDetached() {
        return monitor._isDetached;
      },
      get head() {
        return monitor._head;
      },
    };
    this.snapshotBuilder = new SnapshotBuilder(snapshotHost);

    const statPrecheckHost: StatPrecheckHost = {
      get abortSignal() {
        return monitor._pollAbortController.signal;
      },
      get branch() {
        return monitor._branch;
      },
      get lastWatcherEventAt() {
        return monitor.lastWatcherEventAt;
      },
    };
    this.statPrecheck = new StatPrecheck(statPrecheckHost);

    const baseDivergenceHost: BaseDivergenceHost = {
      get branch() {
        return monitor._branch;
      },
      get isMainWorktree() {
        return monitor._isMainWorktree;
      },
      get mainBranch() {
        return monitor.mainBranch;
      },
      get linkedPrBaseRef() {
        return monitor._linked?.pr?.baseRef;
      },
      get path() {
        return monitor.path;
      },
      get wslInvocation() {
        return monitor.wslInvocation;
      },
      get abortSignal() {
        return monitor._pollAbortController.signal;
      },
    };
    this.baseDivergence = new BaseDivergence(baseDivergenceHost, this.statPrecheck);

    const gitStatusPassHost: GitStatusPassHost = {
      get id() {
        return monitor.id;
      },
      get path() {
        return monitor.path;
      },
      get name() {
        return monitor._name;
      },
      get mainBranch() {
        return monitor.mainBranch;
      },
      get isCurrent() {
        return monitor._isCurrent;
      },
      get isRunning() {
        return monitor._isRunning;
      },
      get basePollingInterval() {
        return monitor.config.basePollingInterval;
      },
      get wslInvocation() {
        return monitor.wslInvocation;
      },
      get abortSignal() {
        return monitor._pollAbortController.signal;
      },
      get prevEmittedIsDetached() {
        return monitor._prevEmittedIsDetached;
      },
      get prevEmittedHead() {
        return monitor._prevEmittedHead;
      },
      get prevEmittedRepoState() {
        return monitor._prevEmittedRepoState;
      },
      get hasInitialStatus() {
        return monitor._hasInitialStatus;
      },
      set hasInitialStatus(value: boolean) {
        monitor._hasInitialStatus = value;
      },
      get repoState() {
        return monitor._repoState;
      },
      set repoState(value) {
        monitor._repoState = value;
      },
      get lastGitStatusCompletedAt() {
        return monitor.lastGitStatusCompletedAt;
      },
      set lastGitStatusCompletedAt(value: number) {
        monitor.lastGitStatusCompletedAt = value;
      },
      get isUpdating() {
        return monitor._isUpdating;
      },
      set isUpdating(value: boolean) {
        monitor._isUpdating = value;
      },
      get branch() {
        return monitor._branch;
      },
      set branch(value: string | undefined) {
        monitor._branch = value;
      },
      get issueNumber() {
        return monitor._issueNumber;
      },
      set issueNumber(value: number | undefined) {
        monitor._issueNumber = value;
      },
      get branchDerivedTitle() {
        return monitor._branchDerivedTitle;
      },
      set branchDerivedTitle(value: string | undefined) {
        monitor._branchDerivedTitle = value;
      },
      get issueTitle() {
        return monitor.issueTitle;
      },
      set issueTitle(value: string | undefined) {
        monitor.issueTitle = value;
      },
      get isDetached() {
        return monitor._isDetached;
      },
      set isDetached(value: boolean) {
        monitor._isDetached = value;
      },
      get head() {
        return monitor._head;
      },
      set head(value: string | undefined) {
        monitor._head = value;
      },
      get mood() {
        return monitor.mood;
      },
      set mood(value: WorktreeMood) {
        monitor.mood = value;
      },
      get summary() {
        return monitor.summary;
      },
      set summary(value: string | undefined) {
        monitor.summary = value;
      },
      get worktreeChanges() {
        return monitor.worktreeChanges;
      },
      set worktreeChanges(value: WorktreeChanges | null) {
        monitor.worktreeChanges = value;
      },
      clearPRInfo: () => monitor.clearPRInfo(),
      onBranchChanged: (branch: string) => monitor.callbacks.onBranchChanged?.(monitor.id, branch),
      onRemoved: () => monitor.callbacks.onRemoved?.(monitor.id),
      stop: () => monitor.stop(),
      emitUpdate: () => monitor.emitUpdate(),
    };
    this.gitStatusPass = new GitStatusPass(
      gitStatusPassHost,
      this.statPrecheck,
      this.baseDivergence,
      this.watcherController,
      this.pollingStrategy,
      this.noteReader
    );

    this._isWslPath = Boolean(worktree.isWslPath);
    this._wslDistro = worktree.wslDistro;
    this._wslPosixPath = worktree.wslPosixPath;
    this._wslGitEligible = worktree.wslGitEligible ?? "unprobed";
    this._wslGitOptIn = Boolean(worktree.wslGitOptIn);
    this._wslGitDismissed = Boolean(worktree.wslGitDismissed);
  }

  /**
   * Build the WSL invocation passed to `createWslHardenedGit` /
   * `getWorktreeChangesWithStats({ wsl })`. Returns `undefined` when this
   * worktree should keep using the native git path: not on Windows, not a
   * WSL path, ineligible distro (not the default), or user hasn't opted in.
   */
  private get wslInvocation(): WslGitInvocation | undefined {
    if (process.platform !== "win32") return undefined;
    if (!this._isWslPath || this._wslGitEligible !== "eligible" || !this._wslGitOptIn)
      return undefined;
    if (!this._wslDistro || !this._wslPosixPath) return undefined;
    return {
      distro: this._wslDistro,
      uncPath: this.path,
      posixPath: this._wslPosixPath,
    };
  }

  /**
   * Update the WSL opt-in / dismissed state at runtime (called by the
   * workspace-host message handler). Re-emits a snapshot so the renderer's
   * banner state stays in sync.
   */
  setWslOptIn(enabled: boolean, dismissed: boolean): void {
    let changed = false;
    if (this._wslGitOptIn !== enabled) {
      this._wslGitOptIn = enabled;
      changed = true;
    }
    if (this._wslGitDismissed !== dismissed) {
      this._wslGitDismissed = dismissed;
      changed = true;
    }
    if (changed && this._hasInitialStatus) {
      this.emitUpdate();
    }
  }

  /**
   * Update the WSL git eligibility at runtime. Called by `WorkspaceService`
   * when the WSL default distro changes (background poll) or the user triggers
   * a re-probe. Re-emits a snapshot so the renderer banner reflects the new
   * state. Safe to flip while running: `createWslHardenedGit` is built per
   * invocation from the `wslInvocation` getter, so the next poll/fetch picks up
   * the routing change without swapping a stored git instance.
   */
  setWslEligible(eligibility: WslGitEligibility): void {
    if (this._wslGitEligible === eligibility) return;
    this._wslGitEligible = eligibility;
    if (this._hasInitialStatus) {
      this.emitUpdate();
    }
  }

  /** WSL routing inputs, read by `WorkspaceService` to recompute eligibility. */
  get isWslPath(): boolean {
    return this._isWslPath;
  }

  get wslDistro(): string | undefined {
    return this._wslDistro;
  }

  /**
   * Push the latest fetch outcome from `WorkspaceService` (sourced from the
   * coordinator's per-commondir state). `null` for `lastFetchedAt` means no
   * successful fetch has landed yet for this repo. Re-emits a snapshot when
   * either field actually changes so the renderer's tooltip/auth affordance
   * stay in sync without waiting for the next status poll.
   */
  setFetchState(
    lastFetchedAt: number | null,
    authFailed: boolean,
    networkFailed: boolean = false
  ): void {
    // Guard against ghost emits after stop(): the coordinator's fan-out call
    // may resolve after the monitor has been torn down (project switch,
    // worktree removal). Without this check, an emit would re-add a removed
    // worktree to the renderer's store via worktree-update.
    if (!this._isRunning) return;
    let changed = false;
    if (this._lastFetchedAt !== lastFetchedAt) {
      this._lastFetchedAt = lastFetchedAt;
      changed = true;
    }
    if (this._fetchAuthFailed !== authFailed) {
      this._fetchAuthFailed = authFailed;
      changed = true;
    }
    if (this._fetchNetworkFailed !== networkFailed) {
      this._fetchNetworkFailed = networkFailed;
      changed = true;
    }
    if (changed && this._hasInitialStatus) {
      this.emitUpdate();
    }
  }

  /**
   * Origin fetch URL probed once at monitor start by `WorkspaceService`.
   * Remembered so the matched provider id can be re-resolved without
   * re-probing git when the provider-matcher table changes.
   */
  get remoteFetchUrl(): string | undefined {
    return this._remoteFetchUrl;
  }

  setRemoteFetchUrl(url: string | undefined): void {
    if (!this._isRunning) return;
    this._remoteFetchUrl = url;
  }

  /**
   * Resolved when `WorkspaceService` matches the origin URL against the
   * relayed provider-matcher table — at monitor start and again on every
   * table change. Gates forge affordances ("Sign in to refresh", PR badge) —
   * unmatched remotes silently hide them even when an auth failure is
   * recorded.
   *
   * Guarded against post-stop emits: `probeForgeRemoteAsync` is a fire-and-
   * forget async call that may resolve after the monitor is torn down (e.g.
   * worktree removal, project switch). Without this check the late resolution
   * would emit a `worktree-update` after `worktree-removed`, re-adding a
   * ghost card to the renderer.
   */
  setMatchedForgeProviderId(value: string | null): void {
    if (!this._isRunning) return;
    if (this._matchedForgeProviderId === value) return;
    this._matchedForgeProviderId = value;
    if (this._hasInitialStatus) {
      this.emitUpdate();
    }
  }

  get name(): string {
    return this._name;
  }

  set name(value: string) {
    this._name = value;
  }

  get branch(): string | undefined {
    return this._branch;
  }

  set branch(value: string | undefined) {
    this._branch = value;
    this._branchDerivedTitle = value ? deriveIssueTitleFromBranch(value) : undefined;
  }

  get isCurrent(): boolean {
    return this._isCurrent;
  }

  set isCurrent(value: boolean) {
    const changed = this._isCurrent !== value;
    this._isCurrent = value;
    if (changed && this._hasResourceConfig && this._hasStatusCommand && this._isRunning) {
      // Only adapt if no explicit statusInterval was configured. Pre-PR this
      // was a value-equality check against the default constants; that
      // collided with explicit user values that happened to match a default
      // (e.g. `statusInterval: 300` matching the new 300s background default).
      if (!this.resourcePollIntervalExplicit) {
        this.resourcePollIntervalMs = value
          ? RESOURCE_POLL_DEFAULT_ACTIVE_MS
          : RESOURCE_POLL_DEFAULT_BACKGROUND_MS;
        this.clearResourcePollTimer();
        this.scheduleResourcePoll();
      }
    }
    // Re-tier the watcher granularity on focus change. Upgrades fire
    // immediately so the focused worktree gets the recursive watcher right
    // away; downgrades settle behind a short delay inside the controller to
    // absorb rapid focus toggles. Only re-derive poll cadence when the
    // controller actually rotated synchronously. Elevation combines focus
    // with agent activity, so losing focus while an agent works is a no-op.
    if (changed && this._isRunning && this.gitWatchEnabled) {
      const rotatedImmediately = this.watcherController.handleElevationChange(this.isElevated);
      if (rotatedImmediately && this.pollingTimer) {
        clearTimeout(this.pollingTimer);
        this.pollingTimer = null;
        this.scheduleNextPoll();
      }
    }
    // Focus gain resets the idle backoff: the user is looking at this
    // worktree now and expects the base cadence, even if the background
    // tier had backed off after a quiet stretch.
    if (changed && value && this._isRunning) {
      this.pollingStrategy.recordStateChange();
    }
    // Fetch cadence flips between focused (~30-45s) and background (5-10min)
    // based on `isCurrent`. Reschedule from the new tier the moment focus
    // changes so the user sees fresh counts shortly after switching to a
    // worktree that hadn't been actively fetched.
    if (changed && this._isRunning) {
      this.fetchScheduler.reschedule(true);
    }
  }

  get isElevated(): boolean {
    return this._isCurrent || this._agentActive;
  }

  get agentActive(): boolean {
    return this._agentActive;
  }

  /**
   * Marks whether an agent is actively producing work in this worktree.
   * Elevation (focus OR agent activity) drives watcher granularity, so a
   * background worktree with a working agent streams working-tree changes
   * like the focused one. Both edges also force a status refresh: on start
   * so the card baselines right away, on stop so the agent's final state
   * lands without waiting for a poll.
   */
  set agentActive(value: boolean) {
    const changed = this._agentActive !== value;
    this._agentActive = value;
    if (!changed || !this._isRunning) {
      return;
    }
    if (this.gitWatchEnabled) {
      const rotatedImmediately = this.watcherController.handleElevationChange(this.isElevated);
      if (rotatedImmediately && this.pollingTimer) {
        clearTimeout(this.pollingTimer);
        this.pollingTimer = null;
        this.scheduleNextPoll();
      }
    }
    if (value) {
      // Agent work incoming — reset the idle backoff so the poll fallback
      // returns to base cadence, mirroring the focus-gain path.
      this.pollingStrategy.recordStateChange();
    }
    if (this._hasInitialStatus) {
      this.triggerRefreshIfUpdating();
    }
  }

  get isMainWorktree(): boolean {
    return this._isMainWorktree;
  }

  set isMainWorktree(value: boolean) {
    this._isMainWorktree = value;
  }

  get isRunning(): boolean {
    return this._isRunning;
  }

  get hasInitialStatus(): boolean {
    return this._hasInitialStatus;
  }

  get issueNumber(): number | undefined {
    return this._issueNumber;
  }

  get createdAt(): number | undefined {
    return this._createdAt;
  }

  get lifecycleStatus(): WorktreeLifecycleStatus | undefined {
    return this._lifecycleStatus;
  }

  get hasWatcher(): boolean {
    return this.watcherController.hasWatcher;
  }

  /** True only once the watcher's async arm resolved — see WatcherController.watcherArmed. */
  get hasArmedWatcher(): boolean {
    return this.watcherController.watcherArmed;
  }

  setIssueNumber(issueNumber: number | undefined): void {
    this._issueNumber = issueNumber;
  }

  setIssueTitle(title: string | undefined): void {
    this.issueTitle = title;
  }

  setIssueLastUpdatedAt(ms: number | undefined): void {
    this.issueLastUpdatedAt = ms;
  }

  setPRTitle(title: string | undefined): void {
    this.prTitle = title;
  }

  setPRInfo(info: {
    prNumber?: number;
    prUrl?: string;
    prState?: import("../../shared/types/forge.js").NormalizedPRState;
    prCiStatus?: CIStatusState;
    prTitle?: string;
    issueTitle?: string;
    prLastUpdatedAt?: number;
    issueLastUpdatedAt?: number;
  }): void {
    this.prNumber = info.prNumber;
    this.prUrl = info.prUrl;
    this.prState = info.prState;
    // Full-replace semantics for prCiStatus: each PR detection carries the
    // current rollup state (or undefined when checks are absent), so we must
    // overwrite stale values rather than only updating when defined.
    this.prCiStatus = info.prCiStatus;
    if (info.prTitle !== undefined) this.prTitle = info.prTitle;
    if (info.issueTitle !== undefined) this.issueTitle = info.issueTitle;
    if (info.prLastUpdatedAt !== undefined) this.prLastUpdatedAt = info.prLastUpdatedAt;
    if (info.issueLastUpdatedAt !== undefined) this.issueLastUpdatedAt = info.issueLastUpdatedAt;
  }

  clearPRInfo(): void {
    this.prNumber = undefined;
    this.prUrl = undefined;
    this.prState = undefined;
    this.prCiStatus = undefined;
    this.prTitle = undefined;
    this.prLastUpdatedAt = undefined;
    // Drop the PR-originated discriminator too (#8888): clearing PR info means
    // the branch no longer maps to its source PR (branch rename, or detection
    // found no PR), so the inverted PR-title headline must not linger with a
    // stale number and no title.
    this._sourcePrNumber = undefined;
  }

  setLinked(linked: import("../../shared/types/plugin.js").PluginWorktreeLinked | null): void {
    this._linked = linked;
  }

  /**
   * Mark this worktree as PR-originated by recording the source PR number (#8888).
   * Set once at creation time from the PR-dropdown flow; immutable thereafter.
   * Drives the inverted PR-title-as-headline display in the worktree card.
   */
  setSourcePrNumber(prNumber: number | undefined): void {
    this._sourcePrNumber = prNumber;
  }

  /**
   * Update the repository's main/integration branch — the base-branch
   * divergence fallback used when this worktree has no linked PR. Called by
   * `syncMonitors` so existing monitors track a main-worktree branch switch.
   */
  setMainBranch(branch: string): void {
    this.mainBranch = branch;
  }

  clearLinked(): void {
    this._linked = null;
  }

  setCreatedAt(ms: number | undefined): void {
    this._createdAt = ms;
  }

  setLifecycleStatus(status: WorktreeLifecycleStatus | undefined): void {
    this._lifecycleStatus = status;
  }

  get lifecyclePhaseResults(): readonly WorktreeLifecyclePhaseResult[] {
    return this._lifecyclePhaseResults;
  }

  /** Reset the per-phase accumulator. Called at the start of a teardown run. */
  clearLifecyclePhaseResults(): void {
    this._lifecyclePhaseResults = [];
  }

  /**
   * Record a settled phase result. Upserts by `phase` so a re-entered phase
   * replaces its prior entry rather than duplicating, while distinct phases
   * (resource-teardown then teardown) both accumulate.
   */
  recordLifecyclePhaseResult(result: WorktreeLifecyclePhaseResult): void {
    const idx = this._lifecyclePhaseResults.findIndex((r) => r.phase === result.phase);
    if (idx >= 0) {
      this._lifecyclePhaseResults[idx] = result;
    } else {
      this._lifecyclePhaseResults.push(result);
    }
  }

  get resourceStatus():
    | import("../../shared/types/worktree.js").WorktreeResourceStatus
    | undefined {
    return this._resourceStatus;
  }

  setResourceStatus(
    status: import("../../shared/types/worktree.js").WorktreeResourceStatus | undefined
  ): void {
    this._resourceStatus = status;
  }

  get resourceConnectCommand(): string | undefined {
    return this._resourceConnectCommand;
  }

  setResourceConnectCommand(cmd: string | undefined): void {
    this._resourceConnectCommand = cmd;
  }

  get resourceProvider(): string | undefined {
    return this._resourceProvider;
  }

  setResourceProvider(provider: string | undefined): void {
    this._resourceProvider = provider;
  }

  get hasResourceConfig(): boolean {
    return this._hasResourceConfig;
  }

  setHasResourceConfig(has: boolean): void {
    this._hasResourceConfig = has;
    if (has && this._hasStatusCommand && this._isRunning) {
      if (this.resourcePollIntervalMs === 0) {
        this.applyDefaultResourcePollInterval();
      }
      this.scheduleResourcePoll();
    } else if (!has) {
      this.clearResourcePollTimer();
    }
  }

  get hasStatusCommand(): boolean {
    return this._hasStatusCommand;
  }

  get hasPauseCommand(): boolean {
    return this._hasPauseCommand;
  }

  setHasPauseCommand(has: boolean): void {
    this._hasPauseCommand = has;
  }

  get hasResumeCommand(): boolean {
    return this._hasResumeCommand;
  }

  setHasResumeCommand(has: boolean): void {
    this._hasResumeCommand = has;
  }

  get hasTeardownCommand(): boolean {
    return this._hasTeardownCommand;
  }

  setHasTeardownCommand(has: boolean): void {
    this._hasTeardownCommand = has;
  }

  get hasProvisionCommand(): boolean {
    return this._hasProvisionCommand;
  }

  setHasProvisionCommand(has: boolean): void {
    this._hasProvisionCommand = has;
  }

  setHasStatusCommand(has: boolean): void {
    this._hasStatusCommand = has;
    if (has && this._hasResourceConfig && this._isRunning) {
      // If no explicit interval was set, apply default based on isCurrent
      if (this.resourcePollIntervalMs === 0) {
        this.applyDefaultResourcePollInterval();
      }
      this.scheduleResourcePoll();
    } else if (!has) {
      this.clearResourcePollTimer();
    }
  }

  /**
   * Set the resource status polling interval in milliseconds.
   * 0 disables auto-polling. Reads from config.json `statusInterval` (seconds).
   */
  setResourcePollInterval(ms: number): void {
    this.resourcePollIntervalMs = ms;
    this.resourcePollIntervalExplicit = true;
    this.clearResourcePollTimer();
    if (ms > 0 && this._hasResourceConfig && this._isRunning) {
      this.scheduleResourcePoll();
    }
  }

  private applyDefaultResourcePollInterval(): void {
    if (this.resourcePollIntervalMs === 0) {
      this.resourcePollIntervalMs = this._isCurrent
        ? RESOURCE_POLL_DEFAULT_ACTIVE_MS
        : RESOURCE_POLL_DEFAULT_BACKGROUND_MS;
    }
  }

  private scheduleResourcePoll(): void {
    this.resourcePollTimer.schedule();
  }

  private clearResourcePollTimer(): void {
    this.resourcePollTimer.clear();
  }

  get worktreeMode(): string {
    return this._worktreeMode;
  }

  setWorktreeMode(mode: string): void {
    this._worktreeMode = mode;
  }

  get worktreeEnvironmentLabel(): string | undefined {
    return this._worktreeEnvironmentLabel;
  }

  setWorktreeEnvironmentLabel(label: string | undefined): void {
    this._worktreeEnvironmentLabel = label;
  }

  setMood(mood: WorktreeMood): void {
    this.mood = mood;
  }

  setSummary(summary: string | undefined): void {
    this.summary = summary;
  }

  updateConfig(config: Partial<WorktreeMonitorConfig>): void {
    if (config.basePollingInterval !== undefined) {
      this.pollingStrategy.setBaseInterval(config.basePollingInterval);
    }
    this.pollingStrategy.updateConfig(
      config.adaptiveBackoff ?? this.config.adaptiveBackoff,
      config.pollIntervalMax ?? this.config.pollIntervalMax,
      config.circuitBreakerThreshold ?? this.config.circuitBreakerThreshold
    );
    if (config.gitWatchEnabled !== undefined) {
      this.gitWatchEnabled = config.gitWatchEnabled;
    }
    if (config.gitWatchDebounceMs !== undefined) {
      this.gitWatchDebounceMs = config.gitWatchDebounceMs;
    }
    if (
      config.fetchIntervalActiveMs !== undefined ||
      config.fetchIntervalBackgroundMs !== undefined
    ) {
      this.fetchScheduler.updateIntervals(
        config.fetchIntervalActiveMs,
        config.fetchIntervalBackgroundMs
      );
    }
    this.config = { ...this.config, ...config };
  }

  async start(): Promise<void> {
    if (this._isRunning) {
      return;
    }

    this._isRunning = true;
    this.pollingEnabled = true;
    this._pollAbortController = new AbortController();

    if (this.gitWatchEnabled) {
      this.watcherController.start();
    }

    // Elevated monitors (focused, or agent already working — e.g. a worktree
    // the agent just created and immediately started editing) run the initial
    // git status synchronously so the card has fresh data right away.
    // Background monitors defer through a 2-5s jitter so N monitors started
    // together don't all fork git at t=0. The fetch scheduler already has
    // its own initial jitter on a separate cadence.
    if (this.isElevated) {
      await this.updateGitStatus(true);

      if (this._isRunning && this.pollingEnabled) {
        this.scheduleNextPoll();
        this.fetchScheduler.schedule(true);
      }
    } else {
      this.fetchScheduler.schedule(true);
      const delayMs = randomBetween(STATUS_INITIAL_DELAY_MIN_MS, STATUS_INITIAL_DELAY_MAX_MS);
      this.initialStatusTimer = setTimeout(() => {
        this.initialStatusTimer = null;
        if (!this._isRunning) return;
        // updateGitStatus already surfaces non-removal errors via mood=error
        // + emit; the catch here just prevents the unhandled rejection from
        // bubbling out of the fire-and-forget timer.
        this.updateGitStatus(true)
          .catch(() => {
            // Already emitted as error mood inside updateGitStatus
          })
          .finally(() => {
            if (this._isRunning && this.pollingEnabled) {
              this.scheduleNextPoll();
            }
          });
      }, delayMs);
      this.initialStatusTimer.unref?.();
    }
  }

  startWithoutGitStatus(): void {
    if (this._isRunning) {
      return;
    }

    this._isRunning = true;
    this.pollingEnabled = true;
    this._pollAbortController = new AbortController();

    if (this.gitWatchEnabled) {
      this.watcherController.start();
    }

    // Skipping the initial git status scan is a perf optimization — freshly
    // created worktrees are clean by definition, and bulk-loading a project
    // runs its own refreshAll later. But we still have to (a) emit the
    // current (default-clean) snapshot so the renderer can add the worktree
    // to its store (the store only grows on worktree-update events), and
    // (b) schedule polling so changes after file-watcher events get picked
    // up. start() does both via updateGitStatus + scheduleNextPoll; this
    // mirrors that contract minus the expensive git invocation.
    this._hasInitialStatus = true;
    this.emitUpdate();

    if (this._isRunning && this.pollingEnabled) {
      this.scheduleNextPoll();
      this.fetchScheduler.schedule(true);
    }
  }

  stop(): void {
    this._isRunning = false;
    this._pollAbortController.abort();
    this.clearTimers();
    this.watcherController.stop();
  }

  /**
   * Trigger an immediate background fetch, bypassing the per-repo failure
   * cache. Used by wake handlers and explicit user refresh paths. The
   * coordinator still serializes against any in-flight fetch on the same repo.
   */
  triggerFetchNow(): Promise<void> {
    return this.fetchScheduler.triggerNow();
  }

  /**
   * Re-arm the background fetch timer. `initial=true` uses the short
   * startup-tier delay (2-5s) so a snap-back after GitHub rate-limit recovery
   * gets fresh data promptly instead of waiting a full (possibly stretched)
   * cadence window.
   */
  rescheduleFetch(initial: boolean): void {
    this.fetchScheduler.reschedule(initial);
  }

  async refresh(): Promise<void> {
    // A stopped monitor has nothing to refresh. This also makes the ENOENT
    // preflight below idempotent: the first removal detection calls stop(),
    // so a concurrent refresh() (background poll racing a topology reconcile)
    // returns here instead of emitting a duplicate worktree-removed (#8510).
    if (!this._isRunning) return;
    // Path-existence preflight (#8510): without this, a removed worktree is
    // only self-detected once the poll reaches the fs.access deep inside
    // getWorktreeChangesWithStats. Catching it here means every refresh path —
    // including a topology-reconcile-triggered one — clears the phantom row
    // immediately. Mirrors the WorktreeRemovedError handling in updateGitStatus.
    try {
      await withTimeout(
        access(this.path),
        FS_OP_TIMEOUT_MS,
        `refresh access preflight: ${this.path}`
      );
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        this.stop();
        this.callbacks.onRemoved?.(this.id);
        return;
      }
      // Non-ENOENT (EACCES/EPERM/transient) or a timeout — fall through to a
      // normal refresh rather than misclassify a permission blip or a stalled
      // filesystem as a removal.
    }
    if (this.pollingStrategy.isCircuitBreakerTripped()) {
      this.pollingStrategy.reset();
    }
    if (this.isElevated && this.gitWatchEnabled) {
      const budgetReset = this.watcherController.resetRetryBudget();
      if (budgetReset) {
        this.watcherController.update();
      }
    }
    await this.updateGitStatus(true);
  }

  pausePolling(): void {
    this.pollingEnabled = false;
    this.clearTimers();
  }

  resumePolling(): void {
    if (!this._isRunning) return;

    this.pollingStrategy.reset();
    this.pollingEnabled = true;

    if (!this.pollingStrategy.isCircuitBreakerTripped()) {
      const jitter = Math.random() * 2000;
      this.resumeTimer = setTimeout(() => {
        this.resumeTimer = null;
        if (this._isRunning && this.pollingEnabled) {
          this.scheduleNextPoll();
        }
      }, jitter);
    }

    this.scheduleResourcePoll();
    this.fetchScheduler.schedule(true);
  }

  getSnapshot(): WorktreeSnapshot {
    return this.snapshotBuilder.build();
  }

  isCircuitBreakerTripped(): boolean {
    return this.pollingStrategy.isCircuitBreakerTripped();
  }

  resetPollingStrategy(): void {
    this.pollingStrategy.reset();
  }

  getWorktreeChanges(): WorktreeChanges | null {
    return this.worktreeChanges;
  }

  triggerRefreshIfUpdating(): void {
    invalidateGitStatusCache(this.path);
    if (this._isUpdating) {
      this.watcherController.markPending();
    } else {
      // Fire-and-forget, but guarded: GitStatusPass surfaces expected failures
      // as mood=error and then rethrows, so a detached call would turn a
      // transient `git status` failure into an unhandled rejection — which the
      // workspace-host's exit-on-unhandled-rejection guard escalates to a
      // process exit. The error is already reflected in monitor state, so
      // swallowing the rethrow here loses nothing (#11151 review).
      void this.updateGitStatus(true).catch(() => {});
    }
  }

  reschedulePolling(): void {
    if (this.pollingTimer) {
      clearTimeout(this.pollingTimer);
      this.pollingTimer = null;
    }
    if (this.resumeTimer) {
      clearTimeout(this.resumeTimer);
      this.resumeTimer = null;
    }

    if (this._isRunning && this.pollingEnabled) {
      this.scheduleNextPoll();
    }
  }

  ensureWatcherState(): void {
    this.watcherController.ensureState();
  }

  /** True when this monitor is currently allowed a git file watcher by the
   *  per-view watcher budget. Reflects the LRU eviction decision, not the
   *  user/config `gitWatchEnabled` flag. */
  get gitWatchBudgetGranted(): boolean {
    return this.gitWatchBudgetAllowed;
  }

  /**
   * Grant or revoke this monitor's watcher budget (WorkspaceService LRU
   * eviction). Revoking stops the watcher via the combined host getter and
   * reschedules polling so the evicted worktree immediately picks up the
   * adaptive interval instead of waiting out the watcher's 300s heartbeat;
   * granting re-arms the watcher at the desired granularity. No-op when the
   * flag is unchanged.
   */
  setGitWatchBudgetAllowed(allowed: boolean): void {
    if (this.gitWatchBudgetAllowed === allowed) return;
    this.gitWatchBudgetAllowed = allowed;
    // Reconcile the watcher against the new combined gate. ensureState() stops
    // the watcher when the gate is now false, or (re)starts it when true.
    this.watcherController.ensureState();
    // The mode dropped to "none" on revoke (or rotated on grant); reschedule
    // so scheduleNextPoll() re-reads the now-current poll cadence.
    this.reschedulePolling();
  }

  restartWatcherIfRunning(): void {
    this.watcherController.restartIfRunning();
  }

  // --- Timers ---

  private clearTimers(): void {
    if (this.pollingTimer) {
      clearTimeout(this.pollingTimer);
      this.pollingTimer = null;
    }
    if (this.resumeTimer) {
      clearTimeout(this.resumeTimer);
      this.resumeTimer = null;
    }
    if (this.initialStatusTimer) {
      clearTimeout(this.initialStatusTimer);
      this.initialStatusTimer = null;
    }
    this.watcherController.clearRetryTimer();
    this.clearResourcePollTimer();
    this.fetchScheduler.clearTimer();
  }

  private scheduleCircuitBreakerRetry(): void {
    if (!this._isRunning || !this.pollingEnabled) {
      return;
    }

    if (!this.pollingStrategy.isCircuitBreakerTripped()) {
      return;
    }

    if (this.pollingTimer || this.resumeTimer) {
      return;
    }

    const cooldown = Math.max(
      this.config.pollIntervalMax,
      this.pollingStrategy.calculateNextInterval()
    );
    const jitter = Math.random() * 2000;

    this.resumeTimer = setTimeout(() => {
      this.resumeTimer = null;
      if (this._isRunning && this.pollingEnabled) {
        void this.poll(true);
      }
    }, cooldown + jitter);
  }

  private scheduleNextPoll(): void {
    if (!this._isRunning || !this.pollingEnabled) {
      return;
    }

    if (this.pollingStrategy.isCircuitBreakerTripped()) {
      this.scheduleCircuitBreakerRetry();
      return;
    }

    if (this.pollingTimer) {
      return;
    }

    const baseInterval = this.watcherController.pollIntervalMs(() =>
      this.pollingStrategy.calculateNextInterval()
    );
    const jitterRange = Math.min(2000, Math.floor(baseInterval * 0.2));
    const jitter = jitterRange > 0 ? Math.floor(Math.random() * jitterRange) : 0;
    const delayMs = baseInterval + jitter;

    this.pollingTimer = setTimeout(() => {
      this.pollingTimer = null;
      if (!this._isRunning) return;

      // Heartbeat gap: when the OS throttles or suspends the process, the
      // timer fires far later than scheduled. Detect by measuring elapsed
      // wall time since the last completed poll. Surface "stale" so the
      // card dims, then force-refresh — categorizeWorktree() on the
      // refreshed status will overwrite mood with the real value.
      // Skip the gap check while a refresh is already in flight: it would
      // false-emit "stale" for any updateGitStatus that happens to take
      // longer than the floor (e.g., a slow git on a frozen filesystem).
      if (!this._isUpdating && this.lastGitStatusCompletedAt > 0) {
        const elapsedMs = Date.now() - this.lastGitStatusCompletedAt;
        const threshold = Math.min(
          Math.max(delayMs * HEARTBEAT_GAP_MULTIPLIER, HEARTBEAT_GAP_FLOOR_MS),
          HEARTBEAT_GAP_CEILING_MS
        );
        if (elapsedMs > threshold) {
          this.mood = "stale";
          this.emitUpdate();
          void this.forceRefreshAfterGap();
          return;
        }
      }

      void this.poll();
    }, delayMs).unref();
  }

  private async forceRefreshAfterGap(): Promise<void> {
    // Route through pollQueue when present so wake-induced gap refreshes are
    // serialized across sibling monitors instead of all racing simultaneously.
    const run = (): Promise<void> =>
      this.updateGitStatus(true).catch(() => {
        // updateGitStatus's own error path emits "error" mood; nothing to do here.
      });
    try {
      if (this.pollQueue) {
        await this.pollQueue.add(run, {
          signal: this._pollAbortController.signal,
          priority: this.isElevated ? 1 : 0,
        });
      } else {
        await run();
      }
    } catch {
      // Queue abort or task error — already swallowed by run() / signal.
    }
    if (this._isRunning && this.pollingEnabled) {
      this.scheduleNextPoll();
    }
  }

  private async poll(force: boolean = false): Promise<void> {
    if (!this._isRunning) return;

    if (!force && this.pollingStrategy.isCircuitBreakerTripped()) {
      try {
        await withTimeout(
          access(this.path),
          FS_OP_TIMEOUT_MS,
          `circuit-breaker access probe: ${this.path}`
        );
      } catch (err) {
        // Only ENOENT proves the worktree is gone. A timeout or permission blip
        // must not be misread as an external removal — that would wrongly drop
        // a live worktree from the sidebar the moment its disk stalls.
        if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
          this.callbacks.onExternalRemoval?.(this.id);
        }
      }
      return;
    }

    let tripped = false;
    const queuedAt = Date.now();

    const executePoll = async (): Promise<void> => {
      const startTime = Date.now();
      const queueDelayMs = Math.max(0, startTime - queuedAt);

      try {
        // Force a status refresh when an elevated worktree (focused or
        // agent-active) lacks recursive coverage — both no-watcher and
        // git-only modes can miss mid-edit changes that haven't reached
        // .git/ yet.
        const forceRefresh = this.isElevated && this.watcherController.currentMode !== "recursive";
        // Watchdog the whole pass: if any await inside updateGitStatus hangs
        // past the ceiling, treat it as a failure and move on rather than let
        // this monitor's loop (and, via the shared pollQueue slot, the whole
        // sidebar) wedge permanently.
        await withTimeout(
          this.updateGitStatus(forceRefresh),
          POLL_WATCHDOG_TIMEOUT_MS,
          `poll watchdog: ${this.path}`
        );
        this.pollingStrategy.recordSuccess(Date.now() - startTime, queueDelayMs);
      } catch (_error) {
        tripped = this.pollingStrategy.recordFailure(Date.now() - startTime, queueDelayMs);

        if (tripped) {
          this.mood = "error";
          this.summary = "⚠️ Polling delayed after consecutive failures";
          this.emitUpdate();
        }
      }
    };

    if (this._pendingPollPromise) return;

    const runPoll = this.pollQueue
      ? this.pollQueue.add(() => executePoll(), {
          signal: this._pollAbortController.signal,
          priority: this.isElevated ? 1 : 0,
        })
      : executePoll();

    this._pendingPollPromise = runPoll
      .catch(() => {
        // Queue abort, watchdog timeout, or execution failure — swallowed
        // intentionally; the finally below always reschedules so the loop can
        // never die on a single bad pass.
      })
      .finally(() => {
        this._pendingPollPromise = null;
      });

    try {
      await this._pendingPollPromise;
    } finally {
      // Reschedule unconditionally — even if the await above rejected (it can't,
      // it's already caught) or the task was dropped by the queue's own
      // watchdog. The only paths that must NOT reschedule are stop()/pause(),
      // both guarded by the _isRunning / pollingEnabled checks.
      if (tripped) {
        this.scheduleCircuitBreakerRetry();
      } else if (this._isRunning && this.pollingEnabled) {
        this.scheduleNextPoll();
      }
    }
  }

  // --- Git status ---

  async updateGitStatus(forceRefresh: boolean = false): Promise<void> {
    return this.gitStatusPass.run(forceRefresh);
  }

  emitUpdate(): void {
    this._prevEmittedIsDetached = this._isDetached;
    this._prevEmittedHead = this._head;
    this._prevEmittedRepoState = this._repoState;
    this.callbacks.onUpdate(this.getSnapshot());
  }
}
