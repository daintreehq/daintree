import os from "os";
import PQueue from "p-queue";
import { mkdir, writeFile, stat } from "fs/promises";
import { join as pathJoin, dirname, resolve as pathResolve, isAbsolute } from "path";
import { SimpleGit, BranchSummary } from "simple-git";
import { createHardenedGit, createAuthenticatedGit } from "../utils/hardenedGit.js";
import type { Worktree } from "../../shared/types/worktree.js";
import type {
  WorkspaceHostEvent,
  WorktreeSnapshot,
  MonitorConfig,
  CreateWorktreeOptions,
  BranchInfo,
  PRServiceStatus,
} from "../../shared/types/workspace-host.js";
import { invalidateGitStatusCache } from "../utils/git.js";
import { getGitDir, clearGitDirCache } from "../utils/gitUtils.js";
import { extractIssueNumberSync, extractIssueNumber } from "../services/issueExtractor.js";
import { GitHubAuth } from "../services/github/GitHubAuth.js";
import { pullRequestService } from "../services/PullRequestService.js";
import { events } from "../services/events.js";
import { NOTE_PATH } from "./types.js";
import { WorktreeLifecycleService } from "./WorktreeLifecycleService.js";
import { WorktreeMonitor } from "./WorktreeMonitor.js";
import { WorktreeListService } from "./WorktreeListService.js";
import { PRIntegrationService } from "./PRIntegrationService.js";
import { waitForPathExists } from "../utils/fs.js";

