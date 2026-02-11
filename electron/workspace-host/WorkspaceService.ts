import PQueue from "p-queue";
import { mkdir, writeFile, stat } from "fs/promises";
import { join as pathJoin, dirname, resolve as pathResolve, isAbsolute } from "path";
import { simpleGit, SimpleGit, BranchSummary } from "simple-git";
import type { Worktree, WorktreeChanges } from "../../shared/types/domain.js";
import type {
  WorkspaceHostEvent,
  WorktreeSnapshot,
  MonitorConfig,
  CreateWorktreeOptions,
  BranchInfo,
  PRServiceStatus,
} from "../../shared/types/workspace-host.js";
import { invalidateGitStatusCache, getWorktreeChangesWithStats } from "../utils/git.js";
import { getGitDir, clearGitDirCache } from "../utils/gitUtils.js";
import { WorktreeRemovedError } from "../utils/errorTypes.js";
import { categorizeWorktree } from "../services/worktree/mood.js";
import { extractIssueNumberSync, extractIssueNumber } from "../services/issueExtractor.js";
import { AdaptivePollingStrategy, NoteFileReader } from "../services/worktree/index.js";
import { GitHubAuth } from "../services/github/GitHubAuth.js";
import { pullRequestService } from "../services/PullRequestService.js";
import { events } from "../services/events.js";
import { MonitorState, NOTE_PATH } from "./types.js";
import { ensureSerializable } from "../../shared/utils/serialization.js";
import { waitForPathExists } from "../utils/fs.js";
import { GitFileWatcher } from "../utils/gitFileWatcher.js";

// Configuration
const DEFAULT_ACTIVE_WORKTREE_INTERVAL_MS = 2000;
const DEFAULT_BACKGROUND_WORKTREE_INTERVAL_MS = 10000;
const WORKTREE_LIST_CACHE_TTL_MS = 60_000;

interface RawWorktreeRecord {
  path: string;
  branch: string;
  bare: boolean;
  isMainWorktree: boolean;
  head?: string;
  isDetached?: boolean;
}

interface WorktreeListCacheEntry {
  expiresAt: number;
  worktrees: RawWorktreeRecord[];
}

async function ensureNoteFile(worktreePath: string): Promise<void> {
  const gitDir = getGitDir(worktreePath);
  if (!gitDir) {
    return;
  }

  const notePath = pathJoin(gitDir, NOTE_PATH);

  try {
    await stat(notePath);
  } catch {
    try {
      const canopyDir = dirname(notePath);
      await mkdir(canopyDir, { recursive: true });
      await writeFile(notePath, "", { flag: "wx" });
    } catch (createError) {
      const code = (createError as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") {
        console.warn("[WorkspaceHost] Failed to create note file:", notePath);
      }
    }
  }
}

export class WorkspaceService {
  private monitors = new Map<string, MonitorState>();
  private pollQueue = new PQueue({ concurrency: 3 });
  private mainBranch: string = "main";
  private activeWorktreeId: string | null = null;
  private pollIntervalActive: number = DEFAULT_ACTIVE_WORKTREE_INTERVAL_MS;
  private pollIntervalBackground: number = DEFAULT_BACKGROUND_WORKTREE_INTERVAL_MS;
  private adaptiveBackoff: boolean = true;
  private pollIntervalMax: number = 30000;
  private circuitBreakerThreshold: number = 3;
  private gitWatchEnabled: boolean = true;
  private gitWatchDebounceMs: number = 300;
  private git: SimpleGit | null = null;
  private pollingEnabled: boolean = true;
  private projectRootPath: string | null = null;
  private prEventUnsubscribers: (() => void)[] = [];
  private prServiceInitializedForPath: string | null = null;
  private worktreeListCache = new Map<string, WorktreeListCacheEntry>();
  private inFlightWorktreeList = new Map<string, Promise<RawWorktreeRecord[]>>();

  constructor(private readonly sendEvent: (event: WorkspaceHostEvent) => void) {}

  async loadProject(requestId: string, projectRootPath: string): Promise<void> {
    try {
      this.projectRootPath = projectRootPath;
      this.git = simpleGit(projectRootPath);

      const rawWorktrees = await this.listWorktreesFromGit();
      const worktrees = this.mapRawWorktrees(rawWorktrees);

      // Create monitors first (without waiting for git status)
      await this.syncMonitors(worktrees, this.activeWorktreeId, this.mainBranch, undefined, true);

      this.sendEvent({ type: "load-project-result", requestId, success: true });

      // Launch expensive post-load tasks in background so project switching isn't blocked.
      void Promise.allSettled([this.initializePRService(), this.refreshAll()]).then((results) => {
        const [prResult, refreshResult] = results;
        if (prResult?.status === "rejected") {
          console.warn("[WorkspaceHost] PR service initialization failed:", prResult.reason);
        }
        if (refreshResult?.status === "rejected") {
          console.warn("[WorkspaceHost] Initial worktree refresh failed:", refreshResult.reason);
        }
      });
    } catch (error) {
      this.sendEvent({
        type: "load-project-result",
        requestId,
        success: false,
        error: (error as Error).message,
      });
    }
  }

  private cloneRawWorktrees(rawWorktrees: RawWorktreeRecord[]): RawWorktreeRecord[] {
    return rawWorktrees.map((worktree) => ({ ...worktree }));
  }

  private mapRawWorktrees(rawWorktrees: RawWorktreeRecord[]): Worktree[] {
    return rawWorktrees.map((wt) => {
      let name: string;
      if (wt.isMainWorktree) {
        name = wt.path.split(/[/\\]/).pop() || "Main";
      } else if (wt.isDetached && wt.head) {
        name = wt.head.substring(0, 7);
      } else if (wt.branch) {
        name = wt.branch;
      } else {
        name = wt.path.split(/[/\\]/).pop() || "Worktree";
      }

      return {
        id: wt.path,
        path: wt.path,
        name: name,
        branch: wt.branch || undefined,
        head: wt.head,
        isDetached: wt.isDetached,
        isCurrent: false,
        isMainWorktree: wt.isMainWorktree,
        gitDir: getGitDir(wt.path) || undefined,
      };
    });
  }

