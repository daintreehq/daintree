/**
 * PtyClient - Main process stub for terminal management.
 *
 * @pattern Dependency Injection via main.ts (Pattern B)
 *
 * This class provides a drop-in replacement for PtyManager in the Main process.
 * It forwards all operations to the Pty Host (UtilityProcess) via IPC,
 * keeping the Main thread responsive.
 *
 * Why this pattern:
 * - Manages critical child process (UtilityProcess) requiring explicit lifecycle control
 * - Constructor accepts configuration: must be instantiated with specific options
 * - Needs coordination with other services (MessagePort distribution, error handlers)
 * - Lifecycle tied to app lifecycle: created in main.ts, passed to IPC handlers
 *
 * When to use Pattern B:
 * - Service manages child processes, sockets, or system resources
 * - Service requires configuration at construction time
 * - Service needs explicit startup/shutdown coordination
 * - Multiple services need to interact (composition root in main.ts)
 */

import { utilityProcess, UtilityProcess, dialog, app, MessagePortMain } from "electron";
import { EventEmitter } from "events";
import path from "path";
import { fileURLToPath } from "url";
import { events } from "./events.js";
import { SharedRingBuffer } from "../../shared/utils/SharedRingBuffer.js";
import type {
  PtyHostRequest,
  PtyHostEvent,
  PtyHostSpawnOptions,
  ActivityTier,
} from "../../shared/types/pty-host.js";
import type { TerminalSnapshot } from "./PtyManager.js";
import type { AgentStateChangeTrigger } from "../types/index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Terminal info response from Pty Host */
interface TerminalInfoResponse {
  id: string;
  projectId?: string;
  type?: string;
  title?: string;
  cwd: string;
  worktreeId?: string;
  agentState?: string;
  spawnedAt: number;
}

/** Configuration for PtyClient */
export interface PtyClientConfig {
  /** Maximum restart attempts before giving up */
  maxRestartAttempts?: number;
  /** Health check interval in milliseconds */
  healthCheckIntervalMs?: number;
  /** Whether to show dialog on crash */
  showCrashDialog?: boolean;
}

const DEFAULT_CONFIG: Required<PtyClientConfig> = {
  maxRestartAttempts: 3,
  healthCheckIntervalMs: 30000,
  showCrashDialog: true,
};

/** Default ring buffer size: 10MB for high-throughput terminal output */
const DEFAULT_RING_BUFFER_SIZE = 10 * 1024 * 1024;

export class PtyClient extends EventEmitter {
  private child: UtilityProcess | null = null;
  private config: Required<PtyClientConfig>;
  private isInitialized = false;
  private isDisposed = false;
  private healthCheckInterval: NodeJS.Timeout | null = null;
  private restartAttempts = 0;
  private isHealthCheckPaused = false;
  private isWaitingForHandshake = false;
  private handshakeTimeout: NodeJS.Timeout | null = null;
  private pendingSpawns: Map<string, PtyHostSpawnOptions> = new Map();
  private snapshotCallbacks: Map<string, (snapshot: TerminalSnapshot | null) => void> = new Map();
  private allSnapshotsCallback: ((snapshots: TerminalSnapshot[]) => void) | null = null;
  private transitionCallbacks: Map<string, (success: boolean) => void> = new Map();
  private terminalsForProjectCallbacks: Map<string, (ids: string[]) => void> = new Map();
  private terminalInfoCallbacks: Map<string, (terminal: TerminalInfoResponse | null) => void> =
    new Map();
  private replayHistoryCallbacks: Map<string, (replayed: number) => void> = new Map();
  private serializedStateCallbacks: Map<string, (state: string | null) => void> = new Map();
  private terminalDiagnosticInfoCallbacks: Map<
    string,
    (info: import("../../shared/types/ipc.js").TerminalInfoPayload | null) => void
  > = new Map();
  private readyPromise: Promise<void>;
  private readyResolve: (() => void) | null = null;

