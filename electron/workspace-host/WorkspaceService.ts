import os from "os";
import PQueue from "p-queue";
import { mkdir, writeFile, stat, readFile } from "fs/promises";
import { join as pathJoin, dirname, resolve as pathResolve, isAbsolute } from "path";
import { generateProjectId, settingsFilePath } from "../services/projectStorePaths.js";
import { SimpleGit, BranchSummary } from "simple-git";
import { createHardenedGit, createAuthenticatedGit } from "../utils/hardenedGit.js";
import type { Worktree, WorktreeResourceStatus } from "../../shared/types/worktree.js";
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
  private projectEnvVars: Record<string, string> = {};
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

  async loadProject(
    requestId: string,
    projectRootPath: string,
    globalEnvVars?: Record<string, string>
  ): Promise<void> {
    try {
      this.projectRootPath = projectRootPath;
      // Merge: global (lowest priority) < project-level < CANOPY_* (set in buildEnv)
      const projectEnvVars = await this.loadProjectEnvVars(projectRootPath);
      this.projectEnvVars = { ...(globalEnvVars ?? {}), ...projectEnvVars };
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
            onResourceStatusPoll: (worktreeId) => {
              void this.runResourceAction(`auto-status-${worktreeId}`, worktreeId, "status");
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

        void this.initResourceConfigAsync(monitor, wt.path);
      }
    }
  }

  private async initResourceConfigAsync(
    monitor: WorktreeMonitor,
    worktreePath: string
  ): Promise<void> {
    try {
      if (!this.projectRootPath) return;
      const config = await this.lifecycleService.loadConfig(worktreePath, this.projectRootPath);
      let resourceConfig = config?.resource;
      if (config?.resources) {
        const envKey = monitor.worktreeMode;
        if (envKey && config.resources[envKey]) {
          resourceConfig = config.resources[envKey];
        } else if (config.resources["default"]) {
          resourceConfig = config.resources["default"];
        } else {
          const keys = Object.keys(config.resources);
          if (keys.length > 0) resourceConfig = config.resources[keys[0]];
        }
      }
      if (!resourceConfig) {
        const envs = await this.lifecycleService.loadProjectResourceEnvironments(
          this.projectRootPath
        );
        if (envs) {
          const envKey = monitor.worktreeMode;
          if (envKey && envKey !== "local" && envs[envKey]) {
            resourceConfig = envs[envKey];
          } else {
            const keys = Object.keys(envs);
            if (keys.length > 0) resourceConfig = envs[keys[0]];
          }
        }
      }
      if (!resourceConfig || !monitor.isRunning) return;
      const vars = this.lifecycleService.buildVariables(
        worktreePath,
        this.projectRootPath,
        monitor.name,
        monitor.branch
      );
      const sub = (cmd: string) => this.lifecycleService.substituteVariables(cmd, vars);
      monitor.setHasResourceConfig(true);
      monitor.setHasStatusCommand(!!resourceConfig.status);
      monitor.setHasPauseCommand(!!resourceConfig.pause?.length);
      monitor.setHasResumeCommand(!!resourceConfig.resume?.length);
      monitor.setHasTeardownCommand(!!resourceConfig.teardown?.length);
      monitor.setResourceProvider(resourceConfig.provider);
      monitor.setResourceConnectCommand(
        resourceConfig.connect ? sub(resourceConfig.connect) : undefined
      );
      if (resourceConfig.statusInterval) {
        monitor.setResourcePollInterval(resourceConfig.statusInterval * 1000);
      }
      if (monitor.hasInitialStatus) {
        this.emitUpdate(monitor);
      }
    } catch {
      // Silently ignore — resource config is optional
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

      // Set worktree mode on the monitor before lifecycle runs
      if (options.worktreeMode && options.worktreeMode !== "local") {
        const m = this.monitors.get(canonicalWorktreeId);
        if (m) {
          m.setWorktreeMode(options.worktreeMode);
          m.setWorktreeEnvironmentLabel(options.worktreeMode);
        }
      }

      void this.runLifecycleSetup(
        canonicalWorktreeId,
        absolutePath,
        rootPath,
        options.provisionResource ?? options.worktreeMode === "remote-worker"
      );
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
    projectRootPath: string,
    provisionResource?: boolean,
    environmentId?: string
  ): Promise<void> {
    const config = await this.lifecycleService.loadConfig(worktreePath, projectRootPath);

    // Resolve resource config: prefer resources (plural) over resource (singular)
    let resolvedResource = config?.resource;
    if (config?.resources) {
      if (environmentId && config.resources[environmentId]) {
        resolvedResource = config.resources[environmentId];
      } else if (config.resources["default"]) {
        resolvedResource = config.resources["default"];
      } else {
        const keys = Object.keys(config.resources);
        if (keys.length > 0) {
          resolvedResource = config.resources[keys[0]];
        }
      }
    }

    // Fallback: resolve from project settings resourceEnvironments
    if (!resolvedResource && this.projectRootPath) {
      const monitor = this.monitors.get(worktreeId);
      const envKey = monitor?.worktreeMode;
      if (envKey && envKey !== "local") {
        const envs = await this.lifecycleService.loadProjectResourceEnvironments(
          this.projectRootPath
        );
        resolvedResource = envs?.[envKey] ?? undefined;
      }
    }

    if (!config?.setup?.length && !(provisionResource && resolvedResource?.provision?.length)) {
      // Cache resource config even if no setup commands
      if (resolvedResource) {
        const m = this.monitors.get(worktreeId);
        if (m) {
          const v = this.lifecycleService.buildVariables(
            worktreePath,
            projectRootPath,
            m.name,
            m.branch
          );
          m.setHasResourceConfig(true);
          m.setHasStatusCommand(!!resolvedResource.status);
          m.setHasPauseCommand(!!resolvedResource.pause?.length);
          m.setHasResumeCommand(!!resolvedResource.resume?.length);
          m.setHasTeardownCommand(!!resolvedResource.teardown?.length);
          m.setResourceProvider(resolvedResource.provider);
          m.setResourceConnectCommand(
            resolvedResource.connect
              ? this.lifecycleService.substituteVariables(resolvedResource.connect, v)
              : undefined
          );
          if (resolvedResource.statusInterval) {
            m.setResourcePollInterval(resolvedResource.statusInterval * 1000);
          }
          this.emitUpdate(m);
        }
      }
      return;
    }

    if (!config) return;

    const monitor = this.monitors.get(worktreeId);
    if (!monitor) {
      return;
    }

    const worktreeName = monitor.name;
    const vars = this.lifecycleService.buildVariables(
      worktreePath,
      projectRootPath,
      worktreeName,
      monitor.branch
    );
    const sub = (cmd: string) => this.lifecycleService.substituteVariables(cmd, vars);
    const commands = (config.setup ?? []).map(sub);
    const env = this.lifecycleService.buildEnv(
      worktreePath,
      projectRootPath,
      worktreeName,
      monitor.branch,
      {
        provider: resolvedResource?.provider,
        endpoint: monitor.resourceStatus?.endpoint,
        lastOutput: monitor.resourceStatus?.lastOutput,
      },
      this.projectEnvVars
    );

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

    if (resolvedResource) {
      const m = this.monitors.get(worktreeId);
      if (m) {
        m.setHasResourceConfig(true);
        m.setHasStatusCommand(!!resolvedResource.status);
        m.setHasPauseCommand(!!resolvedResource.pause?.length);
        m.setHasResumeCommand(!!resolvedResource.resume?.length);
        m.setHasTeardownCommand(!!resolvedResource.teardown?.length);
        m.setResourceProvider(resolvedResource.provider);
        m.setResourceConnectCommand(
          resolvedResource.connect ? sub(resolvedResource.connect) : undefined
        );
        if (resolvedResource.statusInterval) {
          m.setResourcePollInterval(resolvedResource.statusInterval * 1000);
        }
        this.emitUpdate(m);
      }
    }

    // Auto-provision if requested during worktree creation
    if (
      result.success &&
      provisionResource &&
      resolvedResource?.provision?.length &&
      this.projectRootPath
    ) {
      await this.runResourceAction(`auto-provision-${worktreeId}`, worktreeId, "provision");
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

    // Resolve resource config for teardown
    let teardownResource = config?.resource;
    if (config?.resources) {
      if (config.resources["default"]) {
        teardownResource = config.resources["default"];
      } else {
        const keys = Object.keys(config.resources);
        if (keys.length > 0) {
          teardownResource = config.resources[keys[0]];
        }
      }
    }

    // Fallback: resolve from project settings resourceEnvironments
    if (!teardownResource && this.projectRootPath) {
      const envKey = monitor.worktreeMode;
      if (envKey && envKey !== "local") {
        const envs = await this.lifecycleService.loadProjectResourceEnvironments(
          this.projectRootPath
        );
        teardownResource = envs?.[envKey] ?? undefined;
      }
    }

    const hasResourceTeardown = teardownResource?.teardown?.length && monitor.hasResourceConfig;
    if (!config?.teardown?.length && !hasResourceTeardown) {
      return;
    }

    const vars = this.lifecycleService.buildVariables(
      monitor.path,
      this.projectRootPath,
      monitor.name,
      monitor.branch
    );
    const sub = (cmd: string) => this.lifecycleService.substituteVariables(cmd, vars);
    const env = this.lifecycleService.buildEnv(
      monitor.path,
      this.projectRootPath,
      monitor.name,
      monitor.branch,
      {
        provider: teardownResource?.provider,
        endpoint: monitor.resourceStatus?.endpoint,
        lastOutput: monitor.resourceStatus?.lastOutput,
      },
      this.projectEnvVars
    );

    if (hasResourceTeardown) {
      const resourceTeardownCommands = teardownResource!.teardown!.map(sub);

      monitor.setLifecycleStatus({
        phase: "resource-teardown",
        state: "running",
        commandIndex: 0,
        totalCommands: resourceTeardownCommands.length,
        currentCommand: resourceTeardownCommands[0],
        startedAt: Date.now(),
      });
      this.emitUpdate(monitor);

      const resourceStartedAt = monitor.lifecycleStatus?.startedAt ?? Date.now();

      try {
        const resourceResult = await this.lifecycleService.runCommands(resourceTeardownCommands, {
          cwd: monitor.path,
          env,
          timeoutMs: 300_000,
          onProgress: (commandIndex, totalCommands, command) => {
            const m = this.monitors.get(worktreeId);
            if (m) {
              m.setLifecycleStatus({
                phase: "resource-teardown",
                state: "running",
                commandIndex,
                totalCommands,
                currentCommand: command,
                startedAt: m.lifecycleStatus?.startedAt ?? resourceStartedAt,
              });
              this.emitUpdate(m);
            }
          },
        });

        const m = this.monitors.get(worktreeId);
        if (m) {
          m.setLifecycleStatus({
            phase: "resource-teardown",
            state: resourceResult.timedOut
              ? "timed-out"
              : resourceResult.success
                ? "success"
                : "failed",
            totalCommands: resourceTeardownCommands.length,
            output: resourceResult.output,
            error: resourceResult.error,
            startedAt: resourceStartedAt,
            completedAt: Date.now(),
          });
          this.emitUpdate(m);
        }

        if (!resourceResult.success) {
          console.warn(
            `[WorktreeLifecycle] Resource teardown failed for worktree ${worktreeId} (continuing):`,
            resourceResult.error
          );
        }
      } catch (err) {
        const m = this.monitors.get(worktreeId);
        if (m) {
          m.setLifecycleStatus({
            phase: "resource-teardown",
            state: "failed",
            totalCommands: resourceTeardownCommands.length,
            error: (err as Error).message,
            startedAt: resourceStartedAt,
            completedAt: Date.now(),
          });
          this.emitUpdate(m);
        }
        console.warn(
          `[WorktreeLifecycle] Resource teardown threw for worktree ${worktreeId} (continuing):`,
          err
        );
      }
    }

    if (!config?.teardown?.length) {
      return;
    }

    const commands = config.teardown.map(sub);
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
    this.projectEnvVars = {};

    clearGitDirCache();
    this.listService.invalidateCache();
    this.listService.setGit(null, null);

    this.sendEvent({ type: "project-switch-result", requestId, success: true });
  }

  async switchWorktreeEnvironment(
    requestId: string,
    worktreeId: string,
    envKey: string
  ): Promise<void> {
    const monitor = this.monitors.get(worktreeId);
    if (!monitor) {
      this.sendEvent({
        type: "resource-action-result",
        requestId,
        success: false,
        error: "Worktree not found",
      });
      return;
    }

    monitor.setWorktreeMode(envKey);
    monitor.setWorktreeEnvironmentLabel(envKey);

    try {
      if (this.projectRootPath) {
        await this.runLifecycleSetup(worktreeId, monitor.path, this.projectRootPath, false, envKey);
      }
    } catch (err) {
      console.warn(
        `[WorkspaceService] switchWorktreeEnvironment config resolution failed (non-fatal):`,
        err
      );
    }

    this.emitUpdate(monitor);
    this.sendEvent({
      type: "resource-action-result",
      requestId,
      success: true,
    });
  }

  async runResourceAction(
    requestId: string,
    worktreeId: string,
    action: "provision" | "teardown" | "resume" | "pause" | "status",
    environmentId?: string
  ): Promise<void> {
    const monitor = this.monitors.get(worktreeId);
    if (!monitor) {
      this.sendEvent({
        type: "resource-action-result",
        requestId,
        success: false,
        error: "Worktree not found",
      });
      return;
    }

    if (!this.projectRootPath) {
      this.sendEvent({
        type: "resource-action-result",
        requestId,
        success: false,
        error: "No project root path",
      });
      return;
    }

    const config = await this.lifecycleService.loadConfig(monitor.path, this.projectRootPath);

    // Resolve resource config: prefer resources (plural) over resource (singular)
    let resourceConfig = config?.resource;
    if (config?.resources) {
      if (environmentId && config.resources[environmentId]) {
        resourceConfig = config.resources[environmentId];
      } else if (config.resources["default"]) {
        resourceConfig = config.resources["default"];
      } else {
        const keys = Object.keys(config.resources);
        if (keys.length > 0) {
          resourceConfig = config.resources[keys[0]];
        }
      }
    }

    // Fallback: resolve from project settings resourceEnvironments
    if (!resourceConfig && this.projectRootPath) {
      const envKey = monitor.worktreeMode;
      if (envKey && envKey !== "local") {
        const envs = await this.lifecycleService.loadProjectResourceEnvironments(
          this.projectRootPath
        );
        resourceConfig = envs?.[envKey] ?? undefined;
      }
    }

    if (!resourceConfig) {
      this.sendEvent({
        type: "resource-action-result",
        requestId,
        success: false,
        error: "No resource config found",
      });
      return;
    }

    const vars = this.lifecycleService.buildVariables(
      monitor.path,
      this.projectRootPath,
      monitor.name,
      monitor.branch
    );
    const sub = (cmd: string) => this.lifecycleService.substituteVariables(cmd, vars);

    monitor.setHasResourceConfig(true);
    monitor.setHasStatusCommand(!!resourceConfig.status);
    monitor.setHasPauseCommand(!!resourceConfig.pause?.length);
    monitor.setHasResumeCommand(!!resourceConfig.resume?.length);
    monitor.setHasTeardownCommand(!!resourceConfig.teardown?.length);
    monitor.setResourceProvider(resourceConfig.provider);
    monitor.setResourceConnectCommand(
      resourceConfig.connect ? sub(resourceConfig.connect) : undefined
    );
    if (resourceConfig.statusInterval) {
      monitor.setResourcePollInterval(resourceConfig.statusInterval * 1000);
    }

    const env = this.lifecycleService.buildEnv(
      monitor.path,
      this.projectRootPath,
      monitor.name,
      monitor.branch,
      {
        provider: resourceConfig.provider,
        endpoint: monitor.resourceStatus?.endpoint,
        lastOutput: monitor.resourceStatus?.lastOutput,
      },
      this.projectEnvVars
    );

    // Idempotent provision: route to resume when paused, no-op when already running.
    let effectiveAction = action;
    if (action === "provision") {
      const currentStatus = monitor.resourceStatus?.lastStatus?.toLowerCase();
      if (
        currentStatus === "ready" ||
        currentStatus === "running" ||
        currentStatus === "healthy" ||
        currentStatus === "up"
      ) {
        console.log(
          `[WorktreeLifecycle] Provision no-op for worktree ${worktreeId}: already ${currentStatus}`
        );
        this.sendEvent({
          type: "resource-action-result",
          requestId,
          success: true,
          output: `Resource is already ${currentStatus}`,
        });
        return;
      }
      if (currentStatus === "paused" || currentStatus === "stopped") {
        // "stopped" kept here only to gracefully handle a transient read from a CLI
        // that hasn't switched to "paused" yet; the schema/UI no longer emit it.
        console.log(
          `[WorktreeLifecycle] Provision routing to resume for worktree ${worktreeId}: currently ${currentStatus}`
        );
        effectiveAction = "resume";
      }
      // otherwise (not configured / error / unknown / undefined) fall through to provision.
    }

    if (action === "status") {
      if (!resourceConfig.status) {
        this.sendEvent({
          type: "resource-action-result",
          requestId,
          success: false,
          error: "No status command configured",
        });
        return;
      }

      const statusCmd = sub(resourceConfig.status);

      monitor.setLifecycleStatus({
        phase: "resource-status",
        state: "running",
        commandIndex: 0,
        totalCommands: 1,
        currentCommand: statusCmd,
        startedAt: Date.now(),
      });
      this.emitUpdate(monitor);

      const statusTimeoutSec = resourceConfig.timeouts?.status;
      const statusTimeoutMs = statusTimeoutSec != null ? statusTimeoutSec * 1000 : 120_000;
      const result = await this.lifecycleService.runCommands([statusCmd], {
        cwd: monitor.path,
        env,
        timeoutMs: statusTimeoutMs,
        onProgress: () => {},
      });

      try {
        const parsed = JSON.parse(result.output);
        monitor.setResourceStatus({
          lastStatus: parsed.status ?? "unhealthy",
          lastOutput: result.output,
          lastCheckedAt: Date.now(),
          endpoint: typeof parsed.endpoint === "string" ? parsed.endpoint : undefined,
          meta: parsed.meta != null && typeof parsed.meta === "object" ? parsed.meta : undefined,
        });
      } catch {
        // Non-JSON output: if command succeeded (exit 0), treat as "unknown" (neutral) rather
        // than "unhealthy" — the script may not emit JSON but still indicates a live resource.
        // Only mark "unhealthy" when the command itself failed (non-zero exit).
        monitor.setResourceStatus({
          lastStatus: result.success ? "unknown" : "unhealthy",
          lastOutput: result.output,
          lastCheckedAt: Date.now(),
        });
      }

      // Re-substitute connect command with endpoint from status
      const statusEndpoint = monitor.resourceStatus?.endpoint;
      if (statusEndpoint && resourceConfig.connect) {
        const varsWithEndpoint = this.lifecycleService.buildVariables(
          monitor.path,
          this.projectRootPath,
          monitor.name,
          monitor.branch,
          statusEndpoint
        );
        monitor.setResourceConnectCommand(
          this.lifecycleService.substituteVariables(resourceConfig.connect, varsWithEndpoint)
        );
      }

      if (statusEndpoint && monitor.resourceStatus?.lastStatus === "ready") {
        const resolvedConnect = monitor.resourceConnectCommand;
        if (resolvedConnect) {
          await this.generateRemoteWrapper(monitor.path, resolvedConnect, statusEndpoint);
        }
      }

      monitor.setLifecycleStatus({
        phase: "resource-status",
        state: result.timedOut ? "timed-out" : result.success ? "success" : "failed",
        totalCommands: 1,
        output: result.output,
        error: result.error,
        startedAt: monitor.lifecycleStatus?.startedAt ?? Date.now(),
        completedAt: Date.now(),
      });
      this.emitUpdate(monitor);

      this.sendEvent({
        type: "resource-action-result",
        requestId,
        success: result.success,
        output: result.output,
        error: result.error,
      });
      return;
    }

    const commands = (
      resourceConfig[effectiveAction as "provision" | "teardown" | "resume" | "pause"] as
        | string[]
        | undefined
    )?.map(sub);
    if (!commands?.length) {
      this.sendEvent({
        type: "resource-action-result",
        requestId,
        success: false,
        error: `No ${effectiveAction} commands configured`,
      });
      return;
    }

    const phase = `resource-${effectiveAction}` as const;
    const DEFAULT_TIMEOUT: Record<string, number> = {
      provision: 300_000,
      teardown: 300_000,
      resume: 120_000,
      pause: 120_000,
      status: 120_000,
    };
    const configTimeoutSec =
      resourceConfig.timeouts?.[effectiveAction as keyof typeof resourceConfig.timeouts];
    const timeoutMs =
      configTimeoutSec != null
        ? configTimeoutSec * 1000
        : (DEFAULT_TIMEOUT[effectiveAction] ?? 120_000);

    monitor.setLifecycleStatus({
      phase,
      state: "running",
      commandIndex: 0,
      totalCommands: commands.length,
      currentCommand: commands[0],
      startedAt: Date.now(),
    });
    this.emitUpdate(monitor);

    const startedAt = monitor.lifecycleStatus?.startedAt ?? Date.now();

    const result = await this.lifecycleService.runCommands(commands, {
      cwd: monitor.path,
      env,
      timeoutMs,
      onProgress: (commandIndex, totalCommands, command) => {
        const m = this.monitors.get(worktreeId);
        if (m) {
          m.setLifecycleStatus({
            phase,
            state: "running",
            commandIndex,
            totalCommands,
            currentCommand: command,
            startedAt: m.lifecycleStatus?.startedAt ?? startedAt,
          });
          this.emitUpdate(m);
        }
      },
    });

    const finalMonitor = this.monitors.get(worktreeId);
    if (finalMonitor) {
      finalMonitor.setLifecycleStatus({
        phase,
        state: result.timedOut ? "timed-out" : result.success ? "success" : "failed",
        totalCommands: commands.length,
        output: result.output,
        error: result.error,
        startedAt,
        completedAt: Date.now(),
      });

      if (result.success && (effectiveAction === "resume" || effectiveAction === "pause")) {
        const prevStatus = finalMonitor.resourceStatus;
        const timestampUpdate: Partial<WorktreeResourceStatus> =
          effectiveAction === "resume" ? { resumedAt: Date.now() } : { pausedAt: Date.now() };
        finalMonitor.setResourceStatus({
          ...prevStatus,
          ...timestampUpdate,
        });
      }

      this.emitUpdate(finalMonitor);
    }

    if (!result.success) {
      console.warn(
        `[WorktreeLifecycle] Resource ${action} failed for worktree ${worktreeId}:`,
        result.error
      );
    }

    this.sendEvent({
      type: "resource-action-result",
      requestId,
      success: result.success,
      output: result.output,
      error: result.error,
    });
  }

  async hasResourceConfig(rootPath: string): Promise<boolean> {
    if (!this.projectRootPath) {
      return false;
    }
    const config = await this.lifecycleService.loadConfig(rootPath, this.projectRootPath);
    if (config?.resource || config?.resources) return true;
    const envs = await this.lifecycleService.loadProjectResourceEnvironments(this.projectRootPath);
    return envs !== null && Object.keys(envs).length > 0;
  }

  private async generateRemoteWrapper(
    worktreePath: string,
    connectCommand: string,
    endpoint: string
  ): Promise<void> {
    try {
      const wrapperPath = pathJoin(worktreePath, ".canopy", "canopy-remote");
      await mkdir(pathJoin(worktreePath, ".canopy"), { recursive: true });

      const scriptContent = `#!/usr/bin/env bash
# Auto-generated by Canopy - wraps remote compute access
# Endpoint: ${endpoint}
set -euo pipefail
if [ $# -eq 0 ]; then
  echo "Usage: canopy-remote <command>" >&2
  exit 1
fi
${connectCommand} "$@"
`;

      await writeFile(wrapperPath, scriptContent, { mode: 0o755 });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.warn("[WorkspaceService] Failed to generate canopy-remote wrapper:", msg);
    }
  }

  private async loadProjectEnvVars(projectRootPath: string): Promise<Record<string, string>> {
    try {
      const userDataDir = process.env.CANOPY_USER_DATA ?? "";
      const projectId = generateProjectId(projectRootPath);
      const filePath = settingsFilePath(userDataDir, projectId);
      if (!filePath) return {};
      const raw = await readFile(filePath, "utf8");
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
      const envVars = (parsed as Record<string, unknown>).environmentVariables;
      if (!envVars || typeof envVars !== "object" || Array.isArray(envVars)) return {};
      const result: Record<string, string> = {};
      for (const [k, v] of Object.entries(envVars as Record<string, unknown>)) {
        if (typeof k === "string" && typeof v === "string") {
          result[k] = v;
        }
      }
      return result;
    } catch {
      return {};
    }
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