  private getWorktreeCacheKey(): string | null {
    return this.projectRootPath ? pathResolve(this.projectRootPath) : null;
  }

  private getCachedWorktrees(cacheKey: string): RawWorktreeRecord[] | null {
    const cached = this.worktreeListCache.get(cacheKey);
    if (!cached) {
      return null;
    }

    if (cached.expiresAt <= Date.now()) {
      this.worktreeListCache.delete(cacheKey);
      return null;
    }

    return this.cloneRawWorktrees(cached.worktrees);
  }

  private setCachedWorktrees(cacheKey: string, worktrees: RawWorktreeRecord[]): void {
    this.worktreeListCache.set(cacheKey, {
      expiresAt: Date.now() + WORKTREE_LIST_CACHE_TTL_MS,
      worktrees: this.cloneRawWorktrees(worktrees),
    });
  }

  private invalidateCachedWorktrees(cacheKey?: string): void {
    if (cacheKey) {
      this.worktreeListCache.delete(cacheKey);
      this.inFlightWorktreeList.delete(cacheKey);
      return;
    }

    this.worktreeListCache.clear();
    this.inFlightWorktreeList.clear();
  }

  private async listWorktreesFromGit(options?: {
    forceRefresh?: boolean;
  }): Promise<RawWorktreeRecord[]> {
    if (!this.git) {
      throw new Error("Git not initialized");
    }
    const git = this.git;

    const cacheKey = this.getWorktreeCacheKey();
    const forceRefresh = options?.forceRefresh === true;
    if (cacheKey && !forceRefresh) {
      const cached = this.getCachedWorktrees(cacheKey);
      if (cached) {
        return cached;
      }

      const inFlight = this.inFlightWorktreeList.get(cacheKey);
      if (inFlight) {
        return inFlight;
      }
    }

    const fetchPromise = (async () => {
      const output = await git.raw(["worktree", "list", "--porcelain"]);
      const worktrees: RawWorktreeRecord[] = [];

      let currentWorktree: Partial<{
        path: string;
        branch: string;
        bare: boolean;
        head: string;
        isDetached: boolean;
      }> = {};

      const pushWorktree = () => {
        if (currentWorktree.path) {
          worktrees.push({
            path: currentWorktree.path,
            branch: currentWorktree.branch || "",
            bare: currentWorktree.bare || false,
            isMainWorktree: worktrees.length === 0,
            head: currentWorktree.isDetached ? currentWorktree.head : undefined,
            isDetached: currentWorktree.isDetached,
          });
        }
        currentWorktree = {};
      };

      for (const line of output.split("\n")) {
        if (line.startsWith("worktree ")) {
          currentWorktree.path = line.replace("worktree ", "").trim();
        } else if (line.startsWith("HEAD ")) {
          currentWorktree.head = line.replace("HEAD ", "").trim();
        } else if (line.startsWith("branch ")) {
          currentWorktree.branch = line.replace("branch ", "").replace("refs/heads/", "").trim();
        } else if (line.startsWith("bare")) {
          currentWorktree.bare = true;
        } else if (line.trim() === "detached") {
          currentWorktree.isDetached = true;
        } else if (line.trim() === "") {
          pushWorktree();
        }
      }

      pushWorktree();

      if (cacheKey) {
        this.setCachedWorktrees(cacheKey, worktrees);
      }

      return worktrees;
    })();

    if (cacheKey) {
      this.inFlightWorktreeList.set(cacheKey, fetchPromise);
    }

    try {
      return this.cloneRawWorktrees(await fetchPromise);
    } finally {
      if (cacheKey) {
        this.inFlightWorktreeList.delete(cacheKey);
      }
    }
  }

