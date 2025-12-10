import { BrowserWindow } from "electron";
import PQueue from "p-queue";
import { execSync } from "child_process";
import { mkdir, writeFile, stat } from "fs/promises";
import { join as pathJoin, dirname } from "path";
import { WorktreeMonitor, type WorktreeState } from "./WorktreeMonitor.js";
import type { Worktree, MonitorConfig } from "../types/index.js";
import { DEFAULT_CONFIG } from "../types/config.js";
import { logInfo, logWarn, logDebug, logError } from "../utils/logger.js";
import { events } from "./events.js";
import { CHANNELS } from "../ipc/channels.js";
import { GitService, type CreateWorktreeOptions, type BranchInfo } from "./GitService.js";
import { pullRequestService } from "./PullRequestService.js";
import { getGitDir, clearGitDirCache } from "../utils/gitUtils.js";

const DEFAULT_ACTIVE_WORKTREE_INTERVAL_MS = DEFAULT_CONFIG.monitor?.pollIntervalActive ?? 2000;
const DEFAULT_BACKGROUND_WORKTREE_INTERVAL_MS =
  DEFAULT_CONFIG.monitor?.pollIntervalBackground ?? 10000;

const NOTE_PATH = DEFAULT_CONFIG.note?.filename ?? "canopy/note";

async function ensureNoteFile(worktreePath: string): Promise<void> {
  const gitDir = getGitDir(worktreePath);
  if (!gitDir) {
    logDebug("Cannot ensure note file: not a git repository", { path: worktreePath });
    return;
  }

  const notePath = pathJoin(gitDir, NOTE_PATH);

  try {
    await stat(notePath);
    logDebug("Note file already exists", { path: notePath });
  } catch {
    try {
      const canopyDir = dirname(notePath);
      await mkdir(canopyDir, { recursive: true });

      await writeFile(notePath, "", { flag: "wx" });
      logInfo("Created canopy note file", { path: notePath });
    } catch (createError) {
      // Ignore EEXIST (file was created by another process between stat and writeFile)
      const code = (createError as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") {
        logWarn("Failed to create canopy note file", {
          path: notePath,
          error: (createError as Error).message,
        });
      }
    }
  }
}

interface PendingSyncRequest {
  worktrees: Worktree[];
  activeWorktreeId: string | null;
  mainBranch: string;
  monitorConfig?: MonitorConfig;
}

/**
 * WorktreeService - Manages Git worktree monitoring and state synchronization.
 *
 * @pattern Exported Singleton Instance (Pattern A)
 *
 * Why this pattern:
 * - No external dependencies required at construction time
 * - Stateful singleton with lightweight constructor (no external deps, no child processes)
 * - Safe for eager instantiation: no heavy initialization at import time
 * - Simple access: `import { worktreeService } from './WorktreeService'`
 *
 * When to use Pattern A:
 * - Service has no constructor dependencies
 * - Service doesn't manage child processes or system resources requiring explicit lifecycle
 * - Service is used widely across the codebase (simple import pattern)
 * - Initialization is lightweight (no async setup or resource allocation)
 */
export class WorktreeService {
  private monitors = new Map<string, WorktreeMonitor>();
  private pollQueue = new PQueue({ concurrency: 3 });
  private mainBranch: string = "main";
  private activeWorktreeId: string | null = null;
  private isSyncing: boolean = false;
  private pendingSync: PendingSyncRequest | null = null;
  private pollIntervalActive: number = DEFAULT_ACTIVE_WORKTREE_INTERVAL_MS;
  private pollIntervalBackground: number = DEFAULT_BACKGROUND_WORKTREE_INTERVAL_MS;
  private adaptiveBackoff: boolean = DEFAULT_CONFIG.monitor?.adaptiveBackoff ?? true;
  private pollIntervalMax: number = DEFAULT_CONFIG.monitor?.pollIntervalMax ?? 30000;
  private circuitBreakerThreshold: number = DEFAULT_CONFIG.monitor?.circuitBreakerThreshold ?? 3;
  private gitService: GitService | null = null;
  private rootPath: string | null = null;
  private prServiceInitialized: boolean = false;
  private pollingEnabled: boolean = true;

