/**
 * Workspace Host - UtilityProcess entry point for workspace management.
 *
 * This process handles all Git/worktree operations, keeping the Main process
 * responsive. It runs WorktreeService and GitService in an isolated context,
 * communicating with Main via IPC messages.
 *
 * Phase 1: Git operations (implemented)
 * Phase 2: CopyTreeService (implemented - #790)
 * Phase 3: DevServer log parsing (implemented - #789)
 */

import { MessagePort } from "node:worker_threads";
import PQueue from "p-queue";
import { mkdir, writeFile, stat } from "fs/promises";
import { join as pathJoin, dirname } from "path";
import { simpleGit, SimpleGit, BranchSummary } from "simple-git";
import type { Worktree, WorktreeChanges } from "../shared/types/domain.js";
import type {
  WorkspaceHostRequest,
  WorkspaceHostEvent,
  WorktreeSnapshot,
  MonitorConfig,
  CreateWorktreeOptions,
  BranchInfo,
} from "../shared/types/workspace-host.js";
import { invalidateGitStatusCache, getWorktreeChangesWithStats } from "./utils/git.js";
import { getGitDir, clearGitDirCache } from "./utils/gitUtils.js";
import { WorktreeRemovedError } from "./utils/errorTypes.js";
import { categorizeWorktree } from "./services/worktree/mood.js";
import { extractIssueNumberSync, extractIssueNumber } from "./services/issueExtractor.js";
import { AdaptivePollingStrategy, NoteFileReader } from "./services/worktree/index.js";
import { initializeLogger } from "./utils/logger.js";
import { copyTreeService } from "./services/CopyTreeService.js";
import { DevServerParser } from "./services/devserver/DevServerParser.js";
import { GitHubAuth } from "./services/github/GitHubAuth.js";
import { pullRequestService } from "./services/PullRequestService.js";
import { events } from "./services/events.js";
import { fileTreeService } from "./services/FileTreeService.js";
import type { CopyTreeProgress } from "../shared/types/ipc.js";
import type { PRServiceStatus } from "../shared/types/workspace-host.js";

// Validate we're running in UtilityProcess context
if (!process.parentPort) {
  throw new Error("[WorkspaceHost] Must run in UtilityProcess context");
}

if (process.env.CANOPY_USER_DATA) {
  initializeLogger(process.env.CANOPY_USER_DATA);
}

const port = process.parentPort as unknown as MessagePort;

// Global error handlers to prevent silent crashes
process.on("uncaughtException", (err) => {
  console.error("[WorkspaceHost] Uncaught Exception:", err);
  sendEvent({ type: "error", error: err.message });
});

process.on("unhandledRejection", (reason) => {
  console.error("[WorkspaceHost] Unhandled Rejection:", reason);
  sendEvent({
    type: "error",
    error: String(reason instanceof Error ? reason.message : reason),
  });
});

// Helper to send events to Main process
function sendEvent(event: WorkspaceHostEvent): void {
  port.postMessage(event);
}

// Configuration
const DEFAULT_ACTIVE_WORKTREE_INTERVAL_MS = 2000;
const DEFAULT_BACKGROUND_WORKTREE_INTERVAL_MS = 10000;
const NOTE_PATH = "canopy/note";

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

// WorktreeMonitor - simplified for workspace-host context
interface MonitorState extends WorktreeSnapshot {
  pollingTimer: NodeJS.Timeout | null;
  resumeTimer: NodeJS.Timeout | null;
  pollingInterval: number;
  isRunning: boolean;
  isUpdating: boolean;
  pollingEnabled: boolean;
  previousStateHash: string;
  pollingStrategy: AdaptivePollingStrategy;
  noteReader: NoteFileReader;
}