  async syncMonitors(
    worktrees: Worktree[],
    activeWorktreeId: string | null,
    mainBranch: string,
    monitorConfig?: MonitorConfig,
    skipInitialGitStatus: boolean = false
  ): Promise<void> {
    this.mainBranch = mainBranch;
    this.activeWorktreeId = activeWorktreeId;

    if (monitorConfig?.pollIntervalActive !== undefined) {
      this.pollIntervalActive = monitorConfig.pollIntervalActive;
    }
    if (monitorConfig?.pollIntervalBackground !== undefined) {
      this.pollIntervalBackground = monitorConfig.pollIntervalBackground;
    }
    if (monitorConfig?.adaptiveBackoff !== undefined) {
      this.adaptiveBackoff = monitorConfig.adaptiveBackoff;
    }
    if (monitorConfig?.pollIntervalMax !== undefined) {
      this.pollIntervalMax = monitorConfig.pollIntervalMax;
    }
    if (monitorConfig?.circuitBreakerThreshold !== undefined) {
      this.circuitBreakerThreshold = monitorConfig.circuitBreakerThreshold;
    }
    if (monitorConfig?.gitWatchEnabled !== undefined) {
      this.gitWatchEnabled = monitorConfig.gitWatchEnabled;
    }
    if (monitorConfig?.gitWatchDebounceMs !== undefined) {
      this.gitWatchDebounceMs = monitorConfig.gitWatchDebounceMs;
    }

    const currentIds = new Set(worktrees.map((wt) => wt.id));

    // Remove stale monitors
    for (const [id, monitor] of this.monitors) {
      if (!currentIds.has(id)) {
        if (monitor.isMainWorktree) {
          console.warn("[WorkspaceHost] Blocked removal of main worktree monitor");
          continue;
        }

        // Clear activeWorktreeId if this was the active worktree
        if (this.activeWorktreeId === id) {
          this.activeWorktreeId = null;
        }

        this.stopMonitor(monitor);
        this.monitors.delete(id);
        clearGitDirCache(monitor.path);
        invalidateGitStatusCache(monitor.path);
        this.sendEvent({ type: "worktree-removed", worktreeId: id });
        events.emit("sys:worktree:remove", { worktreeId: id, timestamp: Date.now() });
      }
    }

    // Create or update monitors
    for (const wt of worktrees) {
      const existingMonitor = this.monitors.get(wt.id);
      const isActive = wt.id === activeWorktreeId;

      if (existingMonitor) {
        // Check if branch changed - if so, re-extract issue number
        const branchChanged = existingMonitor.branch !== wt.branch;
        const isCurrentChanged = existingMonitor.isCurrent !== isActive;
        existingMonitor.branch = wt.branch;
        existingMonitor.name = wt.name;
        existingMonitor.isCurrent = isActive;
        const interval = isActive ? this.pollIntervalActive : this.pollIntervalBackground;
        existingMonitor.pollingInterval = interval;
        existingMonitor.pollingStrategy.setBaseInterval(interval);
        existingMonitor.pollingStrategy.updateConfig(
          this.adaptiveBackoff,
          this.pollIntervalMax,
          this.circuitBreakerThreshold
        );

        // Update watcher if branch changed
        if (branchChanged && wt.branch && existingMonitor.gitWatcher) {
          this.updateMonitorWatcher(existingMonitor);
        }

        // Emit update if isCurrent changed
        if (isCurrentChanged && existingMonitor.hasInitialStatus) {
          this.emitUpdate(existingMonitor);
        }

        // Re-extract issue number when branch changes
        if (branchChanged && wt.branch) {
          const syncIssueNumber = extractIssueNumberSync(wt.branch, wt.name);
          if (syncIssueNumber) {
            existingMonitor.issueNumber = syncIssueNumber;
          } else {
            // Clear immediately, then try async extraction
            existingMonitor.issueNumber = undefined;
            void this.extractIssueNumberAsync(existingMonitor, wt.branch, wt.name);
          }
          // Clear stale issue title - will be repopulated by PR service
          existingMonitor.issueTitle = undefined;
          // Emit update if initial status has completed
          if (existingMonitor.hasInitialStatus) {
            this.emitUpdate(existingMonitor);
          }
        } else if (branchChanged && !wt.branch) {
          // Branch cleared (e.g., detached HEAD) - clear issue number and title
          existingMonitor.issueNumber = undefined;
          existingMonitor.issueTitle = undefined;
          if (existingMonitor.hasInitialStatus) {
            this.emitUpdate(existingMonitor);
          }
        }
      } else {
        await ensureNoteFile(wt.path);
        const issueNumber = wt.branch ? extractIssueNumberSync(wt.branch, wt.name) : null;
        const interval = isActive ? this.pollIntervalActive : this.pollIntervalBackground;

        // Compute createdAt from directory birthtime (macOS/Windows) or ctime (Linux fallback)
        let createdAt: number | undefined;
        try {
          const stats = await stat(wt.path);
          createdAt = stats.birthtimeMs > 0 ? stats.birthtimeMs : stats.ctimeMs;
        } catch {
          // If stat fails, leave undefined
        }

        const monitor: MonitorState = {
          id: wt.id,
          path: wt.path,
          name: wt.name,
          branch: wt.branch,
          isCurrent: isActive,
          isMainWorktree: Boolean(wt.isMainWorktree),
          gitDir: wt.gitDir,
          worktreeId: wt.id,
          worktreeChanges: null,
          mood: "stable",
          modifiedCount: 0,
          lastActivityTimestamp: null,
          createdAt,
          issueNumber: issueNumber ?? undefined,
          pollingTimer: null,
          resumeTimer: null,
          pollingInterval: interval,
          isRunning: false,
          isUpdating: false,
          pollingEnabled: true,
          hasInitialStatus: false,
          previousStateHash: "",
          pollingStrategy: new AdaptivePollingStrategy({ baseInterval: interval }),
          noteReader: new NoteFileReader(wt.path),
          gitWatcher: null,
          gitWatchDebounceTimer: null,
          gitWatchEnabled: this.gitWatchEnabled,
        };

        monitor.pollingStrategy.updateConfig(
          this.adaptiveBackoff,
          this.pollIntervalMax,
          this.circuitBreakerThreshold
        );

        this.monitors.set(wt.id, monitor);

        if (skipInitialGitStatus) {
          // Just mark as running - refreshAll() will do git status later
          monitor.isRunning = true;
          monitor.pollingEnabled = true;
          // Start watcher even when skipping initial git status
          if (monitor.gitWatchEnabled) {
            this.startMonitorWatcher(monitor);
          }
        } else {
          await this.startMonitor(monitor);
        }

        // Extract issue number asynchronously if not found synchronously
        if (wt.branch && !issueNumber) {
          void this.extractIssueNumberAsync(monitor, wt.branch, wt.name);
        }
      }
    }
  }

  private async extractIssueNumberAsync(
    monitor: MonitorState,
    branchName: string,
    folderName?: string
  ): Promise<void> {
    try {
      const issueNumber = await extractIssueNumber(branchName, folderName);
      // Guard against race condition: only update if branch hasn't changed
      if (issueNumber && monitor.isRunning && monitor.branch === branchName) {
        monitor.issueNumber = issueNumber;
        // Only emit if initial git status has completed to avoid partial snapshots
        if (monitor.hasInitialStatus) {
          this.emitUpdate(monitor);
        }
      }
    } catch {
      // Silently ignore extraction errors
    }
  }

  private async startMonitor(monitor: MonitorState): Promise<void> {
    if (monitor.isRunning) {
      return;
    }

    monitor.isRunning = true;
    monitor.pollingEnabled = true;

    if (monitor.gitWatchEnabled && !monitor.gitWatcher) {
      this.startMonitorWatcher(monitor);
    }

    await this.updateGitStatus(monitor, true);

    if (monitor.isRunning && this.pollingEnabled) {
      this.scheduleNextPoll(monitor);
    }
  }

