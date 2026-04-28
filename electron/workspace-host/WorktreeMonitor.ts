import { readFile } from "fs/promises";
import { join as pathJoin } from "path";
import { existsSync } from "fs";
import { createHardenedGit, createWslHardenedGit } from "../utils/hardenedGit.js";
import type { WslGitInvocation } from "../utils/hardenedGit.js";
import type PQueue from "p-queue";
import type { WorktreeChanges, FileChangeDetail } from "../../shared/types/git.js";
import type {
  Worktree,
  WorktreeMood,
  WorktreeLifecycleStatus,
} from "../../shared/types/worktree.js";
import type { WorktreeSnapshot } from "../../shared/types/workspace-host.js";
import { invalidateGitStatusCache, getWorktreeChangesWithStats } from "../utils/git.js";
import { getGitDir } from "../utils/gitUtils.js";
import { WorktreeRemovedError } from "../utils/errorTypes.js";
import { categorizeWorktree } from "../services/worktree/mood.js";
import { AdaptivePollingStrategy, NoteFileReader } from "../services/worktree/index.js";
import { ensureSerializable } from "../../shared/utils/serialization.js";
import { extractIssueNumberSync, extractIssueNumber } from "../services/issueExtractor.js";
import { GitFileWatcher } from "../utils/gitFileWatcher.js";
import { MutableDisposable, toDisposable, type IDisposable } from "../utils/lifecycle.js";

const GIT_WATCH_SELF_TRIGGER_COOLDOWN_MS = 1000;
const WATCHER_FALLBACK_POLL_INTERVAL_MS = 30_000;
const WATCHER_RETRY_INTERVAL_MS = 30_000;
const WATCHER_MAX_RETRIES = 5;
const WATCHER_WORKTREE_MIN_DEBOUNCE_MS = 150;
const WATCHER_WORKTREE_MAX_DEBOUNCE_MS = 800;
const WATCHER_WORKTREE_MAX_WAIT_MS = 1500;
const PLAN_FILE_CANDIDATES = ["TODO.md", "PLAN.md", "plan.md", "TASKS.md"] as const;
const RESOURCE_POLL_DEFAULT_ACTIVE_MS = 30_000;
const RESOURCE_POLL_DEFAULT_BACKGROUND_MS = 120_000;

export interface WorktreeMonitorConfig {
  basePollingInterval: number;
  adaptiveBackoff: boolean;
  pollIntervalMax: number;
  circuitBreakerThreshold: number;
  gitWatchEnabled?: boolean;
  gitWatchDebounceMs?: number;
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

  // Issue/PR state
  private _issueNumber: number | undefined;
  private prNumber: number | undefined;
  private prUrl: string | undefined;
  private prState: "open" | "closed" | "merged" | undefined;
  private prTitle: string | undefined;
  private issueTitle: string | undefined;

  // Polling state
  private pollingTimer: NodeJS.Timeout | null = null;
  private resumeTimer: NodeJS.Timeout | null = null;
  private _isRunning: boolean = false;
  private _isUpdating: boolean = false;
  private pollingEnabled: boolean = true;
  private _hasInitialStatus: boolean = false;

  // File watcher state — MutableDisposable auto-disposes the previous watcher
  // on reassignment, eliminating the manual stop-old-start-new dance.
  private gitWatcher = new MutableDisposable<IDisposable>();
  private gitWatchDebounceTimer: NodeJS.Timeout | null = null;
  private gitWatchRefreshPending: boolean = false;
  private gitWatchEnabled: boolean;
  private gitWatchDebounceMs: number;
  private lastGitStatusCompletedAt: number = 0;
  private watcherRetryTimer: NodeJS.Timeout | null = null;
  private watcherRetryCount: number = 0;

  // Extra state
  private _createdAt: number | undefined;
  private _lifecycleStatus: WorktreeLifecycleStatus | undefined;

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