class WorkspaceHost {
  private monitors = new Map<string, MonitorState>();
  private pollQueue = new PQueue({ concurrency: 3 });
  private mainBranch: string = "main";
  private activeWorktreeId: string | null = null;
  private pollIntervalActive: number = DEFAULT_ACTIVE_WORKTREE_INTERVAL_MS;
  private pollIntervalBackground: number = DEFAULT_BACKGROUND_WORKTREE_INTERVAL_MS;
  private adaptiveBackoff: boolean = true;
  private pollIntervalMax: number = 30000;
  private circuitBreakerThreshold: number = 3;
  private git: SimpleGit | null = null;
  private pollingEnabled: boolean = true;
  private projectRootPath: string | null = null;
  private prEventUnsubscribers: (() => void)[] = [];

  async loadProject(requestId: string, projectRootPath: string): Promise<void> {
    try {
      this.projectRootPath = projectRootPath;
      this.git = simpleGit(projectRootPath);

      const rawWorktrees = await this.listWorktreesFromGit();
      const worktrees: Worktree[] = rawWorktrees.map((wt) => {
        const name = wt.isMainWorktree
          ? wt.path.split(new RegExp("[/\\\\]")).pop() || "Main"
          : wt.branch || wt.path.split(new RegExp("[/\\\\]")).pop() || "Worktree";

        return {
          id: wt.path,
          path: wt.path,
          name: name,
          branch: wt.branch,
          isCurrent: false,
          isMainWorktree: wt.isMainWorktree,
          gitDir: getGitDir(wt.path) || undefined,
        };
      });

      await this.syncMonitors(worktrees, this.activeWorktreeId, this.mainBranch);
      await this.refreshAll();

      this.initializePRService();

      sendEvent({ type: "load-project-result", requestId, success: true });
    } catch (error) {
      sendEvent({
        type: "load-project-result",
        requestId,
        success: false,
        error: (error as Error).message,
      });
    }
  }

  private async listWorktreesFromGit(): Promise<
    Array<{ path: string; branch: string; bare: boolean; isMainWorktree: boolean }>
  > {
    if (!this.git) {
      throw new Error("Git not initialized");
    }

    const output = await this.git.raw(["worktree", "list", "--porcelain"]);
    const worktrees: Array<{
      path: string;
      branch: string;
      bare: boolean;
      isMainWorktree: boolean;
    }> = [];

    let currentWorktree: Partial<{ path: string; branch: string; bare: boolean }> = {};

    const pushWorktree = () => {
      if (currentWorktree.path) {
        worktrees.push({
          path: currentWorktree.path,
          branch: currentWorktree.branch || "",
          bare: currentWorktree.bare || false,
          isMainWorktree: worktrees.length === 0,
        });
      }
      currentWorktree = {};
    };

    for (const line of output.split("\n")) {
      if (line.startsWith("worktree ")) {
        currentWorktree.path = line.replace("worktree ", "").trim();
      } else if (line.startsWith("branch ")) {
        currentWorktree.branch = line.replace("branch ", "").replace("refs/heads/", "").trim();
      } else if (line.startsWith("bare")) {
        currentWorktree.bare = true;
      } else if (line === "") {
        pushWorktree();
      }
    }

    pushWorktree();
    return worktrees;
  }