  private stopMonitor(monitor: MonitorState): void {
    monitor.isRunning = false;
    if (monitor.pollingTimer) {
      clearTimeout(monitor.pollingTimer);
      monitor.pollingTimer = null;
    }
    if (monitor.resumeTimer) {
      clearTimeout(monitor.resumeTimer);
      monitor.resumeTimer = null;
    }
    this.stopMonitorWatcher(monitor);
  }

  private startMonitorWatcher(monitor: MonitorState): void {
    if (!this.gitWatchEnabled || monitor.gitWatcher) {
      return;
    }

    const watcher = new GitFileWatcher({
      worktreePath: monitor.path,
      branch: monitor.branch,
      debounceMs: this.gitWatchDebounceMs,
      onChange: () => this.handleGitFileChange(monitor),
    });

    const started = watcher.start();
    if (started) {
      monitor.gitWatcher = () => watcher.dispose();
    } else {
      watcher.dispose();
    }
  }

  private stopMonitorWatcher(monitor: MonitorState): void {
    if (monitor.gitWatcher) {
      monitor.gitWatcher();
      monitor.gitWatcher = null;
    }
    if (monitor.gitWatchDebounceTimer) {
      clearTimeout(monitor.gitWatchDebounceTimer);
      monitor.gitWatchDebounceTimer = null;
    }
  }

  private updateMonitorWatcher(monitor: MonitorState): void {
    this.stopMonitorWatcher(monitor);
    if (monitor.isRunning && monitor.gitWatchEnabled) {
      this.startMonitorWatcher(monitor);
    }
  }

  private handleGitFileChange(monitor: MonitorState): void {
    if (!monitor.isRunning) {
      return;
    }

    invalidateGitStatusCache(monitor.path);

    if (monitor.isUpdating) {
      // Schedule a trailing refresh after the current update finishes
      if (!monitor.gitWatchDebounceTimer) {
        monitor.gitWatchDebounceTimer = setTimeout(() => {
          monitor.gitWatchDebounceTimer = null;
          if (monitor.isRunning && !monitor.isUpdating) {
            invalidateGitStatusCache(monitor.path);
            void this.updateGitStatus(monitor, true);
          }
        }, this.gitWatchDebounceMs);
      }
      return;
    }

    void this.updateGitStatus(monitor, true);
  }

  private scheduleCircuitBreakerRetry(monitor: MonitorState): void {
    if (!monitor.isRunning || !monitor.pollingEnabled || !this.pollingEnabled) {
      return;
    }

    if (!monitor.pollingStrategy.isCircuitBreakerTripped()) {
      return;
    }

    if (monitor.pollingTimer || monitor.resumeTimer) {
      return;
    }

    const cooldown = Math.max(
      this.pollIntervalMax,
      monitor.pollingStrategy.calculateNextInterval()
    );
    const jitter = Math.random() * 2000;

    monitor.resumeTimer = setTimeout(() => {
      monitor.resumeTimer = null;
      if (monitor.isRunning && monitor.pollingEnabled && this.pollingEnabled) {
        void this.poll(monitor, true);
      }
    }, cooldown + jitter);
  }

  private scheduleNextPoll(monitor: MonitorState): void {
    if (!monitor.isRunning || !monitor.pollingEnabled || !this.pollingEnabled) {
      return;
    }

    if (monitor.pollingStrategy.isCircuitBreakerTripped()) {
      this.scheduleCircuitBreakerRetry(monitor);
      return;
    }

    if (monitor.pollingTimer) {
      return;
    }

    const nextInterval = monitor.pollingStrategy.calculateNextInterval();
    const jitterRange = Math.min(2000, Math.floor(nextInterval * 0.2));
    const jitter = jitterRange > 0 ? Math.floor(Math.random() * jitterRange) : 0;
    const delayMs = nextInterval + jitter;

    monitor.pollingTimer = setTimeout(() => {
      monitor.pollingTimer = null;
      void this.poll(monitor);
    }, delayMs);
  }

  private async poll(monitor: MonitorState, force: boolean = false): Promise<void> {
    if (!monitor.isRunning || (!force && monitor.pollingStrategy.isCircuitBreakerTripped())) {
      return;
    }

    let tripped = false;
    const queuedAt = Date.now();

    const executePoll = async (): Promise<void> => {
      const startTime = Date.now();
      const queueDelayMs = Math.max(0, startTime - queuedAt);

      try {
        await this.updateGitStatus(monitor, monitor.isCurrent);
        monitor.pollingStrategy.recordSuccess(Date.now() - startTime, queueDelayMs);
      } catch (error) {
        tripped = monitor.pollingStrategy.recordFailure(Date.now() - startTime, queueDelayMs);

        if (tripped) {
          monitor.mood = "error";
          monitor.summary = "⚠️ Polling delayed after consecutive failures";
          this.emitUpdate(monitor);
        }
      }
    };

    try {
      await this.pollQueue.add(() => executePoll());
    } catch {
      // Queue execution failed
    }

    if (tripped) {
      this.scheduleCircuitBreakerRetry(monitor);
      return;
    }

    if (monitor.isRunning && monitor.pollingEnabled && this.pollingEnabled) {
      this.scheduleNextPoll(monitor);
    }
  }

