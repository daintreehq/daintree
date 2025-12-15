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
import { logInfo, logWarn } from "../utils/logger.js";
import { SharedRingBuffer } from "../../shared/utils/SharedRingBuffer.js";
import type {
  PtyHostRequest,
  PtyHostEvent,
  PtyHostSpawnOptions,
  TerminalStatusPayload,
  PtyHostActivityTier,
  CrashType,
  HostCrashPayload,
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

/**
 * Generate user-friendly crash message based on crash type.
 */
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
  private restartAttempts = 0;
  private isHealthCheckPaused = false;
  private isWaitingForHandshake = false;
  private handshakeTimeout: NodeJS.Timeout | null = null;
  private pendingSpawns: Map<string, PtyHostSpawnOptions> = new Map();

  /** Watchdog: Track missed heartbeat responses to detect deadlocks */
  private missedHeartbeats = 0;
  private readonly MAX_MISSED_HEARTBEATS = 3;
  private snapshotCallbacks: Map<string, (snapshot: TerminalSnapshot | null) => void> = new Map();
  private allSnapshotsCallback: ((snapshots: TerminalSnapshot[]) => void) | null = null;
  private transitionCallbacks: Map<string, (success: boolean) => void> = new Map();
  private terminalsForProjectCallbacks: Map<string, (ids: string[]) => void> = new Map();
  private terminalInfoCallbacks: Map<string, (terminal: TerminalInfoResponse | null) => void> =
    new Map();
  private replayHistoryCallbacks: Map<string, (replayed: number) => void> = new Map();
  private serializedStateCallbacks: Map<string, (state: string | null) => void> = new Map();
  private wakeCallbacks: Map<
    string,
    (result: { state: string | null; warnings?: string[] }) => void
  > = new Map();
  private killByProjectCallbacks: Map<string, (killed: number) => void> = new Map();
  private projectStatsCallbacks: Map<
    string,
    (stats: {
      terminalCount: number;
      processIds: number[];
      terminalTypes: Record<string, number>;
    }) => void
  > = new Map();
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

  private hostStdoutBuffer = "";
  private hostStderrBuffer = "";

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
      this.emit("host-crash", -1);
      return;
    }

    this.installHostLogForwarding();

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

      this.isInitialized = false;
      this.child = null; // Prevent posting to dead process

      if (this.isDisposed) {
        // Expected shutdown
        return;
      }

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

        setTimeout(() => {
          this.startHost();
          // Re-spawn any terminals that were pending
          this.respawnPending();
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
        // Reset watchdog counter on every pong - host is responsive
        this.missedHeartbeats = 0;

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

      case "wake-result": {
        const cb = this.wakeCallbacks.get((event as any).requestId);
        if (cb) {
          this.wakeCallbacks.delete((event as any).requestId);
          cb({ state: (event as any).state ?? null, warnings: (event as any).warnings });
        }
        break;
      }

      case "kill-by-project-result": {
        const cb = this.killByProjectCallbacks.get((event as any).requestId);
        if (cb) {
          this.killByProjectCallbacks.delete((event as any).requestId);
          cb((event as any).killed ?? 0);
        }
        break;
      }

      case "project-stats": {
        const cb = this.projectStatsCallbacks.get((event as any).requestId);
        if (cb) {
          this.projectStatsCallbacks.delete((event as any).requestId);
          cb((event as any).stats ?? { terminalCount: 0, processIds: [], terminalTypes: {} });
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

      case "terminal-status": {
        // Forward terminal status events for flow control visibility
        const statusPayload: TerminalStatusPayload = {
          id: event.id,
          status: event.status,
          bufferUtilization: event.bufferUtilization,
          pauseDuration: event.pauseDuration,
          timestamp: event.timestamp,
        };
        this.emit("terminal-status", statusPayload);
        // Also emit to internal event bus for other services
        events.emit("terminal:status", statusPayload);
        break;
      }

      case "host-throttled":
        // Forward host throttle events for memory pressure visibility
        this.emit("host-throttled", {
          isThrottled: event.isThrottled,
          reason: event.reason,
          duration: event.duration,
          timestamp: event.timestamp,
        });
        break;

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
      if (process.env.CANOPY_VERBOSE) {
        console.log("[PtyClient] MessagePort forwarded to Pty Host");
      }
    } catch (error) {
      console.error("[PtyClient] Failed to forward MessagePort to Pty Host:", error);
    }
  }

  // Public API - matches PtyManager interface

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
    this.pendingSpawns.set(id, options);
    this.send({ type: "spawn", id, options });
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

  flushBuffer(id: string): void {
    this.send({ type: "flush-buffer", id });
  }

  setActivityTier(id: string, tier: PtyHostActivityTier): void {
    this.send({ type: "set-activity-tier", id, tier } as any);
  }

  async wakeTerminal(id: string): Promise<{ state: string | null; warnings?: string[] }> {
    return new Promise((resolve) => {
      const requestId = `wake-${id}-${Date.now()}`;
      this.wakeCallbacks.set(requestId, resolve);
      this.send({ type: "wake-terminal", id, requestId } as any);

      setTimeout(() => {
        if (this.wakeCallbacks.has(requestId)) {
          this.wakeCallbacks.delete(requestId);
          resolve({ state: null });
        }
      }, 5000);
    });
  }

  setActiveProject(projectId: string | null): void {
    this.send({ type: "set-active-project", projectId } as any);
  }

  onProjectSwitch(projectId: string): void {
    this.send({ type: "project-switch", projectId } as any);
  }

  async killByProject(projectId: string): Promise<number> {
    return new Promise((resolve) => {
      const requestId = `kill-by-project-${projectId}-${Date.now()}`;
      this.killByProjectCallbacks.set(requestId, resolve);
      this.send({ type: "kill-by-project", projectId, requestId } as any);

      setTimeout(() => {
        if (this.killByProjectCallbacks.has(requestId)) {
          this.killByProjectCallbacks.delete(requestId);
          resolve(0);
        }
      }, 10000);
    });
  }

  async getProjectStats(projectId: string): Promise<{
    terminalCount: number;
    processIds: number[];
    terminalTypes: Record<string, number>;
  }> {
    return new Promise((resolve) => {
      const requestId = `project-stats-${projectId}-${Date.now()}`;
      this.projectStatsCallbacks.set(requestId, resolve);
      this.send({ type: "get-project-stats", projectId, requestId } as any);

      setTimeout(() => {
        if (this.projectStatsCallbacks.has(requestId)) {
          this.projectStatsCallbacks.delete(requestId);
          resolve({ terminalCount: 0, processIds: [], terminalTypes: {} });
        }
      }, 5000);
    });
  }

  /**
   * Acknowledge data processing for flow control.
   */
  acknowledgeData(id: string, charCount: number): void {
    this.send({ type: "acknowledge-data", id, charCount } as any);
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

  /** Get terminal info by ID */
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

  /** Replay terminal history */
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
    for (const cb of this.wakeCallbacks.values()) cb({ state: null });
    for (const cb of this.killByProjectCallbacks.values()) cb(0);
    for (const cb of this.projectStatsCallbacks.values())
      cb({ terminalCount: 0, processIds: [], terminalTypes: {} });
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
    this.wakeCallbacks.clear();
    this.killByProjectCallbacks.clear();
    this.projectStatsCallbacks.clear();
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
