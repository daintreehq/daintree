/**
 * WorkspaceClient - Per-project workspace host process manager.
 *
 * Manages one UtilityProcess per active project path, with refcounting
 * for windows sharing the same project. Replaces the former singleton
 * host pattern that caused cross-project contamination.
 */

import { BrowserWindow } from "electron";
import { EventEmitter } from "events";
import path from "path";
import crypto from "crypto";
import { events } from "./events.js";
import { CHANNELS } from "../ipc/channels.js";
import { WorkspaceHostProcess } from "./WorkspaceHostProcess.js";
import type {
  WorkspaceClientConfig,
  WorktreeSnapshot,
  MonitorConfig,
  CreateWorktreeOptions,
  BranchInfo,
  WorkspaceHostEvent,
} from "../../shared/types/workspace-host.js";
import type {
  CopyTreeOptions,
  CopyTreeProgress,
  CopyTreeResult,
  FileTreeNode,
} from "../../shared/types/ipc.js";
import type { ProjectPulse, PulseRangeDays } from "../../shared/types/pulse.js";

export type CopyTreeProgressCallback = (progress: CopyTreeProgress) => void;

const CLEANUP_GRACE_MS = 5000;

const DEFAULT_CONFIG: Required<WorkspaceClientConfig> = {
  maxRestartAttempts: 3,
  healthCheckIntervalMs: 60000,
  showCrashDialog: true,
};

interface ProcessEntry {
  host: WorkspaceHostProcess;
  refCount: number;
  initPromise: Promise<void>;
  cleanupTimeout: NodeJS.Timeout | null;
  scopeId: string;
  windowIds: Set<number>;
  projectPath: string;
}

export class WorkspaceClient extends EventEmitter {
  private config: Required<WorkspaceClientConfig>;
  private isDisposed = false;

  private entries = new Map<string, ProcessEntry>();
  private windowToProject = new Map<number, string>();

  // Reverse map: worktree path → project path (populated from worktree-update events)
  private worktreePathToProject = new Map<string, string>();

  // CopyTree progress callbacks by operationId (manager-level)
  private copyTreeProgressCallbacks = new Map<string, CopyTreeProgressCallback>();
  private activeCopyTreeOperations = new Map<string, string>();

  constructor(config: WorkspaceClientConfig = {}) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  async waitForReady(): Promise<void> {
    const promises = [...this.entries.values()].map((e) => e.initPromise);
    if (promises.length === 0) return;
    await Promise.all(promises);
  }

  private normalizeProjectPath(p: string): string {
    return path.resolve(p);
  }

  private resolveEntryForWindow(windowId: number): ProcessEntry | undefined {
    const projectPath = this.windowToProject.get(windowId);
    if (!projectPath) return undefined;
    return this.entries.get(projectPath);
  }

  private resolveHostForWindow(windowId: number): WorkspaceHostProcess | undefined {
    return this.resolveEntryForWindow(windowId)?.host;
  }

  private sendToEntryWindows(entry: ProcessEntry, channel: string, ...args: unknown[]): void {
    if (entry.windowIds.size === 0) return;
    const windows = BrowserWindow.getAllWindows();
    for (const win of windows) {
      if (
        win &&
        !win.isDestroyed() &&
        entry.windowIds.has(win.id) &&
        !win.webContents.isDestroyed()
      ) {
        try {
          win.webContents.send(channel, ...args);
        } catch {
          // Silently ignore send failures during window initialization/disposal.
        }
      }
    }
  }

  private wireHostEvents(entry: ProcessEntry): void {
    const host = entry.host;

    host.on("host-event", (event: WorkspaceHostEvent) => {
      this.routeHostEvent(entry, event);
    });

    host.on("host-crash", (code: number) => {
      this.emit("host-crash", code);
    });

    host.on("restarted", () => {
      this.reloadProjectAfterRestart(entry).catch((err) => {
        console.error(`[WorkspaceClient] Failed to reload project after host restart:`, err);
      });
    });
  }