  public async loadProject(rootPath: string): Promise<void> {
    logInfo("Loading project worktrees", { rootPath });

    try {
      this.ensureGitService(rootPath);

      if (!this.gitService) {
        throw new Error("GitService failed to initialize");
      }

      // 1. Get raw list from Git (now includes isMainWorktree flag)
      const rawWorktrees = await this.gitService.listWorktrees();

      // 2. Map to domain Worktree objects
      const worktrees: Worktree[] = rawWorktrees.map((wt) => {
        const name = wt.isMainWorktree
          ? wt.path.split(new RegExp("[/\\\\]")).pop() || "Main"
          : wt.branch || wt.path.split(new RegExp("[/\\\\]")).pop() || "Worktree";

        return {
          id: wt.path,
          path: wt.path,
          name: name,
          branch: wt.branch,
          isCurrent: false, // Will be updated by active ID logic
          isMainWorktree: wt.isMainWorktree, // Pass this flag through
          gitDir: getGitDir(wt.path) || undefined,
        };
      });

      // 3. Sync monitors
      await this.sync(worktrees, this.activeWorktreeId, this.mainBranch);

      // 4. Force an immediate refresh to populate statuses
      await this.refresh();
    } catch (error) {
      logError("Failed to load project worktrees", {
        error: (error as Error).message,
      });
      throw error;
    }
  }

