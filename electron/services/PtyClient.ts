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

import { utilityProcess, UtilityProcess, app, MessagePortMain } from "electron";
import { EventEmitter } from "events";
import path from "path";
import os from "os";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";
import { performance } from "node:perf_hooks";
import { logInfo, logWarn } from "../utils/logger.js";
import { getTrashedPidTracker } from "./TrashedPidTracker.js";
import { RequestResponseBroker, BrokerError } from "./rpc/index.js";
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
  TerminalResourceBatchPayload,
} from "../../shared/types/pty-host.js";
import type { TerminalSnapshot } from "./PtyManager.js";
import type { AgentStateChangeTrigger } from "../types/index.js";
import type { AgentState, AgentId } from "../../shared/types/agent.js";
import type { TerminalType, PanelKind } from "../../shared/types/panel.js";
import type { ResourceProfile } from "../../shared/types/resourceProfile.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface TerminalInfoResponse {
  id: string;
  projectId?: string;
  kind?: PanelKind;
  type?: TerminalType;
  agentId?: AgentId;
  title?: string;
  cwd: string;
  worktreeId?: string;
  agentState?: AgentState;
  waitingReason?: string;
  lastStateChange?: number;
  spawnedAt: number;
  isTrashed?: boolean;
  trashExpiresAt?: number;
  activityTier?: "active" | "background";
  /** Whether this terminal has an active PTY process (false for orphaned terminals that exited) */
  hasPty?: boolean;
  agentSessionId?: string;
  agentLaunchFlags?: string[];
  agentModelId?: string;
}

export interface PtyClientConfig {
  /** Maximum restart attempts before giving up */
  maxRestartAttempts?: number;
  /** Health check interval in milliseconds */
  healthCheckIntervalMs?: number;
  /** Whether to show dialog on crash */
  showCrashDialog?: boolean;
  /** Memory limit in MB for PTY Host process (default: 512) */
  memoryLimitMb?: number;
}

const DEFAULT_CONFIG: Required<PtyClientConfig> = {
  maxRestartAttempts: 3,
  healthCheckIntervalMs: 30000,
  showCrashDialog: true,
  memoryLimitMb: 512,
};

/**
 * Centralized per-operation timeout policy for PTY host RPC calls.
 * Keys are logical method labels forwarded to the broker's onTimeout hook
 * so timeouts can be attributed to specific operations in logs and metrics.
 */
const PTY_TIMEOUTS = {
  "graceful-kill": 5000,
  "graceful-kill-by-project": 10000,
  "kill-by-project": 10000,
  "get-serialized-state": 15000,
  "get-snapshot": 5000,
  "get-all-snapshots": 5000,
  "transition-state": 5000,
} as const satisfies Record<string, number>;

/**
 * Map an authoritative `child-process-gone` reason (Electron 37+) to our CrashType.
 * Used when `app.on("child-process-gone")` fires for the PTY host — the reason
 * string is more reliable than the exit code heuristic in `classifyCrash()`.
 */
function mapGoneReasonToCrashType(reason: string): CrashType {
  switch (reason) {
    case "oom":
    case "memory-eviction":
      return "OUT_OF_MEMORY";
    case "killed":
      return "SIGNAL_TERMINATED";
    case "clean-exit":
      return "CLEAN_EXIT";
    case "crashed":
    case "abnormal-exit":
    case "launch-failed":
    case "integrity-failure":
    default:
      return "UNKNOWN_CRASH";
  }
}

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

const RTT_BUFFER_SIZE = 20;
const RTT_LOG_EVERY_N_SAMPLES = 10;
const RTT_LOG_INTERVAL_MS = 5 * 60 * 1000;
const RTT_WARN_THRESHOLD_MS = 5000;

function rttPercentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (p <= 0) return sorted[0];
  if (p >= 1) return sorted[sorted.length - 1];
  const idx = p * (sorted.length - 1);
  const low = Math.floor(idx);
  const high = Math.ceil(idx);
  if (low === high) return sorted[low];
  const frac = idx - low;
  return sorted[low] * (1 - frac) + sorted[high] * frac;
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
  private ipcDataMirrorIds = new Set<string>();
  private pendingKillCount: Map<string, number> = new Map();
  private needsRespawn = false;
  private activeProjectId: string | null = null;
  private windowProjectContexts = new Map<
    number,
    { projectId: string | null; projectPath?: string; mode: "active" | "switch" }
  >();
  private shouldResyncProjectContext = false;
  private pendingMessagePorts = new Map<number, MessagePortMain>();
  private terminalPids: Map<string, number> = new Map();
  private resourceMonitoringEnabled = false;
  private sessionPersistSuppressed = false;

  /** Watchdog: Track missed heartbeat responses to detect deadlocks */
  private missedHeartbeats = 0;
  private readonly MAX_MISSED_HEARTBEATS = 3;

  /**
   * Cap on pendingSpawns to prevent restart-storm amplification. If the host
   * crashes during spawn and respawnPending() replays the map, an unbounded map
   * lets the next crash grow the replay burst. Capping admission keeps the
   * respawn fan-out bounded under repeated crashes.
   */
  private readonly MAX_PENDING_SPAWNS = 250;

  /**
   * Cap on pendingKillCount to prevent unbounded growth after repeated host
   * crashes. Entries are decremented via "exit" events; if the host crashes
   * before emitting them, entries persist. 2x MAX_PENDING_SPAWNS since kills
   * are fire-and-forget IPC messages with no replay cost.
   */
  private readonly MAX_PENDING_KILLS = 500;

  /** RTT observability: timestamp of the in-flight health-check ping, or null if none. */
  private lastPingTime: number | null = null;
  private rttSamples: number[] = [];
  private rttSamplesSinceLastLog = 0;
  private lastRttLogTime = 0;

  /** Unified request/response broker for all async operations */
  private broker = new RequestResponseBroker({
    defaultTimeoutMs: 5000,
    idPrefix: "pty",
    onTimeout: (requestId, method) => {
      console.warn(`[PtyClient] Request timeout: ${method ? `${method} ` : ""}(${requestId})`);
    },
  });

  private readyPromise: Promise<void>;
  private readyResolve: (() => void) | null = null;
  private readyReject: ((error: Error) => void) | null = null;

  /** Callback to notify renderer when MessagePort needs to be refreshed */
  private onPortRefresh: (() => void) | null = null;

  private hostStdoutBuffer = "";
  private hostStderrBuffer = "";

  /**
   * Authoritative crash reason captured from `app.on("child-process-gone")`.
   * Consumed by the next `exit` handler via `setImmediate` deferral, since
   * Electron 37-41 has a documented race where `exit` often fires before
   * `child-process-gone` for utility-process crashes.
   */
  private pendingChildProcessGoneReason: { reason: string; exitCode: number } | null = null;
  /** Stored handler reference so dispose() can deregister via app.off(). */
  private childProcessGoneHandler:
    | ((event: Electron.Event, details: Electron.Details) => void)
    | null = null;

  constructor(config: PtyClientConfig = {}) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };

    // Create ready promise that resolves when host is ready or rejects on failure
    this.readyPromise = new Promise((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });

    // SharedArrayBuffer cannot be sent to Electron UtilityProcess via postMessage
    // ("An object could not be cloned"). This is a Chromium structured clone limitation
    // that affects all platforms. Use IPC fallback for terminal I/O.
    console.log("[PtyClient] Using IPC mode (SharedArrayBuffer not supported in UtilityProcess)");

    this.registerChildProcessGoneListener();
    this.startHost();
  }

  /**
   * Register a single app-level listener for `child-process-gone`, scoped to
   * our PTY host by `type === "Utility"` and `name === "daintree-pty-host"`.
   * The handler only records the authoritative reason; the `exit` handler
   * consumes it via `setImmediate` deferral to handle the Electron 37-41 race
   * where `exit` can fire before `child-process-gone`.
   */
  private registerChildProcessGoneListener(): void {
    if (this.childProcessGoneHandler) return;
    const handler = (_event: Electron.Event, details: Electron.Details): void => {
      if (this.isDisposed) return;
      if (details.type !== "Utility") return;
      // Electron 41 populates `name` from `serviceName` at runtime, but both
      // fields are typed as optional. Accept either to stay resilient to
      // future runtime changes or edge cases where only one is set.
      const matchesHost =
        details.name === "daintree-pty-host" || details.serviceName === "daintree-pty-host";
      if (!matchesHost) return;
      this.pendingChildProcessGoneReason = {
        reason: details.reason,
        exitCode: details.exitCode,
      };
    };
    this.childProcessGoneHandler = handler;
    app.on("child-process-gone", handler);
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

    // Defensive: clear any stale crash reason from a prior host cycle. Under
    // normal flow the `exit` handler's setImmediate consumes this, but a missed
    // exit event (or out-of-band listener fire) would otherwise leak into the
    // next crash.
    this.pendingChildProcessGoneReason = null;

    // Reset initialization state for restart
    this.isInitialized = false;
    this.readyPromise = new Promise((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });

    const electronDir = path.basename(__dirname) === "chunks" ? path.dirname(__dirname) : __dirname;
    const hostPath = path.join(electronDir, "pty-host-bootstrap.js");

    console.log(`[PtyClient] Starting Pty Host from: ${hostPath}`);

    try {
      this.child = utilityProcess.fork(hostPath, [], {
        serviceName: "daintree-pty-host",
        stdio: "pipe",
        cwd: os.homedir(),
        execArgv: [`--max-old-space-size=${this.config.memoryLimitMb}`],
        env: {
          ...(process.env as Record<string, string>),
          DAINTREE_USER_DATA: app.getPath("userData"),
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

    this.child.on("exit", (code) => {
      this.flushHostOutputBuffers();
      // Note: UtilityProcess exit event doesn't provide signal, but we can infer from code
      const signal = code !== null && code > 128 ? `SIG${code - 128}` : null;
      const fallbackCrashType = classifyCrash(code, signal);

      // Clear health check
      if (this.healthCheckInterval) {
        clearInterval(this.healthCheckInterval);
        this.healthCheckInterval = null;
      }
      this.lastPingTime = null;
      this.rttSamples = [];
      this.rttSamplesSinceLastLog = 0;
      this.lastRttLogTime = 0;

      // Reject ready promise if host exited before becoming ready
      const wasReady = this.isInitialized;
      this.isInitialized = false;
      this.child = null; // Prevent posting to dead process

      if (this.isDisposed) {
        // Expected shutdown - drop any buffered reason so it can't leak.
        this.pendingChildProcessGoneReason = null;
        return;
      }

      // If host crashed before ready, reject the promise so startup doesn't hang
      if (!wasReady && this.readyReject) {
        this.readyReject(new Error("PTY host exited before ready"));
        this.readyResolve = null;
        this.readyReject = null;
      }

      this.cleanupOrphanedPtys(fallbackCrashType);

      this.broker.clear(new BrokerError("HOST_EXITED", "Pty host exited"));
      this.shouldResyncProjectContext = true;

      // Electron 37-41 race: `exit` often fires before `child-process-gone`
      // for utility-process crashes. Defer crash classification by one event
      // loop tick so the authoritative reason can arrive; fall back to the
      // exit-code heuristic when no reason was captured in time.
      setImmediate(() => {
        if (this.isDisposed) {
          this.pendingChildProcessGoneReason = null;
          return;
        }

        const gone = this.pendingChildProcessGoneReason;
        this.pendingChildProcessGoneReason = null;
        const crashType: CrashType = gone
          ? mapGoneReasonToCrashType(gone.reason)
          : fallbackCrashType;
        // Prefer the authoritative exit code from `child-process-gone` over the
        // (sometimes unreliable) one from `exit` — Electron 40-41 has a known
        // signed/unsigned mangling bug on Windows for the exit event.
        const reportedCode = gone ? gone.exitCode : code;

        console.error(
          `[PtyClient] Pty Host exited with code ${reportedCode}` +
            (crashType !== "CLEAN_EXIT" ? ` (${crashType})` : "")
        );

        this.cleanupOrphanedPtys(crashType);

        // Emit crash payload with classification for downstream consumers
        if (crashType !== "CLEAN_EXIT") {
          const crashPayload: HostCrashPayload = {
            code: reportedCode,
            // When we have an authoritative reason, trust it and clear the
            // derived-from-exit-code signal string.
            signal: gone ? null : signal,
            crashType,
            timestamp: Date.now(),
          };
          this.emit("host-crash-details", crashPayload);
        }

        // If `manualRestart()` already spawned a new host during the defer
        // window (possible via the renderer TERMINAL_RESTART_SERVICE IPC call),
        // don't schedule a second auto-restart — it would orphan that host.
        if (this.child !== null) return;

        // Try to restart
        if (this.restartAttempts < this.config.maxRestartAttempts) {
          this.restartAttempts++;
          // Full jitter with floor: break deterministic retry lockstep while
          // keeping a minimum wait so instant-fail crashes don't spin the CPU.
          const cap = Math.min(1000 * Math.pow(2, this.restartAttempts), 10000);
          const floor = 100;
          const delay = floor + Math.floor(Math.random() * Math.max(0, cap - floor));
          console.log(
            `[PtyClient] Restarting Host in ${delay}ms (attempt ${this.restartAttempts}/${this.config.maxRestartAttempts})`
          );

          if (this.restartTimer) {
            clearTimeout(this.restartTimer);
          }
          this.restartTimer = setTimeout(() => {
            this.restartTimer = null;
            if (this.isDisposed || this.child !== null) return;
            this.needsRespawn = true;
            this.startHost();
          }, delay);
        } else {
          console.error("[PtyClient] Max restart attempts reached, giving up");
          this.emit("host-crash", reportedCode);
        }
      });
    });

    // Start health check with watchdog (only if not paused by system sleep)
    if (!this.isHealthCheckPaused) {
      this.startHealthCheckInterval();
    }

    console.log("[PtyClient] Pty Host started");
  }

  private handleHostEvent(event: PtyHostEvent): void {
    // Skip processing if disposed to avoid sending to destroyed renderer frames
    if (this.isDisposed) {
      return;
    }

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
      case "ready": {
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
        const pendingPortWindowIds = new Set(this.pendingMessagePorts.keys());
        this.flushPendingMessagePorts();
        if (this.shouldResyncProjectContext) {
          this.shouldResyncProjectContext = false;
          this.syncProjectContext(pendingPortWindowIds);
        }
        break;
      }

      case "data":
        this.emit("data", event.id, event.data);
        break;

      case "exit": {
        getTrashedPidTracker().removeTrashed(event.id);
        const killCount = this.pendingKillCount.get(event.id) ?? 0;
        if (killCount > 0) {
          // Exit from a kill() call — a new spawn() may have already
          // re-registered this id; don't clear pendingSpawns.
          const remaining = killCount - 1;
          if (remaining > 0) {
            this.pendingKillCount.set(event.id, remaining);
          } else {
            this.pendingKillCount.delete(event.id);
          }
        } else {
          // Normal exit (process ended on its own)
          this.pendingSpawns.delete(event.id);
        }
        this.terminalPids.delete(event.id);
        this.emit("exit", event.id, event.exitCode);
        break;
      }

      case "error":
        this.emit("error", event.id, event.error);
        break;

      case "snapshot":
        this.broker.resolve(event.requestId, (event.snapshot ?? null) as TerminalSnapshot | null);
        break;

      case "all-snapshots":
        this.broker.resolve(event.requestId, (event.snapshots ?? []) as TerminalSnapshot[]);
        break;

      case "transition-result":
        this.broker.resolve(event.requestId, event.success);
        break;

      case "pong":
        this.missedHeartbeats = 0;
        if (this.lastPingTime !== null) {
          const now = performance.now();
          const rtt = now - this.lastPingTime;
          this.lastPingTime = null;
          this.recordRtt(rtt, now);
        }
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

      case "graceful-kill-result": {
        const gkEvent = event as {
          type: "graceful-kill-result";
          requestId: string;
          id: string;
          agentSessionId: string | null;
        };
        this.broker.resolve(gkEvent.requestId, gkEvent.agentSessionId ?? null);
        break;
      }

      case "graceful-kill-by-project-result": {
        const gkpEvent = event as {
          type: "graceful-kill-by-project-result";
          requestId: string;
          results: Array<{ id: string; agentSessionId: string | null }>;
        };
        this.broker.resolve(gkpEvent.requestId, gkpEvent.results ?? []);
        break;
      }

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

      case "resource-metrics": {
        const rmEvent = event as {
          type: "resource-metrics";
          metrics: TerminalResourceBatchPayload;
          timestamp: number;
        };
        this.emit("resource-metrics", rmEvent.metrics, rmEvent.timestamp);
        break;
      }

      default:
        console.warn("[PtyClient] Unknown event type:", (event as { type: string }).type);
    }
  }

  private recordRtt(rtt: number, now: number): void {
    this.rttSamples.push(rtt);
    if (this.rttSamples.length > RTT_BUFFER_SIZE) {
      this.rttSamples.shift();
    }
    this.rttSamplesSinceLastLog++;

    if (rtt > RTT_WARN_THRESHOLD_MS) {
      console.warn(
        `[PtyClient] Heartbeat RTT spike: ${rtt.toFixed(1)}ms (> ${RTT_WARN_THRESHOLD_MS}ms)`
      );
    }

    const countTrigger = this.rttSamplesSinceLastLog >= RTT_LOG_EVERY_N_SAMPLES;
    const timeTrigger = now - this.lastRttLogTime >= RTT_LOG_INTERVAL_MS;
    if (!countTrigger && !timeTrigger) return;

    const sorted = [...this.rttSamples].sort((a, b) => a - b);
    const p50 = rttPercentile(sorted, 0.5);
    const p95 = rttPercentile(sorted, 0.95);
    const p99 = rttPercentile(sorted, 0.99);
    const max = sorted[sorted.length - 1] ?? 0;
    console.log(
      `[PtyClient] Heartbeat RTT (last ${sorted.length}): p50=${p50.toFixed(1)}ms p95=${p95.toFixed(1)}ms p99=${p99.toFixed(1)}ms max=${max.toFixed(1)}ms samples=${this.rttSamplesSinceLastLog}`
    );
    this.rttSamplesSinceLastLog = 0;
    this.lastRttLogTime = now;
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
    // Kills sent to the crashed host will never receive "exit" events, so
    // pendingKillCount entries from that session are permanently stale.
    // Unlike pendingSpawns (replayed below to recreate terminals on the new
    // host), pendingKillCount is cleared — the terminals those kills targeted
    // died with the host process.
    this.pendingKillCount.clear();

    // Notify that ports need refresh after host restart
    if (this.onPortRefresh) {
      for (const port of this.pendingMessagePorts.values()) {
        try {
          port.close();
        } catch {
          // ignore
        }
      }
      this.pendingMessagePorts.clear();
      this.onPortRefresh();
    }

    // Respawn terminals that were active when host crashed
    for (const [id, options] of this.pendingSpawns) {
      console.log(`[PtyClient] Respawning terminal: ${id}`);
      this.send({ type: "spawn", id, options });
    }

    // Re-enable IPC data mirrors that were active before crash
    for (const id of this.ipcDataMirrorIds) {
      this.send({ type: "set-ipc-data-mirror", id, enabled: true });
    }

    // Re-enable resource monitoring if it was active
    if (this.resourceMonitoringEnabled) {
      this.send({ type: "set-resource-monitoring", enabled: true });
    }

    // Replay session persistence suppression if disk space was critical
    if (this.sessionPersistSuppressed) {
      this.send({ type: "set-session-persist-suppressed", suppressed: true });
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

      if (!killed && process.platform === "win32") {
        const result = spawnSync("taskkill", ["/T", "/F", "/PID", String(pid)], {
          windowsHide: true,
          stdio: "ignore",
          timeout: 3000,
        });
        if (result.status === 0 || result.status === 128) {
          killed = true;
        }
      }

      if (!killed) {
        try {
          process.kill(pid, "SIGKILL");
        } catch (error) {
          if (process.env.DAINTREE_VERBOSE) {
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

  private flushPendingMessagePorts(): void {
    if (!this.child || this.pendingMessagePorts.size === 0) {
      return;
    }

    const pending = new Map(this.pendingMessagePorts);
    this.pendingMessagePorts.clear();
    for (const [windowId, port] of pending) {
      this.connectMessagePort(windowId, port);
    }
  }

  /** Forward MessagePort to Pty Host for direct Renderer↔PtyHost communication */
  connectMessagePort(windowId: number, port: MessagePortMain): void {
    const existingPending = this.pendingMessagePorts.get(windowId);
    if (existingPending && existingPending !== port) {
      try {
        existingPending.close();
      } catch {
        // ignore
      }
      this.pendingMessagePorts.delete(windowId);
    }

    if (!this.child) {
      console.warn("[PtyClient] Cannot connect MessagePort - host not running, will retry");
      this.pendingMessagePorts.set(windowId, port);
      return;
    }

    try {
      this.child.postMessage({ type: "connect-port", windowId }, [port]);
      if (process.env.DAINTREE_VERBOSE) {
        console.log(`[PtyClient] MessagePort forwarded to Pty Host for window ${windowId}`);
      }
      // Re-send project context for this window (handles page reload case where
      // disconnectWindow in the host clears windowProjectMap on port-replace)
      const ctx = this.windowProjectContexts.get(windowId);
      if (ctx) {
        if (ctx.mode === "switch" && ctx.projectId !== null) {
          this.send({
            type: "project-switch",
            windowId,
            projectId: ctx.projectId,
            ...(ctx.projectPath ? { projectPath: ctx.projectPath } : {}),
          });
        } else {
          this.send({
            type: "set-active-project",
            windowId,
            projectId: ctx.projectId,
            ...(ctx.projectPath ? { projectPath: ctx.projectPath } : {}),
          });
        }
      }
    } catch (error) {
      console.error("[PtyClient] Failed to forward MessagePort to Pty Host:", error);
      this.pendingMessagePorts.set(windowId, port);
    }
  }

  /** Notify Pty Host that a window's MessagePort should be disconnected */
  disconnectMessagePort(windowId: number): void {
    this.pendingMessagePorts.delete(windowId);
    this.windowProjectContexts.delete(windowId);
    this.send({ type: "disconnect-port", windowId });
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
    if (!this.pendingSpawns.has(id) && this.pendingSpawns.size >= this.MAX_PENDING_SPAWNS) {
      logWarn(
        `[PtyClient] spawn rejected — pendingSpawns at cap (${this.MAX_PENDING_SPAWNS}), id=${id}`
      );
      const result: SpawnResult = {
        success: false,
        id,
        error: {
          code: "PENDING_SPAWNS_CAPPED",
          message: `Too many pending terminal spawns (cap ${this.MAX_PENDING_SPAWNS}); close some terminals and try again.`,
        },
      };
      this.emit("spawn-result", id, result);
      return;
    }

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

  /**
   * Fan out a double-Escape to each terminal. The per-PTY inter-escape
   * delay is scheduled inside the PTY host utility process so the 50ms
   * gap survives main-process IPC jitter (which can otherwise collapse two
   * sub-10ms writes into a single Meta-Escape).
   */
  batchDoubleEscape(ids: string[]): void {
    if (!Array.isArray(ids) || ids.length === 0) return;
    const validIds = ids.filter((id) => typeof id === "string" && id.length > 0);
    if (validIds.length === 0) return;
    this.send({ type: "batch-double-escape", ids: validIds });
  }

  resize(id: string, cols: number, rows: number): void {
    this.send({ type: "resize", id, cols, rows });
  }

  kill(id: string, reason?: string): void {
    getTrashedPidTracker().removeTrashed(id);
    const wasKnown = this.pendingSpawns.has(id);
    this.pendingSpawns.delete(id);
    this.ipcDataMirrorIds.delete(id);

    // Only track pendingKillCount for ids we've seen locally. An "exit"
    // decrement only arrives for terminals the host actually owned, so
    // tracking kills for unknown ids would leak cap slots permanently.
    //
    // Cap is SOFT: the primary defense against unbounded growth is the
    // clear-on-respawn in respawnPending(). Skipping tracking at cap would
    // allow a late "exit" for this id to hit the exit handler's else branch
    // and incorrectly delete a re-spawned entry for the same id (supported
    // by the hydration flow via `requestedId`). So at cap we log a warning
    // for observability but still track.
    if (wasKnown) {
      const current = this.pendingKillCount.get(id);
      if (current === undefined && this.pendingKillCount.size >= this.MAX_PENDING_KILLS) {
        logWarn(
          `[PtyClient] pendingKillCount exceeds soft cap (${this.MAX_PENDING_KILLS}), id=${id}`
        );
      }
      this.pendingKillCount.set(id, (current ?? 0) + 1);
    }
    // Always send the kill IPC. The host-side handler kills the terminal if
    // it exists and removes any persisted session state for the id.
    this.send({ type: "kill", id, reason });
  }

  /** Check if a terminal exists (based on local tracking) */
  hasTerminal(id: string): boolean {
    return this.pendingSpawns.has(id);
  }

  trash(id: string): void {
    getTrashedPidTracker().persistTrashed(id, this.terminalPids.get(id));
    this.send({ type: "trash", id });
  }

  /** Restore terminal from trash. Returns true if terminal was tracked. */
  restore(id: string): boolean {
    getTrashedPidTracker().removeTrashed(id);
    const wasTracked = this.pendingSpawns.has(id);
    this.send({ type: "restore", id });
    return wasTracked;
  }

  setActivityTier(id: string, tier: PtyHostActivityTier): void {
    this.send({ type: "set-activity-tier", id, tier });
  }

  setResourceMonitoring(enabled: boolean): void {
    this.resourceMonitoringEnabled = enabled;
    this.send({ type: "set-resource-monitoring", enabled });
  }

  setResourceProfile(profile: ResourceProfile): void {
    this.send({ type: "set-resource-profile", profile });
  }

  setProcessTreePollInterval(ms: number): void {
    this.send({ type: "set-process-tree-poll-interval", ms });
  }

  /**
   * Enable/disable IPC data mirroring for a terminal.
   * When enabled, PTY data is always sent via IPC in addition to SharedArrayBuffer,
   * allowing main-process consumers (like UrlDetector for dev preview) to receive data events.
   */
  setIpcDataMirror(id: string, enabled: boolean): void {
    if (enabled) {
      this.ipcDataMirrorIds.add(id);
    } else {
      this.ipcDataMirrorIds.delete(id);
    }
    this.send({ type: "set-ipc-data-mirror", id, enabled });
  }

  async wakeTerminal(id: string): Promise<{ state: string | null; warnings?: string[] }> {
    const requestId = this.broker.generateId(`wake-${id}`);
    const promise = this.broker.register<{ state: string | null; warnings?: string[] }>(requestId);
    this.send({ type: "wake-terminal", id, requestId });
    return promise.catch(() => ({ state: null }));
  }

  private syncProjectContext(skipWindowIds?: ReadonlySet<number>): void {
    if (!this.child) {
      this.shouldResyncProjectContext = true;
      return;
    }

    for (const [windowId, ctx] of this.windowProjectContexts) {
      if (skipWindowIds?.has(windowId)) {
        continue;
      }
      if (ctx.mode === "switch" && ctx.projectId !== null) {
        this.send({
          type: "project-switch",
          windowId,
          projectId: ctx.projectId,
          ...(ctx.projectPath ? { projectPath: ctx.projectPath } : {}),
        });
      } else {
        this.send({
          type: "set-active-project",
          windowId,
          projectId: ctx.projectId,
          ...(ctx.projectPath ? { projectPath: ctx.projectPath } : {}),
        });
      }
    }
  }

  setActiveProject(windowId: number, projectId: string | null, projectPath?: string): void {
    this.activeProjectId = projectId;
    this.windowProjectContexts.set(windowId, { projectId, projectPath, mode: "active" });

    if (!this.child) {
      this.shouldResyncProjectContext = true;
      return;
    }

    this.send({
      type: "set-active-project",
      windowId,
      projectId,
      ...(projectPath ? { projectPath } : {}),
    });
  }

  onProjectSwitch(windowId: number, projectId: string, projectPath?: string): void {
    this.activeProjectId = projectId;
    this.windowProjectContexts.set(windowId, { projectId, projectPath, mode: "switch" });

    if (!this.child) {
      this.shouldResyncProjectContext = true;
      return;
    }

    this.send({
      type: "project-switch",
      windowId,
      projectId,
      ...(projectPath ? { projectPath } : {}),
    });
  }

  async gracefulKill(id: string): Promise<string | null> {
    const requestId = this.broker.generateId(`graceful-kill-${id}`);
    const promise = this.broker.register<string | null>(requestId, {
      method: "graceful-kill",
      timeoutMs: PTY_TIMEOUTS["graceful-kill"],
    });
    this.send({ type: "graceful-kill", id, requestId });
    return promise.catch((error: unknown) => {
      // Sending a kill to a host that isn't there only mutates local bookkeeping.
      // Skip whenever the host is known to be gone — either because the broker
      // clear told us (typed BrokerError), or because we notice it ourselves
      // (null child or disposed client, e.g. restart pending, max restarts
      // exhausted, or app quit arriving during the 5s timeout window).
      if (error instanceof BrokerError || !this.child || this.isDisposed) {
        return null;
      }
      this.kill(id, "graceful-kill-timeout");
      return null;
    });
  }

  async gracefulKillByProject(
    projectId: string
  ): Promise<Array<{ id: string; agentSessionId: string | null }>> {
    const requestId = this.broker.generateId(`graceful-kill-by-project-${projectId}`);
    const promise = this.broker.register<Array<{ id: string; agentSessionId: string | null }>>(
      requestId,
      {
        method: "graceful-kill-by-project",
        timeoutMs: PTY_TIMEOUTS["graceful-kill-by-project"],
      }
    );
    this.send({ type: "graceful-kill-by-project", projectId, requestId });
    return promise.catch(() => []);
  }

  async killByProject(projectId: string): Promise<number> {
    const requestId = this.broker.generateId(`kill-by-project-${projectId}`);
    const promise = this.broker.register<number>(requestId, {
      method: "kill-by-project",
      timeoutMs: PTY_TIMEOUTS["kill-by-project"],
    });
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
    state: import("../../shared/types/agent.js").AgentState
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
    // Extended timeout for large terminals with lots of scrollback (see PTY_TIMEOUTS).
    const promise = this.broker.register<string | null>(requestId, {
      method: "get-serialized-state",
      timeoutMs: PTY_TIMEOUTS["get-serialized-state"],
    });
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
    const promise = this.broker.register<TerminalSnapshot | null>(requestId, {
      method: "get-snapshot",
      timeoutMs: PTY_TIMEOUTS["get-snapshot"],
    });
    this.send({ type: "get-snapshot", id, requestId });
    return promise.catch(() => null);
  }

  /** Get snapshots for all terminals (async due to IPC) */
  async getAllTerminalSnapshots(): Promise<TerminalSnapshot[]> {
    const requestId = this.broker.generateId("all-snapshots");
    const promise = this.broker.register<TerminalSnapshot[]>(requestId, {
      method: "get-all-snapshots",
      timeoutMs: PTY_TIMEOUTS["get-all-snapshots"],
    });
    this.send({ type: "get-all-snapshots", requestId });
    return promise.catch(() => []);
  }

  markChecked(id: string): void {
    this.send({ type: "mark-checked", id });
  }

  updateObservedTitle(id: string, title: string): void {
    this.send({ type: "update-observed-title", id, title });
  }

  async transitionState(
    id: string,
    event: { type: string; [key: string]: unknown },
    trigger: AgentStateChangeTrigger,
    confidence: number,
    spawnedAt?: number
  ): Promise<boolean> {
    const requestId = this.broker.generateId(`transition-${id}`);
    const promise = this.broker.register<boolean>(requestId, {
      method: "transition-state",
      timeoutMs: PTY_TIMEOUTS["transition-state"],
    });
    this.send({
      type: "transition-state",
      id,
      requestId,
      event,
      trigger,
      confidence,
      spawnedAt,
    });
    return promise.catch(() => false);
  }

  /** Request PtyHost to trim scrollback on all terminals to reduce memory */
  trimState(targetLines: number): void {
    this.send({ type: "trim-state", targetLines });
  }

  /** Suppress or resume terminal session persistence in the PtyHost */
  suppressSessionPersistence(suppressed: boolean): void {
    this.sessionPersistSuppressed = suppressed;
    this.send({ type: "set-session-persist-suppressed", suppressed });
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
    this.lastPingTime = null;
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
    this.lastPingTime = performance.now();
    this.send({ type: "health-check" });

    // Timeout if no response within 5 seconds - fall back to immediate start
    this.handshakeTimeout = setTimeout(() => {
      if (this.isWaitingForHandshake) {
        console.warn("[PtyClient] Handshake timeout - forcing health check resume");
        this.isWaitingForHandshake = false;
        this.handshakeTimeout = null;
        this.lastPingTime = null;
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
    this.lastRttLogTime = performance.now();

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
        this.lastPingTime = null;
        return;
      }

      // Increment counter - will be reset by 'pong' response
      this.missedHeartbeats++;
      this.lastPingTime = performance.now();
      this.send({ type: "health-check" });
    }, this.config.healthCheckIntervalMs);

    console.log("[PtyClient] Health check interval started (watchdog enabled)");
  }

  /** Handle project switch - forward to host */
  // Note: Project switching is now handled via onProjectSwitch(projectId) which
  // preserves the host and active terminals while changing filtering/backgrounding.

  manualRestart(): void {
    if (this.isDisposed) {
      console.warn("[PtyClient] Cannot manual restart - already disposed");
      return;
    }

    if (this.child !== null) {
      console.warn("[PtyClient] Cannot manual restart - host process already exists");
      return;
    }

    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }

    this.restartAttempts = 0;
    this.needsRespawn = true;

    console.log("[PtyClient] Manual restart initiated");
    this.startHost();
  }

  dispose(): void {
    if (this.isDisposed) return;
    this.isDisposed = true;
    this.shouldResyncProjectContext = false;
    this.needsRespawn = false;

    getTrashedPidTracker().clearAll();
    console.log("[PtyClient] Disposing...");

    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
    this.lastPingTime = null;

    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }

    if (this.handshakeTimeout) {
      clearTimeout(this.handshakeTimeout);
      this.handshakeTimeout = null;
    }
    this.isWaitingForHandshake = false;

    for (const port of this.pendingMessagePorts.values()) {
      try {
        port.close();
      } catch {
        // ignore
      }
    }
    this.pendingMessagePorts.clear();

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

    if (this.childProcessGoneHandler) {
      app.off("child-process-gone", this.childProcessGoneHandler);
      this.childProcessGoneHandler = null;
    }
    this.pendingChildProcessGoneReason = null;

    // Clean up all pending requests via broker (rejects pending promises with
    // "Broker disposed"; callers convert to sentinel values via .catch()).
    this.broker.dispose();

    this.pendingSpawns.clear();
    this.pendingKillCount.clear();
    this.windowProjectContexts.clear();
    this.ipcDataMirrorIds.clear();
    this.terminalPids.clear();
    this.removeAllListeners();

    console.log("[PtyClient] Disposed");
  }

  /** Check if host is running and initialized */
  isReady(): boolean {
    return this.isInitialized && this.child !== null;
  }

  /**
   * Get the SharedArrayBuffers for zero-copy terminal I/O (visual rendering).
   * Always returns empty — SharedArrayBuffer is not supported in Electron UtilityProcess.
   */
  getSharedBuffers(): {
    visualBuffers: SharedArrayBuffer[];
    signalBuffer: SharedArrayBuffer | null;
  } {
    return { visualBuffers: [], signalBuffer: null };
  }

  /**
   * Get the SharedArrayBuffer for semantic analysis (Web Worker).
   * Always returns null — SharedArrayBuffer is not supported in Electron UtilityProcess.
   */
  getAnalysisBuffer(): SharedArrayBuffer | null {
    return null;
  }

  /**
   * Check if SharedArrayBuffer-based I/O is enabled.
   * Always false — Electron UtilityProcess does not support SharedArrayBuffer transfer.
   */
  isSharedBufferEnabled(): boolean {
    return false;
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
