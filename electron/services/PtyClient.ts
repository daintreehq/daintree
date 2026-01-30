/**
 * PtyClient - Main process stub for terminal management.
 *
 * @pattern Dependency Injection via main.ts (Pattern B)
 *
 * This class provides a drop-in replacement for PtyManager in the Main process.
 * It forwards all operations to the Pty Host (UtilityProcess) via IPC,
 * keeping the Main thread responsive.
 *
 * Architecture:
 * - Uses RequestResponseBroker for unified request/response correlation
 * - Uses PtyEventsBridge for domain event routing to internal event bus
 * - Keeps this class focused on transport and lifecycle management
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
import { logInfo, logWarn } from "../utils/logger.js";
import { SharedRingBuffer } from "../../shared/utils/SharedRingBuffer.js";
import { RequestResponseBroker } from "./rpc/index.js";
import { bridgePtyEvent } from "./pty/PtyEventsBridge.js";
import type {
  PtyHostRequest,
  PtyHostEvent,
  PtyHostSpawnOptions,
  TerminalStatusPayload,
  PtyHostActivityTier,
  CrashType,
  HostCrashPayload,
  SpawnResult,
} from "../../shared/types/pty-host.js";
import type { TerminalSnapshot } from "./PtyManager.js";
import type { AgentStateChangeTrigger } from "../types/index.js";
import type { AgentState, TerminalType, TerminalKind, AgentId } from "../../shared/types/domain.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface TerminalInfoResponse {
  id: string;
  projectId?: string;
  kind?: TerminalKind;
  type?: TerminalType;
  agentId?: AgentId;
  title?: string;
  cwd: string;
  worktreeId?: string;
  agentState?: AgentState;
  lastStateChange?: number;
  spawnedAt: number;
  isTrashed?: boolean;
  trashExpiresAt?: number;
  activityTier?: "active" | "background";
  /** Whether this terminal has an active PTY process (false for orphaned terminals that exited) */
  hasPty?: boolean;
}

export interface PtyClientConfig {
  /** Maximum restart attempts before giving up */
  maxRestartAttempts?: number;
  /** Health check interval in milliseconds */
  healthCheckIntervalMs?: number;
  /** Whether to show dialog on crash */
  showCrashDialog?: boolean;
  /** Memory limit in MB for PTY Host process (default: 4096 = 4GB) */
  memoryLimitMb?: number;
}

const DEFAULT_CONFIG: Required<PtyClientConfig> = {
  maxRestartAttempts: 3,
  healthCheckIntervalMs: 30000,
  showCrashDialog: true,
  memoryLimitMb: 4096,
};

/** Default ring buffer size: 10MB for high-throughput terminal output */
const DEFAULT_RING_BUFFER_SIZE = 10 * 1024 * 1024;

/**
 * Classify crash type based on exit code and signal.
 * Exit codes 137 (128+9=SIGKILL) and 134 (128+6=SIGABRT) often indicate OOM.
 */
function classifyCrash(code: number | null, signal: string | null): CrashType {
  if (code === null) {
    return "SIGNAL_TERMINATED";
  }
  if (code === 0) {
    return "CLEAN_EXIT";
  }
  // OOM detection - SIGKILL (exit 137) or SIGABRT (exit 134)
  if (code === 137 || signal === "SIGKILL") {
    return "OUT_OF_MEMORY";
  }
  if (code === 134 || signal === "SIGABRT") {
    return "ASSERTION_FAILURE";
  }
  // Signal-terminated (exit code > 128 typically means 128 + signal number)
  if (code > 128) {
    return "SIGNAL_TERMINATED";
  }
  if (code !== 0) {
    return "UNKNOWN_CRASH";
  }
  return "CLEAN_EXIT";
}

function getCrashMessage(crashType: CrashType, code: number | null): string {
  switch (crashType) {
    case "OUT_OF_MEMORY":
      return (
        `The terminal backend crashed due to memory exhaustion (code ${code}). ` +
        `This can happen with high-throughput terminal output. ` +
        `Consider reducing output volume or splitting tasks.`
      );
    case "ASSERTION_FAILURE":
      return (
        `The terminal backend crashed due to an internal assertion failure (code ${code}). ` +
        `This may indicate a bug. Please report this issue.`
      );
    case "SIGNAL_TERMINATED":
      return (
        `The terminal backend was terminated by a signal (code ${code}). ` +
        `Terminals may need to be restarted.`
      );
    default:
      return `The terminal backend crashed (code ${code}). Terminals may need to be restarted.`;
  }
}