  /**
   * Initialize or update monitors to match the current worktree list.
   *
   * This should be called:
   * - On app startup
   * - When worktrees are added/removed
   * - When the active worktree changes
   *
   * @param worktrees - Current list of worktrees
   * @param activeWorktreeId - ID of the currently active worktree
   * @param mainBranch - Main branch name (default: 'main')
   * @param monitorConfig - Optional polling interval configuration
   */
  public async sync(
    worktrees: Worktree[],
    activeWorktreeId: string | null = null,
    mainBranch: string = "main",
    monitorConfig?: MonitorConfig
  ): Promise<void> {
    // If already syncing, queue this request and return
    if (this.isSyncing) {
      logWarn("Sync already in progress, queuing request");
      this.pendingSync = {
        worktrees,
        activeWorktreeId,
        mainBranch,
        monitorConfig,
      };
      return;
    }

    this.isSyncing = true;

    try {
      this.mainBranch = mainBranch;
      this.activeWorktreeId = activeWorktreeId;

      // Update polling intervals from config
      if (monitorConfig?.pollIntervalActive !== undefined) {
        this.pollIntervalActive = monitorConfig.pollIntervalActive;
      }
      if (monitorConfig?.pollIntervalBackground !== undefined) {
        this.pollIntervalBackground = monitorConfig.pollIntervalBackground;
      }
      // Update adaptive backoff settings from config
      if (monitorConfig?.adaptiveBackoff !== undefined) {
        this.adaptiveBackoff = monitorConfig.adaptiveBackoff;
      }
      if (monitorConfig?.pollIntervalMax !== undefined) {
        this.pollIntervalMax = monitorConfig.pollIntervalMax;
      }
      if (monitorConfig?.circuitBreakerThreshold !== undefined) {
        this.circuitBreakerThreshold = monitorConfig.circuitBreakerThreshold;
      }

      // Initialize PR service if we have worktrees and it hasn't been initialized yet
      if (!this.prServiceInitialized && worktrees.length > 0) {
        try {
          // Get the repository root from the first worktree
          const firstWorktreePath = worktrees[0].path;
          const repoRoot = execSync("git rev-parse --show-toplevel", {
            cwd: firstWorktreePath,
            encoding: "utf-8",
            timeout: 5000,
            stdio: ["pipe", "pipe", "pipe"],
          }).trim();

          pullRequestService.initialize(repoRoot);
          pullRequestService.start();
          this.prServiceInitialized = true;
          logInfo("PullRequestService initialized and started", { repoRoot });
        } catch (error) {
          logWarn("Failed to initialize PullRequestService", {
            error: (error as Error).message,
          });
        }
      }

      const currentIds = new Set(worktrees.map((wt) => wt.id));

      // 1. Remove stale monitors (worktrees that no longer exist)
      for (const [id, monitor] of this.monitors) {
        if (!currentIds.has(id)) {
          const state = monitor.getState();

          // Safeguard: Never remove main worktree monitor
          if (state.isMainWorktree) {
            logWarn("Attempted to remove main worktree monitor - blocked", {
              id,
              branch: state.branch,
              reason: "Main worktree missing from git worktree list (possible transient git error)",
            });
            continue;
          }

          logInfo("Removing stale WorktreeMonitor", { id });
          // Clean up event bus subscription to prevent memory leak
          const unsubscribe = (monitor as any)._eventBusUnsubscribe;
          if (unsubscribe) {
            unsubscribe();
            delete (monitor as any)._eventBusUnsubscribe;
          }
          await monitor.stop();
          this.monitors.delete(id);
          // Emit removal event via IPC so renderer can clean up cached state
          this.sendToRenderer(CHANNELS.WORKTREE_REMOVE, { worktreeId: id });
        }
      }

      // 2. Create new monitors and update existing ones
      for (const wt of worktrees) {
        const existingMonitor = this.monitors.get(wt.id);
        const isActive = wt.id === activeWorktreeId;

        if (existingMonitor) {
          // Update metadata (branch, name) if changed (e.g., after git checkout)
          existingMonitor.updateMetadata(wt);

          // Update polling interval based on active status
          const interval = isActive ? this.pollIntervalActive : this.pollIntervalBackground;

          existingMonitor.setPollingInterval(interval);

          // Update adaptive backoff settings
          existingMonitor.setAdaptiveBackoffConfig(
            this.adaptiveBackoff,
            this.pollIntervalMax,
            this.circuitBreakerThreshold
          );
        } else {
          // Create new monitor
          logInfo("Creating new WorktreeMonitor", { id: wt.id, path: wt.path });

          // Ensure the canopy note file exists for AI agents to write to
          await ensureNoteFile(wt.path);

          // Ensure GitService is available for the monitor
          if (!this.gitService) {
            throw new Error("GitService not initialized - cannot create WorktreeMonitor");
          }

          const monitor = new WorktreeMonitor(wt, this.gitService, this, this.mainBranch);

          // Set initial polling interval
          const interval = isActive ? this.pollIntervalActive : this.pollIntervalBackground;

          monitor.setPollingInterval(interval);

          // Set adaptive backoff settings
          monitor.setAdaptiveBackoffConfig(
            this.adaptiveBackoff,
            this.pollIntervalMax,
            this.circuitBreakerThreshold
          );

          // Subscribe to global event bus for updates (single subscription pattern)
          // WorktreeMonitor emits to the global TypedEventBus, which provides:
          // - Centralized event tracking via EventBuffer
          // - Better debugging via Event Inspector UI
          const unsubscribe = events.on("sys:worktree:update", (state: WorktreeState) => {
            if (state.worktreeId === wt.id) {
              this.sendToRenderer(CHANNELS.WORKTREE_UPDATE, state);
            }
          });

          // Store unsubscribe function for cleanup
          (monitor as any)._eventBusUnsubscribe = unsubscribe;

          try {
            // Start monitoring
            await monitor.start();
            this.monitors.set(wt.id, monitor);

            // If polling is disabled (e.g., during system sleep), pause the new monitor
            if (!this.pollingEnabled) {
              monitor.pause();
            }
          } catch (error) {
            // If monitor startup fails, clean up the event bus subscription
            unsubscribe();
            throw error;
          }
        }
      }

      logInfo("WorktreeService sync complete", {
        totalMonitors: this.monitors.size,
        activeWorktreeId,
      });
    } finally {
      this.isSyncing = false;

      // Check if there's a pending sync request and execute it
      if (this.pendingSync) {
        const pending = this.pendingSync;
        this.pendingSync = null;
        logInfo("Executing pending sync request");
        // Execute pending sync asynchronously (don't await to avoid blocking)
        void this.sync(
          pending.worktrees,
          pending.activeWorktreeId,
          pending.mainBranch,
          pending.monitorConfig
        );
      }
    }
  }