  private routeHostEvent(entry: ProcessEntry, event: WorkspaceHostEvent): void {
    if (this.isDisposed) return;

    switch (event.type) {
      case "worktree-update": {
        const worktree = event.worktree;
        // Populate reverse map for path-based routing
        if (worktree.path) {
          this.worktreePathToProject.set(
            this.normalizeProjectPath(worktree.path),
            entry.projectPath
          );
        }
        this.sendToEntryWindows(entry, CHANNELS.WORKTREE_UPDATE, worktree);
        events.emit("sys:worktree:update", {
          id: worktree.id,
          path: worktree.path,
          name: worktree.name,
          branch: worktree.branch,
          isCurrent: worktree.isCurrent,
          isMainWorktree: worktree.isMainWorktree,
          gitDir: worktree.gitDir,
          summary: worktree.summary,
          modifiedCount: worktree.modifiedCount,
          changes: worktree.changes,
          mood: worktree.mood,
          lastActivityTimestamp: worktree.lastActivityTimestamp ?? null,
          createdAt: worktree.createdAt,
          aiNote: worktree.aiNote,
          aiNoteTimestamp: worktree.aiNoteTimestamp,
          issueNumber: worktree.issueNumber,
          prNumber: worktree.prNumber,
          prUrl: worktree.prUrl,
          prState: worktree.prState,
          worktreeChanges: worktree.worktreeChanges,
          worktreeId: worktree.worktreeId,
          timestamp: worktree.timestamp,
        } as any);
        break;
      }

      case "worktree-removed":
        this.sendToEntryWindows(entry, CHANNELS.WORKTREE_REMOVE, {
          worktreeId: event.worktreeId,
        });
        break;

      case "pr-detected": {
        const prPayload = {
          worktreeId: event.worktreeId,
          prNumber: event.prNumber,
          prUrl: event.prUrl,
          prState: event.prState,
          prTitle: event.prTitle,
          issueNumber: event.issueNumber,
          issueTitle: event.issueTitle,
          timestamp: Date.now(),
        };
        events.emit("sys:pr:detected", prPayload);
        this.sendToEntryWindows(entry, CHANNELS.PR_DETECTED, prPayload);
        break;
      }

      case "pr-cleared": {
        const clearPayload = { worktreeId: event.worktreeId, timestamp: Date.now() };
        events.emit("sys:pr:cleared", clearPayload);
        this.sendToEntryWindows(entry, CHANNELS.PR_CLEARED, clearPayload);
        break;
      }

      case "issue-detected": {
        const issuePayload = {
          worktreeId: event.worktreeId,
          issueNumber: event.issueNumber,
          issueTitle: event.issueTitle,
        };
        events.emit("sys:issue:detected", { ...issuePayload, timestamp: Date.now() });
        this.sendToEntryWindows(entry, CHANNELS.ISSUE_DETECTED, issuePayload);
        break;
      }

      case "issue-not-found": {
        const notFoundPayload = {
          worktreeId: event.worktreeId,
          issueNumber: event.issueNumber,
          timestamp: Date.now(),
        };
        events.emit("sys:issue:not-found", notFoundPayload);
        this.sendToEntryWindows(entry, CHANNELS.ISSUE_NOT_FOUND, notFoundPayload);
        break;
      }

      case "copytree:progress": {
        const callback = this.copyTreeProgressCallbacks.get(event.operationId);
        callback?.(event.progress);
        break;
      }
    }
  }

  private async reloadProjectAfterRestart(entry: ProcessEntry): Promise<void> {
    const host = entry.host;
    await host.waitForReady();

    const requestId = host.generateRequestId();
    await host.sendWithResponse({
      type: "load-project",
      requestId,
      rootPath: entry.projectPath,
      projectScopeId: entry.scopeId,
    });
  }

  private releaseWindow(windowId: number): void {
    const projectPath = this.windowToProject.get(windowId);
    if (!projectPath) return;

    this.windowToProject.delete(windowId);
    const entry = this.entries.get(projectPath);
    if (!entry) return;

    entry.windowIds.delete(windowId);
    entry.refCount--;

    if (entry.refCount <= 0) {
      entry.cleanupTimeout = setTimeout(() => {
        entry.host.dispose();
        this.entries.delete(projectPath);
      }, CLEANUP_GRACE_MS);
    }
  }

  // ── Public API ──