  /** SharedArrayBuffer for zero-copy terminal I/O (null if unavailable) */
  private sharedBuffer: SharedArrayBuffer | null = null;
  /** SharedArrayBuffer for semantic analysis (separate from visual buffer) */
  private analysisBuffer: SharedArrayBuffer | null = null;
  private sharedBufferEnabled = false;

  /** Callback to notify renderer when MessagePort needs to be refreshed */
  private onPortRefresh: (() => void) | null = null;

  constructor(config: PtyClientConfig = {}) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };

    // Create ready promise that resolves when host is ready
    this.readyPromise = new Promise((resolve) => {
      this.readyResolve = resolve;
    });

    // Try to create SharedArrayBuffers for zero-copy terminal I/O
    // Two separate buffers: one for visual rendering, one for semantic analysis
    try {
      this.sharedBuffer = SharedRingBuffer.create(DEFAULT_RING_BUFFER_SIZE);
      this.analysisBuffer = SharedRingBuffer.create(DEFAULT_RING_BUFFER_SIZE);
      this.sharedBufferEnabled = true;
      console.log("[PtyClient] SharedArrayBuffer enabled (dual 10MB ring buffers)");
    } catch (error) {
      console.warn("[PtyClient] SharedArrayBuffer unavailable, using IPC fallback:", error);
      this.sharedBuffer = null;
      this.analysisBuffer = null;
      this.sharedBufferEnabled = false;
    }

    this.startHost();
  }

  /** Wait for the host to be ready */
  async waitForReady(): Promise<void> {
    return this.readyPromise;
  }

  private startHost(): void {
    if (this.isDisposed) {
      console.warn("[PtyClient] Cannot start host - already disposed");
      return;
    }

    // Reset initialization state for restart
    this.isInitialized = false;
    this.readyPromise = new Promise((resolve) => {
      this.readyResolve = resolve;
    });

    // Path to compiled pty-host.js (bundled in same directory)
    const hostPath = path.join(__dirname, "pty-host.js");

    console.log(`[PtyClient] Starting Pty Host from: ${hostPath}`);

    try {
      this.child = utilityProcess.fork(hostPath, [], {
        serviceName: "canopy-pty-host",
        stdio: "inherit", // Show logs in dev
        env: {
          ...(process.env as Record<string, string>),
          CANOPY_USER_DATA: app.getPath("userData"),
        },
      });
    } catch (error) {
      console.error("[PtyClient] Failed to fork Pty Host:", error);
      this.emit("host-crash", -1);
      return;
    }

    this.child.on("message", (msg: PtyHostEvent) => {
      this.handleHostEvent(msg);
    });

    // Send both SharedArrayBuffers to host immediately after spawn
    if (this.sharedBuffer && this.analysisBuffer) {
      try {
        this.child.postMessage({
          type: "init-buffers",
          visualBuffer: this.sharedBuffer,
          analysisBuffer: this.analysisBuffer,
        });
        console.log("[PtyClient] Dual SharedArrayBuffers sent to Pty Host");
      } catch (error) {
        console.warn(
          "[PtyClient] SharedArrayBuffer transfer failed (using IPC fallback):",
          error instanceof Error ? error.message : String(error)
        );
        // Fallback to IPC-only mode
        this.sharedBuffer = null;
        this.analysisBuffer = null;
        this.sharedBufferEnabled = false;
      }
    }

    this.child.on("exit", (code) => {
      console.error(`[PtyClient] Pty Host exited with code ${code}`);

      // Clear health check
      if (this.healthCheckInterval) {
        clearInterval(this.healthCheckInterval);
        this.healthCheckInterval = null;
      }

      this.isInitialized = false;
      this.child = null; // Prevent posting to dead process

      if (this.isDisposed) {
        // Expected shutdown
        return;
      }

      // Try to restart
      if (this.restartAttempts < this.config.maxRestartAttempts) {
        this.restartAttempts++;
        const delay = Math.min(1000 * Math.pow(2, this.restartAttempts), 10000);
        console.log(
          `[PtyClient] Restarting Host in ${delay}ms (attempt ${this.restartAttempts}/${this.config.maxRestartAttempts})`
        );

        setTimeout(() => {
          this.startHost();
          // Re-spawn any terminals that were pending
          this.respawnPending();
        }, delay);
      } else {
        console.error("[PtyClient] Max restart attempts reached, giving up");
        this.emit("host-crash", code);

        if (this.config.showCrashDialog) {
          dialog
            .showMessageBox({
              type: "error",
              title: "Terminal Service Crashed",
              message: `The terminal backend crashed (code ${code}). Terminals may need to be restarted.`,
              buttons: ["OK"],
            })
            .catch(console.error);
        }
      }
    });

    // Start health check (only if not paused by system sleep)
    if (!this.isHealthCheckPaused) {
      this.healthCheckInterval = setInterval(() => {
        if (this.isInitialized && this.child && !this.isHealthCheckPaused) {
          this.send({ type: "health-check" });
        }
      }, this.config.healthCheckIntervalMs);
    }

    console.log("[PtyClient] Pty Host started");
  }

  private handleHostEvent(event: PtyHostEvent): void {
    switch (event.type) {
      case "ready":
        this.isInitialized = true;
        this.restartAttempts = 0; // Reset on successful init
        if (this.readyResolve) {
          this.readyResolve();
          this.readyResolve = null;
        }
        console.log("[PtyClient] Pty Host is ready");
        break;

      case "data":
        this.emit("data", event.id, event.data);
        break;

      case "exit":
        this.pendingSpawns.delete(event.id);
        this.emit("exit", event.id, event.exitCode);
        break;

      case "error":
        this.emit("error", event.id, event.error);
        break;

      case "agent-state":
        // Forward to internal event bus for other services
        events.emit("agent:state-changed", {
          agentId: event.id,
          terminalId: event.id,
          state: event.state,
          previousState: event.previousState,
          timestamp: event.timestamp,
          traceId: event.traceId,
          trigger: event.trigger as AgentStateChangeTrigger,
          confidence: event.confidence,
          worktreeId: event.worktreeId,
        });
        break;

      case "agent-detected":
        events.emit("agent:detected", {
          terminalId: event.terminalId,
          agentType: event.agentType,
          processName: event.processName,
          timestamp: event.timestamp,
        });
        break;

      case "agent-exited":
        events.emit("agent:exited", {
          terminalId: event.terminalId,
          agentType: event.agentType,
          timestamp: event.timestamp,
        });
        break;

      case "agent-spawned":
        events.emit("agent:spawned", event.payload);
        break;

      case "agent-output":
        events.emit("agent:output", event.payload);
        break;

      case "agent-completed":
        events.emit("agent:completed", event.payload);
        break;

      case "agent-failed":
        events.emit("agent:failed", event.payload);
        break;

      case "agent-killed":
        events.emit("agent:killed", event.payload);
        break;

      case "terminal-trashed":
        events.emit("terminal:trashed", { id: event.id, expiresAt: event.expiresAt });
        break;

      case "terminal-restored":
        events.emit("terminal:restored", { id: event.id });
        break;

      case "snapshot": {
        const callback = this.snapshotCallbacks.get(event.id);
        if (callback) {
          this.snapshotCallbacks.delete(event.id);
          callback(event.snapshot as TerminalSnapshot | null);
        }
        break;
      }

      case "all-snapshots": {
        if (this.allSnapshotsCallback) {
          const cb = this.allSnapshotsCallback;
          this.allSnapshotsCallback = null;
          cb(event.snapshots as TerminalSnapshot[]);
        }
        break;
      }

      case "transition-result": {
        const cb = this.transitionCallbacks.get(event.requestId);
        if (cb) {
          this.transitionCallbacks.delete(event.requestId);
          cb(event.success);
        }
        break;
      }

      case "pong":
        // If waiting for handshake, this pong confirms host is responsive
        if (this.isWaitingForHandshake) {
          this.isWaitingForHandshake = false;
          if (this.handshakeTimeout) {
            clearTimeout(this.handshakeTimeout);
            this.handshakeTimeout = null;
          }
          console.log("[PtyClient] Handshake successful - resuming health checks");
          this.startHealthCheckInterval();
        }
        break;

      case "terminals-for-project": {
        const cb = this.terminalsForProjectCallbacks.get((event as any).requestId);
        if (cb) {
          this.terminalsForProjectCallbacks.delete((event as any).requestId);
          cb((event as any).terminalIds ?? []);
        }
        break;
      }

      case "terminal-info": {
        const cb = this.terminalInfoCallbacks.get((event as any).requestId);
        if (cb) {
          this.terminalInfoCallbacks.delete((event as any).requestId);
          cb((event as any).terminal ?? null);
        }
        break;
      }

      case "replay-history-result": {
        const cb = this.replayHistoryCallbacks.get((event as any).requestId);
        if (cb) {
          this.replayHistoryCallbacks.delete((event as any).requestId);
          cb((event as any).replayed ?? 0);
        }
        break;
      }

      case "serialized-state": {
        const cb = this.serializedStateCallbacks.get((event as any).requestId);
        if (cb) {
          this.serializedStateCallbacks.delete((event as any).requestId);
          cb((event as any).state ?? null);
        }
        break;
      }

      case "terminal-diagnostic-info": {
        const cb = this.terminalDiagnosticInfoCallbacks.get(event.requestId);
        if (cb) {
          this.terminalDiagnosticInfoCallbacks.delete(event.requestId);
          cb(event.info);
        }
        break;
      }

      default:
        console.warn("[PtyClient] Unknown event type:", (event as { type: string }).type);
    }
  }

  private send(request: PtyHostRequest): void {
    if (!this.child) {
      console.warn("[PtyClient] Cannot send - host not running");
      return;
    }
    this.child.postMessage(request);
  }

  private respawnPending(): void {
    // Notify that ports need refresh after host restart
    if (this.onPortRefresh) {
      this.onPortRefresh();
    }

    // Respawn terminals that were active when host crashed
    for (const [id, options] of this.pendingSpawns) {
      console.log(`[PtyClient] Respawning terminal: ${id}`);
      this.send({ type: "spawn", id, options });
    }
  }

  /** Set callback for MessagePort refresh (called on host restart) */
  setPortRefreshCallback(callback: () => void): void {
    this.onPortRefresh = callback;
  }

  /** Forward MessagePort to Pty Host for direct Renderer↔PtyHost communication */
  connectMessagePort(port: MessagePortMain): void {
    if (!this.child) {
      console.warn("[PtyClient] Cannot connect MessagePort - host not running, will retry");
      return;
    }

    try {
      this.child.postMessage({ type: "connect-port" }, [port]);
      console.log("[PtyClient] MessagePort forwarded to Pty Host");
    } catch (error) {
      console.error("[PtyClient] Failed to forward MessagePort to Pty Host:", error);
    }
  }

  // Public API - matches PtyManager interface

  spawn(id: string, options: PtyHostSpawnOptions): void {
    this.pendingSpawns.set(id, options);
    this.send({ type: "spawn", id, options });
  }

  write(id: string, data: string, traceId?: string): void {
    this.send({ type: "write", id, data, traceId });
  }

  resize(id: string, cols: number, rows: number): void {
    this.send({ type: "resize", id, cols, rows });
  }

  kill(id: string, reason?: string): void {
    this.pendingSpawns.delete(id);
    this.send({ type: "kill", id, reason });
  }

  /** Check if a terminal exists (based on local tracking) */
  hasTerminal(id: string): boolean {
    return this.pendingSpawns.has(id);
  }

  trash(id: string): void {
    this.send({ type: "trash", id });
  }

  /** Restore terminal from trash. Returns true if terminal was tracked. */
  restore(id: string): boolean {
    // Optimistically return true if we know about this terminal
    const wasTracked = this.pendingSpawns.has(id);
    this.send({ type: "restore", id });
    return wasTracked;
  }

  setBuffering(id: string, enabled: boolean): void {
    this.send({ type: "set-buffering", id, enabled });
  }

  flushBuffer(id: string): void {
    this.send({ type: "flush-buffer", id });
  }

  /**
   * Acknowledge data processing for flow control.
   */
  acknowledgeData(id: string, charCount: number): void {
    this.send({ type: "acknowledge-data", id, charCount } as any);
  }

  /** Set the activity tier for IPC batching (affects flush timing) */
  setActivityTier(id: string, tier: ActivityTier): void {
    this.send({ type: "set-activity-tier", id, tier });
  }

  /** Get terminal IDs for a specific project */
  getTerminalsForProject(_projectId: string): string[] {
    // Note: This is async in PtyClient but returns empty array synchronously
    // Use getTerminalsForProjectAsync for proper async behavior
    console.warn(
      "[PtyClient] getTerminalsForProject called synchronously - use getTerminalsForProjectAsync instead"
    );
    return [];
  }

  /** Get terminal IDs for a specific project (async) */
  async getTerminalsForProjectAsync(projectId: string): Promise<string[]> {
    return new Promise((resolve) => {
      const requestId = `terminals-${projectId}-${Date.now()}`;
      this.terminalsForProjectCallbacks.set(requestId, resolve);
      this.send({ type: "get-terminals-for-project", projectId, requestId } as any);

      setTimeout(() => {
        if (this.terminalsForProjectCallbacks.has(requestId)) {
          this.terminalsForProjectCallbacks.delete(requestId);
          resolve([]);
        }
      }, 5000);
    });
  }

  /** Get terminal info by ID (returns undefined sync, use getTerminalAsync for async) */
  getTerminal(_id: string): undefined {
    // Note: This is async in PtyClient
    console.warn("[PtyClient] getTerminal called synchronously - use getTerminalAsync instead");
    return undefined;
  }

  /** Get terminal info by ID (async) */
  async getTerminalAsync(id: string): Promise<TerminalInfoResponse | null> {
    return new Promise((resolve) => {
      const requestId = `terminal-${id}-${Date.now()}`;
      this.terminalInfoCallbacks.set(requestId, resolve);
      this.send({ type: "get-terminal", id, requestId } as any);

      setTimeout(() => {
        if (this.terminalInfoCallbacks.has(requestId)) {
          this.terminalInfoCallbacks.delete(requestId);
          resolve(null);
        }
      }, 5000);
    });
  }

  /** Replay terminal history (returns 0 sync, use replayHistoryAsync for async) */
  replayHistory(_id: string, _maxLines?: number): number {
    console.warn("[PtyClient] replayHistory called synchronously - use replayHistoryAsync instead");
    return 0;
  }

  /** Replay terminal history (async) */
  async replayHistoryAsync(id: string, maxLines: number = 100): Promise<number> {
    return new Promise((resolve) => {
      const requestId = `replay-${id}-${Date.now()}`;
      this.replayHistoryCallbacks.set(requestId, resolve);
      this.send({ type: "replay-history", id, maxLines, requestId } as any);

      setTimeout(() => {
        if (this.replayHistoryCallbacks.has(requestId)) {
          this.replayHistoryCallbacks.delete(requestId);
          resolve(0);
        }
      }, 5000);
    });
  }

  /**
   * Get serialized terminal state for fast restoration.
   * Returns the serialized state from the headless xterm instance.
   * @param id - Terminal identifier
   * @returns Serialized state string or null if terminal not found
   */
  async getSerializedStateAsync(id: string): Promise<string | null> {
    return new Promise((resolve) => {
      const requestId = `serialize-${id}-${Date.now()}`;
      this.serializedStateCallbacks.set(requestId, resolve);
      this.send({ type: "get-serialized-state", id, requestId } as PtyHostRequest);

      setTimeout(() => {
        if (this.serializedStateCallbacks.has(requestId)) {
          this.serializedStateCallbacks.delete(requestId);
          resolve(null);
        }
      }, 5000);
    });
  }

  /**
   * Get terminal information for diagnostic display.
   */
  async getTerminalInfo(
    id: string
  ): Promise<import("../../shared/types/ipc.js").TerminalInfoPayload | null> {
    return new Promise((resolve) => {
      const requestId = `terminal-info-${id}-${Date.now()}`;
      this.terminalDiagnosticInfoCallbacks.set(requestId, resolve);
      this.send({ type: "get-terminal-info", id, requestId } as any);

      setTimeout(() => {
        if (this.terminalDiagnosticInfoCallbacks.has(requestId)) {
          this.terminalDiagnosticInfoCallbacks.delete(requestId);
          resolve(null);
        }
      }, 5000);
    });
  }

  /** Get a snapshot of terminal state (async due to IPC) */
  async getTerminalSnapshot(id: string): Promise<TerminalSnapshot | null> {
    return new Promise((resolve) => {
      this.snapshotCallbacks.set(id, resolve);
      this.send({ type: "get-snapshot", id });

      // Timeout after 5s
      setTimeout(() => {
        if (this.snapshotCallbacks.has(id)) {
          this.snapshotCallbacks.delete(id);
          resolve(null);
        }
      }, 5000);
    });
  }

  /** Get snapshots for all terminals (async due to IPC) */
  async getAllTerminalSnapshots(): Promise<TerminalSnapshot[]> {
    return new Promise((resolve) => {
      this.allSnapshotsCallback = resolve;
      this.send({ type: "get-all-snapshots" });

      // Timeout after 5s
      setTimeout(() => {
        if (this.allSnapshotsCallback) {
          this.allSnapshotsCallback = null;
          resolve([]);
        }
      }, 5000);
    });
  }

  markChecked(id: string): void {
    this.send({ type: "mark-checked", id });
  }

  async transitionState(
    id: string,
    event: { type: string; [key: string]: unknown },
    trigger: AgentStateChangeTrigger,
    confidence: number,
    spawnedAt?: number
  ): Promise<boolean> {
    return new Promise((resolve) => {
      const requestId = `${id}-${Date.now()}`;
      this.transitionCallbacks.set(requestId, resolve);
      this.send({
        type: "transition-state",
        id,
        requestId,
        event,
        trigger,
        confidence,
        spawnedAt,
      });

      // Timeout after 5s
      setTimeout(() => {
        if (this.transitionCallbacks.has(requestId)) {
          this.transitionCallbacks.delete(requestId);
          resolve(false);
        }
      }, 5000);
    });
  }

  /** Pause all PTY processes during system sleep to prevent buffer overflow */
  pauseAll(): void {
    this.send({ type: "pause-all" });
  }

  /** Resume all PTY processes after system wake with incremental stagger */
  resumeAll(): void {
    this.send({ type: "resume-all" });
  }

  /** Pause health check during system sleep to prevent time-drift false positives */
  pauseHealthCheck(): void {
    if (this.isHealthCheckPaused) return;
    this.isHealthCheckPaused = true;
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
    // Clear any pending handshake from rapid suspend/resume cycles
    if (this.handshakeTimeout) {
      clearTimeout(this.handshakeTimeout);
      this.handshakeTimeout = null;
    }
    this.isWaitingForHandshake = false;
    console.log("[PtyClient] Health check paused");
  }

  /** Resume health check after system wake with handshake verification */
  resumeHealthCheck(): void {
    if (!this.isHealthCheckPaused) return;
    if (!this.isInitialized || !this.child) {
      console.warn("[PtyClient] Cannot resume health check - host not ready");
      this.isHealthCheckPaused = false;
      return;
    }

    this.isHealthCheckPaused = false;

    // Clear any existing interval before starting handshake
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }

    // Clear any existing handshake timeout from rapid suspend/resume
    if (this.handshakeTimeout) {
      clearTimeout(this.handshakeTimeout);
      this.handshakeTimeout = null;
    }

    // Send handshake ping before resuming normal health checks
    console.log("[PtyClient] System resumed. Initiating handshake...");
    this.isWaitingForHandshake = true;
    this.send({ type: "health-check" });

    // Timeout if no response within 5 seconds - fall back to immediate start
    this.handshakeTimeout = setTimeout(() => {
      if (this.isWaitingForHandshake) {
        console.warn("[PtyClient] Handshake timeout - forcing health check resume");
        this.isWaitingForHandshake = false;
        this.handshakeTimeout = null;
        this.startHealthCheckInterval();
      }
    }, 5000);
  }

  /** Start the health check interval (called after handshake or timeout) */
  private startHealthCheckInterval(): void {
    // Clear any existing interval
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }

    this.healthCheckInterval = setInterval(() => {
      if (this.isInitialized && this.child && !this.isHealthCheckPaused) {
        this.send({ type: "health-check" });
      }
    }, this.config.healthCheckIntervalMs);

    console.log("[PtyClient] Health check interval started");
  }

  /** Handle project switch - forward to host */
  onProjectSwitch(): void {
    this.send({ type: "dispose" });
    this.pendingSpawns.clear();
    // Restart host for new project
    if (this.child) {
      this.child.kill();
    }
    setTimeout(() => {
      this.startHost();
    }, 100);
  }

  dispose(): void {
    if (this.isDisposed) return;
    this.isDisposed = true;

    console.log("[PtyClient] Disposing...");

    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }

    if (this.handshakeTimeout) {
      clearTimeout(this.handshakeTimeout);
      this.handshakeTimeout = null;
    }
    this.isWaitingForHandshake = false;

    if (this.child) {
      this.send({ type: "dispose" });
      // Give it a moment to clean up, then force kill
      setTimeout(() => {
        if (this.child) {
          this.child.kill();
          this.child = null;
        }
      }, 1000);
    }

    // Resolve pending callbacks before clearing to prevent hanging promises
    for (const cb of this.snapshotCallbacks.values()) cb(null);
    for (const cb of this.transitionCallbacks.values()) cb(false);
    for (const cb of this.terminalsForProjectCallbacks.values()) cb([]);
    for (const cb of this.terminalInfoCallbacks.values()) cb(null);
    for (const cb of this.replayHistoryCallbacks.values()) cb(0);
    for (const cb of this.serializedStateCallbacks.values()) cb(null);
    if (this.allSnapshotsCallback) {
      this.allSnapshotsCallback([]);
      this.allSnapshotsCallback = null;
    }

    this.pendingSpawns.clear();
    this.snapshotCallbacks.clear();
    this.transitionCallbacks.clear();
    this.terminalsForProjectCallbacks.clear();
    this.terminalInfoCallbacks.clear();
    this.replayHistoryCallbacks.clear();
    this.serializedStateCallbacks.clear();
    this.removeAllListeners();

    console.log("[PtyClient] Disposed");
  }

  /** Check if host is running and initialized */
  isReady(): boolean {
    return this.isInitialized && this.child !== null;
  }

  /**
   * Get the SharedArrayBuffer for zero-copy terminal I/O (visual rendering).
   * Returns null if SharedArrayBuffer is not available.
   */
  getSharedBuffer(): SharedArrayBuffer | null {
    return this.sharedBuffer;
  }

  /**
   * Get the SharedArrayBuffer for semantic analysis (Web Worker).
   * Returns null if SharedArrayBuffer is not available.
   */
  getAnalysisBuffer(): SharedArrayBuffer | null {
    return this.analysisBuffer;
  }

  /**
   * Check if SharedArrayBuffer-based I/O is enabled.
   */
  isSharedBufferEnabled(): boolean {
    return this.sharedBufferEnabled;
  }
}

// Singleton management
let ptyClientInstance: PtyClient | null = null;

export function getPtyClient(config?: PtyClientConfig): PtyClient {
  if (!ptyClientInstance) {
    ptyClientInstance = new PtyClient(config);
  }
  return ptyClientInstance;
}

export function disposePtyClient(): void {
  if (ptyClientInstance) {
    ptyClientInstance.dispose();
    ptyClientInstance = null;
  }
}