  /**
   * Get the monitor for a specific worktree.
   *
   * @param worktreeId - Worktree ID
   * @returns WorktreeMonitor instance or undefined
   */
  public getMonitor(worktreeId: string): WorktreeMonitor | undefined {
    return this.monitors.get(worktreeId);
  }

  /**
   * Get all monitor states.
   *
   * @returns Map of worktree ID to WorktreeState
   */
  public getAllStates(): Map<string, WorktreeState> {
    const states = new Map<string, WorktreeState>();
    for (const [id, monitor] of this.monitors) {
      states.set(id, monitor.getState());
    }
    return states;
  }

  /**
   * Set the active worktree.
   * Adjusts polling intervals for active vs background worktrees.
   *
   * @param worktreeId - ID of the worktree to make active
   */
  public setActiveWorktree(worktreeId: string): void {
    const previousActive = this.activeWorktreeId;
    this.activeWorktreeId = worktreeId;

    // Update intervals for all monitors
    for (const [id, monitor] of this.monitors) {
      const isActive = id === worktreeId;
      const interval = isActive ? this.pollIntervalActive : this.pollIntervalBackground;

      monitor.setPollingInterval(interval);
    }

    logInfo("Active worktree changed", {
      previous: previousActive,
      current: worktreeId,
    });
  }

  /**
   * Refresh a specific worktree or all worktrees.
   *
   * @param worktreeId - Optional worktree ID. If not provided, refreshes all.
   */
  public async refresh(worktreeId?: string): Promise<void> {
    if (worktreeId) {
      const monitor = this.monitors.get(worktreeId);
      if (monitor) {
        await monitor.refresh();
      } else {
        logWarn("Attempted to refresh non-existent worktree", { worktreeId });
      }
    } else {
      // Refresh all
      const promises = Array.from(this.monitors.values()).map((monitor) => monitor.refresh());
      await Promise.all(promises);
    }
  }

  /**
   * Enable or disable polling for all monitors.
   * Used during system sleep/wake to prevent operations while I/O is unavailable.
   *
   * @param enabled - Whether polling should be enabled
   */
  public setPollingEnabled(enabled: boolean): void {
    if (this.pollingEnabled === enabled) return;

    this.pollingEnabled = enabled;

    if (!enabled) {
      // Stop all monitors from polling
      for (const monitor of this.monitors.values()) {
        monitor.pause();
      }
      logInfo("WorktreeService polling disabled");
    } else {
      // Resume all monitors
      for (const monitor of this.monitors.values()) {
        monitor.resume();
      }
      logInfo("WorktreeService polling enabled");
    }
  }

  /**
   * Manually refresh the pull request service.
   * Useful for retrying after authentication failures or circuit breaker trips.
   */
  public async refreshPullRequests(): Promise<void> {
    if (this.prServiceInitialized) {
      await pullRequestService.refresh();
    } else {
      logWarn("PullRequestService not initialized - cannot refresh");
    }
  }