  private async updateGitStatus(
    monitor: MonitorState,
    forceRefresh: boolean = false
  ): Promise<void> {
    if (monitor.isUpdating) {
      return;
    }

    monitor.isUpdating = true;

    try {
      if (forceRefresh) {
        invalidateGitStatusCache(monitor.path);
      }

      // Use polling interval as cache TTL to prevent stale data between polls
      // Subtract 500ms buffer to ensure cache expires before next poll
      // Guard against non-finite intervals (NaN, Infinity) that would break cache expiry
      const pollingInterval = monitor.pollingInterval;
      const cacheTTL =
        Number.isFinite(pollingInterval) && pollingInterval > 0
          ? Math.max(500, pollingInterval - 500)
          : undefined; // Fall back to cache default TTL
      const newChanges = await getWorktreeChangesWithStats(monitor.path, {
        forceRefresh,
        cacheTTL,
      });

      if (!monitor.isRunning) {
        return;
      }

      const noteData = await monitor.noteReader.read();
      const currentHash = this.calculateStateHash(newChanges);
      const stateChanged = currentHash !== monitor.previousStateHash;
      const noteChanged =
        noteData?.content !== monitor.aiNote || noteData?.timestamp !== monitor.aiNoteTimestamp;

      if (!stateChanged && !noteChanged && !forceRefresh) {
        return;
      }

      const isInitialLoad = monitor.previousStateHash === "";
      const isNowClean = newChanges.changedFileCount === 0;
      const hasPendingChanges = newChanges.changedFileCount > 0;
      const shouldUpdateTimestamp =
        (stateChanged && !isInitialLoad) || (isInitialLoad && hasPendingChanges);

      if (shouldUpdateTimestamp) {
        monitor.lastActivityTimestamp = Date.now();
      }

      if (isInitialLoad && isNowClean && monitor.lastActivityTimestamp === null) {
        monitor.lastActivityTimestamp = newChanges.lastCommitTimestampMs ?? null;
      }

      // Use last commit message as summary
      if (
        isNowClean ||
        isInitialLoad ||
        (monitor.worktreeChanges && monitor.worktreeChanges.changedFileCount === 0)
      ) {
        monitor.summary = await this.fetchLastCommitMessage(monitor);
      }

      let nextMood = monitor.mood;
      try {
        nextMood = await categorizeWorktree(
          {
            id: monitor.id,
            path: monitor.path,
            name: monitor.name,
            branch: monitor.branch,
            isCurrent: monitor.isCurrent,
          },
          newChanges || undefined,
          this.mainBranch
        );
      } catch {
        nextMood = "error";
      }

      monitor.previousStateHash = currentHash;
      monitor.worktreeChanges = newChanges;
      monitor.changes = newChanges.changes;
      monitor.modifiedCount = newChanges.changedFileCount;
      monitor.mood = nextMood;
      monitor.aiNote = noteData?.content;
      monitor.aiNoteTimestamp = noteData?.timestamp;
      monitor.hasInitialStatus = true;

      this.emitUpdate(monitor);
    } catch (error) {
      if (error instanceof WorktreeRemovedError) {
        // Worktree was deleted externally - trigger cleanup instead of showing error state
        this.handleExternalWorktreeRemoval(monitor);
        return;
      }

      const errorMessage = (error as Error).message || "";
      if (errorMessage.includes("index.lock")) {
        // Git index locked, skip this cycle
        return;
      }

      monitor.mood = "error";
      this.emitUpdate(monitor);
      throw error;
    } finally {
      monitor.isUpdating = false;
    }
  }

  private calculateStateHash(changes: WorktreeChanges): string {
    const hashInput = changes.changes
      .map((c) => `${c.path}:${c.status}:${c.insertions ?? 0}:${c.deletions ?? 0}`)
      .sort()
      .join("|");
    return hashInput;
  }