  async loadProject(rootPath: string, windowId: number, _scopeId?: string): Promise<void> {
    if (this.isDisposed) {
      throw new Error("WorkspaceClient disposed");
    }

    const normalizedPath = this.normalizeProjectPath(rootPath);

    // Release old project for this window if switching to a different project
    const oldProject = this.windowToProject.get(windowId);
    if (oldProject && oldProject !== normalizedPath) {
      this.releaseWindow(windowId);
    }

    let entry = this.entries.get(normalizedPath);
    if (entry) {
      // Check if this entry has a failed initPromise (poisoned by prior crash)
      const isInitFailed = await entry.initPromise.then(
        () => false,
        () => true
      );
      if (isInitFailed) {
        // Clean up poisoned entry and fall through to create a fresh one
        entry.host.dispose();
        this.entries.delete(normalizedPath);
        entry = undefined;
      } else {
        // Existing healthy entry — increment refcount, reuse process
        if (!entry.windowIds.has(windowId)) {
          entry.refCount++;
          entry.windowIds.add(windowId);
        }
        if (entry.cleanupTimeout) {
          clearTimeout(entry.cleanupTimeout);
          entry.cleanupTimeout = null;
        }
        this.windowToProject.set(windowId, normalizedPath);
        return;
      }
    }

    // Create new per-project host
    const scopeId = crypto.randomUUID();
    const host = new WorkspaceHostProcess(normalizedPath, this.config);

    const initPromise = (async () => {
      await host.waitForReady();
      const requestId = host.generateRequestId();
      await host.sendWithResponse({
        type: "load-project",
        requestId,
        rootPath: normalizedPath,
        projectScopeId: scopeId,
      });
    })();

    entry = {
      host,
      refCount: 1,
      initPromise,
      cleanupTimeout: null,
      scopeId,
      windowIds: new Set([windowId]),
      projectPath: normalizedPath,
    };

    this.entries.set(normalizedPath, entry);
    this.windowToProject.set(windowId, normalizedPath);
    this.wireHostEvents(entry);

    try {
      await initPromise;
    } catch (error) {
      // Clean up failed entry so subsequent loadProject calls create a fresh host
      if (this.entries.get(normalizedPath) === entry) {
        this.entries.delete(normalizedPath);
        this.windowToProject.delete(windowId);
        entry.host.dispose();
      }
      throw error;
    }
  }

  async sync(
    worktrees: import("../../shared/types/worktree.js").Worktree[],
    activeWorktreeId: string | null = null,
    mainBranch: string = "main",
    monitorConfig?: MonitorConfig
  ): Promise<void> {
    // Fan out to all hosts
    for (const entry of this.entries.values()) {
      const requestId = entry.host.generateRequestId();
      await entry.host.sendWithResponse({
        type: "sync",
        requestId,
        worktrees,
        activeWorktreeId,
        mainBranch,
        monitorConfig,
      });
    }
  }

  async getAllStatesAsync(windowId?: number): Promise<WorktreeSnapshot[]> {
    if (windowId !== undefined) {
      const host = this.resolveHostForWindow(windowId);
      if (!host) return [];
      const requestId = host.generateRequestId();
      const result = await host.sendWithResponse<{ states: WorktreeSnapshot[] }>({
        type: "get-all-states",
        requestId,
      });
      return result.states;
    }

    // No windowId — aggregate from all hosts
    const allStates: WorktreeSnapshot[] = [];
    for (const entry of this.entries.values()) {
      try {
        const requestId = entry.host.generateRequestId();
        const result = await entry.host.sendWithResponse<{ states: WorktreeSnapshot[] }>({
          type: "get-all-states",
          requestId,
        });
        allStates.push(...result.states);
      } catch {
        // Host may be crashed or restarting
      }
    }
    return allStates;
  }

  async getMonitorAsync(worktreeId: string): Promise<WorktreeSnapshot | null> {
    // Fan out — only one host will have this worktree
    for (const entry of this.entries.values()) {
      try {
        const requestId = entry.host.generateRequestId();
        const result = await entry.host.sendWithResponse<{ state: WorktreeSnapshot | null }>({
          type: "get-monitor",
          requestId,
          worktreeId,
        });
        if (result.state) return result.state;
      } catch {
        // Try next host
      }
    }
    return null;
  }

