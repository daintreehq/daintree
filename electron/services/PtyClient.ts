/**
 * PtyClient - Main process orchestrator for terminal management.
 *
 * @pattern Dependency Injection via main.ts (Pattern B)
 *
 * Acts as a drop-in replacement for PtyManager in the Main process. Forwards
 * all operations to the Pty Host (UtilityProcess) via IPC, keeping the Main
 * thread responsive.
 *
 * Architecture (post-#6690 split):
 * - {@link PtyHostLifecycle} (`pty/PtyHostLifecycle.ts`) — UtilityProcess fork,
 *   exit handling, restart backoff, child-process-gone race, host log
 *   forwarding, and `readyPromise` lifecycle.
 * - {@link PtyHealthWatchdog} (`pty/PtyHealthWatchdog.ts`) — heartbeat watchdog,
 *   sleep/wake handshake, RTT observability.
 * - {@link routeHostEvent} (`pty/PtyEventRouter.ts`) — pure-function router for
 *   transport-level host events. Eliminates `event as any` casts via the
 *   {@link PtyHostResponseEvent} sub-union.
 * - {@link bridgePtyEvent} (`pty/PtyEventsBridge.ts`) — domain event bridge to
 *   the internal event bus. Called first by the router.
 * - {@link RequestResponseBroker} — request/response correlation.
 *
 * PtyClient itself owns the cross-cutting business state (broker, pending
 * spawns/kills, MessagePort plumbing, project context, log-level overrides)
 * and the public API.
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

import { MessagePortMain } from "electron";
import { EventEmitter } from "events";
import path from "path";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";
import { createLogger, isValidLogOverrideLevel } from "../utils/logger.js";
import { store } from "../store.js";

const logger = createLogger("main:PtyClient");
const logInfo = (msg: string, ctx?: Record<string, unknown>) =>
  ctx ? logger.info(msg, ctx) : logger.info(msg);
const logWarn = (msg: string, ctx?: Record<string, unknown>) =>
  ctx ? logger.warn(msg, ctx) : logger.warn(msg);
import { getTrashedPidTracker } from "./TrashedPidTracker.js";
import { RequestResponseBroker, BrokerError } from "./rpc/index.js";
import { routeHostEvent, type PtyEventRouterDeps } from "./pty/PtyEventRouter.js";
import { PtyHealthWatchdog } from "./pty/PtyHealthWatchdog.js";
import { PtyHostLifecycle } from "./pty/PtyHostLifecycle.js";
import type {
  PtyHostRequest,
  PtyHostEvent,
  PtyHostSpawnOptions,
  PtyHostActivityTier,
  CrashType,
  SpawnResult,
} from "../../shared/types/pty-host.js";
import type { TerminalSnapshot } from "./PtyManager.js";
import type { AgentStateChangeTrigger } from "../types/index.js";
import type { AgentState, AgentId } from "../../shared/types/agent.js";
import type { PanelKind } from "../../shared/types/panel.js";
import type { ResourceProfile } from "../../shared/types/resourceProfile.js";
import type { BuiltInAgentId } from "../../shared/config/agentIds.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface TerminalInfoResponse {
  id: string;
  projectId?: string;
  kind?: PanelKind;
  launchAgentId?: AgentId;
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
  agentPresetId?: string;
  agentPresetColor?: string;
  originalAgentPresetId?: string;
  /** Set once on first runtime agent detection; never cleared. Sticky across agent exit/re-enter within session. */
  everDetectedAgent?: boolean;
  /** Runtime-detected agent identity (cleared when the agent exits). */
  detectedAgentId?: BuiltInAgentId;
  /** Runtime-detected non-agent process icon id (npm, yarn, etc.). Cleared when the process exits. */
  detectedProcessId?: string;
  /** Capability mode — sealed-at-spawn agent capability surface. Set when the terminal was cold-launched as a built-in agent. */
  capabilityAgentId?: BuiltInAgentId;
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

const MAX_MISSED_HEARTBEATS = 3;

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
 * Read and sanitize the persisted log-level override map. Invalid values are
 * dropped — the stored payload is `Record<string, string>` but user edits to
 * the config file could leave it in an unknown state, so we defensively
 * filter before seeding the cache.
 */
function readPersistedOverrides(): Record<string, string> {
  try {
    const raw = store.get("logLevelOverrides") ?? {};
    const clean: Record<string, string> = {};
    for (const [key, value] of Object.entries(raw)) {
      if (typeof key === "string" && key && isValidLogOverrideLevel(value)) {
        clean[key] = value as string;
      }
    }
    return clean;
  } catch {
    return {};
  }
}

