/**
 * WorkspaceClient - Per-project workspace host process manager.
 *
 * Manages one UtilityProcess per active project path, with refcounting
 * for windows sharing the same project. Replaces the former singleton
 * host pattern that caused cross-project contamination.
 */

import { MessageChannelMain, type WebContents } from "electron";
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

const CLEANUP_GRACE_MS = 180_000; // 3 minutes
const MAX_WARM_ENTRIES = 3;

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
  /** WebContents with direct MessagePort connections to this host */
  directPortViews: Map<number, WebContents>;
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
    // Target this project's specific webContents via directPortViews rather
    // than using getAppWebContents(win), which returns the *active* view for
    // a window.  In multi-view mode the active view may belong to a different
    // project, causing cross-project worktree contamination.
    for (const [wcId, wc] of entry.directPortViews) {
      if (wc.isDestroyed()) {
        entry.directPortViews.delete(wcId);
        continue;
      }
      try {
        wc.send(channel, ...args);
      } catch {
        // Silently ignore send failures during window initialization/disposal.
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

    // IPC relay targets each entry's directPortViews — the same webContents
    // that hold the direct MessagePort.  Views receive events twice (port +
    // IPC); stores handle dedup via equality checks.

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
        this.sendToEntryWindows(entry, CHANNELS.WORKTREE_UPDATE, {
          worktree,
          scopeId: entry.scopeId,
        });
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

    // Re-establish direct renderer ports after host restart
    for (const [wcId, wc] of entry.directPortViews) {
      if (wc.isDestroyed()) {
        entry.directPortViews.delete(wcId);
        continue;
      }
      this.createDirectPortForEntry(entry, wc);
    }
  }

  private evictEntry(projectPath: string, entry: ProcessEntry): void {
    if (entry.cleanupTimeout) {
      clearTimeout(entry.cleanupTimeout);
      entry.cleanupTimeout = null;
    }
    entry.host.dispose();
    this.entries.delete(projectPath);
  }

  private enforceDormantCap(): void {
    let dormantCount = 0;
    for (const entry of this.entries.values()) {
      if (entry.refCount <= 0 && entry.cleanupTimeout !== null) {
        dormantCount++;
      }
    }

    while (dormantCount > MAX_WARM_ENTRIES) {
      // Find the LRU dormant entry (first in iteration order with refCount <= 0)
      for (const [path, entry] of this.entries) {
        if (entry.refCount <= 0 && entry.cleanupTimeout !== null) {
          this.evictEntry(path, entry);
          dormantCount--;
          break;
        }
      }
    }
  }

  private scheduleDormantCleanup(projectPath: string, entry: ProcessEntry): void {
    if (entry.cleanupTimeout) {
      clearTimeout(entry.cleanupTimeout);
    }
    entry.cleanupTimeout = setTimeout(() => {
      entry.host.dispose();
      this.entries.delete(projectPath);
    }, CLEANUP_GRACE_MS);
    this.enforceDormantCap();
  }

  private releaseWindow(windowId: number): void {
    const projectPath = this.windowToProject.get(windowId);
    if (!projectPath) return;

    this.windowToProject.delete(windowId);
    const entry = this.entries.get(projectPath);
    if (!entry) return;

    entry.windowIds.delete(windowId);
    entry.refCount--;

    // Clean up any direct port views for this window's webContents
    for (const [wcId, wc] of entry.directPortViews) {
      if (wc.isDestroyed()) {
        entry.directPortViews.delete(wcId);
      }
    }

    if (entry.refCount <= 0) {
      this.scheduleDormantCleanup(projectPath, entry);
    }
  }

  // ── Public API ──

  async loadProject(rootPath: string, windowId: number, _scopeId?: string): Promise<string> {
    if (this.isDisposed) {
      throw new Error("WorkspaceClient disposed");
    }

    const normalizedPath = this.normalizeProjectPath(rootPath);
    const oldProjectPath = this.windowToProject.get(windowId);
    const isSwitching = oldProjectPath !== undefined && oldProjectPath !== normalizedPath;

    const existingEntry = this.entries.get(normalizedPath);
    if (existingEntry) {
      // Check if this entry has a failed initPromise (poisoned by prior crash)
      const isInitFailed = await existingEntry.initPromise.then(
        () => false,
        () => true
      );
      if (isInitFailed) {
        existingEntry.host.dispose();
        this.entries.delete(normalizedPath);
      } else {
        // Existing healthy entry — promote to MRU and attach window
        this.entries.delete(normalizedPath);
        this.entries.set(normalizedPath, existingEntry);

        if (!existingEntry.windowIds.has(windowId)) {
          existingEntry.refCount++;
          existingEntry.windowIds.add(windowId);
        }
        if (existingEntry.cleanupTimeout) {
          clearTimeout(existingEntry.cleanupTimeout);
          existingEntry.cleanupTimeout = null;
        }
        this.windowToProject.set(windowId, normalizedPath);

        if (isSwitching) {
          this.releaseOldProject(windowId, oldProjectPath);
        }
        return existingEntry.scopeId;
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

    const newEntry: ProcessEntry = {
      host,
      refCount: 1,
      initPromise,
      cleanupTimeout: null,
      scopeId,
      windowIds: new Set([windowId]),
      projectPath: normalizedPath,
      directPortViews: new Map(),
    };

    this.entries.set(normalizedPath, newEntry);
    this.wireHostEvents(newEntry);

    try {
      await initPromise;
    } catch (error) {
      // Clean up failed entry so subsequent calls create a fresh host
      if (this.entries.get(normalizedPath) === newEntry) {
        this.entries.delete(normalizedPath);
        newEntry.windowIds.delete(windowId);
        newEntry.refCount--;
        newEntry.host.dispose();
      }
      throw error;
    }

    if (this.isDisposed) {
      if (newEntry.refCount <= 0 && this.entries.get(normalizedPath) === newEntry) {
        newEntry.host.dispose();
        this.entries.delete(normalizedPath);
      }
      return scopeId;
    }

    this.windowToProject.set(windowId, normalizedPath);

    if (isSwitching) {
      this.releaseOldProject(windowId, oldProjectPath);
    }

    return scopeId;
  }

  private releaseOldProject(windowId: number, oldProjectPath: string): void {
    const oldEntry = this.entries.get(oldProjectPath);
    if (!oldEntry) return;

    oldEntry.windowIds.delete(windowId);
    oldEntry.refCount--;

    if (oldEntry.refCount <= 0) {
      this.scheduleDormantCleanup(oldProjectPath, oldEntry);
    }
  }

  /**
   * Create a direct MessagePort channel between a workspace host and a renderer view.
   * Spontaneous events (worktree updates, PR/issue events) bypass the main-process relay.
   */
  attachDirectPort(windowId: number, webContents: WebContents): void {
    const entry = this.resolveEntryForWindow(windowId);
    if (!entry) {
      console.warn("[WorkspaceClient] No entry for window, cannot attach direct port");
      return;
    }
    this.createDirectPortForEntry(entry, webContents);
  }

  private createDirectPortForEntry(entry: ProcessEntry, webContents: WebContents): void {
    if (webContents.isDestroyed()) return;

    const { port1, port2 } = new MessageChannelMain();

    // port1 → workspace host UtilityProcess
    const attached = entry.host.attachRendererPort(port1);
    if (!attached) {
      port1.close();
      port2.close();
      return;
    }

    // port2 → renderer view
    webContents.postMessage("workspace-port", null, [port2]);
    entry.directPortViews.set(webContents.id, webContents);
  }

  /**
   * Remove a direct port mapping when a view is evicted/destroyed.
   * Called by ProjectViewManager.onViewEvicted callback.
   */
  removeDirectPort(webContentsId: number): void {
    for (const entry of this.entries.values()) {
      entry.directPortViews.delete(webContentsId);
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
        // Broadcast to all entries' views (no windowId → fan out)
        for (const entry of this.entries.values()) {
          this.sendToEntryWindows(entry, CHANNELS.WORKTREE_ACTIVATED, { worktreeId });
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

  async fetchPRBranch(rootPath: string, prNumber: number, headRefName: string): Promise<void> {
    const host = this.resolveHostForPath(rootPath);
    if (!host) throw new Error("No workspace host for project");
    const requestId = host.generateRequestId();
    await host.sendWithResponse({
      type: "fetch-pr-branch",
      requestId,
      rootPath,
      prNumber,
      headRefName,
    });
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