export class PtyClient extends EventEmitter {
  private child: UtilityProcess | null = null;
  private config: Required<PtyClientConfig>;
  private isInitialized = false;
  private isDisposed = false;
  private healthCheckInterval: NodeJS.Timeout | null = null;
  private restartTimer: NodeJS.Timeout | null = null;
  private restartAttempts = 0;
  private isHealthCheckPaused = false;
  private isWaitingForHandshake = false;
  private handshakeTimeout: NodeJS.Timeout | null = null;
  private pendingSpawns: Map<string, PtyHostSpawnOptions> = new Map();
  private needsRespawn = false;
  private activeProjectId: string | null = null;
  private projectContextMode: "active" | "switch" = "active";
  private shouldResyncProjectContext = false;
  private pendingMessagePort: MessagePortMain | null = null;
  private terminalPids: Map<string, number> = new Map();

  /** Watchdog: Track missed heartbeat responses to detect deadlocks */
  private missedHeartbeats = 0;
  private readonly MAX_MISSED_HEARTBEATS = 3;

  /** Unified request/response broker for all async operations */
  private broker = new RequestResponseBroker({
    defaultTimeoutMs: 5000,
    idPrefix: "pty",
    onTimeout: (requestId) => {
      console.warn(`[PtyClient] Request timeout: ${requestId}`);
    },
  });

  /** Special callbacks that don't fit the request/response pattern */
  private snapshotCallbacks: Map<string, (snapshot: TerminalSnapshot | null) => void> = new Map();
  private snapshotTimeouts: Map<string, NodeJS.Timeout> = new Map();
  private allSnapshotsCallbacks: Map<string, (snapshots: TerminalSnapshot[]) => void> = new Map();
  private allSnapshotsTimeouts: Map<string, NodeJS.Timeout> = new Map();
  private transitionCallbacks: Map<string, (success: boolean) => void> = new Map();
  private transitionTimeouts: Map<string, NodeJS.Timeout> = new Map();

  private readyPromise: Promise<void>;
  private readyResolve: (() => void) | null = null;
  private readyReject: ((error: Error) => void) | null = null;

  /** SharedArrayBuffer array for zero-copy terminal I/O (null if unavailable) */
  private visualBuffers: SharedArrayBuffer[] = [];
  /** SharedArrayBuffer for semantic analysis (separate from visual buffers) */
  private analysisBuffer: SharedArrayBuffer | null = null;
  /** SharedArrayBuffer for global wake signal */
  private visualSignalBuffer: SharedArrayBuffer | null = null;
  private sharedBufferEnabled = false;
  private readonly VISUAL_SHARD_COUNT = 4;

  /** Callback to notify renderer when MessagePort needs to be refreshed */
  private onPortRefresh: (() => void) | null = null;

  private hostStdoutBuffer = "";
  private hostStderrBuffer = "";