  async setActiveWorktree(
    worktreeId: string,
    windowId?: number,
    options?: { silent?: boolean }
  ): Promise<void> {
    // Route to the window's host or fan out
    const hosts =
      windowId !== undefined
        ? ([this.resolveHostForWindow(windowId)].filter(Boolean) as WorkspaceHostProcess[])
        : [...this.entries.values()].map((e) => e.host);

    let accepted = false;
    for (const host of hosts) {
      try {
        const requestId = host.generateRequestId();
        await host.sendWithResponse({
          type: "set-active",
          requestId,
          worktreeId,
        });
        accepted = true;
        break; // Only one host needs to handle it
      } catch {
        // Try next
      }
    }

    if (accepted && !options?.silent) {
      if (windowId !== undefined) {
        const entry = this.resolveEntryForWindow(windowId);
        if (entry) {
          this.sendToEntryWindows(entry, CHANNELS.WORKTREE_ACTIVATED, { worktreeId });
        }
      } else {
        const windows = BrowserWindow.getAllWindows();
        for (const win of windows) {
          if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
            try {
              win.webContents.send(CHANNELS.WORKTREE_ACTIVATED, { worktreeId });
            } catch {
              // ignore
            }
          }
        }
      }
    }
  }

  async refresh(worktreeId?: string): Promise<void> {
    // Fan out to all hosts
    for (const entry of this.entries.values()) {
      try {
        const requestId = entry.host.generateRequestId();
        await entry.host.sendWithResponse({
          type: "refresh",
          requestId,
          worktreeId,
        });
      } catch {
        // Host may be crashed
      }
    }
  }

  async refreshPullRequests(): Promise<void> {
    for (const entry of this.entries.values()) {
      try {
        const requestId = entry.host.generateRequestId();
        await entry.host.sendWithResponse({
          type: "refresh-prs",
          requestId,
        });
      } catch {
        // Host may be crashed
      }
    }
  }

  async getPRStatus(): Promise<
    import("../../shared/types/workspace-host.js").PRServiceStatus | null
  > {
    // Return status from the first available host
    for (const entry of this.entries.values()) {
      try {
        const requestId = entry.host.generateRequestId();
        const result = await entry.host.sendWithResponse<{
          status: import("../../shared/types/workspace-host.js").PRServiceStatus | null;
        }>({
          type: "get-pr-status",
          requestId,
        });
        return result.status;
      } catch {
        // Try next
      }
    }
    return null;
  }

  async resetPRState(): Promise<void> {
    for (const entry of this.entries.values()) {
      try {
        const requestId = entry.host.generateRequestId();
        await entry.host.sendWithResponse({
          type: "reset-pr-state",
          requestId,
        });
      } catch {
        // ignore
      }
    }
  }

  updateGitHubToken(token: string | null): void {
    for (const entry of this.entries.values()) {
      entry.host.send({ type: "update-github-token", token });
    }
  }

  setPollingEnabled(enabled: boolean): void {
    for (const entry of this.entries.values()) {
      entry.host.send({ type: "set-polling-enabled", enabled });
    }
  }

  updateMonitorConfig(config: MonitorConfig): void {
    for (const entry of this.entries.values()) {
      const requestId = entry.host.generateRequestId();
      entry.host.send({ type: "update-monitor-config", requestId, config });
    }
  }

  async onProjectSwitch(windowId: number): Promise<void> {
    this.releaseWindow(windowId);
  }

  unregisterWindow(windowId: number): void {
    this.releaseWindow(windowId);
  }

  async listBranches(rootPath: string): Promise<BranchInfo[]> {
    const host = this.resolveHostForPath(rootPath);
    if (!host) return [];
    const requestId = host.generateRequestId();
    const result = await host.sendWithResponse<{ branches: BranchInfo[] }>({
      type: "list-branches",
      requestId,
      rootPath,
    });
    return result.branches;
  }

  async getRecentBranches(rootPath: string): Promise<string[]> {
    const host = this.resolveHostForPath(rootPath);
    if (!host) return [];
    const requestId = host.generateRequestId();
    const result = await host.sendWithResponse<{ branches: string[] }>({
      type: "get-recent-branches",
      requestId,
      rootPath,
    });
    return result.branches;
  }

  async createWorktree(rootPath: string, options: CreateWorktreeOptions): Promise<string> {
    const host = this.resolveHostForPath(rootPath);
    if (!host) throw new Error("No workspace host for project");
    const requestId = host.generateRequestId();
    const result = await host.sendWithResponse<{ worktreeId?: string }>({
      type: "create-worktree",
      requestId,
      rootPath,
      options,
    });
    return result.worktreeId ?? options.path;
  }

  async deleteWorktree(
    worktreeId: string,
    force: boolean = false,
    deleteBranch: boolean = false
  ): Promise<void> {
    // Fan out — only one host will have this worktree
    let lastError: Error | undefined;
    for (const entry of this.entries.values()) {
      try {
        const requestId = entry.host.generateRequestId();
        await entry.host.sendWithResponse({
          type: "delete-worktree",
          requestId,
          worktreeId,
          force,
          deleteBranch,
        });
        return;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
      }
    }
    throw lastError ?? new Error(`Worktree not found: ${worktreeId}`);
  }

  async getFileDiff(cwd: string, filePath: string, status: string): Promise<string> {
    // Route by cwd path
    const host = this.resolveHostForPath(cwd);
    if (!host) throw new Error("No workspace host for path");
    const requestId = host.generateRequestId();
    const result = await host.sendWithResponse<{ diff: string }>({
      type: "get-file-diff",
      requestId,
      cwd,
      filePath,
      status,
    });
    return result.diff;
  }

  // CopyTree methods

  async generateContext(
    rootPath: string,
    options?: CopyTreeOptions,
    onProgress?: CopyTreeProgressCallback
  ): Promise<CopyTreeResult> {
    const host = this.resolveHostForPath(rootPath);
    if (!host) throw new Error("No workspace host for path");

    const requestId = host.generateRequestId();
    const operationId = crypto.randomUUID();

    if (onProgress) {
      this.copyTreeProgressCallbacks.set(operationId, onProgress);
    }
    this.activeCopyTreeOperations.set(operationId, requestId);

    try {
      const result = await host.sendWithResponse<{ result: CopyTreeResult }>(
        {
          type: "copytree:generate",
          requestId,
          operationId,
          rootPath,
          options,
        },
        120000
      );
      return result.result;
    } finally {
      this.copyTreeProgressCallbacks.delete(operationId);
      this.activeCopyTreeOperations.delete(operationId);
    }
  }

  cancelContext(operationId: string): void {
    for (const entry of this.entries.values()) {
      entry.host.send({ type: "copytree:cancel", operationId });
    }

    const requestId = this.activeCopyTreeOperations.get(operationId);
    if (requestId) {
      // We can't easily resolve the pending request from here since it's
      // in the host's pendingRequests map. The cancel message to the host
      // will cause it to send a copytree:error which resolves the request.
    }

    this.copyTreeProgressCallbacks.delete(operationId);
    this.activeCopyTreeOperations.delete(operationId);
  }

  async testConfig(
    rootPath: string,
    options?: CopyTreeOptions
  ): Promise<import("../../shared/types/index.js").CopyTreeTestConfigResult> {
    const host = this.resolveHostForPath(rootPath);
    if (!host) {
      return {
        includedFiles: 0,
        includedSize: 0,
        excluded: { byTruncation: 0, bySize: 0, byPattern: 0 },
        error: "No workspace host for path",
      };
    }

    const requestId = host.generateRequestId();
    try {
      const result = await host.sendWithResponse<{
        result: import("../../shared/types/index.js").CopyTreeTestConfigResult;
      }>(
        {
          type: "copytree:test-config",
          requestId,
          rootPath,
          options,
        },
        120000
      );
      return result.result;
    } catch (error) {
      return {
        includedFiles: 0,
        includedSize: 0,
        excluded: { byTruncation: 0, bySize: 0, byPattern: 0 },
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  cancelAllContext(): void {
    for (const operationId of this.activeCopyTreeOperations.keys()) {
      for (const entry of this.entries.values()) {
        entry.host.send({ type: "copytree:cancel", operationId });
      }
    }
    this.copyTreeProgressCallbacks.clear();
    this.activeCopyTreeOperations.clear();
  }

  // Project Pulse methods

  async getProjectPulse(
    worktreePath: string,
    worktreeId: string,
    mainBranch: string,
    rangeDays: PulseRangeDays,
    options?: { includeDelta?: boolean; includeRecentCommits?: boolean; forceRefresh?: boolean }
  ): Promise<ProjectPulse> {
    const host = this.resolveHostForPath(worktreePath);
    if (!host) throw new Error("No workspace host for path");

    const requestId = host.generateRequestId();
    const result = await host.sendWithResponse<{ data: ProjectPulse }>(
      {
        type: "git:get-project-pulse",
        requestId,
        worktreePath,
        worktreeId,
        mainBranch,
        rangeDays,
        includeDelta: options?.includeDelta,
        includeRecentCommits: options?.includeRecentCommits,
        forceRefresh: options?.forceRefresh,
      },
      30000
    );
    return result.data;
  }

  // File tree methods

  async getFileTree(worktreePath: string, dirPath?: string): Promise<FileTreeNode[]> {
    const host = this.resolveHostForPath(worktreePath);
    if (!host) throw new Error("No workspace host for path");

    const requestId = host.generateRequestId();
    const result = await host.sendWithResponse<{ nodes: FileTreeNode[]; error?: string }>(
      {
        type: "get-file-tree",
        requestId,
        worktreePath,
        dirPath,
      },
      30000
    );

    if (result.error) {
      throw new Error(result.error);
    }
    return result.nodes;
  }

  // Broadcast lifecycle methods

  pauseHealthCheck(): void {
    for (const entry of this.entries.values()) {
      entry.host.pauseHealthCheck();
    }
  }

  resumeHealthCheck(): void {
    for (const entry of this.entries.values()) {
      entry.host.resumeHealthCheck();
    }
  }

  dispose(): void {
    if (this.isDisposed) return;
    this.isDisposed = true;

    for (const entry of this.entries.values()) {
      if (entry.cleanupTimeout) {
        clearTimeout(entry.cleanupTimeout);
      }
      entry.host.dispose();
    }
    this.entries.clear();
    this.windowToProject.clear();
    this.worktreePathToProject.clear();
    this.copyTreeProgressCallbacks.clear();
    this.activeCopyTreeOperations.clear();
    this.removeAllListeners();
  }

  isReady(): boolean {
    if (this.entries.size === 0) return !this.isDisposed;
    for (const entry of this.entries.values()) {
      if (entry.host.isReady()) return true;
    }
    return false;
  }

  // ── Private helpers ──

  private resolveHostForPath(targetPath: string): WorkspaceHostProcess | undefined {
    const normalized = this.normalizeProjectPath(targetPath);

    // Try exact match on project path
    const exactEntry = this.entries.get(normalized);
    if (exactEntry) return exactEntry.host;

    // Try finding an entry whose project path is a parent of the target
    for (const entry of this.entries.values()) {
      if (normalized.startsWith(entry.projectPath + path.sep) || normalized === entry.projectPath) {
        return entry.host;
      }
    }

    // Check reverse map: worktree path → project path (for sibling worktrees)
    const projectPath = this.worktreePathToProject.get(normalized);
    if (projectPath) {
      const entry = this.entries.get(projectPath);
      if (entry) return entry.host;
    }

    // Try matching target as a child of a known worktree path
    for (const [wtPath, projPath] of this.worktreePathToProject) {
      if (normalized.startsWith(wtPath + path.sep)) {
        const entry = this.entries.get(projPath);
        if (entry) return entry.host;
      }
    }

    // Only fall back to single-host case (avoids cross-project routing)
    if (this.entries.size === 1) {
      const [entry] = this.entries.values();
      if (entry.host.isReady()) return entry.host;
    }

    return undefined;
  }
}

// Singleton management
let workspaceClientInstance: WorkspaceClient | null = null;

export function getWorkspaceClient(config?: WorkspaceClientConfig): WorkspaceClient {
  if (!workspaceClientInstance) {
    workspaceClientInstance = new WorkspaceClient(config);
  }
  return workspaceClientInstance;
}

export function disposeWorkspaceClient(): void {
  if (workspaceClientInstance) {
    workspaceClientInstance.dispose();
    workspaceClientInstance = null;
  }
}