  /**
   * Stop all monitors and clean up resources.
   * Should be called on app shutdown.
   */
  public async stopAll(): Promise<void> {
    logInfo("Stopping all WorktreeMonitors", { count: this.monitors.size });

    const promises = Array.from(this.monitors.values()).map(async (monitor) => {
      // Clean up event bus subscription
      const unsubscribe = (monitor as any)._eventBusUnsubscribe;
      if (unsubscribe) {
        unsubscribe();
        delete (monitor as any)._eventBusUnsubscribe;
      }
      await monitor.stop();
    });

    await Promise.all(promises);
    this.monitors.clear();

    // Wait for any pending polls in the queue to complete
    await this.pollQueue.onIdle();

    // Stop PR service
    if (this.prServiceInitialized) {
      pullRequestService.destroy();
      this.prServiceInitialized = false;
      logInfo("PullRequestService stopped and cleaned up");
    }
  }

  /**
   * Handle project switch - stop all monitors and reset state.
   * Similar to stopAll but also resets internal state for the new project.
   */
  public async onProjectSwitch(): Promise<void> {
    logInfo("Handling project switch in WorktreeService");

    // Stop all monitors and clean up (reuse stopAll logic)
    await this.stopAll();

    // Reset internal state for new project
    this.activeWorktreeId = null;
    this.mainBranch = "main";
    this.gitService = null;
    this.rootPath = null;
    this.isSyncing = false;
    this.pendingSync = null;

    // Reset adaptive backoff state by clearing monitors
    // (already done in stopAll, but this makes intent explicit)
    this.monitors.clear();

    // Clear git-dir cache to prevent stale paths when switching projects
    clearGitDirCache();

    logInfo("WorktreeService state reset for project switch");
  }

  /**
   * Get count of active monitors.
   */
  public getMonitorCount(): number {
    return this.monitors.size;
  }

  /**
   * Execute a poll operation through the shared concurrency queue.
   * Limits parallel git operations across all monitors to prevent resource spikes.
   */
  public async executePoll(monitorId: string, pollFn: () => Promise<void>): Promise<void> {
    return this.pollQueue.add(async () => {
      logDebug("Executing queued poll", {
        monitorId,
        queueSize: this.pollQueue.size,
        pending: this.pollQueue.pending,
      });
      await pollFn();
    });
  }

  /**
   * Get performance metrics for monitoring and debugging.
   */
  public getPerformanceMetrics(): {
    totalMonitors: number;
    queueSize: number;
    queuePending: number;
    estimatedProcessesPerMinute: number;
  } {
    const activeCount = this.activeWorktreeId ? 1 : 0;
    const backgroundCount = this.monitors.size - activeCount;

    // Estimate based on cache hit assumptions (80% hit rate after fixes)
    const activePollsPerMin = 30; // 2s interval
    const backgroundPollsPerMin = backgroundCount * 6; // 10s interval
    const cacheHitRate = 0.8;
    const processesPerPoll = 3;

    const estimatedProcesses =
      (activePollsPerMin + backgroundPollsPerMin) * (1 - cacheHitRate) * processesPerPoll;

    return {
      totalMonitors: this.monitors.size,
      queueSize: this.pollQueue.size,
      queuePending: this.pollQueue.pending,
      estimatedProcessesPerMinute: Math.round(estimatedProcesses),
    };
  }

  /**
   * Initialize GitService for worktree creation operations.
   * Must be called after sync() to ensure rootPath is set.
   *
   * @param rootPath - Repository root path
   */
  private ensureGitService(rootPath: string): void {
    if (!this.gitService || this.rootPath !== rootPath) {
      this.rootPath = rootPath;
      this.gitService = new GitService(rootPath);
      logDebug("GitService initialized", { rootPath });
    }
  }

  /**
   * List all local and remote branches.
   * Requires sync() to have been called at least once.
   *
   * @param rootPath - Repository root path
   * @returns Array of branch information
   */
  public async listBranches(rootPath: string): Promise<BranchInfo[]> {
    try {
      this.ensureGitService(rootPath);
      if (!this.gitService) {
        throw new Error("GitService not initialized");
      }
      return await this.gitService.listBranches();
    } catch (error) {
      logError("Failed to list branches", { error: (error as Error).message });
      throw error;
    }
  }

