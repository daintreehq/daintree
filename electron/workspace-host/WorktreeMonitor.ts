import { readFile, access, stat } from "fs/promises";
import { isAbsolute, join as pathJoin } from "path";
import { createHardenedGit, createWslHardenedGit } from "../utils/hardenedGit.js";
import type { WslGitInvocation } from "../utils/hardenedGit.js";
import type PQueue from "p-queue";
import type { WorktreeChanges, FileChangeDetail } from "../../shared/types/git.js";
import type {
  Worktree,
  WorktreeMood,
  WorktreeLifecycleStatus,
  WorktreeLifecyclePhaseResult,
} from "../../shared/types/worktree.js";
import type { GitHubPRCIStatus } from "../../shared/types/github.js";
import type { WorktreeSnapshot } from "../../shared/types/workspace-host.js";
import { invalidateGitStatusCache, getWorktreeChangesWithStats } from "../utils/git.js";
import { getGitDir } from "../utils/gitUtils.js";
import {
  isRepoOperationInProgress,
  getRepoOperationStateSync,
} from "../utils/gitRepoOperationState.js";
import { WorktreeRemovedError } from "../utils/errorTypes.js";
import { categorizeWorktree } from "../services/worktree/mood.js";
import { AdaptivePollingStrategy, NoteFileReader } from "../services/worktree/index.js";
import { ensureSerializable } from "../../shared/utils/serialization.js";
import { extractIssueNumberSync, extractIssueNumber } from "../services/issueExtractor.js";
import { FetchScheduler, type FetchSchedulerHost } from "./FetchScheduler.js";
import { ResourcePollTimer, type ResourcePollTimerHost } from "./ResourcePollTimer.js";
import { WatcherController, type WatcherControllerHost } from "./WatcherController.js";

const PLAN_FILE_CANDIDATES = ["TODO.md", "PLAN.md", "plan.md", "TASKS.md"] as const;
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
// Sentinel for "this git path doesn't exist". Used so the baseline can
// stably record absence (packed-refs, detached HEAD's branch ref) and still
// match on the next stat pass without forcing a real git check.
const STAT_ABSENT_SENTINEL = -1;

function randomBetween(minMs: number, maxMs: number): number {
  if (maxMs <= minMs) return minMs;
  return minMs + Math.floor(Math.random() * (maxMs - minMs));
}

interface GitFileStatBaseline {
  index: number;
  head: number;
  refsHead: number;
  packedRefs: number;
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
  private _isMainWorktree: boolean;

  // State
  private worktreeChanges: WorktreeChanges | null = null;
  private changes: FileChangeDetail[] | undefined;
  private mood: WorktreeMood = "stable";
  private summary: string | undefined;
  private modifiedCount: number = 0;
  private lastActivityTimestamp: number | null = null;
  private previousStateHash: string = "";

  // Note state
  private aiNote: string | undefined;
  private aiNoteTimestamp: number | undefined;

  // Plan file state
  private hasPlanFile: boolean = false;
  private planFilePath: string | undefined;

  // Upstream tracking state
  private aheadCount: number | undefined;
  private behindCount: number | undefined;

  // Base-branch divergence state
  private _baseBranchName: string | null | undefined;
  private _baseAheadCount: number | null | undefined;
  private _baseBehindCount: number | null | undefined;
  private _baseMatchesUpstream: boolean | undefined;

  // Issue/PR state
  private _issueNumber: number | undefined;
  private prNumber: number | undefined;
  private prUrl: string | undefined;
  private prState: "open" | "closed" | "merged" | undefined;
  private prCiStatus: GitHubPRCIStatus | undefined;
  private prTitle: string | undefined;
  private issueTitle: string | undefined;
  private prLastUpdatedAt: number | undefined;
  private issueLastUpdatedAt: number | undefined;

