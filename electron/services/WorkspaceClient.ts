/**
 * WorkspaceClient - Main process stub for workspace management.
 *
 * This class provides a drop-in replacement for WorktreeService in the Main process.
 * It forwards all operations to the Workspace Host (UtilityProcess) via IPC,
 * keeping the Main thread responsive.
 *
 * Interface matches WorktreeService for seamless integration with existing code.
 */

import { utilityProcess, UtilityProcess, dialog, app, BrowserWindow } from "electron";
import { EventEmitter } from "events";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { events } from "./events.js";
import { CHANNELS } from "../ipc/channels.js";
import type {
  WorkspaceHostRequest,
  WorkspaceHostEvent,
  WorkspaceClientConfig,
  WorktreeSnapshot,
  MonitorConfig,
  CreateWorktreeOptions,
  BranchInfo,
} from "../../shared/types/workspace-host.js";
import type { Worktree } from "../../shared/types/domain.js";
import type {
  CopyTreeOptions,
  CopyTreeProgress,
  CopyTreeResult,
  FileTreeNode,
} from "../../shared/types/ipc.js";
import type { ProjectPulse, PulseRangeDays } from "../../shared/types/pulse.js";
import { GitHubAuth } from "./github/GitHubAuth.js";

export type CopyTreeProgressCallback = (progress: CopyTreeProgress) => void;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Default configuration */
const DEFAULT_CONFIG: Required<WorkspaceClientConfig> = {
  maxRestartAttempts: 3,
  healthCheckIntervalMs: 60000,
  showCrashDialog: true,
};

export class WorkspaceClient extends EventEmitter {
  private child: UtilityProcess | null = null;
  private config: Required<WorkspaceClientConfig>;
  private isInitialized = false;
  private isDisposed = false;
  private healthCheckInterval: NodeJS.Timeout | null = null;
  private restartTimer: NodeJS.Timeout | null = null;
  private restartAttempts = 0;
  private isHealthCheckPaused = false;

  // Callback maps for request/response correlation
  private pendingRequests = new Map<
    string,
    {
      resolve: (value: any) => void;
      reject: (error: Error) => void;
      timeout: NodeJS.Timeout;
    }
  >();

  // CopyTree progress callbacks by operationId
  private copyTreeProgressCallbacks = new Map<string, CopyTreeProgressCallback>();
  // Track active CopyTree operations: operationId -> requestId
  private activeCopyTreeOperations = new Map<string, string>();

  // Ready promise
  private readyPromise: Promise<void>;
  private readyResolve: (() => void) | null = null;
  private readyReject: ((error: Error) => void) | null = null;

  // Cached state
  private currentRootPath: string | null = null;
  private currentProjectScopeId: string | null = null;
  private lastScopeMismatchWarnAt = 0;