  /**
   * Create a new worktree and automatically sync monitors.
   *
   * @param rootPath - Repository root path
   * @param options - Worktree creation options
   * @param worktrees - Current worktree list (for sync after creation)
   * @throws Error if worktree creation fails
   */
  public async createWorktree(rootPath: string, options: CreateWorktreeOptions): Promise<void> {
    try {
      this.ensureGitService(rootPath);
      if (!this.gitService) {
        throw new Error("GitService not initialized");
      }

      logInfo("Creating worktree", {
        baseBranch: options.baseBranch,
        newBranch: options.newBranch,
        path: options.path,
        fromRemote: options.fromRemote,
      });

      // Create the worktree using GitService
      await this.gitService.createWorktree(options);

      // Ensure note file exists for the new worktree
      await ensureNoteFile(options.path);

      // Trigger a sync to pick up the new worktree
      // Need to refresh the worktree list to include the newly created one
      const updatedWorktrees = await this.gitService.listWorktrees();

      // Convert to Worktree format expected by sync
      const worktreeList: Worktree[] = updatedWorktrees.map((wt) => ({
        id: wt.path,
        path: wt.path,
        name: wt.isMainWorktree
          ? wt.path.split(new RegExp("[/\\\\]")).pop() || "Main"
          : wt.branch || wt.path.split(new RegExp("[/\\\\]")).pop() || wt.path,
        branch: wt.branch,
        isCurrent: false, // Will be determined by sync
        isMainWorktree: wt.isMainWorktree,
        gitDir: getGitDir(wt.path) || undefined,
      }));

      if (worktreeList.length > 0) {
        await this.sync(worktreeList, this.activeWorktreeId, this.mainBranch);
      }

      logInfo("Worktree created successfully", {
        path: options.path,
        branch: options.newBranch,
      });
    } catch (error) {
      logError("Failed to create worktree", {
        options,
        error: (error as Error).message,
      });
      throw error;
    }
  }

  public async deleteWorktree(worktreeId: string, force: boolean = false): Promise<void> {
    const monitor = this.monitors.get(worktreeId);
    if (!monitor) {
      throw new Error(`Worktree not found: ${worktreeId}`);
    }

    const state = monitor.getState();
    if (state.isMainWorktree) {
      throw new Error(
        "Cannot delete the main worktree. Use standard directory deletion if you wish to remove the repository entirely."
      );
    }

    if (state.isCurrent) {
      throw new Error(
        "Cannot delete the currently active worktree. Switch to another worktree first."
      );
    }

    if (!force && (state.worktreeChanges?.changedFileCount ?? 0) > 0) {
      throw new Error(
        "Worktree has uncommitted changes. Use force delete to proceed or commit/stash changes first."
      );
    }

    logInfo("Deleting worktree", { worktreeId, force });

    await monitor.stop();
    this.monitors.delete(worktreeId);

    const unsubscribe = (monitor as any)._eventBusUnsubscribe;

    if (this.gitService) {
      try {
        await this.gitService.removeWorktree(monitor.path, force);
        clearGitDirCache(monitor.path);
      } catch (error) {
        this.monitors.set(worktreeId, monitor);
        if (unsubscribe) {
          (monitor as any)._eventBusUnsubscribe = unsubscribe;
        }
        try {
          await monitor.start();
        } catch {
          // Ignore restart error
        }
        throw error;
      }
    }

    if (unsubscribe) {
      unsubscribe();
    }

    this.sendToRenderer(CHANNELS.WORKTREE_REMOVE, { worktreeId });
    logInfo("Worktree deleted successfully", { worktreeId });
  }

  /**
   * Helper method to send IPC events to all renderer windows.
   *
   * @param channel - IPC channel name
   * @param args - Arguments to send
   */
  private sendToRenderer(channel: string, ...args: unknown[]): void {
    const windows = BrowserWindow.getAllWindows();
    for (const win of windows) {
      if (win && !win.isDestroyed()) {
        win.webContents.send(channel, ...args);
      }
    }
  }
}

export const worktreeService = new WorktreeService();