  // Provider-agnostic forge linkage (populated alongside legacy fields)
  private _linked: import("../../shared/types/plugin.js").PluginWorktreeLinked | null = null;

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
  private gitWatchDebounceMs: number;
  private lastGitStatusCompletedAt: number = 0;
  // Stamped by the watcher's onTriggerUpdate hook before a forced refresh
  // fires. The stat pre-check compares against `lastStatBaselineAt` to know
  // whether an event arrived since the baseline was captured — if so, the
  // skip is invalid and we must run the full git check.
  private lastWatcherEventAt: number = 0;
  // mtime cache for .git/index, HEAD, refs/heads/<branch>, packed-refs.
  // Populated after every successful git check. When the next poll finds all
  // four mtimes unchanged AND no watcher event has fired since, we skip the
  // simple-git fork-exec. null = no baseline yet (first poll, or post-error).
  private lastStatBaseline: GitFileStatBaseline | null = null;
  private lastStatBaselineAt: number = 0;
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
  // worktree card can show "Last fetched X ago", an in-flight pulse, and a
  // GitHub auth-failure affordance. `_lastFetchedAt` and `_fetchAuthFailed`
  // are pushed in via `setFetchState` from `WorkspaceService` (which receives
  // them on every coordinator round-trip and fans them out to siblings sharing
  // the commondir). `_isGitHubRemote` is set once at monitor start when the
  // origin URL is probed.
  private _lastFetchedAt: number | null = null;
  private _fetchAuthFailed: boolean = false;
  private _fetchNetworkFailed: boolean = false;
  private _isGitHubRemote: boolean = false;

  // Poll queue concurrency
  private _pendingPollPromise: Promise<void> | null = null;
  private _pollAbortController: AbortController = new AbortController();

  // WSL routing state (Windows only)
  private _isWslPath: boolean = false;
  private _wslDistro: string | undefined;
  private _wslGitEligible: boolean = false;
  private _wslGitOptIn: boolean = false;
  private _wslGitDismissed: boolean = false;
  private _wslPosixPath: string | undefined;

  // Components
  private pollingStrategy: AdaptivePollingStrategy;
  private noteReader: NoteFileReader;
  private pollQueue?: PQueue;

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
    this._gitDir = worktree.gitDir;
    this._isCurrent = worktree.isCurrent;
    this._isMainWorktree = Boolean(worktree.isMainWorktree);
    this._isDetached = Boolean(worktree.isDetached);
    this._head = worktree.head;
    this.gitWatchEnabled = config.gitWatchEnabled ?? true;
    this.gitWatchDebounceMs = config.gitWatchDebounceMs ?? 300;
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
      get isCurrent() {
        return monitor._isCurrent;
      },
      get gitWatchEnabled() {
        return monitor.gitWatchEnabled;
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

    this._isWslPath = Boolean(worktree.isWslPath);
    this._wslDistro = worktree.wslDistro;
    this._wslGitEligible = Boolean(worktree.wslGitEligible);
    this._wslGitOptIn = Boolean(worktree.wslGitOptIn);
    this._wslGitDismissed = Boolean(worktree.wslGitDismissed);
    if (this._isWslPath && this._wslDistro) {
      const m = /^\\\\wsl(?:\$|\.localhost)\\[^\\]+(.*)/i.exec(worktree.path);
      const remainder = m ? (m[1] ?? "") : "";
      this._wslPosixPath = remainder.replace(/\\/g, "/") || "/";
    }
  }

