import { utilityProcess, UtilityProcess, app, MessagePortMain } from "electron";
import { EventEmitter } from "events";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";
import type {
  WorkspaceHostRequest,
  WorkspaceHostEvent,
  WorkspaceClientConfig,
} from "../../shared/types/workspace-host.js";
import { GitHubAuth } from "./github/GitHubAuth.js";
import { createLogger } from "../utils/logger.js";
import { formatErrorMessage } from "../../shared/utils/errorMessage.js";

const logger = createLogger("main:WorkspaceHost");
const logInfo = (msg: string, ctx?: Record<string, unknown>) =>
  ctx ? logger.info(msg, ctx) : logger.info(msg);
const logWarn = (msg: string, ctx?: Record<string, unknown>) =>
  ctx ? logger.warn(msg, ctx) : logger.warn(msg);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export class WorkspaceHostProcess extends EventEmitter {
  private child: UtilityProcess | null = null;
  private config: Required<WorkspaceClientConfig>;
  private isInitialized = false;
  private isDisposed = false;
  readonly projectPath: string;
  private readonly serviceName: string;

  private healthCheckInterval: NodeJS.Timeout | null = null;
  private restartTimer: NodeJS.Timeout | null = null;
  private restartAttempts = 0;
  private isHealthCheckPaused = false;
  private isWaitingForHandshake = false;
  private handshakeTimeout: NodeJS.Timeout | null = null;
  private missedHeartbeats = 0;
  private readonly MAX_MISSED_HEARTBEATS = 3;

  private pendingRequests = new Map<
    string,
    {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      resolve: (value: any) => void;
      reject: (error: Error) => void;
      timeout: NodeJS.Timeout;
    }
  >();

  private readyPromise: Promise<void>;
  private readyResolve: (() => void) | null = null;
  private readyReject: ((error: Error) => void) | null = null;

  /** Replayed on every `ready` — the child's message listener isn't attached
   * until after `ready`, so pushing at fork time would silently drop. */
  private logLevelOverridesCache: Record<string, string> = {};

  /** Buffers for line-splitting stdout/stderr from the forked host. Forking
   * with `stdio:"pipe"` (instead of `"inherit"`) isolates the host from the
   * main process's fd 2 — critical on AppImage GUI launches where fd 2 points
   * to a dead pty that returns EIO on write. See issue #5588. */
  private hostStdoutBuffer = "";
  private hostStderrBuffer = "";

  constructor(projectPath: string, config: Required<WorkspaceClientConfig>) {
    super();
    this.projectPath = projectPath;
    this.config = config;

    const safeName = path
      .basename(projectPath)
      .replace(/[^a-zA-Z0-9_-]/g, "-")
      .slice(0, 40);
    this.serviceName = `daintree-workspace-host:${safeName}`;

    this.readyPromise = new Promise((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });

    this.startHost();
  }

  async waitForReady(): Promise<void> {
    return this.readyPromise;
  }

  isReady(): boolean {
    return this.isInitialized && this.child !== null;
  }

  generateRequestId(): string {
    return `req-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
  }

  send(request: WorkspaceHostRequest): boolean {
    if (!this.child) {
      console.warn(`[WorkspaceHost:${this.serviceName}] Cannot send - host not running`);
      return false;
    }
    try {
      this.child.postMessage(request);
      return true;
    } catch (error) {
      console.error(`[WorkspaceHost:${this.serviceName}] Failed to send message:`, error);
      return false;
    }
  }

  /**
   * Transfer a MessagePort to the workspace host for direct renderer communication.
   * The host sends spontaneous events (worktree updates, PR events) through this port,
   * bypassing the main-process IPC relay.
   */
  attachRendererPort(port: MessagePortMain): boolean {
    if (!this.child || this.isDisposed) return false;
    try {
      this.child.postMessage({ type: "attach-renderer-port" }, [port]);
      return true;
    } catch (error) {
      console.error(`[WorkspaceHost:${this.serviceName}] Failed to attach renderer port:`, error);
      return false;
    }
  }

  /**
   * Transfer a MessagePort for the new worktree port protocol (Phase 1).
   * Supports request/response correlation and scoped event delivery.
   */
  attachWorktreePort(port: MessagePortMain): boolean {
    if (!this.child || this.isDisposed) return false;
    try {
      this.child.postMessage({ type: "attach-worktree-port" }, [port]);
      return true;
    } catch (error) {
      console.error(`[WorkspaceHost:${this.serviceName}] Failed to attach worktree port:`, error);
      return false;
    }
  }

  sendWithResponse<T>(
    request: WorkspaceHostRequest & { requestId: string },
    timeoutMs: number = 30000
  ): Promise<T> {
    if (this.isDisposed) {
      return Promise.reject(new Error("WorkspaceHostProcess disposed"));
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

  /**
   * Update the cached overrides and push immediately if initialized. On
   * restart, `ready` replays the cached map automatically.
   */
  setLogLevelOverrides(overrides: Record<string, string>): void {
    this.logLevelOverridesCache = { ...overrides };
    if (this.isInitialized && this.child) {
      this.send({ type: "set-log-level-overrides", overrides: this.logLevelOverridesCache });
    }
  }

  pauseHealthCheck(): void {
    if (this.isHealthCheckPaused) return;
    this.isHealthCheckPaused = true;
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
    if (this.handshakeTimeout) {
      clearTimeout(this.handshakeTimeout);
      this.handshakeTimeout = null;
    }
    this.isWaitingForHandshake = false;
  }

  resumeHealthCheck(): void {
    if (!this.isHealthCheckPaused) return;
    if (!this.isInitialized || !this.child) {
      this.isHealthCheckPaused = false;
      return;
    }

    this.isHealthCheckPaused = false;

    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
    if (this.handshakeTimeout) {
      clearTimeout(this.handshakeTimeout);
      this.handshakeTimeout = null;
    }

    this.isWaitingForHandshake = true;
    this.send({ type: "health-check" });

    this.handshakeTimeout = setTimeout(() => {
      if (this.isWaitingForHandshake) {
        this.isWaitingForHandshake = false;
        this.handshakeTimeout = null;
        this.startHealthCheckInterval();
      }
    }, 5000);
  }

  /**
   * Restart the host after its auto-restart budget has been exhausted.
   * Resets `restartAttempts` so future crashes get a fresh budget, respawns
   * the child, and emits `"restarted"` so `WorkspaceClient` can re-broker
   * ports and reload the project — the auto-restart path emits this from
   * its `setTimeout` callback which `manualRestart()` bypasses.
   */
  manualRestart(): void {
    if (this.isDisposed) {
      console.warn(`[WorkspaceHost:${this.serviceName}] Cannot manual restart - already disposed`);
      return;
    }

    if (this.child !== null) {
      console.warn(
        `[WorkspaceHost:${this.serviceName}] Cannot manual restart - host process already exists`
      );
      return;
    }

    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }

    this.restartAttempts = 0;

    console.log(`[WorkspaceHost:${this.serviceName}] Manual restart initiated`);
    this.startHost();

    // Only signal "restarted" when the fork actually produced a child —
    // `startHost()` emits `host-crash` on fork failure and leaves `child`
    // null; emitting `restarted` in that case would poison
    // `reloadProjectAfterRestart` by awaiting a `waitForReady()` that will
    // never resolve.
    if (this.child !== null) {
      this.emit("restarted");
    }
  }

  dispose(): void {
    if (this.isDisposed) return;
    this.isDisposed = true;

    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (this.handshakeTimeout) {
      clearTimeout(this.handshakeTimeout);
      this.handshakeTimeout = null;
    }
    this.isWaitingForHandshake = false;

    if (this.readyReject) {
      this.readyReject(new Error("WorkspaceHostProcess disposed"));
      this.readyReject = null;
      this.readyResolve = null;
    }

    for (const [, { reject, timeout }] of this.pendingRequests) {
      clearTimeout(timeout);
      reject(new Error("WorkspaceHostProcess disposed"));
    }
    this.pendingRequests.clear();

    if (this.child) {
      this.send({ type: "dispose" });
      setTimeout(() => {
        if (this.child) {
          try {
            this.child.kill();
          } catch (error) {
            console.warn(
              `[WorkspaceHost:${this.serviceName}] Failed to kill host during dispose:`,
              error
            );
          } finally {
            this.child = null;
          }
        }
      }, 1000);
    }

    this.removeAllListeners();
  }

  private forwardHostOutput(kind: "stdout" | "stderr", chunk: Buffer): void {
    const text = chunk.toString("utf8");
    if (kind === "stdout") {
      this.hostStdoutBuffer += text;
    } else {
      this.hostStderrBuffer += text;
    }

    const MAX_BUFFER = 64 * 1024;
    if (this.hostStdoutBuffer.length > MAX_BUFFER)
      this.hostStdoutBuffer = this.hostStdoutBuffer.slice(-MAX_BUFFER);
    if (this.hostStderrBuffer.length > MAX_BUFFER)
      this.hostStderrBuffer = this.hostStderrBuffer.slice(-MAX_BUFFER);

    const current = kind === "stdout" ? this.hostStdoutBuffer : this.hostStderrBuffer;
    const lines = current.split(/\r?\n/);
    const remainder = lines.pop() ?? "";
    if (kind === "stdout") {
      this.hostStdoutBuffer = remainder;
    } else {
      this.hostStderrBuffer = remainder;
    }

    for (const line of lines) {
      const trimmed = line.trimEnd();
      if (!trimmed) continue;
      const message = `[WorkspaceHost] ${trimmed.length > 4000 ? `${trimmed.slice(0, 4000)}…` : trimmed}`;
      if (kind === "stderr") {
        logWarn(message);
      } else {
        logInfo(message);
      }
    }
  }

  private installHostLogForwarding(): void {
    if (!this.child) return;
    this.hostStdoutBuffer = "";
    this.hostStderrBuffer = "";

    const stdout = (this.child as unknown as { stdout?: NodeJS.ReadableStream }).stdout;
    const stderr = (this.child as unknown as { stderr?: NodeJS.ReadableStream }).stderr;

    stdout?.on("data", (chunk: Buffer) => this.forwardHostOutput("stdout", chunk));
    stderr?.on("data", (chunk: Buffer) => this.forwardHostOutput("stderr", chunk));
    // Swallow post-exit pipe errors so an unhandled Readable error can't
    // surface as an uncaughtException after the host is already shutting down.
    stdout?.on("error", () => {});
    stderr?.on("error", () => {});
    // Flush any partial line buffered at close — 'exit' fires before pipes
    // fully drain, so the tail of a crash stack trace can arrive after the
    // exit-time flush would otherwise clear the buffer.
    stdout?.on("close", () => this.flushHostOutputBuffers());
    stderr?.on("close", () => this.flushHostOutputBuffers());
  }

  private flushHostOutputBuffers(): void {
    const stdoutRemainder = this.hostStdoutBuffer.trim();
    if (stdoutRemainder) {
      logInfo(
        `[WorkspaceHost] ${stdoutRemainder.length > 4000 ? `${stdoutRemainder.slice(0, 4000)}…` : stdoutRemainder}`
      );
    }
    const stderrRemainder = this.hostStderrBuffer.trim();
    if (stderrRemainder) {
      logWarn(
        `[WorkspaceHost] ${stderrRemainder.length > 4000 ? `${stderrRemainder.slice(0, 4000)}…` : stderrRemainder}`
      );
    }
    this.hostStdoutBuffer = "";
    this.hostStderrBuffer = "";
  }

  private startHost(): void {
    if (this.isDisposed) return;

    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }

    if (this.readyReject && this.isInitialized) {
      this.readyReject(new Error("Workspace Host restarting"));
    }

    this.isInitialized = false;
    this.readyPromise = new Promise((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });

    const electronDir = path.basename(__dirname) === "chunks" ? path.dirname(__dirname) : __dirname;
    const hostPath = path.join(electronDir, "workspace-host-bootstrap.js");

    try {
      this.child = utilityProcess.fork(hostPath, [], {
        serviceName: this.serviceName,
        stdio: "pipe",
        cwd: os.homedir(),
        // Redirect v8.setHeapSnapshotNearHeapLimit dumps (set in
        // workspace-host.ts) into the app's logs directory.
        execArgv: [`--diagnostic-dir=${app.getPath("logs")}`],
        env: {
          ...(process.env as Record<string, string>),
          DAINTREE_USER_DATA: app.getPath("userData"),
          DAINTREE_UTILITY_PROCESS_KIND: "workspace-host",
        },
      });
    } catch (error) {
      console.error(`[WorkspaceHost:${this.serviceName}] Failed to fork:`, error);
      if (this.readyReject) {
        const errorMessage = formatErrorMessage(error, "Workspace host failed to fork");
        this.readyReject(new Error(`Workspace host failed to fork: ${errorMessage}`));
        this.readyReject = null;
      }
      this.emit("host-crash", -1);
      return;
    }

    this.installHostLogForwarding();

    this.child.on("message", (msg: WorkspaceHostEvent) => {
      this.handleHostEvent(msg);
    });

    this.child.on("error", (error) => {
      logWarn(`[WorkspaceHost:${this.serviceName}] Error event: ${String(error)}`);
      if (this.readyReject) {
        this.readyReject(new Error(`Workspace host error: ${String(error)}`));
        this.readyReject = null;
      }
      this.emit("host-crash", -1);
    });

    this.child.on("exit", (code) => {
      this.flushHostOutputBuffers();
      logWarn(`[WorkspaceHost:${this.serviceName}] Exited with code ${code}`);

      if (this.healthCheckInterval) {
        clearInterval(this.healthCheckInterval);
        this.healthCheckInterval = null;
      }
      if (this.handshakeTimeout) {
        clearTimeout(this.handshakeTimeout);
        this.handshakeTimeout = null;
      }
      this.isWaitingForHandshake = false;
      this.missedHeartbeats = 0;
      this.isInitialized = false;
      this.child = null;

      for (const [, { reject, timeout }] of this.pendingRequests) {
        clearTimeout(timeout);
        reject(new Error("Workspace Host crashed"));
      }
      this.pendingRequests.clear();

      if (this.readyReject) {
        this.readyReject(new Error(`Workspace Host crashed (exit code ${code})`));
        this.readyReject = null;
      }

      if (this.isDisposed) return;

      // Fire the recovery signal before restart scheduling so the renderer can
      // reject in-flight requests immediately instead of waiting up to ~10s for
      // the per-request timeout.
      this.emit("host-recovering", code);

      if (this.restartAttempts < this.config.maxRestartAttempts) {
        this.restartAttempts++;
        const delay = Math.min(1000 * Math.pow(2, this.restartAttempts), 10000);
        console.log(
          `[WorkspaceHost:${this.serviceName}] Restarting in ${delay}ms (attempt ${this.restartAttempts}/${this.config.maxRestartAttempts})`
        );

        if (this.restartTimer) clearTimeout(this.restartTimer);
        this.restartTimer = setTimeout(() => {
          this.restartTimer = null;
          this.startHost();
          this.emit("restarted");
        }, delay);
      } else {
        console.error(`[WorkspaceHost:${this.serviceName}] Max restart attempts reached`);
        this.emit("host-crash", code);
      }
    });

    this.startHealthCheckInterval();
  }

  private startHealthCheckInterval(): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }

    if (this.isHealthCheckPaused || !this.child) return;

    this.missedHeartbeats = 0;

    this.healthCheckInterval = setInterval(() => {
      if (!this.isInitialized || !this.child || this.isHealthCheckPaused) return;

      if (this.missedHeartbeats >= this.MAX_MISSED_HEARTBEATS) {
        const missedMs = this.missedHeartbeats * this.config.healthCheckIntervalMs;
        console.error(
          `[WorkspaceHost:${this.serviceName}] Watchdog: unresponsive for ${missedMs}ms. Force killing.`
        );

        if (this.child.pid) {
          try {
            process.kill(this.child.pid, "SIGKILL");
          } catch {
            // Process may have already exited
          }
        }
        this.missedHeartbeats = 0;
        return;
      }

      this.missedHeartbeats++;
      this.send({ type: "health-check" });
    }, this.config.healthCheckIntervalMs);
  }

  private handleHostEvent(event: WorkspaceHostEvent): void {
    try {
      this.processHostEvent(event);
    } catch (error) {
      const eventType = (event as { type?: string })?.type ?? "unknown";
      console.error(`[WorkspaceHost:${this.serviceName}] Error processing "${eventType}":`, error);

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
    if (this.isDisposed) return;

    switch (event.type) {
      case "ready": {
        if (!this.child) return;
        this.isInitialized = true;
        this.restartAttempts = 0;

        const token = GitHubAuth.getToken();
        if (token) {
          this.send({ type: "update-github-token", token });
        }

        // Replay cached log-level overrides on every ready (initial + restarts).
        this.send({ type: "set-log-level-overrides", overrides: this.logLevelOverridesCache });

        if (this.readyResolve) {
          this.readyResolve();
          this.readyResolve = null;
        }
        this.startHealthCheckInterval();
        break;
      }

      case "pong":
        this.missedHeartbeats = 0;
        if (this.isWaitingForHandshake) {
          this.isWaitingForHandshake = false;
          if (this.handshakeTimeout) {
            clearTimeout(this.handshakeTimeout);
            this.handshakeTimeout = null;
          }
          this.startHealthCheckInterval();
        }
        break;

      case "error":
        console.error(`[WorkspaceHost:${this.serviceName}] Host error:`, event.error);
        if (event.requestId) {
          const pending = this.pendingRequests.get(event.requestId);
          if (pending) {
            clearTimeout(pending.timeout);
            this.pendingRequests.delete(event.requestId);
            pending.reject(new Error(event.error));
          }
        }
        break;

      // Request/response results - resolve pending promises
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
      case "fetch-pr-branch-result":
        this.handleRequestResult(event);
        break;

      case "all-states":
        this.handleRequestResult(this.toResult(event, true));
        break;

      case "monitor":
        this.handleRequestResult(this.toResult(event, true));
        break;

      case "list-branches-result":
      case "get-recent-branches-result":
      case "get-file-diff-result":
      case "file-tree-result":
      case "resource-action-result":
      case "has-resource-config-result":
      case "update-monitor-config-result":
        this.handleRequestResult(this.toResult(event));
        break;

      case "copytree:complete":
      case "copytree:test-config-result":
        this.handleRequestResult(this.toResult(event, true));
        break;

      case "copytree:error":
        this.handleRequestResult({
          requestId: event.requestId,
          success: false,
          error: event.error,
        });
        break;

      case "git:project-pulse":
        this.handleRequestResult(this.toResult(event, true));
        break;

      case "git:project-pulse-error":
        this.handleRequestResult(this.toResult(event, false));
        break;

      // Spontaneous events - re-emit for the manager to route
      case "worktree-update":
      case "worktree-removed":
      case "pr-detected":
      case "pr-cleared":
      case "issue-detected":
      case "issue-not-found":
      case "copytree:progress":
        this.emit("host-event", event);
        break;

      default:
        console.warn(
          `[WorkspaceHost:${this.serviceName}] Unknown event:`,
          (event as { type: string }).type
        );
    }
  }

  private handleRequestResult(event: {
    requestId: string;
    success?: boolean;
    error?: string;
  }): void {
    const pending = this.pendingRequests.get(event.requestId);
    if (pending) {
      clearTimeout(pending.timeout);
      this.pendingRequests.delete(event.requestId);
      if (event.success === false || event.error) {
        pending.reject(new Error(event.error || "Operation failed"));
      } else {
        pending.resolve(event);
      }
    }
  }

  private toResult<T extends { requestId: string; error?: string }>(
    event: T,
    success?: boolean
  ): T & { success: boolean } {
    return {
      ...event,
      success: success ?? !event.error,
    };
  }
}