  async syncMonitors(
    worktrees: Worktree[],
    activeWorktreeId: string | null,
    mainBranch: string,
    monitorConfig?: MonitorConfig
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

    const currentIds = new Set(worktrees.map((wt) => wt.id));

    // Remove stale monitors
    for (const [id, monitor] of this.monitors) {
      if (!currentIds.has(id)) {
        if (monitor.isMainWorktree) {
          console.warn("[WorkspaceHost] Blocked removal of main worktree monitor");
          continue;
        }

        this.stopMonitor(monitor);
        this.monitors.delete(id);
        sendEvent({ type: "worktree-removed", worktreeId: id });
        events.emit("sys:worktree:remove", { worktreeId: id, timestamp: Date.now() });
      }
    }

    // Create or update monitors
    for (const wt of worktrees) {
      const existingMonitor = this.monitors.get(wt.id);
      const isActive = wt.id === activeWorktreeId;

      if (existingMonitor) {
        existingMonitor.branch = wt.branch;
        existingMonitor.name = wt.name;
        const interval = isActive ? this.pollIntervalActive : this.pollIntervalBackground;
        existingMonitor.pollingInterval = interval;
        existingMonitor.pollingStrategy.setBaseInterval(interval);
        existingMonitor.pollingStrategy.updateConfig(
          this.adaptiveBackoff,
          this.pollIntervalMax,
          this.circuitBreakerThreshold
        );
      } else {
        await ensureNoteFile(wt.path);
        const issueNumber = wt.branch ? extractIssueNumberSync(wt.branch, wt.name) : null;
        const interval = isActive ? this.pollIntervalActive : this.pollIntervalBackground;

        const monitor: MonitorState = {
          id: wt.id,
          path: wt.path,
          name: wt.name,
          branch: wt.branch,
          isCurrent: wt.isCurrent,
          isMainWorktree: Boolean(wt.isMainWorktree),
          gitDir: wt.gitDir,
          worktreeId: wt.id,
          worktreeChanges: null,
          mood: "stable",
          modifiedCount: 0,
          lastActivityTimestamp: null,
          issueNumber: issueNumber ?? undefined,
          pollingTimer: null,
          resumeTimer: null,
          pollingInterval: interval,
          isRunning: false,
          isUpdating: false,
          pollingEnabled: true,
          previousStateHash: "",
          pollingStrategy: new AdaptivePollingStrategy({ baseInterval: interval }),
          noteReader: new NoteFileReader(wt.path),
        };

        monitor.pollingStrategy.updateConfig(
          this.adaptiveBackoff,
          this.pollIntervalMax,
          this.circuitBreakerThreshold
        );

        this.monitors.set(wt.id, monitor);

        // Start the monitor
        await this.startMonitor(monitor);

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
      if (issueNumber && monitor.isRunning) {
        monitor.issueNumber = issueNumber;
        this.emitUpdate(monitor);
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
  }

  private scheduleNextPoll(monitor: MonitorState): void {
    if (!monitor.isRunning || !monitor.pollingEnabled || !this.pollingEnabled) {
      return;
    }

    if (monitor.pollingStrategy.isCircuitBreakerTripped()) {
      return;
    }

    if (monitor.pollingTimer) {
      return;
    }

    const nextInterval = monitor.pollingStrategy.calculateNextInterval();

    monitor.pollingTimer = setTimeout(() => {
      monitor.pollingTimer = null;
      void this.poll(monitor);
    }, nextInterval);
  }

  private async poll(monitor: MonitorState): Promise<void> {
    if (!monitor.isRunning || monitor.pollingStrategy.isCircuitBreakerTripped()) {
      return;
    }

    const executePoll = async (): Promise<void> => {
      const startTime = Date.now();

      try {
        await this.updateGitStatus(monitor);
        monitor.pollingStrategy.recordSuccess(Date.now() - startTime);
      } catch (error) {
        const tripped = monitor.pollingStrategy.recordFailure(Date.now() - startTime);

        if (tripped) {
          monitor.mood = "error";
          monitor.summary = `⚠️ Polling stopped after consecutive failures`;
          this.emitUpdate(monitor);
          return;
        }
      }
    };

    try {
      await this.pollQueue.add(() => executePoll());
    } catch {
      // Queue execution failed
    }

    if (monitor.isRunning && !monitor.pollingStrategy.isCircuitBreakerTripped()) {
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

      const newChanges = await getWorktreeChangesWithStats(monitor.path, forceRefresh);

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

      this.emitUpdate(monitor);
    } catch (error) {
      if (error instanceof WorktreeRemovedError) {
        monitor.mood = "error";
        monitor.summary = "⚠️ Directory not accessible";
        this.emitUpdate(monitor);
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

  private emitUpdate(monitor: MonitorState): void {
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
      aiNote: monitor.aiNote,
      aiNoteTimestamp: monitor.aiNoteTimestamp,
      issueNumber: monitor.issueNumber,
      prNumber: monitor.prNumber,
      prUrl: monitor.prUrl,
      prState: monitor.prState,
      worktreeChanges: monitor.worktreeChanges,
      worktreeId: monitor.worktreeId,
      timestamp: Date.now(),
    };

    sendEvent({ type: "worktree-update", worktree: snapshot });

    events.emit("sys:worktree:update", snapshot as any);
  }

  getAllStates(requestId: string): void {
    const states: WorktreeSnapshot[] = [];
    for (const monitor of this.monitors.values()) {
      states.push({
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
        aiNote: monitor.aiNote,
        aiNoteTimestamp: monitor.aiNoteTimestamp,
        issueNumber: monitor.issueNumber,
        prNumber: monitor.prNumber,
        prUrl: monitor.prUrl,
        prState: monitor.prState,
        worktreeChanges: monitor.worktreeChanges,
        worktreeId: monitor.worktreeId,
      });
    }
    sendEvent({ type: "all-states", requestId, states });
  }

  getMonitor(requestId: string, worktreeId: string): void {
    const monitor = this.monitors.get(worktreeId);
    if (!monitor) {
      sendEvent({ type: "monitor", requestId, state: null });
      return;
    }

    sendEvent({
      type: "monitor",
      requestId,
      state: {
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
        aiNote: monitor.aiNote,
        aiNoteTimestamp: monitor.aiNoteTimestamp,
        issueNumber: monitor.issueNumber,
        prNumber: monitor.prNumber,
        prUrl: monitor.prUrl,
        prState: monitor.prState,
        worktreeChanges: monitor.worktreeChanges,
        worktreeId: monitor.worktreeId,
      },
    });
  }

  setActiveWorktree(requestId: string, worktreeId: string): void {
    this.activeWorktreeId = worktreeId;

    for (const [id, monitor] of this.monitors) {
      const isActive = id === worktreeId;
      const interval = isActive ? this.pollIntervalActive : this.pollIntervalBackground;
      monitor.pollingInterval = interval;
      monitor.pollingStrategy.setBaseInterval(interval);
    }

    sendEvent({ type: "set-active-result", requestId, success: true });
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
        await this.refreshAll();
      }
      sendEvent({ type: "refresh-result", requestId, success: true });
    } catch (error) {
      sendEvent({
        type: "refresh-result",
        requestId,
        success: false,
        error: (error as Error).message,
      });
    }
  }

  private async refreshAll(): Promise<void> {
    const promises = Array.from(this.monitors.values()).map((monitor) =>
      this.updateGitStatus(monitor, true)
    );
    await Promise.all(promises);
  }

  async createWorktree(
    requestId: string,
    rootPath: string,
    options: CreateWorktreeOptions
  ): Promise<void> {
    try {
      const git = simpleGit(rootPath);
      const { baseBranch, newBranch, path, fromRemote = false } = options;

      if (fromRemote) {
        await git.raw(["worktree", "add", "-b", newBranch, "--track", path, baseBranch]);
      } else {
        await git.raw(["worktree", "add", "-b", newBranch, path, baseBranch]);
      }

      await ensureNoteFile(path);

      // Refresh worktree list
      const updatedWorktrees = await this.listWorktreesFromGit();
      const worktreeList: Worktree[] = updatedWorktrees.map((wt) => ({
        id: wt.path,
        path: wt.path,
        name: wt.isMainWorktree
          ? wt.path.split(new RegExp("[/\\\\]")).pop() || "Main"
          : wt.branch || wt.path.split(new RegExp("[/\\\\]")).pop() || wt.path,
        branch: wt.branch,
        isCurrent: false,
        isMainWorktree: wt.isMainWorktree,
        gitDir: getGitDir(wt.path) || undefined,
      }));

      await this.syncMonitors(worktreeList, this.activeWorktreeId, this.mainBranch);

      sendEvent({ type: "create-worktree-result", requestId, success: true });
    } catch (error) {
      sendEvent({
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
    force: boolean = false
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

      this.stopMonitor(monitor);
      this.monitors.delete(worktreeId);

      if (this.git) {
        const args = ["worktree", "remove"];
        if (force) {
          args.push("--force");
        }
        args.push(monitor.path);
        await this.git.raw(args);
        clearGitDirCache(monitor.path);
      }

      sendEvent({ type: "worktree-removed", worktreeId });
      sendEvent({ type: "delete-worktree-result", requestId, success: true });
    } catch (error) {
      sendEvent({
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

      sendEvent({ type: "list-branches-result", requestId, branches });
    } catch (error) {
      sendEvent({
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
          sendEvent({ type: "get-file-diff-result", requestId, diff: "BINARY_FILE" });
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

        sendEvent({ type: "get-file-diff-result", requestId, diff });
        return;
      }

      const diff = await git.diff(["HEAD", "--no-color", "--", normalizedPath]);

      if (diff.includes("Binary files")) {
        sendEvent({ type: "get-file-diff-result", requestId, diff: "BINARY_FILE" });
        return;
      }

      if (!diff.trim()) {
        sendEvent({ type: "get-file-diff-result", requestId, diff: "NO_CHANGES" });
        return;
      }

      sendEvent({ type: "get-file-diff-result", requestId, diff });
    } catch (error) {
      sendEvent({
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
    sendEvent({ type: "get-pr-status-result", requestId, status: prStatus });
  }

  resetPRState(requestId: string): void {
    pullRequestService.reset();
    if (this.projectRootPath) {
      pullRequestService.initialize(this.projectRootPath);
      pullRequestService.start();
    }
    sendEvent({ type: "reset-pr-state-result", requestId, success: true });
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

  private initializePRService(): void {
    if (!this.projectRootPath) {
      return;
    }

    this.cleanupPRService();

    pullRequestService.initialize(this.projectRootPath);
    pullRequestService.start();

    this.prEventUnsubscribers.push(
      events.on("sys:pr:detected", (data: any) => {
        const monitor = this.monitors.get(data.worktreeId);
        if (monitor) {
          monitor.prNumber = data.prNumber;
          monitor.prUrl = data.prUrl;
          monitor.prState = data.prState;
          this.emitUpdate(monitor);
        }

        sendEvent({
          type: "pr-detected",
          worktreeId: data.worktreeId,
          prNumber: data.prNumber,
          prUrl: data.prUrl,
          prState: data.prState,
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
          this.emitUpdate(monitor);
        }

        sendEvent({
          type: "pr-cleared",
          worktreeId: data.worktreeId,
        });
      })
    );
  }

  private cleanupPRService(): void {
    pullRequestService.destroy();
    for (const unsubscribe of this.prEventUnsubscribers) {
      unsubscribe();
    }
    this.prEventUnsubscribers = [];
  }

  async onProjectSwitch(requestId: string): Promise<void> {
    this.cleanupPRService();

    // Stop all monitors
    for (const monitor of this.monitors.values()) {
      this.stopMonitor(monitor);
    }
    this.monitors.clear();

    // Wait for pending polls
    await this.pollQueue.onIdle();

    // Reset state
    this.activeWorktreeId = null;
    this.mainBranch = "main";
    this.git = null;
    this.projectRootPath = null;

    // Clear caches
    clearGitDirCache();

    sendEvent({ type: "project-switch-result", requestId, success: true });
  }

  dispose(): void {
    this.cleanupPRService();
    for (const monitor of this.monitors.values()) {
      this.stopMonitor(monitor);
    }
    this.monitors.clear();
  }
}

// Create singleton instance
const workspaceHost = new WorkspaceHost();

// Handle requests from Main
port.on("message", async (rawMsg: any) => {
  const msg = rawMsg?.data ? rawMsg.data : rawMsg;

  try {
    const request = msg as WorkspaceHostRequest;

    switch (request.type) {
      case "load-project":
        await workspaceHost.loadProject(request.requestId, request.rootPath);
        break;

      case "sync":
        try {
          await workspaceHost.syncMonitors(
            request.worktrees,
            request.activeWorktreeId,
            request.mainBranch,
            request.monitorConfig
          );
          sendEvent({ type: "sync-result", requestId: request.requestId, success: true });
        } catch (error) {
          sendEvent({
            type: "sync-result",
            requestId: request.requestId,
            success: false,
            error: (error as Error).message,
          });
        }
        break;

      case "project-switch":
        await workspaceHost.onProjectSwitch(request.requestId);
        break;

      case "get-all-states":
        workspaceHost.getAllStates(request.requestId);
        break;

      case "get-monitor":
        workspaceHost.getMonitor(request.requestId, request.worktreeId);
        break;

      case "set-active":
        workspaceHost.setActiveWorktree(request.requestId, request.worktreeId);
        break;

      case "refresh":
        await workspaceHost.refresh(request.requestId, request.worktreeId);
        break;

      case "refresh-prs":
        try {
          await pullRequestService.refresh();
          sendEvent({ type: "refresh-prs-result", requestId: request.requestId, success: true });
        } catch (error) {
          sendEvent({
            type: "refresh-prs-result",
            requestId: request.requestId,
            success: false,
            error: (error as Error).message,
          });
        }
        break;

      case "get-pr-status":
        workspaceHost.getPRStatus(request.requestId);
        break;

      case "reset-pr-state":
        workspaceHost.resetPRState(request.requestId);
        break;

      case "create-worktree":
        await workspaceHost.createWorktree(request.requestId, request.rootPath, request.options);
        break;

      case "delete-worktree":
        await workspaceHost.deleteWorktree(request.requestId, request.worktreeId, request.force);
        break;

      case "list-branches":
        await workspaceHost.listBranches(request.requestId, request.rootPath);
        break;

      case "get-file-diff":
        await workspaceHost.getFileDiff(
          request.requestId,
          request.cwd,
          request.filePath,
          request.status
        );
        break;

      case "set-polling-enabled":
        workspaceHost.setPollingEnabled(request.enabled);
        break;

      case "health-check":
        sendEvent({ type: "pong" });
        break;

      case "dispose":
        workspaceHost.dispose();
        break;

      case "copytree:generate": {
        const { requestId, operationId, rootPath, options } = request;
        console.log(`[WorkspaceHost] CopyTree generate started: ${operationId}`);

        const onProgress = (progress: CopyTreeProgress) => {
          sendEvent({
            type: "copytree:progress",
            operationId,
            progress,
          });
        };

        try {
          const result = await copyTreeService.generate(
            rootPath,
            options || {},
            onProgress,
            operationId
          );
          sendEvent({
            type: "copytree:complete",
            requestId,
            operationId,
            result,
          });
        } catch (error) {
          sendEvent({
            type: "copytree:error",
            requestId,
            operationId,
            error: (error as Error).message,
          });
        }
        break;
      }

      case "copytree:cancel":
        copyTreeService.cancel(request.operationId);
        break;

      case "devserver:parse-output": {
        const { requestId, worktreeId, output } = request;
        try {
          const detected = DevServerParser.detectUrl(output);
          sendEvent({
            type: "devserver:urls-detected",
            requestId,
            worktreeId,
            detected,
          });
        } catch (error) {
          sendEvent({
            type: "error",
            error: (error as Error).message,
            requestId,
          });
        }
        break;
      }

      case "update-github-token":
        workspaceHost.updateGitHubToken(request.token);
        break;

      case "get-file-tree": {
        const { requestId, worktreePath, dirPath } = request;
        try {
          const nodes = await fileTreeService.getFileTree(worktreePath, dirPath);
          sendEvent({
            type: "file-tree-result",
            requestId,
            nodes,
          });
        } catch (error) {
          sendEvent({
            type: "file-tree-result",
            requestId,
            nodes: [],
            error: (error as Error).message,
          });
        }
        break;
      }

      default:
        console.warn("[WorkspaceHost] Unknown message type:", (msg as { type: string }).type);
    }
  } catch (error) {
    console.error("[WorkspaceHost] Error handling message:", error);
    sendEvent({ type: "error", error: (error as Error).message });
  }
});

// Handle process exit
process.on("exit", () => {
  workspaceHost.dispose();
  console.log("[WorkspaceHost] Disposed");
});

// Signal ready
console.log("[WorkspaceHost] Initialized and ready");
sendEvent({ type: "ready" });