  /**
   * Build the WSL invocation passed to `createWslHardenedGit` /
   * `getWorktreeChangesWithStats({ wsl })`. Returns `undefined` when this
   * worktree should keep using the native git path: not on Windows, not a
   * WSL path, ineligible distro (not the default), or user hasn't opted in.
   */
  private get wslInvocation(): WslGitInvocation | undefined {
    if (process.platform !== "win32") return undefined;
    if (!this._isWslPath || !this._wslGitEligible || !this._wslGitOptIn) return undefined;
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
   * Set once at monitor start when `WorkspaceService` resolves the origin URL.
   * Gates the "Sign in to refresh" affordance — non-GitHub remotes silently
   * hide the affordance even when an auth failure is recorded.
   *
   * Guarded against post-stop emits: `probeGitHubRemoteAsync` is a fire-and-
   * forget async call that may resolve after the monitor is torn down (e.g.
   * worktree removal, project switch). Without this check the late resolution
   * would emit a `worktree-update` after `worktree-removed`, re-adding a
   * ghost card to the renderer.
   */
  setIsGitHubRemote(value: boolean): void {
    if (!this._isRunning) return;
    if (this._isGitHubRemote === value) return;
    this._isGitHubRemote = value;
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
    // controller actually rotated synchronously.
    if (changed && this._isRunning && this.gitWatchEnabled) {
      const rotatedImmediately = this.watcherController.handleFocusChange(value);
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
    prState?: "open" | "closed" | "merged";
    prCiStatus?: GitHubPRCIStatus;
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
  }

  setLinked(linked: import("../../shared/types/plugin.js").PluginWorktreeLinked | null): void {
    this._linked = linked;
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

    // Foreground monitors run the initial git status synchronously — the
    // user is looking at this card and expects fresh data on app launch.
    // Background monitors defer through a 2-5s jitter so N monitors started
    // together don't all fork git at t=0. The fetch scheduler already has
    // its own initial jitter on a separate cadence.
    if (this._isCurrent) {
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
      await access(this.path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        this.stop();
        this.callbacks.onRemoved?.(this.id);
        return;
      }
      // Non-ENOENT (EACCES/EPERM/transient) — fall through to normal refresh
      // rather than misclassify a permission blip as a removal.
    }
    if (this.pollingStrategy.isCircuitBreakerTripped()) {
      this.pollingStrategy.reset();
    }
    if (this._isCurrent && this.gitWatchEnabled) {
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
    let resourceStatus: import("../../shared/types/worktree.js").WorktreeResourceStatus | undefined;
    if (this._resourceStatus) {
      resourceStatus = { ...this._resourceStatus, provider: this._resourceProvider };
    } else if (this._resourceProvider) {
      resourceStatus = { provider: this._resourceProvider };
    }

    const snapshot: WorktreeSnapshot = {
      id: this.id,
      path: this.path,
      name: this._name,
      branch: this._branch,
      isCurrent: this._isCurrent,
      isMainWorktree: this._isMainWorktree,
      gitDir: this._gitDir,
      summary: this.summary,
      modifiedCount: this.modifiedCount,
      changes: this.changes,
      mood: this.mood,
      lastActivityTimestamp: this.lastActivityTimestamp,
      createdAt: this._createdAt,
      aiNote: this.aiNote,
      aiNoteTimestamp: this.aiNoteTimestamp,
      issueNumber: this._issueNumber,
      prNumber: this.prNumber,
      prUrl: this.prUrl,
      prState: this.prState,
      prCiStatus: this.prCiStatus,
      prTitle: this.prTitle,
      issueTitle: this.issueTitle,
      prLastUpdatedAt: this.prLastUpdatedAt,
      issueLastUpdatedAt: this.issueLastUpdatedAt,
      worktreeChanges: this.worktreeChanges,
      worktreeId: this.id,
      timestamp: Date.now(),
      lifecycleStatus: this._lifecycleStatus,
      lifecyclePhaseResults:
        this._lifecyclePhaseResults.length > 0 ? [...this._lifecyclePhaseResults] : undefined,
      resourceStatus,
      resourceConnectCommand: this._resourceConnectCommand,
      hasResourceConfig: this._hasResourceConfig || undefined,
      hasStatusCommand: this._hasStatusCommand || undefined,
      hasPauseCommand: this._hasPauseCommand || undefined,
      hasResumeCommand: this._hasResumeCommand || undefined,
      hasTeardownCommand: this._hasTeardownCommand || undefined,
      hasProvisionCommand: this._hasProvisionCommand || undefined,
      worktreeMode: this._worktreeMode !== "local" ? this._worktreeMode : undefined,
      worktreeEnvironmentLabel: this._worktreeEnvironmentLabel,
      hasPlanFile: this.hasPlanFile || undefined,
      planFilePath: this.planFilePath,
      aheadCount: this.aheadCount,
      behindCount: this.behindCount,
      baseBranchName: this._baseBranchName ?? undefined,
      baseAheadCount: this._baseAheadCount ?? undefined,
      baseBehindCount: this._baseBehindCount ?? undefined,
      baseMatchesUpstream: this._baseMatchesUpstream ?? undefined,
      lastFetchedAt: this._lastFetchedAt ?? undefined,
      lastGitStatusCheckedAt: this.lastGitStatusCompletedAt,
      fetchAuthFailed: this._fetchAuthFailed || undefined,
      fetchNetworkFailed: this._fetchNetworkFailed || undefined,
      // Read in-flight state authoritatively at snapshot time (lesson #1700)
      // so a snapshot emitted between fetch-start and fetch-end always
      // serializes the correct value, never a stale cached copy.
      isFetchInFlight: this.fetchScheduler.isFetchInFlight || undefined,
      isGitHubRemote: this._isGitHubRemote || undefined,
      isWslPath: this._isWslPath || undefined,
      wslDistro: this._wslDistro,
      wslGitEligible: this._wslGitEligible || undefined,
      wslGitOptIn: this._wslGitOptIn || undefined,
      wslGitDismissed: this._wslGitDismissed || undefined,
      linked: this._linked,
      repoState: this._repoState || undefined,
      isDetached: this._isDetached || undefined,
      head: this._head || undefined,
    };

    return ensureSerializable(snapshot) as WorktreeSnapshot;
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
      void this.updateGitStatus(true);
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
          priority: this._isCurrent ? 1 : 0,
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
        await access(this.path);
      } catch {
        this.callbacks.onExternalRemoval?.(this.id);
      }
      return;
    }

    let tripped = false;
    const queuedAt = Date.now();

    const executePoll = async (): Promise<void> => {
      const startTime = Date.now();
      const queueDelayMs = Math.max(0, startTime - queuedAt);

      try {
        // Force a status refresh when the active worktree lacks recursive
        // coverage — both no-watcher and git-only modes can miss mid-edit
        // changes that haven't reached .git/ yet.
        const forceRefresh = this._isCurrent && this.watcherController.currentMode !== "recursive";
        await this.updateGitStatus(forceRefresh);
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
          priority: this._isCurrent ? 1 : 0,
        })
      : executePoll();

    this._pendingPollPromise = runPoll
      .catch(() => {
        // Queue abort or execution failure — swallowed intentionally
      })
      .finally(() => {
        this._pendingPollPromise = null;
      });

    await this._pendingPollPromise;

    if (tripped) {
      this.scheduleCircuitBreakerRetry();
      return;
    }

    if (this._isRunning && this.pollingEnabled) {
      this.scheduleNextPoll();
    }
  }

  // --- Git status ---

  async updateGitStatus(forceRefresh: boolean = false): Promise<void> {
    if (this._isUpdating) {
      return;
    }

    // Skip the git status invocation while a rebase/merge/cherry-pick/revert
    // is in progress — running it would compete with the user's git client
    // for .git/index.lock. The watcher tracks the same sentinel files, so
    // it fires when the operation finishes and triggers a fresh refresh.
    // Polling continues uninterrupted, so the next scheduled poll after
    // sentinels clear also picks up the change.
    const gitDir = getGitDir(this.path, { cache: true, logErrors: false });

    // Detect blocking git operation state from sentinel files so the renderer
    // can surface it even when git status is skipped.
    if (gitDir) {
      const opState = getRepoOperationStateSync(gitDir);
      if (opState !== this._repoState) {
        this._repoState = opState;
        if (this._hasInitialStatus) {
          this.emitUpdate();
        }
      }
    } else {
      this._repoState = undefined;
    }

    if (gitDir && isRepoOperationInProgress(gitDir)) {
      // If we're skipping the very first poll (e.g. app started mid-rebase),
      // emit a default snapshot so the renderer can still display the worktree.
      // Mirrors startWithoutGitStatus()'s contract.
      if (!this._hasInitialStatus) {
        this._hasInitialStatus = true;
        this.emitUpdate();
      }
      return;
    }

    // Cheap stat pre-check: when the four git files we care about haven't
    // changed since the last baseline and no watcher event has fired since,
    // the simple-git fork-exec would be redundant. Skip it. This is the
    // common case on a quiet repo — the per-poll cost drops from ~15-50ms
    // (fork + git status) to ~1ms (four stat() calls).
    //
    // The baseline only exists after the first real check, so this branch
    // is a no-op on the very first poll. Forced refreshes (watcher events,
    // user actions) always run the full check.
    if (!forceRefresh && gitDir && this._hasInitialStatus && this.lastStatBaseline !== null) {
      const baselineAt = this.lastStatBaselineAt;
      const checkStartedAt = Date.now();
      try {
        const commonDir = await this.resolveCommonDirAsync(gitDir);
        const fresh = await this.buildStatBaseline(gitDir, commonDir);
        if (
          fresh !== null &&
          this.lastWatcherEventAt <= baselineAt &&
          this.statBaselineMatches(this.lastStatBaseline, fresh)
        ) {
          // Treat the skip as a no-change observation so the idle backoff
          // ramps up the next interval. lastGitStatusCompletedAt bumps too,
          // otherwise the heartbeat-gap check would false-positive on a
          // long quiet streak that only ran stat-skips.
          this.pollingStrategy.recordNoChange();
          this.lastStatBaselineAt = checkStartedAt;
          this.lastGitStatusCompletedAt = Date.now();
          return;
        }
      } catch {
        // Unexpected stat error — fall through to the full git check.
        // Don't poison the baseline; the post-check rebuild will refresh it.
      }
    }

    this._isUpdating = true;
    // Tracks whether the try block reached a clean exit point — either the
    // no-change early return or the post-emit fall-through. The catch block
    // doesn't flip it (so the finally clears the stale baseline) which means
    // a flaky git that throws here can't get its old baseline re-stamped and
    // silently suppress the next retry.
    let checkSucceeded = false;

    try {
      if (forceRefresh) {
        invalidateGitStatusCache(this.path);
      }

      const pollingInterval = this.config.basePollingInterval;
      const cacheTTL =
        Number.isFinite(pollingInterval) && pollingInterval > 0
          ? Math.max(500, pollingInterval - 500)
          : undefined;
      const newChanges = await getWorktreeChangesWithStats(this.path, {
        forceRefresh,
        cacheTTL,
        wsl: this.wslInvocation,
      });

      if (!this._isRunning) {
        return;
      }

      // Detect branch changes by reading HEAD directly
      const currentBranch = await this.readCurrentBranch();
      const branchChanged = currentBranch !== undefined && currentBranch !== this._branch;
      if (branchChanged) {
        this._branch = currentBranch;
        const hadPendingRefresh = this.watcherController.takePending();
        this.watcherController.update();
        if (hadPendingRefresh) {
          this.watcherController.markPending();
        }
        const syncIssueNumber = extractIssueNumberSync(currentBranch, this._name);
        if (syncIssueNumber) {
          this._issueNumber = syncIssueNumber;
        } else {
          this._issueNumber = undefined;
          void this.extractIssueNumberAsync(currentBranch, this._name);
        }
        this.issueTitle = undefined;
        // Clear PR info synchronously in the same emit as the branch change
        // so the renderer never sees a frame with the new branch but the old
        // PR (#8079). PullRequestService still emits its own clear downstream;
        // by then this snapshot already has null PR fields, so that second
        // emit collapses to a no-op via snapshotsEqual.
        this.clearPRInfo();
        this.callbacks.onBranchChanged?.(this.id, currentBranch);
      }

      const noteData = await this.noteReader.read();

      const hasUpstream = !!newChanges.tracking;
      const nextAheadCount = hasUpstream ? (newChanges.ahead ?? 0) : undefined;
      const nextBehindCount = hasUpstream ? (newChanges.behind ?? 0) : undefined;

      // Base-branch divergence — runs in parallel with plan file detection.
      const baseDivergencePromise = this.computeBaseDivergence(hasUpstream);

      const planResults = await Promise.allSettled(
        PLAN_FILE_CANDIDATES.map((candidate) => access(pathJoin(this.path, candidate)))
      );
      const detectedPlanFile = PLAN_FILE_CANDIDATES.find(
        (_, i) => planResults[i].status === "fulfilled"
      );
      const nextHasPlanFile = detectedPlanFile !== undefined;
      const nextPlanFilePath = detectedPlanFile;

      const baseDivergence = await baseDivergencePromise;
      const nextBaseBranchName = baseDivergence?.baseBranchName ?? undefined;
      const nextBaseAheadCount = baseDivergence?.aheadCount ?? undefined;
      const nextBaseBehindCount = baseDivergence?.behindCount ?? undefined;
      const nextBaseMatchesUpstream = baseDivergence?.matchesUpstream ?? undefined;

      const currentHash = this.calculateStateHash(newChanges);
      const stateChanged = currentHash !== this.previousStateHash;
      const noteChanged =
        noteData?.content !== this.aiNote || noteData?.timestamp !== this.aiNoteTimestamp;
      const planChanged =
        nextHasPlanFile !== this.hasPlanFile || nextPlanFilePath !== this.planFilePath;
      const upstreamChanged =
        nextAheadCount !== this.aheadCount || nextBehindCount !== this.behindCount;
      const baseDivergenceChanged =
        nextBaseBranchName !== this._baseBranchName ||
        nextBaseAheadCount !== this._baseAheadCount ||
        nextBaseBehindCount !== this._baseBehindCount ||
        nextBaseMatchesUpstream !== this._baseMatchesUpstream;

      const gitStateChanged =
        this._isDetached !== this._prevEmittedIsDetached ||
        this._head !== this._prevEmittedHead ||
        this._repoState !== this._prevEmittedRepoState;

      const anythingChanged =
        stateChanged ||
        noteChanged ||
        branchChanged ||
        planChanged ||
        upstreamChanged ||
        baseDivergenceChanged ||
        gitStateChanged;

      // Drive the idle backoff from what the git check actually observed —
      // a real state change resets, otherwise we count one quiet tick. The
      // skip path above runs its own recordNoChange so this branch only
      // sees ticks that paid the full fork-exec cost.
      if (anythingChanged) {
        this.pollingStrategy.recordStateChange();
      } else {
        this.pollingStrategy.recordNoChange();
      }

      if (!anythingChanged && !forceRefresh) {
        checkSucceeded = true;
        return;
      }

      const isInitialLoad = this.previousStateHash === "";
      const isNowClean = newChanges.changedFileCount === 0;
      const hasPendingChanges = newChanges.changedFileCount > 0;
      const shouldUpdateTimestamp =
        (stateChanged && !isInitialLoad) || (isInitialLoad && hasPendingChanges);

      if (shouldUpdateTimestamp) {
        this.lastActivityTimestamp = Date.now();
      }

      if (isInitialLoad && isNowClean && this.lastActivityTimestamp === null) {
        this.lastActivityTimestamp = newChanges.lastCommitTimestampMs ?? null;
      }

      if (
        isNowClean ||
        isInitialLoad ||
        (this.worktreeChanges && this.worktreeChanges.changedFileCount === 0)
      ) {
        this.summary = await this.fetchLastCommitMessage(newChanges);
      }

      let nextMood = this.mood;
      try {
        nextMood = await categorizeWorktree(
          {
            id: this.id,
            path: this.path,
            name: this._name,
            branch: this._branch,
            isCurrent: this._isCurrent,
          },
          newChanges || undefined,
          this.mainBranch
        );
      } catch {
        nextMood = "error";
      }

      this.previousStateHash = currentHash;
      this.worktreeChanges = newChanges;
      this.changes = newChanges.changes;
      this.modifiedCount = newChanges.changedFileCount;
      this.mood = nextMood;
      this.aiNote = noteData?.content;
      this.aiNoteTimestamp = noteData?.timestamp;
      this.hasPlanFile = nextHasPlanFile;
      this.planFilePath = nextPlanFilePath;
      this.aheadCount = nextAheadCount;
      this.behindCount = nextBehindCount;
      this._baseBranchName = nextBaseBranchName;
      this._baseAheadCount = nextBaseAheadCount;
      this._baseBehindCount = nextBaseBehindCount;
      this._baseMatchesUpstream = nextBaseMatchesUpstream;
      this._hasInitialStatus = true;

      this.emitUpdate();
      checkSucceeded = true;
    } catch (error) {
      if (error instanceof WorktreeRemovedError) {
        this.stop();
        this.callbacks.onRemoved?.(this.id);
        return;
      }

      const errorMessage = (error as Error).message || "";
      if (errorMessage.includes("index.lock")) {
        this.watcherController.markPending();
        this.watcherController.scheduleDelayedFlush();
        return;
      }

      this.mood = "error";
      this.emitUpdate();
      throw error;
    } finally {
      this._isUpdating = false;
      this.lastGitStatusCompletedAt = Date.now();
      // Rebuild the stat baseline only when a real git check finished
      // cleanly. On failure (anything that didn't set checkSucceeded — git
      // throw, WorktreeRemovedError, index.lock retry path) we drop the
      // baseline so the next non-forced poll falls through to a full check
      // rather than skipping against a snapshot that predates the failure.
      if (checkSucceeded && gitDir) {
        try {
          const commonDir = await this.resolveCommonDirAsync(gitDir);
          const fresh = await this.buildStatBaseline(gitDir, commonDir);
          if (fresh !== null) {
            this.lastStatBaseline = fresh;
            this.lastStatBaselineAt = Date.now();
          } else {
            this.lastStatBaseline = null;
          }
        } catch {
          this.lastStatBaseline = null;
        }
      } else {
        this.lastStatBaseline = null;
      }
      this.watcherController.flushPendingIfReady(true);
    }
  }

  /**
   * Resolve the common git directory for a linked worktree (the `gitDir`
   * inside `<repo>/.git/worktrees/<name>/` points at `commondir`, which
   * holds packed-refs and the shared refs/heads tree). Returns `gitDir`
   * itself for the main worktree, or when the commondir file is missing.
   * Mirrors `GitFileWatcher.resolveCommonDir` but uses async `readFile`.
   */
  private async resolveCommonDirAsync(gitDir: string): Promise<string> {
    try {
      const commondirContent = await readFile(pathJoin(gitDir, "commondir"), "utf-8");
      const trimmed = commondirContent.trim();
      if (!trimmed) return gitDir;
      return isAbsolute(trimmed) ? trimmed : pathJoin(gitDir, trimmed);
    } catch {
      return gitDir;
    }
  }

  /**
   * Capture mtimeMs for the four git files whose changes would invalidate
   * the previous status snapshot: index, HEAD, refs/heads/<branch>, and
   * packed-refs. Returns `null` if any unexpected error occurs (caller
   * falls back to a full git check). ENOENT is normal for packed-refs and
   * the branch ref (detached HEAD, or branch not pushed yet) — those paths
   * return STAT_ABSENT_SENTINEL and the baseline comparison still works.
   */
  private async buildStatBaseline(
    gitDir: string,
    commonDir: string
  ): Promise<GitFileStatBaseline | null> {
    try {
      const [indexStat, headStat, refsHeadStat, packedRefsStat] = await Promise.all([
        this.statMtime(pathJoin(gitDir, "index")),
        this.statMtime(pathJoin(gitDir, "HEAD")),
        this._branch
          ? this.statMtime(pathJoin(commonDir, "refs", "heads", this._branch))
          : Promise.resolve(STAT_ABSENT_SENTINEL),
        this.statMtime(pathJoin(commonDir, "packed-refs")),
      ]);
      return {
        index: indexStat,
        head: headStat,
        refsHead: refsHeadStat,
        packedRefs: packedRefsStat,
      };
    } catch {
      return null;
    }
  }

  /**
   * Stat one git path. Returns `STAT_ABSENT_SENTINEL` when the file is
   * missing (the most common case for packed-refs and unpushed branch
   * refs) so the baseline can still compare equal on the next pass without
   * forcing a full git check. Other errors propagate up so the caller
   * falls back to the full path — a permission flip or filesystem hiccup
   * should not silently freeze the cached baseline.
   */
  private async statMtime(filePath: string): Promise<number> {
    try {
      const result = await stat(filePath);
      return result.mtimeMs;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code === "ENOENT") return STAT_ABSENT_SENTINEL;
      throw error;
    }
  }