  constructor(config: PtyClientConfig = {}) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };

    // Create ready promise that resolves when host is ready or rejects on failure
    this.readyPromise = new Promise((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });

    try {
      const perShardSize = Math.floor(DEFAULT_RING_BUFFER_SIZE / this.VISUAL_SHARD_COUNT);
      for (let i = 0; i < this.VISUAL_SHARD_COUNT; i++) {
        this.visualBuffers.push(SharedRingBuffer.create(perShardSize));
      }
      this.analysisBuffer = SharedRingBuffer.create(DEFAULT_RING_BUFFER_SIZE);
      this.visualSignalBuffer = new SharedArrayBuffer(4);
      this.sharedBufferEnabled = true;
      console.log(
        `[PtyClient] SharedArrayBuffer enabled (${this.VISUAL_SHARD_COUNT} visual shards × ${Math.floor(perShardSize / 1024 / 1024)}MB + 10MB analysis)`
      );
    } catch (error) {
      console.warn("[PtyClient] SharedArrayBuffer unavailable, using IPC fallback:", error);
      this.visualBuffers = [];
      this.analysisBuffer = null;
      this.visualSignalBuffer = null;
      this.sharedBufferEnabled = false;
    }

    this.startHost();
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
      const message = `[PtyHost] ${trimmed.length > 4000 ? `${trimmed.slice(0, 4000)}…` : trimmed}`;
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
  }

  private flushHostOutputBuffers(): void {
    const stdoutRemainder = this.hostStdoutBuffer.trim();
    if (stdoutRemainder) {
      logInfo(
        `[PtyHost] ${stdoutRemainder.length > 4000 ? `${stdoutRemainder.slice(0, 4000)}…` : stdoutRemainder}`
      );
    }
    const stderrRemainder = this.hostStderrBuffer.trim();
    if (stderrRemainder) {
      logWarn(
        `[PtyHost] ${stderrRemainder.length > 4000 ? `${stderrRemainder.slice(0, 4000)}…` : stderrRemainder}`
      );
    }
    this.hostStdoutBuffer = "";
    this.hostStderrBuffer = "";
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

    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }

    // Reset initialization state for restart
    this.isInitialized = false;
    this.readyPromise = new Promise((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });

    const hostPath = path.join(__dirname, "pty-host.js");

    console.log(`[PtyClient] Starting Pty Host from: ${hostPath}`);

    try {
      this.child = utilityProcess.fork(hostPath, [], {
        serviceName: "canopy-pty-host",
        stdio: "pipe",
        execArgv: [`--max-old-space-size=${this.config.memoryLimitMb}`],
        env: {
          ...(process.env as Record<string, string>),
          CANOPY_USER_DATA: app.getPath("userData"),
        },
      });
      console.log(`[PtyClient] Pty Host started with ${this.config.memoryLimitMb}MB memory limit`);
    } catch (error) {
      console.error("[PtyClient] Failed to fork Pty Host:", error);
      if (this.readyReject) {
        this.readyReject(new Error("PTY host failed to start"));
        this.readyResolve = null;
        this.readyReject = null;
      }
      this.emit("host-crash", -1);
      return;
    }

    this.installHostLogForwarding();

    this.child.on("message", (msg: PtyHostEvent) => {
      this.handleHostEvent(msg);
    });

    // Send all SharedArrayBuffers to host immediately after spawn
    if (this.visualBuffers.length > 0 && this.analysisBuffer && this.visualSignalBuffer) {
      try {
        this.child.postMessage({
          type: "init-buffers",
          visualBuffers: this.visualBuffers,
          analysisBuffer: this.analysisBuffer,
          visualSignalBuffer: this.visualSignalBuffer,
        });
        console.log(
          `[PtyClient] SharedArrayBuffers sent to Pty Host (${this.visualBuffers.length} visual shards + analysis + signal)`
        );
      } catch (error) {
        console.warn(
          "[PtyClient] SharedArrayBuffer transfer failed (using IPC fallback):",
          error instanceof Error ? error.message : String(error)
        );
        this.visualBuffers = [];
        this.analysisBuffer = null;
        this.visualSignalBuffer = null;
        this.sharedBufferEnabled = false;
      }
    }

    this.child.on("exit", (code) => {
      this.flushHostOutputBuffers();
      // Note: UtilityProcess exit event doesn't provide signal, but we can infer from code
      const signal = code !== null && code > 128 ? `SIG${code - 128}` : null;
      const crashType = classifyCrash(code, signal);

      console.error(
        `[PtyClient] Pty Host exited with code ${code}` +
          (crashType !== "CLEAN_EXIT" ? ` (${crashType})` : "")
      );

      // Clear health check
      if (this.healthCheckInterval) {
        clearInterval(this.healthCheckInterval);
        this.healthCheckInterval = null;
      }

      // Reject ready promise if host exited before becoming ready
      const wasReady = this.isInitialized;
      this.isInitialized = false;
      this.child = null; // Prevent posting to dead process

      if (this.isDisposed) {
        // Expected shutdown
        return;
      }

      // If host crashed before ready, reject the promise so startup doesn't hang
      if (!wasReady && this.readyReject) {
        this.readyReject(new Error("PTY host exited before ready"));
        this.readyResolve = null;
        this.readyReject = null;
      }

      this.cleanupOrphanedPtys(crashType);

      this.broker.clear(new Error("Pty host restarted"));
      this.shouldResyncProjectContext = true;

      // Emit crash payload with classification for downstream consumers
      if (crashType !== "CLEAN_EXIT") {
        const crashPayload: HostCrashPayload = {
          code,
          signal,
          crashType,
          timestamp: Date.now(),
        };
        this.emit("host-crash-details", crashPayload);
      }

      // Try to restart
      if (this.restartAttempts < this.config.maxRestartAttempts) {
        this.restartAttempts++;
        const delay = Math.min(1000 * Math.pow(2, this.restartAttempts), 10000);
        console.log(
          `[PtyClient] Restarting Host in ${delay}ms (attempt ${this.restartAttempts}/${this.config.maxRestartAttempts})`
        );

        if (this.restartTimer) {
          clearTimeout(this.restartTimer);
        }
        this.restartTimer = setTimeout(() => {
          this.restartTimer = null;
          this.needsRespawn = true;
          this.startHost();
        }, delay);
      } else {
        console.error("[PtyClient] Max restart attempts reached, giving up");
        this.emit("host-crash", code);

        if (this.config.showCrashDialog) {
          const crashMessage = getCrashMessage(crashType, code);
          dialog
            .showMessageBox({
              type: "error",
              title: "Terminal Service Crashed",
              message: crashMessage,
              buttons: ["OK"],
            })
            .catch(console.error);
        }
      }
    });

    // Start health check with watchdog (only if not paused by system sleep)
    if (!this.isHealthCheckPaused) {
      this.startHealthCheckInterval();
    }

    console.log("[PtyClient] Pty Host started");
  }

  private handleHostEvent(event: PtyHostEvent): void {
    // First, try to handle as a domain event via the bridge
    const bridged = bridgePtyEvent(event, {
      onTerminalStatus: (payload) => {
        const statusPayload: TerminalStatusPayload = {
          id: payload.id,
          status: payload.status,
          bufferUtilization: payload.bufferUtilization,
          pauseDuration: payload.pauseDuration,
          timestamp: payload.timestamp,
        };
        this.emit("terminal-status", statusPayload);
      },
      onHostThrottled: (payload) => {
        this.emit("host-throttled", payload);
      },
    });

    if (bridged) {
      return;
    }

    // Handle transport-level events and request/response correlation
    switch (event.type) {
      case "ready":
        // Ignore late ready events if host is already dead
        if (!this.child) {
          console.warn("[PtyClient] Ignoring late ready event - host is dead");
          break;
        }
        this.isInitialized = true;
        this.restartAttempts = 0;
        if (this.readyResolve) {
          this.readyResolve();
          this.readyResolve = null;
          this.readyReject = null;
        }
        console.log("[PtyClient] Pty Host is ready");
        if (this.needsRespawn) {
          this.needsRespawn = false;
          this.respawnPending();
        }
        if (this.shouldResyncProjectContext) {
          this.shouldResyncProjectContext = false;
          this.syncProjectContext();
        }
        this.flushPendingMessagePort();
        break;

      case "data":
        this.emit("data", event.id, event.data);
        break;

      case "exit":
        this.pendingSpawns.delete(event.id);
        this.terminalPids.delete(event.id);
        this.emit("exit", event.id, event.exitCode);
        break;

      case "error":
        this.emit("error", event.id, event.error);
        break;

      case "snapshot": {
        const callback = this.snapshotCallbacks.get(event.requestId);
        if (callback) {
          this.snapshotCallbacks.delete(event.requestId);
          const timeout = this.snapshotTimeouts.get(event.requestId);
          if (timeout) {
            clearTimeout(timeout);
            this.snapshotTimeouts.delete(event.requestId);
          }
          callback(event.snapshot as TerminalSnapshot | null);
        }
        break;
      }

      case "all-snapshots": {
        const callback = this.allSnapshotsCallbacks.get(event.requestId);
        if (callback) {
          this.allSnapshotsCallbacks.delete(event.requestId);
          const timeout = this.allSnapshotsTimeouts.get(event.requestId);
          if (timeout) {
            clearTimeout(timeout);
            this.allSnapshotsTimeouts.delete(event.requestId);
          }
          callback(event.snapshots as TerminalSnapshot[]);
        }
        break;
      }

      case "transition-result": {
        const cb = this.transitionCallbacks.get(event.requestId);
        if (cb) {
          this.transitionCallbacks.delete(event.requestId);
          const timeout = this.transitionTimeouts.get(event.requestId);
          if (timeout) {
            clearTimeout(timeout);
            this.transitionTimeouts.delete(event.requestId);
          }
          cb(event.success);
        }
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
          console.log("[PtyClient] Handshake successful - resuming health checks");
          this.startHealthCheckInterval();
        }
        break;

      // Request/response events handled via broker
      case "terminals-for-project":
        this.broker.resolve((event as any).requestId, (event as any).terminalIds ?? []);
        break;

      case "terminal-info":
        this.broker.resolve((event as any).requestId, (event as any).terminal ?? null);
        break;

      case "replay-history-result":
        this.broker.resolve((event as any).requestId, (event as any).replayed ?? 0);
        break;

      case "available-terminals": {
        const availableEvent = event as {
          type: "available-terminals";
          requestId: string;
          terminals: TerminalInfoResponse[];
        };
        this.broker.resolve(availableEvent.requestId, availableEvent.terminals ?? []);
        break;
      }

      case "terminals-by-state": {
        const byStateEvent = event as {
          type: "terminals-by-state";
          requestId: string;
          terminals: TerminalInfoResponse[];
        };
        this.broker.resolve(byStateEvent.requestId, byStateEvent.terminals ?? []);
        break;
      }

      case "all-terminals": {
        const allEvent = event as {
          type: "all-terminals";
          requestId: string;
          terminals: TerminalInfoResponse[];
        };
        this.broker.resolve(allEvent.requestId, allEvent.terminals ?? []);
        break;
      }

      case "serialized-state":
        this.broker.resolve((event as any).requestId, (event as any).state ?? null);
        break;

      case "wake-result":
        this.broker.resolve((event as any).requestId, {
          state: (event as any).state ?? null,
          warnings: (event as any).warnings,
        });
        break;

      case "kill-by-project-result":
        this.broker.resolve((event as any).requestId, (event as any).killed ?? 0);
        break;

      case "project-stats":
        this.broker.resolve(
          (event as any).requestId,
          (event as any).stats ?? { terminalCount: 0, processIds: [], terminalTypes: {} }
        );
        break;

      case "terminal-diagnostic-info":
        this.broker.resolve(event.requestId, event.info);
        break;

      case "terminal-pid":
        this.terminalPids.set(event.id, event.pid);
        break;

      case "spawn-result": {
        const spawnResultEvent = event as { type: "spawn-result"; id: string; result: SpawnResult };
        if (!spawnResultEvent.result.success) {
          // Remove from pending spawns since spawn failed
          this.pendingSpawns.delete(spawnResultEvent.id);
        }
        this.emit("spawn-result", spawnResultEvent.id, spawnResultEvent.result);
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
    try {
      this.child.postMessage(request);
    } catch (error) {
      console.error("[PtyClient] postMessage failed:", error);
      // Treat as host crash - triggers restart path
      if (this.child) {
        this.child.kill();
      }
    }
  }

  private respawnPending(): void {
    // Notify that ports need refresh after host restart
    if (this.onPortRefresh) {
      if (this.pendingMessagePort) {
        try {
          this.pendingMessagePort.close();
        } catch {
          // ignore
        }
        this.pendingMessagePort = null;
      }
      this.onPortRefresh();
    }

    // Respawn terminals that were active when host crashed
    for (const [id, options] of this.pendingSpawns) {
      console.log(`[PtyClient] Respawning terminal: ${id}`);
      this.send({ type: "spawn", id, options });
    }
  }

  private cleanupOrphanedPtys(crashType: CrashType): void {
    if (crashType === "CLEAN_EXIT" || this.terminalPids.size === 0) {
      return;
    }

    const uniquePids = new Set(this.terminalPids.values());
    console.warn(
      `[PtyClient] Attempting to clean up ${uniquePids.size} orphaned PTY process(es) after host crash`
    );

    for (const pid of uniquePids) {
      if (!Number.isFinite(pid) || pid <= 0) continue;
      if (pid === process.pid) continue;

      let killed = false;
      if (process.platform !== "win32") {
        try {
          process.kill(-pid, "SIGKILL");
          killed = true;
        } catch {
          // ignore - fall back to direct kill
        }
      }

      if (!killed) {
        try {
          process.kill(pid, "SIGKILL");
        } catch (error) {
          if (process.env.CANOPY_VERBOSE) {
            console.warn(`[PtyClient] Failed to kill orphaned PTY pid=${pid}:`, error);
          }
        }
      }
    }

    this.terminalPids.clear();
  }

  /** Set callback for MessagePort refresh (called on host restart) */
  setPortRefreshCallback(callback: () => void): void {
    this.onPortRefresh = callback;
  }

  private flushPendingMessagePort(): void {
    if (!this.child || !this.pendingMessagePort) {
      return;
    }

    const port = this.pendingMessagePort;
    this.pendingMessagePort = null;
    this.connectMessagePort(port);
  }

  /** Forward MessagePort to Pty Host for direct Renderer↔PtyHost communication */
  connectMessagePort(port: MessagePortMain): void {
    if (this.pendingMessagePort && this.pendingMessagePort !== port) {
      try {
        this.pendingMessagePort.close();
      } catch {
        // ignore
      }
      this.pendingMessagePort = null;
    }

    if (!this.child) {
      console.warn("[PtyClient] Cannot connect MessagePort - host not running, will retry");
      this.pendingMessagePort = port;
      return;
    }

    try {
      this.child.postMessage({ type: "connect-port" }, [port]);
      if (process.env.CANOPY_VERBOSE) {
        console.log("[PtyClient] MessagePort forwarded to Pty Host");
      }
    } catch (error) {
      console.error("[PtyClient] Failed to forward MessagePort to Pty Host:", error);
      this.pendingMessagePort = port;
    }
  }

  private resolveKeySequence(key: string): string | null {
    const normalizedKey = key.trim().toLowerCase();
    if (!normalizedKey) return null;
    if (normalizedKey.length > 64) return null;

    const simpleMap: Record<string, string> = {
      enter: "\r",
      return: "\r",
      tab: "\t",
      "shift+tab": "\u001b[Z",
      esc: "\u001b",
      escape: "\u001b",
      backspace: "\u007f",
      delete: "\u001b[3~",
      insert: "\u001b[2~",
      home: "\u001b[H",
      end: "\u001b[F",
      pageup: "\u001b[5~",
      pagedown: "\u001b[6~",
      up: "\u001b[A",
      down: "\u001b[B",
      right: "\u001b[C",
      left: "\u001b[D",
    };

    if (simpleMap[normalizedKey]) return simpleMap[normalizedKey];

    const ctrlMatch = normalizedKey.match(/^ctrl\+([a-z])$/);
    if (ctrlMatch) {
      const char = ctrlMatch[1].toUpperCase();
      return String.fromCharCode(char.charCodeAt(0) - 64);
    }

    const altMatch = normalizedKey.match(/^alt\+(.+)$/);
    if (altMatch) {
      const rest = this.resolveKeySequence(altMatch[1]);
      if (!rest) return null;
      return `\u001b${rest}`;
    }

    if (normalizedKey.length === 1) return normalizedKey;

    return null;
  }

  spawn(id: string, options: PtyHostSpawnOptions): void {
    const activeProjectId = this.activeProjectId ?? undefined;
    const normalizedProjectId =
      typeof options.projectId === "string" && options.projectId.trim()
        ? options.projectId
        : undefined;

    const resolvedProjectId = normalizedProjectId ?? activeProjectId;
    const resolvedOptions =
      resolvedProjectId !== undefined ? { ...options, projectId: resolvedProjectId } : options;

    this.pendingSpawns.set(id, resolvedOptions);
    this.send({ type: "spawn", id, options: resolvedOptions });
  }

  write(id: string, data: string, traceId?: string): void {
    this.send({ type: "write", id, data, traceId });
  }

  submit(id: string, text: string): void {
    this.send({ type: "submit", id, text });
  }

  sendKey(id: string, key: string): void {
    const sequence = this.resolveKeySequence(key);
    if (!sequence) {
      console.warn(`[PtyClient] Ignoring unknown key sequence: ${key}`);
      return;
    }
    this.write(id, sequence);
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

  setActivityTier(id: string, tier: PtyHostActivityTier): void {
    this.send({ type: "set-activity-tier", id, tier });
  }

  async wakeTerminal(id: string): Promise<{ state: string | null; warnings?: string[] }> {
    const requestId = this.broker.generateId(`wake-${id}`);
    const promise = this.broker.register<{ state: string | null; warnings?: string[] }>(requestId);
    this.send({ type: "wake-terminal", id, requestId });
    return promise.catch(() => ({ state: null }));
  }

  private syncProjectContext(): void {
    if (!this.child) {
      this.shouldResyncProjectContext = true;
      return;
    }

    if (!this.activeProjectId) {
      this.send({ type: "set-active-project", projectId: null });
      return;
    }

    if (this.projectContextMode === "switch") {
      this.send({ type: "project-switch", projectId: this.activeProjectId });
      return;
    }

    this.send({ type: "set-active-project", projectId: this.activeProjectId });
  }

  setActiveProject(projectId: string | null): void {
    this.activeProjectId = projectId;
    this.projectContextMode = "active";

    if (!this.child) {
      this.shouldResyncProjectContext = true;
      return;
    }

    this.send({ type: "set-active-project", projectId });
  }

  onProjectSwitch(projectId: string): void {
    this.activeProjectId = projectId;
    this.projectContextMode = "switch";

    if (!this.child) {
      this.shouldResyncProjectContext = true;
      return;
    }

    this.send({ type: "project-switch", projectId });
  }

  async killByProject(projectId: string): Promise<number> {
    const requestId = this.broker.generateId(`kill-by-project-${projectId}`);
    const promise = this.broker.register<number>(requestId, 10000);
    this.send({ type: "kill-by-project", projectId, requestId });
    return promise.catch(() => 0);
  }

  async getProjectStats(projectId: string): Promise<{
    terminalCount: number;
    processIds: number[];
    terminalTypes: Record<string, number>;
  }> {
    const requestId = this.broker.generateId(`project-stats-${projectId}`);
    const promise = this.broker.register<{
      terminalCount: number;
      processIds: number[];
      terminalTypes: Record<string, number>;
    }>(requestId);
    this.send({ type: "get-project-stats", projectId, requestId });
    return promise.catch(() => ({ terminalCount: 0, processIds: [], terminalTypes: {} }));
  }

  /**
   * Acknowledge data processing for flow control.
   */
  acknowledgeData(id: string, charCount: number): void {
    this.send({ type: "acknowledge-data", id, charCount });
  }

  /**
   * Force resume a terminal that may be paused due to backpressure.
   * This is a user-initiated action to unblock a terminal when the
   * automatic flow control gets stuck.
   */
  forceResume(id: string): void {
    this.send({ type: "force-resume", id });
  }

  /** Get terminal IDs for a specific project */
  async getTerminalsForProjectAsync(projectId: string): Promise<string[]> {
    const requestId = this.broker.generateId(`terminals-${projectId}`);
    const promise = this.broker.register<string[]>(requestId);
    this.send({ type: "get-terminals-for-project", projectId, requestId });
    return promise.catch(() => []);
  }

  /** Get terminal info by ID */
  async getTerminalAsync(id: string): Promise<TerminalInfoResponse | null> {
    const requestId = this.broker.generateId(`terminal-${id}`);
    const promise = this.broker.register<TerminalInfoResponse | null>(requestId);
    this.send({ type: "get-terminal", id, requestId });
    return promise.catch(() => null);
  }

  /** Get available terminals (idle or waiting for user input) */
  async getAvailableTerminalsAsync(): Promise<TerminalInfoResponse[]> {
    const requestId = this.broker.generateId("available-terminals");
    const promise = this.broker.register<TerminalInfoResponse[]>(requestId);
    this.send({ type: "get-available-terminals", requestId });
    return promise.catch(() => []);
  }

  /** Get terminals filtered by agent state */
  async getTerminalsByStateAsync(
    state: import("../../shared/types/domain.js").AgentState
  ): Promise<TerminalInfoResponse[]> {
    const requestId = this.broker.generateId(`terminals-by-state-${state}`);
    const promise = this.broker.register<TerminalInfoResponse[]>(requestId);
    this.send({ type: "get-terminals-by-state", state, requestId });
    return promise.catch(() => []);
  }

  /** Get all terminals */
  async getAllTerminalsAsync(): Promise<TerminalInfoResponse[]> {
    const requestId = this.broker.generateId("all-terminals");
    const promise = this.broker.register<TerminalInfoResponse[]>(requestId);
    this.send({ type: "get-all-terminals", requestId });
    return promise.catch(() => []);
  }

  /** Replay terminal history */
  async replayHistoryAsync(id: string, maxLines: number = 100): Promise<number> {
    const requestId = this.broker.generateId(`replay-${id}`);
    const promise = this.broker.register<number>(requestId);
    this.send({ type: "replay-history", id, maxLines, requestId });
    return promise.catch(() => 0);
  }

  /**
   * Get serialized terminal state for fast restoration.
   * Returns the serialized state from the headless xterm instance.
   * @param id - Terminal identifier
   * @returns Serialized state string or null if terminal not found
   */
  async getSerializedStateAsync(id: string): Promise<string | null> {
    const requestId = this.broker.generateId(`serialize-${id}`);
    // Extended timeout (15s) for large terminals with lots of scrollback.
    const promise = this.broker.register<string | null>(requestId, 15000);
    this.send({ type: "get-serialized-state", id, requestId } as PtyHostRequest);
    return promise.catch(() => {
      console.warn(`[PtyClient] getSerializedState timeout for ${id}`);
      return null;
    });
  }

  /**
   * Get terminal information for diagnostic display.
   */
  async getTerminalInfo(
    id: string
  ): Promise<import("../../shared/types/ipc.js").TerminalInfoPayload | null> {
    const requestId = this.broker.generateId(`terminal-info-${id}`);
    const promise = this.broker.register<
      import("../../shared/types/ipc.js").TerminalInfoPayload | null
    >(requestId);
    this.send({ type: "get-terminal-info", id, requestId });
    return promise.catch(() => null);
  }

  /** Get a snapshot of terminal state (async due to IPC) */
  async getTerminalSnapshot(id: string): Promise<TerminalSnapshot | null> {
    const requestId = this.broker.generateId(`snapshot-${id}`);
    return new Promise((resolve) => {
      this.snapshotCallbacks.set(requestId, resolve);
      this.send({ type: "get-snapshot", id, requestId });

      // Timeout after 5s
      const timeout = setTimeout(() => {
        if (this.snapshotCallbacks.has(requestId)) {
          this.snapshotCallbacks.delete(requestId);
          this.snapshotTimeouts.delete(requestId);
          resolve(null);
        }
      }, 5000);
      this.snapshotTimeouts.set(requestId, timeout);
    });
  }

  /** Get snapshots for all terminals (async due to IPC) */
  async getAllTerminalSnapshots(): Promise<TerminalSnapshot[]> {
    const requestId = this.broker.generateId("all-snapshots");
    return new Promise((resolve) => {
      this.allSnapshotsCallbacks.set(requestId, resolve);
      this.send({ type: "get-all-snapshots", requestId });

      // Timeout after 5s
      const timeout = setTimeout(() => {
        if (this.allSnapshotsCallbacks.has(requestId)) {
          this.allSnapshotsCallbacks.delete(requestId);
          this.allSnapshotsTimeouts.delete(requestId);
          resolve([]);
        }
      }, 5000);
      this.allSnapshotsTimeouts.set(requestId, timeout);
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
      const requestId = this.broker.generateId(`transition-${id}`);
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
      const timeout = setTimeout(() => {
        if (this.transitionCallbacks.has(requestId)) {
          this.transitionCallbacks.delete(requestId);
          this.transitionTimeouts.delete(requestId);
          resolve(false);
        }
      }, 5000);
      this.transitionTimeouts.set(requestId, timeout);
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

  /** Start the health check interval with watchdog (called after handshake or timeout) */
  private startHealthCheckInterval(): void {
    // Clear any existing interval
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }

    // Reset watchdog counter when starting
    this.missedHeartbeats = 0;

    this.healthCheckInterval = setInterval(() => {
      if (!this.isInitialized || !this.child || this.isHealthCheckPaused) return;

      // WATCHDOG CHECK: Force-kill if host is unresponsive
      if (this.missedHeartbeats >= this.MAX_MISSED_HEARTBEATS) {
        const missedMs = this.missedHeartbeats * this.config.healthCheckIntervalMs;
        console.error(
          `[PtyClient] Watchdog: Host unresponsive for ${this.missedHeartbeats} checks (${missedMs}ms). Force killing.`
        );

        // Emit crash details before force-killing
        const crashPayload: HostCrashPayload = {
          code: null,
          signal: "SIGKILL",
          crashType: "SIGNAL_TERMINATED",
          timestamp: Date.now(),
        };
        this.emit("host-crash-details", crashPayload);

        // Force kill with SIGKILL (UtilityProcess.kill() only sends SIGTERM)
        if (this.child.pid) {
          process.kill(this.child.pid, "SIGKILL");
        }
        this.missedHeartbeats = 0;
        return;
      }

      // Increment counter - will be reset by 'pong' response
      this.missedHeartbeats++;
      this.send({ type: "health-check" });
    }, this.config.healthCheckIntervalMs);

    console.log("[PtyClient] Health check interval started (watchdog enabled)");
  }

  /** Handle project switch - forward to host */
  // Note: Project switching is now handled via onProjectSwitch(projectId) which
  // preserves the host and active terminals while changing filtering/backgrounding.

  dispose(): void {
    if (this.isDisposed) return;
    this.isDisposed = true;
    this.shouldResyncProjectContext = false;
    this.needsRespawn = false;

    console.log("[PtyClient] Disposing...");

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

    if (this.pendingMessagePort) {
      try {
        this.pendingMessagePort.close();
      } catch {
        // ignore
      }
      this.pendingMessagePort = null;
    }

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

    // Clean up all pending requests via broker
    this.broker.dispose();

    // Clean up remaining special callbacks
    for (const cb of this.snapshotCallbacks.values()) cb(null);
    for (const cb of this.allSnapshotsCallbacks.values()) cb([]);
    for (const cb of this.transitionCallbacks.values()) cb(false);

    // Clear all timeouts
    for (const timeout of this.snapshotTimeouts.values()) clearTimeout(timeout);
    for (const timeout of this.allSnapshotsTimeouts.values()) clearTimeout(timeout);
    for (const timeout of this.transitionTimeouts.values()) clearTimeout(timeout);

    this.pendingSpawns.clear();
    this.terminalPids.clear();
    this.snapshotCallbacks.clear();
    this.snapshotTimeouts.clear();
    this.allSnapshotsCallbacks.clear();
    this.allSnapshotsTimeouts.clear();
    this.transitionCallbacks.clear();
    this.transitionTimeouts.clear();
    this.removeAllListeners();

    console.log("[PtyClient] Disposed");
  }

  /** Check if host is running and initialized */
  isReady(): boolean {
    return this.isInitialized && this.child !== null;
  }

  /**
   * Get the SharedArrayBuffers for zero-copy terminal I/O (visual rendering).
   * Returns empty array if SharedArrayBuffer is not available.
   */
  getSharedBuffers(): {
    visualBuffers: SharedArrayBuffer[];
    signalBuffer: SharedArrayBuffer | null;
  } {
    return {
      visualBuffers: this.visualBuffers,
      signalBuffer: this.visualSignalBuffer,
    };
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
   * Used internally and by diagnostic/debugging code.
   */
  isSharedBufferEnabled(): boolean {
    return this.sharedBufferEnabled;
  }
}

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