// Configuration
const DEFAULT_ACTIVE_WORKTREE_INTERVAL_MS = 2000;
const DEFAULT_BACKGROUND_WORKTREE_INTERVAL_MS = 10000;

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
  private monitors = new Map<string, WorktreeMonitor>();
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
  private lifecycleService = new WorktreeLifecycleService();
  private listService = new WorktreeListService();
  private prService: PRIntegrationService;
  private _shutdownController = new AbortController();

  constructor(private readonly sendEvent: (event: WorkspaceHostEvent) => void) {
    this.prService = new PRIntegrationService(pullRequestService, events, {
      onPRDetected: (worktreeId, data) => {
        const monitor = this.monitors.get(worktreeId);
        if (!monitor) return;

        monitor.setPRInfo({
          prNumber: data.prNumber,
          prUrl: data.prUrl,
          prState: data.prState,
          prTitle: data.prTitle,
          issueTitle: data.issueTitle,
        });
        if (monitor.hasInitialStatus) {
          this.emitUpdate(monitor);
        }

        this.sendEvent({
          type: "pr-detected",
          worktreeId,
          prNumber: data.prNumber,
          prUrl: data.prUrl,
          prState: data.prState,
          prTitle: data.prTitle,
          issueNumber: data.issueNumber,
          issueTitle: data.issueTitle,
        });
      },
      onPRCleared: (worktreeId) => {
        const monitor = this.monitors.get(worktreeId);
        if (!monitor) return;

        monitor.clearPRInfo();
        if (monitor.hasInitialStatus) {
          this.emitUpdate(monitor);
        }

        this.sendEvent({
          type: "pr-cleared",
          worktreeId,
        });
      },
      onIssueDetected: (worktreeId, data) => {
        const monitor = this.monitors.get(worktreeId);
        if (!monitor) return;

        monitor.setIssueTitle(data.issueTitle);
        if (monitor.hasInitialStatus) {
          this.emitUpdate(monitor);
        }

        this.sendEvent({
          type: "issue-detected",
          worktreeId,
          issueNumber: data.issueNumber,
          issueTitle: data.issueTitle,
        });
      },
      onIssueNotFound: (worktreeId, issueNumber) => {
        const monitor = this.monitors.get(worktreeId);
        if (!monitor) return;
        if (monitor.issueNumber !== issueNumber) return;

        monitor.setIssueNumber(undefined);
        monitor.setIssueTitle(undefined);
        if (monitor.hasInitialStatus) {
          this.emitUpdate(monitor);
        }

        this.sendEvent({
          type: "issue-not-found",
          worktreeId,
          issueNumber,
        });
      },
    });
  }

  async loadProject(requestId: string, projectRootPath: string): Promise<void> {
    try {
      this.projectRootPath = projectRootPath;
      this.git = createHardenedGit(projectRootPath, this._shutdownController.signal);
      this.listService.setGit(this.git, projectRootPath);

      const rawWorktrees = await this.listService.list();
      const worktrees = this.listService.mapToWorktrees(rawWorktrees);

      await this.syncMonitors(worktrees, this.activeWorktreeId, this.mainBranch, undefined, true);

      this.sendEvent({ type: "load-project-result", requestId, success: true });

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

        if (this.activeWorktreeId === id) {
          this.activeWorktreeId = null;
        }

        monitor.stop();
        this.monitors.delete(id);
        clearGitDirCache(monitor.path);
        invalidateGitStatusCache(monitor.path);
        this.sendEvent({
          type: "worktree-removed",
          worktreeId: id,
        });
        events.emit("sys:worktree:remove", { worktreeId: id, timestamp: Date.now() });
      }
    }

    // Create or update monitors
    for (const wt of worktrees) {
      const existingMonitor = this.monitors.get(wt.id);
      const isActive = wt.id === activeWorktreeId;

      if (existingMonitor) {
        const branchChanged = existingMonitor.branch !== wt.branch;
        const isCurrentChanged = existingMonitor.isCurrent !== isActive;
        existingMonitor.branch = wt.branch;
        existingMonitor.name = wt.name;
        existingMonitor.isCurrent = isActive;
        existingMonitor.isMainWorktree = wt.isMainWorktree ?? false;

        const interval = isActive ? this.pollIntervalActive : this.pollIntervalBackground;
        existingMonitor.updateConfig({
          basePollingInterval: interval,
          adaptiveBackoff: this.adaptiveBackoff,
          pollIntervalMax: this.pollIntervalMax,
          circuitBreakerThreshold: this.circuitBreakerThreshold,
          gitWatchEnabled: this.gitWatchEnabled,
          gitWatchDebounceMs: this.gitWatchDebounceMs,
        });

        existingMonitor.ensureWatcherState();

        if (branchChanged && existingMonitor.hasWatcher) {
          existingMonitor.restartWatcherIfRunning();
        }

        if (isCurrentChanged && existingMonitor.hasInitialStatus) {
          this.emitUpdate(existingMonitor);
        }

        if (branchChanged && wt.branch) {
          const syncIssueNumber = extractIssueNumberSync(wt.branch, wt.name);
          if (syncIssueNumber) {
            existingMonitor.setIssueNumber(syncIssueNumber);
          } else {
            existingMonitor.setIssueNumber(undefined);
            void this.extractIssueNumberAsync(existingMonitor, wt.branch, wt.name);
          }
          existingMonitor.setIssueTitle(undefined);
          if (existingMonitor.hasInitialStatus) {
            this.emitUpdate(existingMonitor);
          }
        } else if (branchChanged && !wt.branch) {
          existingMonitor.setIssueNumber(undefined);
          existingMonitor.setIssueTitle(undefined);
          if (existingMonitor.hasInitialStatus) {
            this.emitUpdate(existingMonitor);
          }
        }
      } else {
        await ensureNoteFile(wt.path);
        const issueNumber = wt.branch ? extractIssueNumberSync(wt.branch, wt.name) : null;
        const interval = isActive ? this.pollIntervalActive : this.pollIntervalBackground;

        let createdAt: number | undefined;
        try {
          const stats = await stat(wt.path);
          createdAt = stats.birthtimeMs > 0 ? stats.birthtimeMs : stats.ctimeMs;
        } catch {
          // If stat fails, leave undefined
        }

        const monitor = new WorktreeMonitor(
          { ...wt, isCurrent: isActive },
          {
            basePollingInterval: interval,
            adaptiveBackoff: this.adaptiveBackoff,
            pollIntervalMax: this.pollIntervalMax,
            circuitBreakerThreshold: this.circuitBreakerThreshold,
            gitWatchEnabled: this.gitWatchEnabled,
            gitWatchDebounceMs: this.gitWatchDebounceMs,
          },
          {
            onUpdate: (snapshot) => {
              this.handleMonitorUpdate(monitor, snapshot);
            },
            onRemoved: (worktreeId) => {
              this.handleExternalWorktreeRemoval(worktreeId);
            },
            onExternalRemoval: (worktreeId) => {
              this.handleExternalWorktreeRemoval(worktreeId);
            },
          },
          this.mainBranch,
          this.pollQueue
        );

        monitor.setIssueNumber(issueNumber ?? undefined);
        monitor.setCreatedAt(createdAt);

        this.monitors.set(wt.id, monitor);

        if (skipInitialGitStatus) {
          monitor.startWithoutGitStatus();
        } else {
          await monitor.start();
        }

        if (wt.branch && !issueNumber) {
          void this.extractIssueNumberAsync(monitor, wt.branch, wt.name);
        }
      }
    }
  }

  private async extractIssueNumberAsync(
    monitor: WorktreeMonitor,
    branchName: string,
    folderName?: string
  ): Promise<void> {
    try {
      const issueNumber = await extractIssueNumber(branchName, folderName);
      if (issueNumber && monitor.isRunning && monitor.branch === branchName) {
        monitor.setIssueNumber(issueNumber);
        if (monitor.hasInitialStatus) {
          this.emitUpdate(monitor);
        }
      }
    } catch {
      // Silently ignore extraction errors
    }
  }

  private handleMonitorUpdate(monitor: WorktreeMonitor, _snapshot: WorktreeSnapshot): void {
    const snapshot = monitor.getSnapshot();
    this.sendEvent({
      type: "worktree-update",
      worktree: snapshot,
    });
    events.emit("sys:worktree:update", snapshot as any);
  }

  private emitUpdate(monitor: WorktreeMonitor): void {
    const snapshot = monitor.getSnapshot();
    this.sendEvent({
      type: "worktree-update",
      worktree: snapshot,
    });
    events.emit("sys:worktree:update", snapshot as any);
  }

  private handleExternalWorktreeRemoval(worktreeId: string): void {
    const monitor = this.monitors.get(worktreeId);
    if (!monitor) {
      return;
    }

    if (monitor.isMainWorktree) {
      console.warn("[WorkspaceHost] Blocked removal of main worktree monitor");
      monitor.setMood("error");
      monitor.setSummary("⚠️ Directory not accessible");
      this.emitUpdate(monitor);
      return;
    }

    if (!this.monitors.has(worktreeId)) {
      return;
    }

    if (this.activeWorktreeId === worktreeId) {
      this.activeWorktreeId = null;
    }

    monitor.stop();
    this.monitors.delete(worktreeId);

    clearGitDirCache(monitor.path);
    invalidateGitStatusCache(monitor.path);
    const cacheKey = this.listService.getCacheKey();
    if (cacheKey) {
      this.listService.invalidateCache(cacheKey);
    }

    this.sendEvent({ type: "worktree-removed", worktreeId });
    events.emit("sys:worktree:remove", { worktreeId, timestamp: Date.now() });

    console.log(
      `[WorkspaceHost] Worktree deleted externally, removed monitor: ${monitor.name} (${worktreeId})`
    );
  }

  getAllStates(requestId: string): void {
    const states: WorktreeSnapshot[] = [];
    for (const monitor of this.monitors.values()) {
      states.push(monitor.getSnapshot());
    }
    this.sendEvent({ type: "all-states", requestId, states });
  }

  getSnapshotsSync(): WorktreeSnapshot[] {
    const states: WorktreeSnapshot[] = [];
    for (const monitor of this.monitors.values()) {
      states.push(monitor.getSnapshot());
    }
    return states;
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
      state: monitor.getSnapshot(),
    });
  }

  setActiveWorktree(requestId: string, worktreeId: string): void {
    this.activeWorktreeId = worktreeId;

    for (const [id, monitor] of this.monitors) {
      const isActive = id === worktreeId;
      const wasCurrent = monitor.isCurrent;
      const interval = isActive ? this.pollIntervalActive : this.pollIntervalBackground;

      monitor.updateConfig({ basePollingInterval: interval });
      monitor.isCurrent = isActive;

      if (wasCurrent !== isActive) {
        monitor.reschedulePolling();
      }

      if (isActive && monitor.isRunning) {
        monitor.triggerRefreshIfUpdating();
      }

      if (monitor.hasInitialStatus && wasCurrent !== isActive) {
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
          await monitor.refresh();
        }
      } else {
        await this.discoverAndSyncWorktrees();
        await this.refreshAll();
        await pullRequestService.refresh();
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

    const rawWorktrees = await this.listService.list({ forceRefresh: true });
    const worktrees = this.listService.mapToWorktrees(rawWorktrees);

    await this.syncMonitors(worktrees, this.activeWorktreeId, this.mainBranch, undefined, true);
  }

  private async refreshAll(): Promise<void> {
    const promises = Array.from(this.monitors.values()).map((monitor) =>
      this.pollQueue.add(async () => {
        try {
          await monitor.updateGitStatus(true);
        } finally {
          if (monitor.isRunning && this.pollingEnabled) {
            monitor.reschedulePolling();
          }
        }
      })
    );
    await Promise.all(promises);
  }

  async createWorktree(
    requestId: string,
    rootPath: string,
    options: CreateWorktreeOptions
  ): Promise<void> {
    try {
      const git = createHardenedGit(rootPath);
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

      const absolutePath = isAbsolute(path) ? path : pathResolve(rootPath, path);
      await waitForPathExists(absolutePath, {
        timeoutMs: 5000,
        initialRetryDelayMs: 50,
        maxRetryDelayMs: 800,
      });

      await ensureNoteFile(absolutePath);

      await this.lifecycleService.copyCanopyDir(rootPath, absolutePath);

      this.listService.invalidateCache(pathResolve(rootPath));
      const updatedWorktrees = await this.listService.list({ forceRefresh: true });
      const worktreeList = this.listService.mapToWorktrees(updatedWorktrees);

      await this.syncMonitors(worktreeList, this.activeWorktreeId, this.mainBranch);

      const createdWorktree = worktreeList.find((wt) => wt.branch === newBranch);
      const canonicalWorktreeId = createdWorktree?.id || path;

      this.sendEvent({
        type: "create-worktree-result",
        requestId,
        success: true,
        worktreeId: canonicalWorktreeId,
      });

      void this.runLifecycleSetup(canonicalWorktreeId, absolutePath, rootPath);
    } catch (error) {
      this.sendEvent({
        type: "create-worktree-result",
        requestId,
        success: false,
        error: (error as Error).message,
      });
    }
  }

  private async runLifecycleSetup(
    worktreeId: string,
    worktreePath: string,
    projectRootPath: string
  ): Promise<void> {
    const config = await this.lifecycleService.loadConfig(worktreePath, projectRootPath);
    if (!config?.setup?.length) {
      return;
    }

    const monitor = this.monitors.get(worktreeId);
    if (!monitor) {
      return;
    }

    const commands = config.setup;
    const worktreeName = monitor.name;
    const env = this.lifecycleService.buildEnv(worktreePath, projectRootPath, worktreeName);

    monitor.setLifecycleStatus({
      phase: "setup",
      state: "running",
      commandIndex: 0,
      totalCommands: commands.length,
      currentCommand: commands[0],
      startedAt: Date.now(),
    });
    this.emitUpdate(monitor);

    const result = await this.lifecycleService.runCommands(commands, {
      cwd: worktreePath,
      env,
      onProgress: (commandIndex, totalCommands, command) => {
        const m = this.monitors.get(worktreeId);
        if (m) {
          m.setLifecycleStatus({
            phase: "setup",
            state: "running",
            commandIndex,
            totalCommands,
            currentCommand: command,
            startedAt: m.lifecycleStatus?.startedAt ?? Date.now(),
          });
          this.emitUpdate(m);
        }
      },
    });

    const finalMonitor = this.monitors.get(worktreeId);
    if (finalMonitor) {
      finalMonitor.setLifecycleStatus({
        phase: "setup",
        state: result.timedOut ? "timed-out" : result.success ? "success" : "failed",
        totalCommands: commands.length,
        output: result.output,
        error: result.error,
        startedAt: finalMonitor.lifecycleStatus?.startedAt ?? Date.now(),
        completedAt: Date.now(),
      });
      this.emitUpdate(finalMonitor);
    }

    if (!result.success) {
      console.warn(`[WorktreeLifecycle] Setup failed for worktree ${worktreeId}:`, result.error);
    }
  }

  private async runLifecycleTeardown(
    worktreeId: string,
    monitor: WorktreeMonitor,
    force: boolean
  ): Promise<void> {
    if (!this.projectRootPath) {
      return;
    }

    const config = await this.lifecycleService.loadConfig(monitor.path, this.projectRootPath);
    if (!config?.teardown?.length) {
      return;
    }

    const commands = config.teardown;
    const env = this.lifecycleService.buildEnv(monitor.path, this.projectRootPath, monitor.name);
    const timeoutMs = force ? 15_000 : 120_000;

    monitor.setLifecycleStatus({
      phase: "teardown",
      state: "running",
      commandIndex: 0,
      totalCommands: commands.length,
      currentCommand: commands[0],
      startedAt: Date.now(),
    });
    this.emitUpdate(monitor);

    const teardownStartedAt = monitor.lifecycleStatus?.startedAt ?? Date.now();

    try {
      const result = await this.lifecycleService.runCommands(commands, {
        cwd: monitor.path,
        env,
        timeoutMs,
        onProgress: (commandIndex, totalCommands, command) => {
          const m = this.monitors.get(worktreeId);
          if (m) {
            m.setLifecycleStatus({
              phase: "teardown",
              state: "running",
              commandIndex,
              totalCommands,
              currentCommand: command,
              startedAt: m.lifecycleStatus?.startedAt ?? teardownStartedAt,
            });
            this.emitUpdate(m);
          }
        },
      });

      const finalMonitor = this.monitors.get(worktreeId);
      if (finalMonitor) {
        finalMonitor.setLifecycleStatus({
          phase: "teardown",
          state: result.timedOut ? "timed-out" : result.success ? "success" : "failed",
          totalCommands: commands.length,
          output: result.output,
          error: result.error,
          startedAt: teardownStartedAt,
          completedAt: Date.now(),
        });
        this.emitUpdate(finalMonitor);
      }

      if (!result.success) {
        console.warn(
          `[WorktreeLifecycle] Teardown failed for worktree ${worktreeId} (continuing deletion):`,
          result.error
        );
      }
    } catch (err) {
      const finalMonitor = this.monitors.get(worktreeId);
      if (finalMonitor) {
        finalMonitor.setLifecycleStatus({
          phase: "teardown",
          state: "failed",
          totalCommands: commands.length,
          error: (err as Error).message,
          startedAt: teardownStartedAt,
          completedAt: Date.now(),
        });
        this.emitUpdate(finalMonitor);
      }
      console.warn(
        `[WorktreeLifecycle] Teardown threw for worktree ${worktreeId} (continuing deletion):`,
        err
      );
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

      const wtChanges = monitor.getWorktreeChanges();
      if (!force && (wtChanges?.changedFileCount ?? 0) > 0) {
        const fileChanges = wtChanges?.changes ?? [];
        const hasTracked = fileChanges.some(
          (c) => c.status !== "untracked" && c.status !== "ignored"
        );
        const hasUntracked = fileChanges.some((c) => c.status === "untracked");
        const description =
          hasTracked && hasUntracked
            ? "uncommitted changes and untracked files"
            : hasTracked
              ? "uncommitted changes"
              : "untracked files";
        throw new Error(`Worktree has ${description}. Use force delete to proceed.`);
      }

      const branchToDelete = deleteBranch ? monitor.branch : undefined;

      if (deleteBranch && !monitor.branch) {
        throw new Error("Cannot delete branch: worktree has no associated branch (detached HEAD)");
      }

      if (monitor.isCurrent) {
        let mainWorktreeId: string | undefined;
        for (const [id, m] of this.monitors) {
          if (m.isMainWorktree) {
            mainWorktreeId = id;
            break;
          }
        }
        if (!mainWorktreeId) {
          throw new Error("Cannot delete active worktree: no main worktree found to switch to");
        }
        this.setActiveWorktree(`${requestId}-auto-switch`, mainWorktreeId);
      }

      await this.runLifecycleTeardown(worktreeId, monitor, force);

      if (this.git) {
        const args = ["worktree", "remove"];
        if (force) {
          args.push("--force");
        }
        args.push(monitor.path);
        await this.git.raw(args);
        clearGitDirCache(monitor.path);

        const cacheKey = this.listService.getCacheKey();
        if (cacheKey) {
          this.listService.invalidateCache(cacheKey);
        }
      }

      // Clean up the monitor immediately after worktree removal succeeds,
      // before attempting branch deletion — so the monitor doesn't linger
      // if branch deletion fails.
      monitor.stop();
      this.monitors.delete(worktreeId);

      this.sendEvent({
        type: "worktree-removed",
        worktreeId,
      });

      if (branchToDelete && this.git) {
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
            throw new Error(`Cannot delete branch '${branchToDelete}': ${errorMsg.split("\n")[0]}`);
          } else {
            throw new Error(`Failed to delete branch '${branchToDelete}': ${errorMsg}`);
          }
        }
      }

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
      const git = createHardenedGit(rootPath);
      const summary: BranchSummary = await git.branch(["-a"]);
      const branches: BranchInfo[] = [];

      for (const [branchName, branchDetail] of Object.entries(summary.branches)) {
        if (
          branchName.includes("HEAD ->") ||
          branchName.endsWith("/HEAD") ||
          branchName.startsWith("(")
        ) {
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

  async fetchPRBranch(
    requestId: string,
    rootPath: string,
    prNumber: number,
    headRefName: string
  ): Promise<void> {
    try {
      const git = createAuthenticatedGit(rootPath);
      await git.raw(["fetch", "origin", `pull/${prNumber}/head:${headRefName}`]);
      this.sendEvent({ type: "fetch-pr-branch-result", requestId, success: true });
    } catch (error) {
      this.sendEvent({
        type: "fetch-pr-branch-result",
        requestId,
        success: false,
        error: (error as Error).message,
      });
    }
  }

  async getRecentBranches(requestId: string, rootPath: string): Promise<void> {
    try {
      const git = createHardenedGit(rootPath);
      const rawReflog = await git.raw(["reflog", "--format=%gs"]);

      if (!rawReflog?.trim()) {
        this.sendEvent({ type: "get-recent-branches-result", requestId, branches: [] });
        return;
      }

      const seen = new Set<string>();
      const branches: string[] = [];
      const checkoutRegex = /^checkout: moving from \S+ to (\S+)$/;

      for (const line of rawReflog.split("\n")) {
        const m = line.match(checkoutRegex);
        if (!m) continue;
        const name = m[1].trim();
        if (/^[0-9a-f]{40}$/i.test(name)) continue;
        if (!seen.has(name)) {
          seen.add(name);
          branches.push(name);
        }
      }

      this.sendEvent({ type: "get-recent-branches-result", requestId, branches });
    } catch {
      this.sendEvent({ type: "get-recent-branches-result", requestId, branches: [] });
    }
  }

  async getFileDiff(
    requestId: string,
    cwd: string,
    filePath: string,
    status: string
  ): Promise<void> {
    try {
      const { resolve, normalize, sep, isAbsolute } = await import("path");

      if (isAbsolute(filePath)) {
        throw new Error("Absolute paths are not allowed");
      }

      const normalizedPath = normalize(filePath);
      const pathSegments = normalizedPath.split(/[\\/]+/).filter(Boolean);
      if (pathSegments.includes("..") || normalizedPath.startsWith(sep)) {
        throw new Error("Path traversal detected");
      }

      // Git always uses forward slashes in diff output, even on Windows
      const gitPath = normalizedPath.replaceAll("\\", "/");

      const git = createHardenedGit(cwd);

      if (status === "untracked" || status === "added") {
        const { readFile } = await import("fs/promises");
        const absolutePath = resolve(cwd, normalizedPath);
        const buffer = await readFile(absolutePath);

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

        const diff = `diff --git a/${gitPath} b/${gitPath}
new file mode 100644
--- /dev/null
+++ b/${gitPath}
@@ -0,0 +1,${lines.length} @@
${lines.map((l) => "+" + l).join("\n")}`;

        this.sendEvent({ type: "get-file-diff-result", requestId, diff });
        return;
      }

      const diff = await git.diff(["HEAD", "--no-ext-diff", "--no-color", "--", normalizedPath]);

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

  updateMonitorConfig(config: MonitorConfig): void {
    if (config.pollIntervalActive !== undefined) {
      this.pollIntervalActive = config.pollIntervalActive;
    }
    if (config.pollIntervalBackground !== undefined) {
      this.pollIntervalBackground = config.pollIntervalBackground;
    }
    if (config.adaptiveBackoff !== undefined) {
      this.adaptiveBackoff = config.adaptiveBackoff;
    }
    if (config.pollIntervalMax !== undefined) {
      this.pollIntervalMax = config.pollIntervalMax;
    }

    for (const [worktreeId, monitor] of this.monitors) {
      const isActive = worktreeId === this.activeWorktreeId;
      const baseInterval = isActive ? this.pollIntervalActive : this.pollIntervalBackground;
      monitor.updateConfig({ basePollingInterval: baseInterval });
    }
  }

  setPollingEnabled(enabled: boolean): void {
    if (this.pollingEnabled === enabled) return;

    this.pollingEnabled = enabled;

    if (!enabled) {
      for (const monitor of this.monitors.values()) {
        monitor.pausePolling();
      }
    } else {
      for (const monitor of this.monitors.values()) {
        monitor.resumePolling();
      }
    }
  }

  pause(): void {
    console.log("[WorkspaceService] Pausing (backgrounded)");
    this.setPollingEnabled(false);
    pullRequestService.stop();
    try {
      os.setPriority(process.pid, os.constants.priority.PRIORITY_LOW);
    } catch {
      // Sandboxed environments may deny setpriority — non-fatal
    }
    if (typeof global.gc === "function") {
      global.gc();
    }
  }

  resume(): void {
    console.log("[WorkspaceService] Resuming (foregrounded)");
    try {
      os.setPriority(process.pid, os.constants.priority.PRIORITY_NORMAL);
    } catch {
      // Sandboxed environments may deny setpriority — non-fatal
    }
    this.setPollingEnabled(true);
    pullRequestService.start();
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

    return this.prService.initialize(this.projectRootPath, () => {
      const candidates: Array<{ worktreeId: string; branch?: string; issueNumber?: number }> = [];
      for (const monitor of this.monitors.values()) {
        candidates.push({
          worktreeId: monitor.id,
          branch: monitor.branch,
          issueNumber: monitor.issueNumber,
        });
      }
      return candidates;
    });
  }

  async onProjectSwitch(requestId: string): Promise<void> {
    this.prService.cleanup();

    for (const monitor of this.monitors.values()) {
      monitor.stop();
    }
    this.monitors.clear();

    this.activeWorktreeId = null;
    this.mainBranch = "main";
    this.git = null;
    this.projectRootPath = null;

    clearGitDirCache();
    this.listService.invalidateCache();
    this.listService.setGit(null, null);

    this.sendEvent({ type: "project-switch-result", requestId, success: true });
  }

  dispose(): void {
    this._shutdownController.abort();
    this.prService.cleanup();
    for (const monitor of this.monitors.values()) {
      monitor.stop();
    }
    this.monitors.clear();
    this.listService.invalidateCache();
  }
}