  private statBaselineMatches(a: GitFileStatBaseline, b: GitFileStatBaseline): boolean {
    return (
      a.index === b.index &&
      a.head === b.head &&
      a.refsHead === b.refsHead &&
      a.packedRefs === b.packedRefs
    );
  }

  private async readCurrentBranch(): Promise<string | undefined> {
    const gitDir = getGitDir(this.path, { cache: true, logErrors: false });
    if (!gitDir) {
      this._isDetached = false;
      this._head = undefined;
      return undefined;
    }

    try {
      const headContent = await readFile(pathJoin(gitDir, "HEAD"), "utf-8");
      const trimmed = headContent.trim();
      const prefix = "ref: refs/heads/";
      if (trimmed.startsWith(prefix)) {
        this._isDetached = false;
        this._head = undefined;
        return trimmed.slice(prefix.length);
      }
      // Detached HEAD — the file contains a commit SHA
      if (/^[0-9a-f]{40}$/.test(trimmed)) {
        this._isDetached = true;
        this._head = trimmed;
      } else {
        this._isDetached = false;
        this._head = undefined;
      }
      return undefined;
    } catch {
      this._isDetached = false;
      this._head = undefined;
      return undefined;
    }
  }

  private async extractIssueNumberAsync(branchName: string, folderName?: string): Promise<void> {
    try {
      const issueNum = await extractIssueNumber(branchName, folderName);
      if (issueNum && this._isRunning && this._branch === branchName) {
        this._issueNumber = issueNum;
        if (this._hasInitialStatus) {
          this.emitUpdate();
        }
      }
    } catch {
      // Silently ignore extraction errors
    }
  }