  private async fetchLastCommitMessage(monitor: MonitorState): Promise<string> {
    if (monitor.worktreeChanges?.lastCommitMessage) {
      const firstLine = monitor.worktreeChanges.lastCommitMessage.split("\n")[0].trim();
      return `✅ ${firstLine}`;
    }

    try {
      const git = simpleGit(monitor.path);
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

  private createSnapshot(monitor: MonitorState): WorktreeSnapshot {
    const snapshot: WorktreeSnapshot = {
      id: monitor.id,
      path: monitor.path,
      name: monitor.name,
      branch: monitor.branch,
      isCurrent: monitor.isCurrent,
      isMainWorktree: monitor.isMainWorktree,
      gitDir: monitor.gitDir,
      summary: monitor.summary,
      modifiedCount: monitor.modifiedCount,
      changes: monitor.changes,
      mood: monitor.mood,
      lastActivityTimestamp: monitor.lastActivityTimestamp,
      createdAt: monitor.createdAt,
      aiNote: monitor.aiNote,
      aiNoteTimestamp: monitor.aiNoteTimestamp,
      issueNumber: monitor.issueNumber,
      prNumber: monitor.prNumber,
      prUrl: monitor.prUrl,
      prState: monitor.prState,
      prTitle: monitor.prTitle,
      issueTitle: monitor.issueTitle,
      worktreeChanges: monitor.worktreeChanges,
      worktreeId: monitor.worktreeId,
      timestamp: Date.now(),
    };

    return ensureSerializable(snapshot) as WorktreeSnapshot;
  }

  private emitUpdate(monitor: MonitorState): void {
    const snapshot = this.createSnapshot(monitor);
    this.sendEvent({ type: "worktree-update", worktree: snapshot });
    events.emit("sys:worktree:update", snapshot as any);
  }

  private handleExternalWorktreeRemoval(monitor: MonitorState): void {
    // Safeguard: Never remove main worktree
    if (monitor.isMainWorktree) {
      console.warn("[WorkspaceHost] Blocked removal of main worktree monitor");
      monitor.mood = "error";
      monitor.summary = "⚠️ Directory not accessible";
      this.emitUpdate(monitor);
      return;
    }

    const worktreeId = monitor.id;

    // Guard against duplicate removal (race with syncMonitors or deleteWorktree)
    if (!this.monitors.has(worktreeId)) {
      return;
    }

    // Clear activeWorktreeId if this was the active worktree
    if (this.activeWorktreeId === worktreeId) {
      this.activeWorktreeId = null;
    }

    // Stop the monitor and remove from map
    this.stopMonitor(monitor);
    this.monitors.delete(worktreeId);

    // Clear git caches to prevent stale data if path is reused
    clearGitDirCache(monitor.path);
    invalidateGitStatusCache(monitor.path);

    // Emit removal events for frontend cleanup
    this.sendEvent({ type: "worktree-removed", worktreeId });
    events.emit("sys:worktree:remove", { worktreeId, timestamp: Date.now() });

    console.log(
      `[WorkspaceHost] Worktree deleted externally, removed monitor: ${monitor.name} (${worktreeId})`
    );
  }

  getAllStates(requestId: string): void {
    const states: WorktreeSnapshot[] = [];
    for (const monitor of this.monitors.values()) {
      states.push(this.createSnapshot(monitor));
    }
    this.sendEvent({ type: "all-states", requestId, states });
  }

  getMonitor(requestId: string, worktreeId: string): void {
    const monitor = this.monitors.get(worktreeId);
    if (!monitor) {
      this.sendEvent({ type: "monitor", requestId, state: null });
      return;
    }

    this.sendEvent({
      type: "monitor",
      requestId,
      state: this.createSnapshot(monitor),
    });
  }

  setActiveWorktree(requestId: string, worktreeId: string): void {
    this.activeWorktreeId = worktreeId;

    for (const [id, monitor] of this.monitors) {
      const isActive = id === worktreeId;
      const interval = isActive ? this.pollIntervalActive : this.pollIntervalBackground;
      monitor.pollingInterval = interval;
      monitor.pollingStrategy.setBaseInterval(interval);
      monitor.isCurrent = isActive;
      if (monitor.hasInitialStatus) {
        this.emitUpdate(monitor);
      }
    }

    this.sendEvent({ type: "set-active-result", requestId, success: true });
  }

  async refresh(requestId: string, worktreeId?: string): Promise<void> {
    try {
      if (worktreeId) {
        const monitor = this.monitors.get(worktreeId);
        if (monitor) {
          if (monitor.pollingStrategy.isCircuitBreakerTripped()) {
            monitor.pollingStrategy.reset();
          }
          await this.updateGitStatus(monitor, true);
        }
      } else {
        // Re-discover worktrees to find new/removed ones
        await this.discoverAndSyncWorktrees();
        await this.refreshAll();
      }
      this.sendEvent({ type: "refresh-result", requestId, success: true });
    } catch (error) {
      this.sendEvent({
        type: "refresh-result",
        requestId,
        success: false,
        error: (error as Error).message,
      });
    }
  }

  private async discoverAndSyncWorktrees(): Promise<void> {
    if (!this.git) {
      return;
    }

    const rawWorktrees = await this.listWorktreesFromGit({ forceRefresh: true });
    const worktrees = this.mapRawWorktrees(rawWorktrees);

    await this.syncMonitors(worktrees, this.activeWorktreeId, this.mainBranch, undefined, true);
  }

  private async refreshAll(): Promise<void> {
    const promises = Array.from(this.monitors.values()).map(async (monitor) => {
      try {
        await this.updateGitStatus(monitor, true);
      } finally {
        // Schedule polling if not already scheduled and not currently updating
        // This ensures monitors created with skipInitialGitStatus start polling even if updateGitStatus fails
        if (
          monitor.isRunning &&
          this.pollingEnabled &&
          !monitor.pollingTimer &&
          !monitor.isUpdating
        ) {
          this.scheduleNextPoll(monitor);
        }
      }
    });
    await Promise.all(promises);
  }

  async createWorktree(
    requestId: string,
    rootPath: string,
    options: CreateWorktreeOptions
  ): Promise<void> {
    try {
      const git = simpleGit(rootPath);
      const {
        baseBranch,
        newBranch,
        path,
        fromRemote = false,
        useExistingBranch = false,
      } = options;

      if (useExistingBranch) {
        await git.raw(["worktree", "add", path, newBranch]);
      } else if (fromRemote) {
        await git.raw(["worktree", "add", "-b", newBranch, "--track", path, baseBranch]);
      } else {
        await git.raw(["worktree", "add", "-b", newBranch, path, baseBranch]);
      }

      // Wait for the worktree directory to be accessible before proceeding.
      // This prevents race conditions where git completes but the filesystem
      // hasn't flushed the directory creation to disk yet, which can cause
      // ENOENT errors when spawning terminals with the worktree as cwd.
      // Normalize to absolute path to avoid cwd mismatch between git and fs.access
      const absolutePath = isAbsolute(path) ? path : pathResolve(rootPath, path);
      await waitForPathExists(absolutePath, {
        timeoutMs: 5000,
        initialRetryDelayMs: 50,
        maxRetryDelayMs: 800,
      });

      await ensureNoteFile(path);

      // Refresh worktree list
      this.invalidateCachedWorktrees(pathResolve(rootPath));
      const updatedWorktrees = await this.listWorktreesFromGit({ forceRefresh: true });
      const worktreeList = this.mapRawWorktrees(updatedWorktrees);

      await this.syncMonitors(worktreeList, this.activeWorktreeId, this.mainBranch);

      // Find the created worktree in the updated list to get the canonical ID
      const createdWorktree = worktreeList.find((wt) => wt.branch === newBranch);
      const canonicalWorktreeId = createdWorktree?.id || path;

      this.sendEvent({
        type: "create-worktree-result",
        requestId,
        success: true,
        worktreeId: canonicalWorktreeId,
      });
    } catch (error) {
      this.sendEvent({
        type: "create-worktree-result",
        requestId,
        success: false,
        error: (error as Error).message,
      });
    }
  }

  async deleteWorktree(
    requestId: string,
    worktreeId: string,
    force: boolean = false,
    deleteBranch: boolean = false
  ): Promise<void> {
    try {
      const monitor = this.monitors.get(worktreeId);
      if (!monitor) {
        throw new Error(`Worktree not found: ${worktreeId}`);
      }

      if (monitor.isMainWorktree) {
        throw new Error("Cannot delete the main worktree");
      }

      if (monitor.isCurrent) {
        throw new Error("Cannot delete the currently active worktree");
      }

      if (!force && (monitor.worktreeChanges?.changedFileCount ?? 0) > 0) {
        throw new Error("Worktree has uncommitted changes. Use force delete to proceed.");
      }

      const branchToDelete = deleteBranch ? monitor.branch : undefined;

      if (deleteBranch && !monitor.branch) {
        throw new Error("Cannot delete branch: worktree has no associated branch (detached HEAD)");
      }

      if (this.git) {
        const args = ["worktree", "remove"];
        if (force) {
          args.push("--force");
        }
        args.push(monitor.path);
        await this.git.raw(args);
        clearGitDirCache(monitor.path);

        if (branchToDelete) {
          try {
            await this.git.raw(["branch", "-d", branchToDelete]);
            console.log(`[WorkspaceHost] Deleted branch: ${branchToDelete} (safe)`);
          } catch (branchError) {
            const errorMsg = (branchError as Error).message || "";
            if (errorMsg.includes("not found")) {
              console.log(`[WorkspaceHost] Branch already deleted: ${branchToDelete}`);
            } else if (errorMsg.includes("not fully merged")) {
              throw new Error(
                `Branch '${branchToDelete}' has unmerged changes. Enable force delete to remove it.`
              );
            } else if (errorMsg.includes("checked out at") || errorMsg.includes("Cannot delete")) {
              throw new Error(
                `Cannot delete branch '${branchToDelete}': ${errorMsg.split("\n")[0]}`
              );
            } else {
              throw new Error(`Failed to delete branch '${branchToDelete}': ${errorMsg}`);
            }
          }
        }
      }

      this.stopMonitor(monitor);
      this.monitors.delete(worktreeId);

      this.sendEvent({ type: "worktree-removed", worktreeId });
      this.sendEvent({ type: "delete-worktree-result", requestId, success: true });
    } catch (error) {
      this.sendEvent({
        type: "delete-worktree-result",
        requestId,
        success: false,
        error: (error as Error).message,
      });
    }
  }

  async listBranches(requestId: string, rootPath: string): Promise<void> {
    try {
      const git = simpleGit(rootPath);
      const summary: BranchSummary = await git.branch(["-a"]);
      const branches: BranchInfo[] = [];

      for (const [branchName, branchDetail] of Object.entries(summary.branches)) {
        if (branchName.includes("HEAD ->") || branchName.endsWith("/HEAD")) {
          continue;
        }

        const isRemote = branchName.startsWith("remotes/");
        const displayName = isRemote ? branchName.replace("remotes/", "") : branchName;

        branches.push({
          name: displayName,
          current: branchDetail.current,
          commit: branchDetail.commit,
          remote: isRemote ? displayName.split("/")[0] : undefined,
        });
      }

      this.sendEvent({ type: "list-branches-result", requestId, branches });
    } catch (error) {
      this.sendEvent({
        type: "list-branches-result",
        requestId,
        branches: [],
        error: (error as Error).message,
      });
    }
  }

  async getFileDiff(
    requestId: string,
    cwd: string,
    filePath: string,
    status: string
  ): Promise<void> {
    try {
      // Validate file path for all statuses (not just untracked/added)
      const { resolve, normalize, sep, isAbsolute } = await import("path");

      if (isAbsolute(filePath)) {
        throw new Error("Absolute paths are not allowed");
      }

      const normalizedPath = normalize(filePath);
      if (normalizedPath.includes("..") || normalizedPath.startsWith(sep)) {
        throw new Error("Path traversal detected");
      }

      const git = simpleGit(cwd);

      if (status === "untracked" || status === "added") {
        const { readFile } = await import("fs/promises");
        const absolutePath = resolve(cwd, normalizedPath);
        const buffer = await readFile(absolutePath);

        // Simple binary check
        let isBinary = false;
        const checkLength = Math.min(buffer.length, 8192);
        for (let i = 0; i < checkLength; i++) {
          if (buffer[i] === 0) {
            isBinary = true;
            break;
          }
        }

        if (isBinary) {
          this.sendEvent({ type: "get-file-diff-result", requestId, diff: "BINARY_FILE" });
          return;
        }

        const content = buffer.toString("utf-8");
        const lines = content.split("\n");

        const diff = `diff --git a/${normalizedPath} b/${normalizedPath}
new file mode 100644
--- /dev/null
+++ b/${normalizedPath}
@@ -0,0 +1,${lines.length} @@
${lines.map((l) => "+" + l).join("\n")}`;

        this.sendEvent({ type: "get-file-diff-result", requestId, diff });
        return;
      }

      const diff = await git.diff(["HEAD", "--no-color", "--", normalizedPath]);

      if (diff.includes("Binary files")) {
        this.sendEvent({ type: "get-file-diff-result", requestId, diff: "BINARY_FILE" });
        return;
      }

      if (!diff.trim()) {
        this.sendEvent({ type: "get-file-diff-result", requestId, diff: "NO_CHANGES" });
        return;
      }

      this.sendEvent({ type: "get-file-diff-result", requestId, diff });
    } catch (error) {
      this.sendEvent({
        type: "get-file-diff-result",
        requestId,
        diff: "",
        error: (error as Error).message,
      });
    }
  }

  setPollingEnabled(enabled: boolean): void {
    if (this.pollingEnabled === enabled) return;

    this.pollingEnabled = enabled;

    if (!enabled) {
      for (const monitor of this.monitors.values()) {
        monitor.pollingEnabled = false;
        if (monitor.pollingTimer) {
          clearTimeout(monitor.pollingTimer);
          monitor.pollingTimer = null;
        }
      }
    } else {
      for (const monitor of this.monitors.values()) {
        monitor.pollingStrategy.reset();
        monitor.pollingEnabled = true;

        if (monitor.isRunning && !monitor.pollingStrategy.isCircuitBreakerTripped()) {
          const jitter = Math.random() * 2000;
          monitor.resumeTimer = setTimeout(() => {
            monitor.resumeTimer = null;
            if (monitor.isRunning && monitor.pollingEnabled) {
              this.scheduleNextPoll(monitor);
            }
          }, jitter);
        }
      }
    }
  }

  getPRStatus(requestId: string): void {
    const status = pullRequestService.getStatus();
    const prStatus: PRServiceStatus = {
      isRunning: status.isPolling,
      candidateCount: status.candidateCount,
      resolvedPRCount: status.resolvedCount,
      lastCheckTime: undefined,
      circuitBreakerTripped: !status.isEnabled,
    };
    this.sendEvent({ type: "get-pr-status-result", requestId, status: prStatus });
  }

  resetPRState(requestId: string): void {
    pullRequestService.reset();
    if (this.projectRootPath) {
      pullRequestService.initialize(this.projectRootPath);
      pullRequestService.start();
    }
    this.sendEvent({ type: "reset-pr-state-result", requestId, success: true });
  }

  updateGitHubToken(token: string | null): void {
    GitHubAuth.setMemoryToken(token);
    if (token) {
      pullRequestService.refresh();
    } else {
      pullRequestService.reset();
      if (this.projectRootPath) {
        pullRequestService.initialize(this.projectRootPath);
        pullRequestService.start();
      }
    }
  }

  private initializePRService(): Promise<void> {
    if (!this.projectRootPath) {
      return Promise.resolve();
    }

    // Skip if already initialized for this project (prevents reset on duplicate loadProject calls)
    if (this.prServiceInitializedForPath === this.projectRootPath) {
      return Promise.resolve();
    }

    this.cleanupPRService();

    pullRequestService.initialize(this.projectRootPath);

    this.prServiceInitializedForPath = this.projectRootPath;

    // Register event handlers BEFORE seeding to avoid race conditions
    this.prEventUnsubscribers.push(
      events.on("sys:pr:detected", (data: any) => {
        const monitor = this.monitors.get(data.worktreeId);
        if (monitor) {
          monitor.prNumber = data.prNumber;
          monitor.prUrl = data.prUrl;
          monitor.prState = data.prState;
          monitor.prTitle = data.prTitle;
          monitor.issueTitle = data.issueTitle;
          // Only emit if initial git status has completed to avoid partial snapshots
          if (monitor.hasInitialStatus) {
            this.emitUpdate(monitor);
          }
        }

        this.sendEvent({
          type: "pr-detected",
          worktreeId: data.worktreeId,
          prNumber: data.prNumber,
          prUrl: data.prUrl,
          prState: data.prState,
          prTitle: data.prTitle,
          issueNumber: data.issueNumber,
          issueTitle: data.issueTitle,
        });
      })
    );

    this.prEventUnsubscribers.push(
      events.on("sys:issue:detected", (data: any) => {
        const monitor = this.monitors.get(data.worktreeId);
        if (monitor) {
          monitor.issueTitle = data.issueTitle;
          // Only emit if initial git status has completed to avoid partial snapshots
          if (monitor.hasInitialStatus) {
            this.emitUpdate(monitor);
          }
        }

        this.sendEvent({
          type: "issue-detected",
          worktreeId: data.worktreeId,
          issueNumber: data.issueNumber,
          issueTitle: data.issueTitle,
        });
      })
    );

    this.prEventUnsubscribers.push(
      events.on("sys:pr:cleared", (data: any) => {
        const monitor = this.monitors.get(data.worktreeId);
        if (monitor) {
          monitor.prNumber = undefined;
          monitor.prUrl = undefined;
          monitor.prState = undefined;
          monitor.prTitle = undefined;
          // Only emit if initial git status has completed to avoid partial snapshots
          if (monitor.hasInitialStatus) {
            this.emitUpdate(monitor);
          }
        }

        this.sendEvent({
          type: "pr-cleared",
          worktreeId: data.worktreeId,
        });
      })
    );

    // Seed PR service with existing monitors as candidates
    // This is necessary because worktree:update events fire before PR service starts
    // Now safe to emit since handlers are registered above
    for (const monitor of this.monitors.values()) {
      if (monitor.branch && monitor.branch !== "main" && monitor.branch !== "master") {
        events.emit("sys:worktree:update", {
          worktreeId: monitor.worktreeId,
          branch: monitor.branch,
          issueNumber: monitor.issueNumber,
        } as any);
      }
    }

    return pullRequestService.start();
  }

  private cleanupPRService(): void {
    pullRequestService.reset();
    for (const unsubscribe of this.prEventUnsubscribers) {
      unsubscribe();
    }
    this.prEventUnsubscribers = [];
    this.prServiceInitializedForPath = null;
  }

  async onProjectSwitch(requestId: string): Promise<void> {
    this.cleanupPRService();

    for (const monitor of this.monitors.values()) {
      this.stopMonitor(monitor);
    }
    this.monitors.clear();

    await this.pollQueue.onIdle();

    this.activeWorktreeId = null;
    this.mainBranch = "main";
    this.git = null;
    this.projectRootPath = null;

    clearGitDirCache();
    const now = Date.now();
    for (const [cacheKey, cacheEntry] of this.worktreeListCache) {
      if (cacheEntry.expiresAt <= now) {
        this.worktreeListCache.delete(cacheKey);
        this.inFlightWorktreeList.delete(cacheKey);
      }
    }

    this.sendEvent({ type: "project-switch-result", requestId, success: true });
  }

  dispose(): void {
    this.cleanupPRService();
    for (const monitor of this.monitors.values()) {
      this.stopMonitor(monitor);
    }
    this.monitors.clear();
    this.invalidateCachedWorktrees();
  }
}