export class PtyClient extends EventEmitter {
  private config: Required<PtyClientConfig>;
  private isDisposed = false;
  private readonly lifecycle: PtyHostLifecycle;
  private readonly healthWatchdog: PtyHealthWatchdog;
  private readonly routerDeps: PtyEventRouterDeps;

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

  /** Unified request/response broker for all async operations */
  private broker = new RequestResponseBroker({
    defaultTimeoutMs: 5000,
    idPrefix: "pty",
    onTimeout: (requestId, method) => {
      console.warn(`[PtyClient] Request timeout: ${method ? `${method} ` : ""}(${requestId})`);
    },
  });

  /** Callback to notify renderer when MessagePort needs to be refreshed */
  private onPortRefresh: (() => void) | null = null;

  /** Cached log-level overrides. Replayed on every host spawn/restart via the
   * `ready` event, which is the first moment the child's message listener is
   * attached (push-on-spawn would race and silently drop the first message).
   * Seeded from the persisted store so boot-time host spawns inherit the
   * user's saved configuration without waiting for renderer IPC. */
  private logLevelOverridesCache: Record<string, string> = readPersistedOverrides();

  constructor(config: PtyClientConfig = {}) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };

    // SharedArrayBuffer cannot be sent to Electron UtilityProcess via postMessage
    // ("An object could not be cloned"). This is a Chromium structured clone limitation
    // that affects all platforms. Use IPC fallback for terminal I/O.
    console.log("[PtyClient] Using IPC mode (SharedArrayBuffer not supported in UtilityProcess)");

    const electronDir = path.basename(__dirname) === "chunks" ? path.dirname(__dirname) : __dirname;

    this.healthWatchdog = new PtyHealthWatchdog({
      intervalMs: this.config.healthCheckIntervalMs,
      maxMissedHeartbeats: MAX_MISSED_HEARTBEATS,
      getChild: () => this.lifecycle.child,
      isHostInitialized: () => this.lifecycle.isInitialized,
      send: (request) => this.send(request),
      emitCrashDetails: (payload) => {
        this.emit("host-crash-details", payload);
      },
    });

    this.lifecycle = new PtyHostLifecycle(
      {
        maxRestartAttempts: this.config.maxRestartAttempts,
        memoryLimitMb: this.config.memoryLimitMb,
        electronDir,
      },
      {
        onMessage: (event) => this.handleHostEvent(event),
        onExitSync: ({ wasReady: _wasReady, fallbackCrashType }) => {
          this.healthWatchdog.stop();
          if (this.isDisposed) {
            return;
          }
          this.cleanupOrphanedPtys(fallbackCrashType);
          this.broker.clear(new BrokerError("HOST_EXITED", "Pty host exited"));
          this.shouldResyncProjectContext = true;
        },
        onCrashClassified: ({ crashType, payload }) => {
          this.cleanupOrphanedPtys(crashType);
          if (payload) {
            this.emit("host-crash-details", payload);
          }
        },
        onMaxRestartsReached: (code) => {
          this.emit("host-crash", code);
        },
        onForkFailed: () => {
          this.emit("host-crash", -1);
        },
        onBeforeRestart: () => {
          this.needsRespawn = true;
        },
        isDisposed: () => this.isDisposed,
        logInfo: (message) => logInfo(message),
        logWarn: (message) => logWarn(message),
      }
    );

    this.routerDeps = {
      isDisposed: () => this.isDisposed,
      broker: this.broker,
      emitter: this,
      state: {
        pendingSpawns: this.pendingSpawns,
        pendingKillCount: this.pendingKillCount,
        terminalPids: this.terminalPids,
      },
      callbacks: {
        onReady: () => this.handleReady(),
        onPong: () => this.healthWatchdog.recordPong(),
        onTerminalRemovedFromTrash: (id) => getTrashedPidTracker().removeTrashed(id),
      },
      logWarn: (message) => console.warn(message),
    };

    this.lifecycle.start();

    console.log("[PtyClient] Pty Host started");
  }

  /** Wait for the host to be ready */
  async waitForReady(): Promise<void> {
    return this.lifecycle.waitForReady();
  }

  private handleHostEvent(event: PtyHostEvent): void {
    routeHostEvent(event, this.routerDeps);
  }

  private handleReady(): void {
    if (!this.lifecycle.markReady()) {
      console.warn("[PtyClient] Ignoring late ready event - host is dead");
      return;
    }
    console.log("[PtyClient] Pty Host is ready");
    // Replay log-level overrides on every ready (initial spawn + restarts).
    // The child's message listener isn't attached until after it receives
    // "ready", so pushing on spawn would race.
    this.send({
      type: "set-log-level-overrides",
      overrides: this.logLevelOverridesCache,
    });
    // Re-arm the watchdog on every successful ready — covers both the initial
    // boot and every auto-restart cycle. The original code armed it inside
    // startHost() before ready arrived, but the tick was a no-op until
    // isInitialized=true anyway, so deferring to ready is equivalent and
    // avoids a leaked timer when fork itself fails.
    if (!this.healthWatchdog.isHealthCheckPaused) {
      this.healthWatchdog.start();
    }
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
  }

  private send(request: PtyHostRequest): void {
    this.lifecycle.postMessage(request);
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

  /**
   * Update the cached log-level overrides and push immediately if the host is
   * ready. On every subsequent restart the cached map is replayed via the
   * `ready` handler — callers don't need to track restarts themselves.
   */
  setLogLevelOverrides(overrides: Record<string, string>): void {
    this.logLevelOverridesCache = { ...overrides };
    if (this.lifecycle.isInitialized && this.lifecycle.child) {
      this.send({ type: "set-log-level-overrides", overrides: this.logLevelOverridesCache });
    }
  }

  private flushPendingMessagePorts(): void {
    if (!this.lifecycle.child || this.pendingMessagePorts.size === 0) {
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

    if (!this.lifecycle.child) {
      console.warn("[PtyClient] Cannot connect MessagePort - host not running, will retry");
      this.pendingMessagePorts.set(windowId, port);
      return;
    }

    try {
      this.lifecycle.child.postMessage({ type: "connect-port", windowId }, [port]);
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
      "shift+tab": "[Z",
      esc: "",
      escape: "",
      backspace: "",
      delete: "[3~",
      insert: "[2~",
      home: "[H",
      end: "[F",
      pageup: "[5~",
      pagedown: "[6~",
      up: "[A",
      down: "[B",
      right: "[C",
      left: "[D",
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
      return `${rest}`;
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

  /**
   * Fan one data payload to every id in a single pty-host message. Used by
   * fleet broadcast: every keystroke becomes one main→host message instead
   * of N renderer→main IPC hops, cutting fan-out latency on large fleets.
   */
  broadcastWrite(ids: string[], data: string): void {
    if (!Array.isArray(ids) || ids.length === 0 || typeof data !== "string" || data.length === 0)
      return;
    const validIds = ids.filter((id) => typeof id === "string" && id.length > 0);
    if (validIds.length === 0) return;
    this.send({ type: "broadcast-write", ids: validIds, data });
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
    void getTrashedPidTracker()
      .persistTrashed(id, this.terminalPids.get(id))
      .catch((err) => {
        console.warn("[PtyClient] persistTrashed failed:", err);
      });
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
    if (!this.lifecycle.child) {
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

    if (!this.lifecycle.child) {
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

    if (!this.lifecycle.child) {
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
      if (error instanceof BrokerError || !this.lifecycle.child || this.isDisposed) {
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

  /**
   * Scan every terminal's semantic buffer for `query` and return one
   * ANSI-stripped snippet per matching terminal. Substring (case-insensitive)
   * unless `isRegex` is true. Returns an empty array on regex compile error
   * or IPC failure — UI never throws on bad input.
   */
  async searchSemanticBuffersAsync(
    query: string,
    isRegex: boolean
  ): Promise<import("../../shared/types/ipc/terminal.js").SemanticSearchMatch[]> {
    const requestId = this.broker.generateId("semantic-search");
    const promise =
      this.broker.register<import("../../shared/types/ipc/terminal.js").SemanticSearchMatch[]>(
        requestId
      );
    this.send({ type: "search-semantic-buffers", query, isRegex, requestId });
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
    this.healthWatchdog.pause();
  }

  /** Resume health check after system wake with handshake verification */
  resumeHealthCheck(): void {
    this.healthWatchdog.resume();
  }

  manualRestart(): void {
    this.lifecycle.manualRestart();
  }

  dispose(): void {
    if (this.isDisposed) return;
    this.isDisposed = true;
    this.shouldResyncProjectContext = false;
    this.needsRespawn = false;

    getTrashedPidTracker().clearAll();
    console.log("[PtyClient] Disposing...");

    this.healthWatchdog.dispose();
    this.lifecycle.dispose();

    for (const port of this.pendingMessagePorts.values()) {
      try {
        port.close();
      } catch {
        // ignore
      }
    }
    this.pendingMessagePorts.clear();

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
    return this.lifecycle.isRunning();
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