  private async computeBaseDivergence(hasUpstream: boolean): Promise<{
    baseBranchName: string | null;
    aheadCount: number | null;
    behindCount: number | null;
    matchesUpstream: boolean;
  } | null> {
    if (!this._branch || this._isMainWorktree) return null;
    const wsl = this.wslInvocation;
    const git = wsl
      ? createWslHardenedGit(wsl, this._pollAbortController.signal)
      : createHardenedGit(this.path, this._pollAbortController.signal);

    try {
      // Resolve base ref: try origin/<branch> first (remote ref stays fresh
      // after fetch), fall back to local branch for repos without a remote.
      const remoteRef = `origin/${this.mainBranch}`;
      const localRef = this.mainBranch;
      let resolvedRef: string;
      try {
        await git.raw(["rev-parse", "--verify", remoteRef]);
        resolvedRef = remoteRef;
      } catch {
        try {
          await git.raw(["rev-parse", "--verify", localRef]);
          resolvedRef = localRef;
        } catch {
          return null;
        }
      }

      const baseBranchName = this.mainBranch;
      const result = await git.raw([
        "rev-list",
        "--count",
        "--left-right",
        `${resolvedRef}...HEAD`,
      ]);
      const trimmed = result.trim();
      const parts = trimmed.split("\t");
      const behindCount = parts[0] != null && parts[0] !== "" ? parseInt(parts[0], 10) : 0;
      const aheadCount = parts[1] != null && parts[1] !== "" ? parseInt(parts[1], 10) : 0;

      let matchesUpstream = false;
      if (hasUpstream) {
        try {
          const upstreamCommit = await git.raw(["rev-parse", "@{u}"]);
          const baseCommit = await git.raw(["rev-parse", resolvedRef]);
          matchesUpstream = upstreamCommit.trim() === baseCommit.trim();
        } catch {
          matchesUpstream = false;
        }
      }

      return {
        baseBranchName,
        aheadCount: Number.isFinite(aheadCount) ? aheadCount : null,
        behindCount: Number.isFinite(behindCount) ? behindCount : null,
        matchesUpstream,
      };
    } catch {
      return null;
    }
  }