  constructor(config: WorkspaceClientConfig = {}) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };

    this.readyPromise = new Promise((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });

    this.startHost();
  }

  /** Wait for the host to be ready */
  async waitForReady(): Promise<void> {
    return this.readyPromise;
  }

  private startHealthCheckLoop(): void {
    if (this.healthCheckInterval || this.isHealthCheckPaused || !this.child) {
      return;
    }

    this.healthCheckInterval = setInterval(() => {
      if (this.isInitialized && this.child && !this.isHealthCheckPaused) {
        this.send({ type: "health-check" });
      }
    }, this.config.healthCheckIntervalMs);
  }

  private startHost(): void {
    if (this.isDisposed) {
      console.warn("[WorkspaceClient] Cannot start host - already disposed");
      return;
    }

    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }

    // Reject previous ready promise only if host is restarting (not on initial boot)
    // Check isInitialized to identify restart vs first start
    if (this.readyReject && this.isInitialized) {
      this.readyReject(new Error("Workspace Host restarting"));
    }

    this.isInitialized = false;
    this.readyPromise = new Promise((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });

    const hostPath = path.join(__dirname, "workspace-host.js");
    console.log(`[WorkspaceClient] Starting Workspace Host from: ${hostPath}`);

    try {
      this.child = utilityProcess.fork(hostPath, [], {
        serviceName: "canopy-workspace-host",
        stdio: "inherit",
        env: {
          ...(process.env as Record<string, string>),
          CANOPY_USER_DATA: app.getPath("userData"),
        },
      });
    } catch (error) {
      console.error("[WorkspaceClient] Failed to fork Workspace Host:", error);
      // Reject ready promise so waitForReady() doesn't hang indefinitely
      if (this.readyReject) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        this.readyReject(new Error(`Workspace host failed to fork (${hostPath}): ${errorMessage}`));
        this.readyReject = null;
      }
      this.emit("host-crash", -1);
      return;
    }

    this.child.on("message", (msg: WorkspaceHostEvent) => {
      this.handleHostEvent(msg);
    });

    this.child.on("error", (error) => {
      console.error("[WorkspaceClient] Workspace Host error event:", error);
      if (this.readyReject) {
        this.readyReject(new Error(`Workspace host error: ${String(error)}`));
        this.readyReject = null;
      }
      this.emit("host-crash", -1);
    });

    this.child.on("exit", (code) => {
      console.error(`[WorkspaceClient] Workspace Host exited with code ${code}`);

      if (this.healthCheckInterval) {
        clearInterval(this.healthCheckInterval);
        this.healthCheckInterval = null;
      }

      this.isInitialized = false;
      this.child = null;

      // Reject all pending requests and clear their timeouts
      for (const [, { reject, timeout }] of this.pendingRequests) {
        clearTimeout(timeout);
        reject(new Error("Workspace Host crashed"));
      }
      this.pendingRequests.clear();

      // Reject ready promise for any waiters
      if (this.readyReject) {
        this.readyReject(new Error(`Workspace Host crashed (exit code ${code})`));
        this.readyReject = null;
      }

      if (this.isDisposed) {
        return;
      }

      if (this.restartAttempts < this.config.maxRestartAttempts) {
        this.restartAttempts++;
        const delay = Math.min(1000 * Math.pow(2, this.restartAttempts), 10000);
        console.log(
          `[WorkspaceClient] Restarting Host in ${delay}ms (attempt ${this.restartAttempts}/${this.config.maxRestartAttempts})`
        );

        if (this.restartTimer) {
          clearTimeout(this.restartTimer);
        }
        this.restartTimer = setTimeout(() => {
          this.restartTimer = null;
          this.startHost();
          // Re-load project if we had one, preserving the existing scope ID
          // so that events from the restarted host still match the client's scope.
          // Wait for the host to be ready before sending loadProject to avoid
          // racing with the 'ready' handshake (token-order contract).
          if (this.currentRootPath) {
            const rootPath = this.currentRootPath;
            const preservedScopeId = this.currentProjectScopeId ?? undefined;
            void this.waitForReady()
              .then(() => this.loadProject(rootPath, preservedScopeId))
              .catch((err) => {
                console.error(
                  "[WorkspaceClient] Failed to reload project after host restart:",
                  err
                );
              });
          }
        }, delay);
      } else {
        console.error("[WorkspaceClient] Max restart attempts reached, giving up");
        this.emit("host-crash", code);

        if (this.config.showCrashDialog) {
          dialog
            .showMessageBox({
              type: "error",
              title: "Workspace Service Crashed",
              message: `The workspace backend crashed (code ${code}). Worktree monitoring may need to be restarted.`,
              buttons: ["OK"],
            })
            .catch(console.error);
        }
      }
    });

    this.startHealthCheckLoop();

    console.log("[WorkspaceClient] Workspace Host started");
  }

  private isCurrentProjectEvent(eventScopeId: string): boolean {
    if (!this.currentProjectScopeId || !eventScopeId) {
      return false;
    }
    const isMatch = eventScopeId === this.currentProjectScopeId;
    if (!isMatch) {
      const now = Date.now();
      if (now - this.lastScopeMismatchWarnAt > 5000) {
        this.lastScopeMismatchWarnAt = now;
        console.warn(
          "[WorkspaceClient] Event scope mismatch (further mismatches suppressed for 5s)",
          {
            eventScopeId,
            currentScopeId: this.currentProjectScopeId,
            currentPath: this.currentRootPath,
          }
        );
      }
    }
    return isMatch;
  }

  private handleHostEvent(event: WorkspaceHostEvent): void {
    try {
      this.processHostEvent(event);
    } catch (error) {
      const eventType = (event as { type?: string })?.type ?? "unknown";
      console.error(`[WorkspaceClient] Error processing event "${eventType}":`, error);

      // Try to reject any pending request associated with this event
      const requestId = (event as { requestId?: string })?.requestId;
      if (requestId) {
        const pending = this.pendingRequests.get(requestId);
        if (pending) {
          clearTimeout(pending.timeout);
          this.pendingRequests.delete(requestId);
          pending.reject(
            error instanceof Error ? error : new Error(`Event processing failed: ${eventType}`)
          );
        }
      }
    }
  }

  private processHostEvent(event: WorkspaceHostEvent): void {
    // Skip processing if disposed to avoid sending to destroyed renderer frames
    if (this.isDisposed) {
      return;
    }

    switch (event.type) {
      case "ready": {
        // Guard against accepting ready after child has exited
        if (!this.child) {
          console.warn("[WorkspaceClient] Ignoring ready event - child already exited");
          return;
        }

        this.isInitialized = true;
        this.restartAttempts = 0;

        // Send GitHub token BEFORE resolving ready promise
        // This ensures the token is available before loadProject() runs
        const token = GitHubAuth.getToken();
        if (token) {
          this.send({ type: "update-github-token", token });
          console.log("[WorkspaceClient] Sent GitHub token to host");
        }

        if (this.readyResolve) {
          this.readyResolve();
          this.readyResolve = null;
        }
        this.startHealthCheckLoop();
        console.log("[WorkspaceClient] Workspace Host is ready");
        break;
      }

      case "pong":
        // Health check response - host is alive
        break;

      case "error":
        console.error("[WorkspaceClient] Host error:", event.error);
        if (event.requestId) {
          const pending = this.pendingRequests.get(event.requestId);
          if (pending) {
            clearTimeout(pending.timeout);
            this.pendingRequests.delete(event.requestId);
            pending.reject(new Error(event.error));
          }
        }
        break;

      // Handle responses to requests
      case "load-project-result":
      case "sync-result":
      case "project-switch-result":
      case "set-active-result":
      case "refresh-result":
      case "refresh-prs-result":
      case "get-pr-status-result":
      case "reset-pr-state-result":
      case "create-worktree-result":
      case "delete-worktree-result":
        this.handleRequestResult(event);
        break;

      case "all-states":
        this.handleRequestResult(this.toResult(event, true));
        break;

      case "monitor":
        this.handleRequestResult(this.toResult(event, true));
        break;

      case "list-branches-result":
        this.handleRequestResult(this.toResult(event));
        break;

      case "get-file-diff-result":
        this.handleRequestResult(this.toResult(event));
        break;

      // Handle spontaneous events (forward to renderer)
      case "worktree-update": {
        if (!this.isCurrentProjectEvent(event.projectScopeId)) {
          return;
        }
        const worktree = event.worktree;
        this.sendToRenderer(CHANNELS.WORKTREE_UPDATE, worktree);
        // Emit to internal event bus with explicit object construction
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
        if (!this.isCurrentProjectEvent(event.projectScopeId)) {
          return;
        }
        this.sendToRenderer(CHANNELS.WORKTREE_REMOVE, { worktreeId: event.worktreeId });
        break;

      case "pr-detected": {
        if (!this.isCurrentProjectEvent(event.projectScopeId)) {
          return;
        }
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
        this.sendToRenderer(CHANNELS.PR_DETECTED, prPayload);
        break;
      }

      case "pr-cleared": {
        if (!this.isCurrentProjectEvent(event.projectScopeId)) {
          return;
        }
        const clearPayload = { worktreeId: event.worktreeId, timestamp: Date.now() };
        events.emit("sys:pr:cleared", clearPayload);
        this.sendToRenderer(CHANNELS.PR_CLEARED, clearPayload);
        break;
      }

      case "issue-detected": {
        if (!this.isCurrentProjectEvent(event.projectScopeId)) {
          return;
        }
        const issuePayload = {
          worktreeId: event.worktreeId,
          issueNumber: event.issueNumber,
          issueTitle: event.issueTitle,
        };
        events.emit("sys:issue:detected", { ...issuePayload, timestamp: Date.now() });
        this.sendToRenderer(CHANNELS.ISSUE_DETECTED, issuePayload);
        break;
      }

      case "issue-not-found": {
        if (!this.isCurrentProjectEvent(event.projectScopeId)) {
          return;
        }
        const notFoundPayload = {
          worktreeId: event.worktreeId,
          issueNumber: event.issueNumber,
          timestamp: Date.now(),
        };
        events.emit("sys:issue:not-found", notFoundPayload);
        this.sendToRenderer(CHANNELS.ISSUE_NOT_FOUND, notFoundPayload);
        break;
      }

      // CopyTree events
      case "copytree:progress": {
        const callback = this.copyTreeProgressCallbacks.get(event.operationId);
        callback?.(event.progress);
        break;
      }

      case "copytree:complete":
        this.handleRequestResult(this.toResult(event, true));
        break;

      case "copytree:error":
        this.handleRequestResult({
          requestId: event.requestId,
          success: false,
          error: event.error,
        });
        break;

      case "copytree:test-config-result":
        this.handleRequestResult(this.toResult(event, true));
        break;

      // File tree events
      case "file-tree-result":
        this.handleRequestResult(this.toResult(event));
        break;

      // Project Pulse events
      case "git:project-pulse":
        this.handleRequestResult(this.toResult(event, true));
        break;

      case "git:project-pulse-error":
        this.handleRequestResult(this.toResult(event, false));
        break;

      default:
        console.warn("[WorkspaceClient] Unknown event type:", (event as { type: string }).type);
    }
  }

  private handleRequestResult(event: {
    requestId: string;
    success?: boolean;
    error?: string;
  }): void {
    const requestId = event.requestId;
    const pending = this.pendingRequests.get(requestId);
    if (pending) {
      clearTimeout(pending.timeout);
      this.pendingRequests.delete(requestId);
      if (event.success === false || event.error) {
        pending.reject(new Error(event.error || "Operation failed"));
      } else {
        pending.resolve(event);
      }
    }
  }

  /**
   * Convert an event to a result format expected by handleRequestResult.
   * This helper avoids repetitive type casting throughout processHostEvent.
   * Spreads all event properties to preserve data (worktrees, branches, etc.).
   */
  private toResult<T extends { requestId: string; error?: string }>(
    event: T,
    success?: boolean
  ): T & { success: boolean } {
    return {
      ...event,
      success: success ?? !event.error,
    };
  }

  private send(request: WorkspaceHostRequest): boolean {
    if (!this.child) {
      console.warn("[WorkspaceClient] Cannot send - host not running");
      return false;
    }
    try {
      this.child.postMessage(request);
      return true;
    } catch (error) {
      console.error("[WorkspaceClient] Failed to send message to host:", error);
      return false;
    }
  }

  private sendWithResponse<T>(
    request: WorkspaceHostRequest & { requestId: string },
    timeoutMs: number = 30000
  ): Promise<T> {
    if (this.isDisposed) {
      return Promise.reject(new Error("WorkspaceClient disposed"));
    }
    if (!this.child) {
      return Promise.reject(new Error("Workspace Host not running"));
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (this.pendingRequests.has(request.requestId)) {
          this.pendingRequests.delete(request.requestId);
          reject(new Error("Request timeout"));
        }
      }, timeoutMs);

      this.pendingRequests.set(request.requestId, { resolve, reject, timeout });
      try {
        if (!this.child) {
          throw new Error("Workspace Host not running");
        }
        this.child.postMessage(request);
      } catch (error) {
        clearTimeout(timeout);
        this.pendingRequests.delete(request.requestId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private generateRequestId(): string {
    return `req-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  private sendToRenderer(channel: string, ...args: unknown[]): void {
    const windows = BrowserWindow.getAllWindows();
    for (const win of windows) {
      if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
        try {
          win.webContents.send(channel, ...args);
        } catch {
          // Silently ignore send failures during window initialization/disposal.
          // The render frame may be in a transitional state where it exists but
          // cannot receive messages (e.g., during startup or reload).
        }
      }
    }
  }

  // Public API - matches WorktreeService interface

  async loadProject(rootPath: string, scopeId?: string): Promise<void> {
    this.currentRootPath = rootPath;
    this.currentProjectScopeId = scopeId ?? crypto.randomUUID();
    const requestId = this.generateRequestId();

    await this.sendWithResponse({
      type: "load-project",
      requestId,
      rootPath,
      projectScopeId: this.currentProjectScopeId,
    });
  }

  async sync(
    worktrees: Worktree[],
    activeWorktreeId: string | null = null,
    mainBranch: string = "main",
    monitorConfig?: MonitorConfig
  ): Promise<void> {
    const requestId = this.generateRequestId();

    await this.sendWithResponse({
      type: "sync",
      requestId,
      worktrees,
      activeWorktreeId,
      mainBranch,
      monitorConfig,
    });
  }

  async getAllStatesAsync(): Promise<WorktreeSnapshot[]> {
    const scopeAtStart = this.currentProjectScopeId;
    const requestId = this.generateRequestId();

    const result = await this.sendWithResponse<{ states: WorktreeSnapshot[] }>({
      type: "get-all-states",
      requestId,
    });

    if (scopeAtStart === null || scopeAtStart !== this.currentProjectScopeId) {
      console.warn(
        "[WorkspaceClient] Discarding stale getAllStatesAsync response - project scope changed"
      );
      return [];
    }

    return result.states;
  }

  async getMonitorAsync(worktreeId: string): Promise<WorktreeSnapshot | null> {
    const requestId = this.generateRequestId();

    const result = await this.sendWithResponse<{ state: WorktreeSnapshot | null }>({
      type: "get-monitor",
      requestId,
      worktreeId,
    });

    return result.state;
  }

  async setActiveWorktree(worktreeId: string): Promise<void> {
    const requestId = this.generateRequestId();

    await this.sendWithResponse({
      type: "set-active",
      requestId,
      worktreeId,
    });
  }

  async refresh(worktreeId?: string): Promise<void> {
    const requestId = this.generateRequestId();

    await this.sendWithResponse({
      type: "refresh",
      requestId,
      worktreeId,
    });
  }

  async refreshPullRequests(): Promise<void> {
    const requestId = this.generateRequestId();

    await this.sendWithResponse({
      type: "refresh-prs",
      requestId,
    });
  }

  async getPRStatus(): Promise<
    import("../../shared/types/workspace-host.js").PRServiceStatus | null
  > {
    const requestId = this.generateRequestId();

    const result = await this.sendWithResponse<{
      status: import("../../shared/types/workspace-host.js").PRServiceStatus | null;
    }>({
      type: "get-pr-status",
      requestId,
    });

    return result.status;
  }

  async resetPRState(): Promise<void> {
    const requestId = this.generateRequestId();

    await this.sendWithResponse({
      type: "reset-pr-state",
      requestId,
    });
  }

  updateGitHubToken(token: string | null): void {
    this.send({ type: "update-github-token", token });
  }

  setPollingEnabled(enabled: boolean): void {
    this.send({ type: "set-polling-enabled", enabled });
  }

  async onProjectSwitch(): Promise<void> {
    this.currentProjectScopeId = null;
    this.currentRootPath = null;
    const requestId = this.generateRequestId();

    await this.sendWithResponse({
      type: "project-switch",
      requestId,
    });
  }

  async listBranches(rootPath: string): Promise<BranchInfo[]> {
    const requestId = this.generateRequestId();

    const result = await this.sendWithResponse<{ branches: BranchInfo[] }>({
      type: "list-branches",
      requestId,
      rootPath,
    });

    return result.branches;
  }

  async createWorktree(rootPath: string, options: CreateWorktreeOptions): Promise<string> {
    const requestId = this.generateRequestId();

    const result = await this.sendWithResponse<{ worktreeId?: string }>({
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
    const requestId = this.generateRequestId();

    await this.sendWithResponse({
      type: "delete-worktree",
      requestId,
      worktreeId,
      force,
      deleteBranch,
    });
  }

  async getFileDiff(cwd: string, filePath: string, status: string): Promise<string> {
    const requestId = this.generateRequestId();

    const result = await this.sendWithResponse<{ diff: string }>({
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
    const requestId = this.generateRequestId();
    const operationId = crypto.randomUUID();

    if (onProgress) {
      this.copyTreeProgressCallbacks.set(operationId, onProgress);
    }

    this.activeCopyTreeOperations.set(operationId, requestId);

    try {
      const result = await this.sendWithResponse<{ result: CopyTreeResult }>(
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
    this.send({ type: "copytree:cancel", operationId });

    const requestId = this.activeCopyTreeOperations.get(operationId);
    if (requestId) {
      const pending = this.pendingRequests.get(requestId);
      if (pending) {
        clearTimeout(pending.timeout);
        this.pendingRequests.delete(requestId);
        pending.reject(new Error("Context generation cancelled"));
      }
    }

    this.copyTreeProgressCallbacks.delete(operationId);
    this.activeCopyTreeOperations.delete(operationId);
  }

  async testConfig(
    rootPath: string,
    options?: CopyTreeOptions
  ): Promise<import("../../shared/types/index.js").CopyTreeTestConfigResult> {
    const requestId = this.generateRequestId();

    try {
      const result = await this.sendWithResponse<{
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
      this.send({ type: "copytree:cancel", operationId });

      const requestId = this.activeCopyTreeOperations.get(operationId);
      if (requestId) {
        const pending = this.pendingRequests.get(requestId);
        if (pending) {
          clearTimeout(pending.timeout);
          this.pendingRequests.delete(requestId);
          pending.reject(new Error("Context generation cancelled"));
        }
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
    const requestId = this.generateRequestId();

    const result = await this.sendWithResponse<{ data: ProjectPulse }>(
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
    const requestId = this.generateRequestId();

    const result = await this.sendWithResponse<{ nodes: FileTreeNode[]; error?: string }>(
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

  /** Pause health check during system sleep */
  pauseHealthCheck(): void {
    if (this.isHealthCheckPaused) return;
    this.isHealthCheckPaused = true;
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
    console.log("[WorkspaceClient] Health check paused");
  }

  /** Resume health check after system wake */
  resumeHealthCheck(): void {
    if (!this.isHealthCheckPaused) return;
    this.isHealthCheckPaused = false;

    if (this.child) {
      this.startHealthCheckLoop();
    }

    console.log("[WorkspaceClient] Health check resumed");
  }

  dispose(): void {
    if (this.isDisposed) return;
    this.isDisposed = true;

    console.log("[WorkspaceClient] Disposing...");

    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }

    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }

    if (this.readyReject) {
      this.readyReject(new Error("WorkspaceClient disposed"));
      this.readyReject = null;
      this.readyResolve = null;
    }

    // Reject all pending requests and clear their timeouts
    for (const [, { reject, timeout }] of this.pendingRequests) {
      clearTimeout(timeout);
      reject(new Error("WorkspaceClient disposed"));
    }
    this.pendingRequests.clear();

    if (this.child) {
      this.send({ type: "dispose" });
      setTimeout(() => {
        if (this.child) {
          try {
            this.child.kill();
          } catch (error) {
            console.warn("[WorkspaceClient] Failed to kill host process during dispose:", error);
          } finally {
            this.child = null;
          }
        }
      }, 1000);
    }

    this.removeAllListeners();
    console.log("[WorkspaceClient] Disposed");
  }

  isReady(): boolean {
    return this.isInitialized && this.child !== null;
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