  // Resource status auto-polling
  private resourcePollTimer: NodeJS.Timeout | null = null;
  private resourcePollIntervalMs: number = 0; // 0 = disabled

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
      // Only adapt if no explicit statusInterval was configured (i.e., using defaults)
      const isUsingDefaultInterval =
        this.resourcePollIntervalMs === RESOURCE_POLL_DEFAULT_ACTIVE_MS ||
        this.resourcePollIntervalMs === RESOURCE_POLL_DEFAULT_BACKGROUND_MS;
      if (isUsingDefaultInterval) {
        this.resourcePollIntervalMs = value
          ? RESOURCE_POLL_DEFAULT_ACTIVE_MS
          : RESOURCE_POLL_DEFAULT_BACKGROUND_MS;
        this.clearResourcePollTimer();
        this.scheduleResourcePoll();
      }
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
    return this.gitWatcher.value !== undefined;
  }

  setIssueNumber(issueNumber: number | undefined): void {
    this._issueNumber = issueNumber;
  }

  setIssueTitle(title: string | undefined): void {
    this.issueTitle = title;
  }

  setPRTitle(title: string | undefined): void {
    this.prTitle = title;
  }

  setPRInfo(info: {
    prNumber?: number;
    prUrl?: string;
    prState?: "open" | "closed" | "merged";
    prTitle?: string;
    issueTitle?: string;
  }): void {
    this.prNumber = info.prNumber;
    this.prUrl = info.prUrl;
    this.prState = info.prState;
    if (info.prTitle !== undefined) this.prTitle = info.prTitle;
    if (info.issueTitle !== undefined) this.issueTitle = info.issueTitle;
  }

  clearPRInfo(): void {
    this.prNumber = undefined;
    this.prUrl = undefined;
    this.prState = undefined;
    this.prTitle = undefined;
  }

  setCreatedAt(ms: number | undefined): void {
    this._createdAt = ms;
  }

  setLifecycleStatus(status: WorktreeLifecycleStatus | undefined): void {
    this._lifecycleStatus = status;
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
        this.resourcePollIntervalMs = this._isCurrent
          ? RESOURCE_POLL_DEFAULT_ACTIVE_MS
          : RESOURCE_POLL_DEFAULT_BACKGROUND_MS;
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
        this.resourcePollIntervalMs = this._isCurrent
          ? RESOURCE_POLL_DEFAULT_ACTIVE_MS
          : RESOURCE_POLL_DEFAULT_BACKGROUND_MS;
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
    this.clearResourcePollTimer();
    if (ms > 0 && this._hasResourceConfig && this._isRunning) {
      this.scheduleResourcePoll();
    }
  }

  private scheduleResourcePoll(): void {
    if (this.resourcePollTimer) return;
    if (this.resourcePollIntervalMs <= 0 || !this._hasResourceConfig || !this._hasStatusCommand)
      return;

    this.resourcePollTimer = setTimeout(async () => {
      this.resourcePollTimer = null;
      if (
        this._isRunning &&
        this._hasResourceConfig &&
        this._hasStatusCommand &&
        this.resourcePollIntervalMs > 0
      ) {
        try {
          await this.callbacks.onResourceStatusPoll?.(this.id);
        } catch {
          // Poll callback failure — swallowed intentionally
        }
        if (!this._isRunning) return;
        this.scheduleResourcePoll();
      }
    }, this.resourcePollIntervalMs);
  }

  private clearResourcePollTimer(): void {
    if (this.resourcePollTimer) {
      clearTimeout(this.resourcePollTimer);
      this.resourcePollTimer = null;
    }
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
      this.startWatcher();
    }

    await this.updateGitStatus(true);

    if (this._isRunning && this.pollingEnabled) {
      this.scheduleNextPoll();
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
      this.startWatcher();
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
    }
  }

  stop(): void {
    this._isRunning = false;
    this._pollAbortController.abort();
    this._pollAbortController = new AbortController();
    this.clearTimers();
    this.stopWatcher();
  }

  async refresh(): Promise<void> {
    if (this.pollingStrategy.isCircuitBreakerTripped()) {
      this.pollingStrategy.reset();
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
      prTitle: this.prTitle,
      issueTitle: this.issueTitle,
      worktreeChanges: this.worktreeChanges,
      worktreeId: this.id,
      timestamp: Date.now(),
      lifecycleStatus: this._lifecycleStatus,
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
      isWslPath: this._isWslPath || undefined,
      wslDistro: this._wslDistro,
      wslGitEligible: this._wslGitEligible || undefined,
      wslGitOptIn: this._wslGitOptIn || undefined,
      wslGitDismissed: this._wslGitDismissed || undefined,
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
      this.gitWatchRefreshPending = true;
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
    if (!this.gitWatchEnabled && this.gitWatcher.value) {
      this.stopWatcher();
    } else if (this.gitWatchEnabled && this._isRunning && !this.gitWatcher.value) {
      this.startWatcher();
    }
  }

  restartWatcherIfRunning(): void {
    if (this.gitWatcher.value) {
      this.updateWatcher();
    }
  }

  // --- File watcher management ---

  private startWatcher(): void {
    if (!this._isRunning || !this.gitWatchEnabled || this.gitWatcher.value) {
      return;
    }

    const watcher = new GitFileWatcher({
      worktreePath: this.path,
      branch: this._branch,
      debounceMs: this.gitWatchDebounceMs,
      onChange: () => this.handleGitFileChange(),
      watchWorktree: true,
      worktreeMinDebounceMs: WATCHER_WORKTREE_MIN_DEBOUNCE_MS,
      worktreeMaxDebounceMs: WATCHER_WORKTREE_MAX_DEBOUNCE_MS,
      worktreeMaxWaitMs: WATCHER_WORKTREE_MAX_WAIT_MS,
      onWatcherFailed: () => this.handleWatcherFailed(),
      onInotifyLimitReached: () => this.callbacks.onInotifyLimitReached?.(this.id),
      onEmfileLimitReached: () => this.callbacks.onEmfileLimitReached?.(this.id),
    });

    const started = watcher.start();
    if (started) {
      this.gitWatcher.value = toDisposable(() => watcher.dispose());
      this.watcherRetryCount = 0;
    } else {
      watcher.dispose();
      this.scheduleWatcherRetry();
    }
  }

  private stopWatcher(): void {
    this.gitWatcher.clear();
    if (this.gitWatchDebounceTimer) {
      clearTimeout(this.gitWatchDebounceTimer);
      this.gitWatchDebounceTimer = null;
    }
    if (this.watcherRetryTimer) {
      clearTimeout(this.watcherRetryTimer);
      this.watcherRetryTimer = null;
    }
    this.watcherRetryCount = 0;
    this.gitWatchRefreshPending = false;
  }

  private updateWatcher(): void {
    this.stopWatcher();
    if (this._isRunning && this.gitWatchEnabled) {
      this.startWatcher();
    }
  }

  private handleWatcherFailed(): void {
    this.gitWatcher.clear();
    this.scheduleWatcherRetry();
  }

  private scheduleWatcherRetry(): void {
    if (!this._isRunning || !this.gitWatchEnabled || this.watcherRetryTimer) {
      return;
    }

    this.watcherRetryCount++;
    if (this.watcherRetryCount > WATCHER_MAX_RETRIES) {
      return;
    }

    this.watcherRetryTimer = setTimeout(() => {
      this.watcherRetryTimer = null;
      if (this._isRunning && this.gitWatchEnabled && !this.gitWatcher.value) {
        this.startWatcher();
      }
    }, WATCHER_RETRY_INTERVAL_MS);
  }

  private handleGitFileChange(): void {
    if (!this._isRunning) {
      return;
    }

    if (!this._isUpdating) {
      const msSinceLastStatus = Date.now() - this.lastGitStatusCompletedAt;
      if (msSinceLastStatus < GIT_WATCH_SELF_TRIGGER_COOLDOWN_MS) {
        this.gitWatchRefreshPending = true;
        return;
      }
    }

    this.gitWatchRefreshPending = true;
    invalidateGitStatusCache(this.path);

    if (this._isUpdating) {
      if (this.gitWatchDebounceTimer) {
        clearTimeout(this.gitWatchDebounceTimer);
      }
      this.gitWatchDebounceTimer = setTimeout(() => {
        this.gitWatchDebounceTimer = null;
        this.flushPendingGitWatchRefresh();
      }, this.gitWatchDebounceMs);
      return;
    }

    this.flushPendingGitWatchRefresh();
  }

  private flushPendingGitWatchRefresh(): void {
    if (!this._isRunning || this._isUpdating || !this.gitWatchRefreshPending) {
      return;
    }

    this.gitWatchRefreshPending = false;
    invalidateGitStatusCache(this.path);
    void this.updateGitStatus(true);
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
    if (this.watcherRetryTimer) {
      clearTimeout(this.watcherRetryTimer);
      this.watcherRetryTimer = null;
    }
    this.clearResourcePollTimer();
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

    const baseInterval = this.gitWatcher.value
      ? WATCHER_FALLBACK_POLL_INTERVAL_MS
      : this.pollingStrategy.calculateNextInterval();
    const jitterRange = Math.min(2000, Math.floor(baseInterval * 0.2));
    const jitter = jitterRange > 0 ? Math.floor(Math.random() * jitterRange) : 0;
    const delayMs = baseInterval + jitter;

    this.pollingTimer = setTimeout(() => {
      this.pollingTimer = null;
      void this.poll();
    }, delayMs);
  }

  private async poll(force: boolean = false): Promise<void> {
    if (!this._isRunning) return;

    if (!force && this.pollingStrategy.isCircuitBreakerTripped()) {
      if (!existsSync(this.path)) {
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
        const forceRefresh = this._isCurrent && !this.gitWatcher.value;
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

    this._isUpdating = true;

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
        const hadPendingRefresh = this.gitWatchRefreshPending;
        this.updateWatcher();
        if (hadPendingRefresh) {
          this.gitWatchRefreshPending = true;
        }
        const syncIssueNumber = extractIssueNumberSync(currentBranch, this._name);
        if (syncIssueNumber) {
          this._issueNumber = syncIssueNumber;
        } else {
          this._issueNumber = undefined;
          void this.extractIssueNumberAsync(currentBranch, this._name);
        }
        this.issueTitle = undefined;
        this.callbacks.onBranchChanged?.(this.id, currentBranch);
      }

      const noteData = await this.noteReader.read();

      const upstreamCounts = await this.fetchUpstreamCounts();

      const detectedPlanFile = PLAN_FILE_CANDIDATES.find((candidate) =>
        existsSync(pathJoin(this.path, candidate))
      );
      const nextHasPlanFile = detectedPlanFile !== undefined;
      const nextPlanFilePath = detectedPlanFile;

      const currentHash = this.calculateStateHash(newChanges);
      const stateChanged = currentHash !== this.previousStateHash;
      const noteChanged =
        noteData?.content !== this.aiNote || noteData?.timestamp !== this.aiNoteTimestamp;
      const planChanged =
        nextHasPlanFile !== this.hasPlanFile || nextPlanFilePath !== this.planFilePath;
      const upstreamChanged =
        upstreamCounts.ahead !== this.aheadCount || upstreamCounts.behind !== this.behindCount;

      if (
        !stateChanged &&
        !noteChanged &&
        !branchChanged &&
        !planChanged &&
        !upstreamChanged &&
        !forceRefresh
      ) {
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
      this.aheadCount = upstreamCounts.ahead;
      this.behindCount = upstreamCounts.behind;
      this._hasInitialStatus = true;

      this.emitUpdate();
    } catch (error) {
      if (error instanceof WorktreeRemovedError) {
        this.stop();
        this.callbacks.onRemoved?.(this.id);
        return;
      }

      const errorMessage = (error as Error).message || "";
      if (errorMessage.includes("index.lock")) {
        this.gitWatchRefreshPending = true;
        if (!this.gitWatchDebounceTimer) {
          this.gitWatchDebounceTimer = setTimeout(() => {
            this.gitWatchDebounceTimer = null;
            this.flushPendingGitWatchRefresh();
          }, this.gitWatchDebounceMs);
        }
        return;
      }

      this.mood = "error";
      this.emitUpdate();
      throw error;
    } finally {
      this._isUpdating = false;
      this.lastGitStatusCompletedAt = Date.now();
      if (this.gitWatchRefreshPending && !this.gitWatchDebounceTimer) {
        this.flushPendingGitWatchRefresh();
      }
    }
  }

  private async readCurrentBranch(): Promise<string | undefined> {
    const gitDir = getGitDir(this.path, { cache: true, logErrors: false });
    if (!gitDir) return undefined;

    try {
      const headContent = await readFile(pathJoin(gitDir, "HEAD"), "utf-8");
      const trimmed = headContent.trim();
      const prefix = "ref: refs/heads/";
      if (trimmed.startsWith(prefix)) {
        return trimmed.slice(prefix.length);
      }
      return undefined;
    } catch {
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

  private async fetchUpstreamCounts(): Promise<{
    ahead: number | undefined;
    behind: number | undefined;
  }> {
    if (!this._branch) {
      return { ahead: undefined, behind: undefined };
    }

    try {
      const wsl = this.wslInvocation;
      const git = wsl
        ? createWslHardenedGit(wsl, this._pollAbortController.signal)
        : createHardenedGit(this.path, this._pollAbortController.signal);
      const output = await git.raw(["rev-list", "--left-right", "--count", "HEAD...@{u}"]);
      const [aheadStr, behindStr] = output.trim().split(/\s+/);
      return {
        ahead: parseInt(aheadStr, 10) || 0,
        behind: parseInt(behindStr, 10) || 0,
      };
    } catch {
      return { ahead: undefined, behind: undefined };
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
    this.callbacks.onUpdate(this.getSnapshot());
  }
}