  private calculateStateHash(changes: WorktreeChanges): string {
    const hashInput = changes.changes
      .map((c) => `${c.path}:${c.status}:${c.insertions ?? 0}:${c.deletions ?? 0}`)
      .sort()
      .join("|");
    return hashInput;
  }

  private async fetchLastCommitMessage(changes: WorktreeChanges): Promise<string> {
    if (changes.lastCommitMessage) {
      const firstLine = changes.lastCommitMessage.split("\n")[0].trim();
      return `✅ ${firstLine}`;
    }

    try {
      const wsl = this.wslInvocation;
      const git = wsl
        ? createWslHardenedGit(wsl, this._pollAbortController.signal)
        : createHardenedGit(this.path, this._pollAbortController.signal);
      const log = await git.log({ maxCount: 1 });
      const lastCommitMsg = log.latest?.message;

      if (lastCommitMsg) {
        const firstLine = lastCommitMsg.split("\n")[0].trim();
        return `✅ ${firstLine}`;
      }
      return "🌱 Ready to get started";
    } catch {
      return "🌱 Ready to get started";
    }
  }

  emitUpdate(): void {
    this._prevEmittedIsDetached = this._isDetached;
    this._prevEmittedHead = this._head;
    this._prevEmittedRepoState = this._repoState;
    this.callbacks.onUpdate(this.getSnapshot());
  }
}
