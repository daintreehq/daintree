import { utilityProcess, UtilityProcess, app } from "electron";
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

  constructor(projectPath: string, config: Required<WorkspaceClientConfig>) {
    super();
    this.projectPath = projectPath;
    this.config = config;

    const safeName = path
      .basename(projectPath)
      .replace(/[^a-zA-Z0-9_-]/g, "-")
      .slice(0, 40);
    this.serviceName = `canopy-workspace-host:${safeName}`;

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
    const hostPath = path.join(electronDir, "workspace-host.js");

    try {
      this.child = utilityProcess.fork(hostPath, [], {
        serviceName: this.serviceName,
        stdio: "inherit",
        cwd: os.homedir(),
        env: {
          ...(process.env as Record<string, string>),
          CANOPY_USER_DATA: app.getPath("userData"),
        },
      });
    } catch (error) {
      console.error(`[WorkspaceHost:${this.serviceName}] Failed to fork:`, error);
      if (this.readyReject) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        this.readyReject(new Error(`Workspace host failed to fork: ${errorMessage}`));
        this.readyReject = null;
      }
      this.emit("host-crash", -1);
      return;
    }

    this.child.on("message", (msg: WorkspaceHostEvent) => {
      this.handleHostEvent(msg);
    });

    this.child.on("error", (error) => {
      console.error(`[WorkspaceHost:${this.serviceName}] Error event:`, error);
      if (this.readyReject) {
        this.readyReject(new Error(`Workspace host error: ${String(error)}`));
        this.readyReject = null;
      }
      this.emit("host-crash", -1);
    });

    this.child.on("exit", (code) => {
      console.error(`[WorkspaceHost:${this.serviceName}] Exited with code ${code}`);

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
      case "get-file-diff-result":
      case "file-tree-result":
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
