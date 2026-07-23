// eager-import-allow: reads pty config via store.get synchronously during client init
/**
 * PtyClient - Main process orchestrator for terminal management.
 *
 * @pattern Dependency Injection via main.ts (Pattern B)
 *
 * Acts as a drop-in replacement for PtyManager in the Main process. Forwards
 * all operations to the Pty Host (UtilityProcess) via IPC, keeping the Main
 * thread responsive.
 *
 * Fabric architecture: PtyClient is the router of the PTY fabric — a pool of
 * host shards ({@link PtyShard}), each a full pty-host UtilityProcess owning a
 * disjoint subset of terminals on its own event loop, heap, and resource
 * governor. With `DAINTREE_PTY_FABRIC` off (the default) there is exactly one
 * shard ("main") and behavior is byte-for-byte the legacy singleton host. With
 * the fabric on, each project gets its own shard: placement is per-project
 * (one project never spans shards), window MessagePorts route to the shard
 * owning the window's active project, and cross-shard invariants (memory
 * rollup, flow-control snapshots, host-throttle/memory-warning signals) are
 * aggregated here. PtyClient stays pure bookkeeping + port plumbing — terminal
 * bytes flow renderer↔shard directly over MessageChannelMain, never through
 * this class.
 *
 * Per-shard machinery (owned by each {@link PtyShard}):
 * - {@link PtyHostLifecycle} (`pty/PtyHostLifecycle.ts`) — UtilityProcess fork,
 *   exit handling, restart backoff, child-process-gone race, host log
 *   forwarding, and `readyPromise` lifecycle.
 * - {@link PtyHealthWatchdog} (`pty/PtyHealthWatchdog.ts`) — heartbeat watchdog,
 *   sleep/wake handshake, RTT observability.
 * - {@link RequestResponseBroker} — request/response correlation, per shard so
 *   a crashing shard rejects only its own pending requests.
 *
 * Shared routing plumbing:
 * - {@link routeHostEvent} (`pty/PtyEventRouter.ts`) — pure-function router for
 *   transport-level host events, invoked with per-shard deps.
 * - {@link bridgePtyEvent} (`pty/PtyEventsBridge.ts`) — domain event bridge to
 *   the internal event bus. Called first by the router.
 *
 * PtyClient itself owns the cross-shard business state (placement, terminal
 * ownership, pending spawns/kills, MessagePort routing, project context,
 * log-level overrides) and the public API.
 *
 * Why this pattern:
 * - Manages critical child processes (UtilityProcess) requiring explicit lifecycle control
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
import os from "os";
import path from "path";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";
import { createLogger, isValidLogOverrideLevel } from "../utils/logger.js";
import { store } from "../store.js";
import { getPluginAgentRegistry } from "../../shared/config/pluginAgentRegistry.js";

const logger = createLogger("main:PtyClient");
const logInfo = (msg: string, ctx?: Record<string, unknown>) =>
  ctx ? logger.info(msg, ctx) : logger.info(msg);
const logWarn = (msg: string, ctx?: Record<string, unknown>) =>
  ctx ? logger.warn(msg, ctx) : logger.warn(msg);
import { getTrashedPidTracker } from "./TrashedPidTracker.js";
import { helpSessionService } from "./HelpSessionService.js";
import { helpSessionJobService } from "./HelpSessionJobService.js";
import { getLifecycleLedger, ledgerFactsFromSpawnOptions } from "./pty/lifecycleLedger.js";
import { BrokerError } from "./rpc/index.js";
import { routeHostEvent, type PtyEventRouterDeps } from "./pty/PtyEventRouter.js";
import { sendPtyHostRpc } from "./pty/PtyHostRpcFacade.js";
import { mergeFlowControlSnapshots, mergeMemoryRollups } from "./pty/rollupMerge.js";
import { HostSignalAggregator, type HostMemoryWarningPayload } from "./pty/HostSignalAggregator.js";
import { ShardPlacementRouter } from "./pty/ShardPlacementRouter.js";
import { PtyShard } from "./pty/PtyShard.js";
import {
  DEFAULT_SHARD_KEY,
  PTY_SHARD_IDLE_LINGER_MS,
  isPtyFabricEnabled,
  maxProjectShards,
  shardHeapBudgetMb,
  shardServiceName,
} from "./pty/fabricConfig.js";
import type { PtyHealthWatchdog } from "./pty/PtyHealthWatchdog.js";
import type { PtyHostLifecycle } from "./pty/PtyHostLifecycle.js";
import type {
  PtyHostEvent,
  PtyHostSpawnOptions,
  PluginPtyHostSpawnOptions,
  PtyHostActivityTier,
  CrashType,
  SpawnResult,
  FlowControlSnapshot,
  HostThrottlePayload,
  MemoryRollup,
  GracefulKillResult,
  PtyHostWorkerGovernanceSnapshot,
} from "../../shared/types/pty-host.js";
import type { TerminalSnapshot } from "./PtyManager.js";
import type { AgentStateChangeTrigger } from "../types/index.js";
import type { AgentState, AgentId, WaitingReason } from "../../shared/types/agent.js";
import type { PanelKind, PanelTitleMode } from "../../shared/types/panel.js";
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
  /** Title ownership rung mirrored from the pty-host record. */
  titleMode?: PanelTitleMode;
  cwd: string;
  worktreeId?: string;
  agentState?: AgentState;
  waitingReason?: WaitingReason;
  lastStateChange?: number;
  lastInputTime?: number;
  lastOutputTime?: number;
  spawnedAt: number;
  isTrashed?: boolean;
  trashExpiresAt?: number;
  activityTier?: "active" | "background";
  /** Whether this terminal has an active PTY process (false for orphaned terminals that exited) */
  hasPty?: boolean;
  agentSessionId?: string;
  agentLaunchFlags?: string[];
  agentModelId?: string;
  /** Last non-useless OSC title observed from the agent — preferred over `title` for resume-record labels. */
  lastObservedTitle?: string;
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

/**
 * Result of {@link PtyClient.gracefulKillByProjectConfirmed}. `confirmed` is
 * false only when a live host timed out without acknowledging the kill — the
 * caller must NOT clear restoration state in that case, or still-running agents
 * are orphaned. On the confirmed path `sessions` holds one entry per terminal
 * (agentSessionId null for non-agents / unresumable terminals).
 */
export interface GracefulKillByProjectOutcome {
  confirmed: boolean;
  sessions: Array<{ id: string; agentSessionId: string | null }>;
}

export interface PtyClientConfig {
  /** Health check interval in milliseconds */
  healthCheckIntervalMs?: number;
  /** Whether to show dialog on crash */
  showCrashDialog?: boolean;
  /**
   * Memory limit in MB for PTY Host process (default: 512). Applies to the
   * legacy singleton path; with the PTY fabric enabled every shard instead
   * gets a RAM-scaled budget from {@link shardHeapBudgetMb}.
   */
  memoryLimitMb?: number;
  /**
   * When true the constructor wires up the host lifecycle but does NOT fork the
   * PTY host. The caller forks it later via {@link PtyClient.start} once its
   * prerequisites are met — for the app boot path that is the early PATH
   * refresh (#8625), deferred so the host fork no longer blocks the first
   * renderer load (#8827). Defaults to false so every other caller keeps the
   * construct-and-fork behavior.
   */
  deferStart?: boolean;
  /**
   * Force the PTY fabric (per-project host shards) on or off, overriding the
   * DAINTREE_PTY_FABRIC environment flag. Primarily a test hook.
   */
  fabric?: boolean;
  /** Override the concurrent project-shard cap. Primarily a test hook. */
  maxProjectShards?: number;
}

type ResolvedPtyClientConfig = Required<Omit<PtyClientConfig, "fabric" | "maxProjectShards">>;

const DEFAULT_CONFIG: ResolvedPtyClientConfig = {
  // 5s heartbeat. Watchdog checks the missed-pong count before incrementing,
  // so SIGKILL fires on the tick after 3 consecutive missed pongs — ~20s
  // worst-case detection. Was 30s (~90s detection), which left users staring
  // at frozen terminals long enough to assume the app had hung.
  healthCheckIntervalMs: 5000,
  showCrashDialog: true,
  memoryLimitMb: 512,
  deferStart: false,
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
  private config: ResolvedPtyClientConfig;
  private isDisposed = false;

  /** Whether the PTY fabric (per-project host shards) is active. */
  private readonly fabricEnabled: boolean;
  /** Max concurrent project shards; overflow projects co-locate on the default shard. */
  private readonly projectShardCap: number;
  /** Per-shard V8 heap budget (RAM-scaled under the fabric, config value otherwise). */
  private readonly shardMemoryLimitMb: number;
  private readonly electronDir: string;
  /** Live shards by key: "main" plus one per project under the fabric. */
  private readonly shards = new Map<string, PtyShard>();
  /** The boot shard — always exists, never retired; the only shard when the fabric is off. */
  private readonly defaultShard: PtyShard;
  /** Placement lookups over the maps below — constructed once `defaultShard` exists. */
  private readonly placementRouter: ShardPlacementRouter;
  /** Per-shard router deps, built once per shard (broker + emitter proxy are shard-scoped). */
  private readonly shardRouterDeps = new WeakMap<PtyShard, PtyEventRouterDeps>();
  private shardCallbacksCache: ConstructorParameters<typeof PtyShard>[1] | null = null;
  /**
   * terminalId → owning shard key. Set at spawn admission, retargeted on
   * crash-loop migration, and dropped once no incarnation of the id remains
   * (final exit / failed spawn). The single source of truth for routing
   * per-terminal requests to the shard that actually holds the terminal.
   */
  private readonly terminalOwners = new Map<string, string>();
  /**
   * projectId → forced shard key. Written when a project shard exhausts its
   * crash budget (its terminals migrate to the default shard and stay there
   * for the rest of the session — no crash-loop ping-pong) and when the
   * project-shard cap overflows.
   */
  private readonly projectShardOverrides = new Map<string, string>();
  /** windowId → shard key currently holding (or pending) that window's MessagePort. */
  private readonly windowPortShard = new Map<number, string>();
  private readonly shardRetirementTimers = new Map<string, NodeJS.Timeout>();
  // Aggregated host signals. Consumers of "host-throttled" / "host-memory-warning"
  // treat the payload as THE terminal backend's state, so with multiple shards a
  // healthy sibling's release must not clear a struggling shard's warning — the
  // fabric ORs the per-shard booleans and only forwards aggregate transitions.
  private readonly signalAggregator = new HostSignalAggregator({
    emit: (event, payload) => this.emit(event, payload),
  });
  /** Mirrors the system-sleep watchdog pause so shards created mid-sleep stay quiet. */
  private healthChecksPaused = false;

  private pendingSpawns: Map<string, PtyHostSpawnOptions> = new Map();
  private ipcDataMirrorIds = new Set<string>();
  private pendingKillCount: Map<string, number> = new Map();
  private activeProjectId: string | null = null;
  private windowProjectContexts = new Map<
    number,
    { projectId: string | null; projectPath?: string; mode: "active" | "switch" }
  >();
  // Per-window UI-focused terminal id. Cached so it can be replayed to the host
  // on port reconnect (page reload clears the host's map on port-replace) and on
  // host restart (#5534) — the renderer only re-sends on an actual focus change,
  // so without replay a restart would strip focus prioritization until the next
  // click. `null` means the window has no focused terminal.
  private windowFocusedTerminals = new Map<number, string | null>();
  private deferInitialPoolWarm = false;
  private hostStartRequested = false;
  private terminalPids: Map<string, number> = new Map();
  private resourceMonitoringEnabled = false;
  private sessionPersistSuppressed = false;
  // Cached for replay in respawnPendingForShard(): both sends are fire-and-forget,
  // so a restarted host would otherwise boot on balanced governor thresholds and
  // the ProcessTreeCache constructor default until the next profile change.
  private lastResourceProfile: ResourceProfile | null = null;
  private lastProcessTreePollIntervalMs: number | null = null;

  /**
   * Cap on pendingSpawns to prevent restart-storm amplification. If the host
   * crashes during spawn and the respawn replay walks the map, an unbounded map
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

  /**
   * Callback to notify renderer when MessagePorts need to be refreshed. Called
   * with a windowId to refresh one window (fabric shard restart / port
   * reroute) or with no argument to refresh every window (legacy host
   * restart).
   */
  private onPortRefresh: ((windowId?: number) => void) | null = null;

  /** Cached log-level overrides. Replayed on every host spawn/restart via the
   * `ready` event, which is the first moment the child's message listener is
   * attached (push-on-spawn would race and silently drop the first message).
   * Seeded from the persisted store so boot-time host spawns inherit the
   * user's saved configuration without waiting for renderer IPC. */
  private logLevelOverridesCache: Record<string, string> = readPersistedOverrides();

  /**
   * Default-shard accessors. Internal code uses these wherever the singleton
   * client used its single lifecycle/watchdog (ready gate, boot wait); the
   * adversarial/watchdog test suites also reach them via casts, so keep the
   * names stable.
   */
  private get lifecycle(): PtyHostLifecycle {
    return this.defaultShard.lifecycle;
  }

  /** @internal Default-shard watchdog — kept for the watchdog/handshake test suites. */
  get healthWatchdog(): PtyHealthWatchdog {
    return this.defaultShard.watchdog;
  }

  constructor(config: PtyClientConfig = {}) {
    super();
    const { fabric, maxProjectShards: shardCapOverride, ...baseConfig } = config;
    this.config = { ...DEFAULT_CONFIG, ...baseConfig };
    this.fabricEnabled = fabric ?? isPtyFabricEnabled();
    this.projectShardCap = shardCapOverride ?? maxProjectShards(os.cpus().length);
    this.shardMemoryLimitMb = this.fabricEnabled
      ? shardHeapBudgetMb(os.totalmem())
      : this.config.memoryLimitMb;

    // SharedArrayBuffer cannot be sent to Electron UtilityProcess via postMessage
    // ("An object could not be cloned"). This is a Chromium structured clone limitation
    // that affects all platforms. Use IPC fallback for terminal I/O.
    console.log("[PtyClient] Using IPC mode (SharedArrayBuffer not supported in UtilityProcess)");
    if (this.fabricEnabled) {
      console.log(
        `[PtyClient] PTY fabric enabled: per-project host shards (cap ${this.projectShardCap}, heap ${this.shardMemoryLimitMb}MB/shard)`
      );
    }

    this.electronDir = path.basename(__dirname) === "chunks" ? path.dirname(__dirname) : __dirname;

    this.defaultShard = this.ensureShard(DEFAULT_SHARD_KEY);
    this.placementRouter = new ShardPlacementRouter({
      fabricEnabled: this.fabricEnabled,
      projectShardCap: this.projectShardCap,
      defaultShard: this.defaultShard,
      shards: this.shards,
      terminalOwners: this.terminalOwners,
      projectShardOverrides: this.projectShardOverrides,
      windowPortShard: this.windowPortShard,
      windowProjectContexts: this.windowProjectContexts,
      ensureShard: (key) => this.ensureShard(key),
      logWarn,
    });

    if (!this.config.deferStart) {
      this.start();
    }
  }

  /** Get or create the shard for a key. Forks immediately once start() has been requested. */
  private ensureShard(key: string): PtyShard {
    this.cancelShardRetirement(key);
    const existing = this.shards.get(key);
    if (existing) return existing;

    const shard = new PtyShard(
      {
        key,
        serviceName: shardServiceName(key),
        memoryLimitMb: this.shardMemoryLimitMb,
        electronDir: this.electronDir,
        healthCheckIntervalMs: this.config.healthCheckIntervalMs,
        maxMissedHeartbeats: MAX_MISSED_HEARTBEATS,
        // Project shards always defer the boot-time homedir pool warm: their
        // first project context immediately drains the pool to the project
        // path, so a homedir warm would only spawn shells for the drain to
        // kill. The default shard keeps the boot-restore deferral flag (#10393).
        deferInitialPoolWarm:
          key === DEFAULT_SHARD_KEY ? () => this.deferInitialPoolWarm : () => true,
        resyncContextOnFirstReady: key !== DEFAULT_SHARD_KEY,
      },
      this.shardCallbacks()
    );
    this.shards.set(key, shard);
    if (key !== DEFAULT_SHARD_KEY) {
      console.log(`[PtyClient] Created PTY shard '${key}' (${shard.serviceName})`);
    }
    if (this.hostStartRequested) {
      shard.start();
    }
    return shard;
  }

  private shardCallbacks(): ConstructorParameters<typeof PtyShard>[1] {
    if (this.shardCallbacksCache) return this.shardCallbacksCache;
    this.shardCallbacksCache = {
      onMessage: (shard, event) => this.handleShardEvent(shard, event),
      onExitSync: (shard, { fallbackCrashType }) => {
        shard.watchdog.stop();
        if (this.isDisposed) {
          return;
        }
        this.cleanupOrphanedPtysForShard(shard, fallbackCrashType);
        shard.broker.clear(new BrokerError("HOST_EXITED", "Pty host exited"));
        shard.shouldResyncProjectContext = true;
        // The crashed shard's throttle/memory-warning holds are gone with the
        // process; recompute the aggregate so a sibling-free release isn't
        // stuck behind a dead shard's stale hold.
        this.dropShardSignals(shard.key);
      },
      onCrashClassified: (shard, { crashType, payload }) => {
        this.cleanupOrphanedPtysForShard(shard, crashType);
        if (payload) {
          this.emitCrashDetailsForShard(shard, payload);
        }
      },
      onMaxRestartsReached: (shard, code) => {
        if (shard.key === DEFAULT_SHARD_KEY || !this.fabricEnabled) {
          this.emit("host-crash", code);
          return;
        }
        this.migrateShardTerminalsToDefault(shard, code);
      },
      onForkFailed: (shard) => {
        if (shard.key === DEFAULT_SHARD_KEY || !this.fabricEnabled) {
          this.emit("host-crash", -1);
          return;
        }
        // fork() throws synchronously — possibly mid-spawn/ensureShard, before
        // the caller has registered the terminal it was placing here. Defer the
        // containment one tick so the in-flight registration lands first and
        // the migration replays it on the default shard. No restart is ever
        // scheduled after a fork failure, so without this the project's
        // terminals would route to a permanently dead shard while every window
        // showed a global backend-crashed banner.
        setImmediate(() => {
          if (this.isDisposed || shard.retired) return;
          this.migrateShardTerminalsToDefault(shard, -1);
        });
      },
      emitCrashDetails: (shard, payload) => {
        this.emitCrashDetailsForShard(shard, payload);
      },
      onBrokerTimeout: (_shard, requestId, method) => {
        console.warn(`[PtyClient] Request timeout: ${method ? `${method} ` : ""}(${requestId})`);
      },
      isClientDisposed: () => this.isDisposed,
      logInfo: (message) => logInfo(message),
      logWarn: (message) => logWarn(message),
    };
    return this.shardCallbacksCache;
  }

  private handleShardEvent(shard: PtyShard, event: PtyHostEvent): void {
    if (shard.retired) return;
    let deps = this.shardRouterDeps.get(shard);
    if (!deps) {
      deps = this.buildRouterDeps(shard);
      this.shardRouterDeps.set(shard, deps);
    }
    routeHostEvent(event, deps);
  }

  private buildRouterDeps(shard: PtyShard): PtyEventRouterDeps {
    return {
      isDisposed: () => this.isDisposed || shard.retired,
      broker: shard.broker,
      emitter: new ShardEventEmitter((event, args) => this.emitFromShard(shard, event, args)),
      state: {
        pendingSpawns: this.pendingSpawns,
        pendingKillCount: this.pendingKillCount,
        terminalPids: this.terminalPids,
      },
      callbacks: {
        onReady: () => this.handleShardReady(shard),
        onPong: () => shard.watchdog.recordPong(),
        onTerminalRemovedFromTrash: (id) => getTrashedPidTracker().removeTrashed(id),
        // #7526: filter help-session PTYs into the Windows Job Object so the
        // OS reaps the agent tree on a hard Daintree crash. No-op on
        // non-Windows and on non-help terminals.
        onTerminalPid: (id, pid) => {
          if (helpSessionService.isHelpTerminal(id)) {
            helpSessionJobService.attachHelpSessionPid(pid);
          }
        },
        // Lifecycle-ledger bookkeeping. Exits carry the host-adopted
        // launchGeneration so a stale exit arriving after a same-id respawn
        // closes its own incarnation, never the successor.
        onTerminalExit: (id, exitCode, launchGeneration) => {
          const ledger = getLifecycleLedger();
          const generation = launchGeneration ?? ledger.currentGeneration(id);
          if (generation !== undefined && ledger.currentGeneration(id) !== undefined) {
            ledger.recordClose(id, generation, "exit", exitCode);
          }
        },
        onSpawnResult: (id, result) => {
          const ledger = getLifecycleLedger();
          // Prefer the generation echoed by the host: a stale result from a
          // killed predecessor must record against its own incarnation (where
          // the ledger rejects it as stale), never the live successor's.
          const generation = result.launchGeneration ?? ledger.currentGeneration(id);
          if (generation === undefined || ledger.currentGeneration(id) === undefined) return;
          const resolved = ledger.recordSpawnResolved(id, generation, result.success);
          if (resolved.accepted && !result.success) {
            ledger.recordClose(id, generation, `spawn-failed:${result.error?.code ?? "UNKNOWN"}`);
          }
        },
      },
      logWarn: (message) => console.warn(message),
    };
  }

  /**
   * Every event the per-shard router would emit funnels through here so the
   * fabric can do cross-shard bookkeeping before forwarding on the public
   * emitter: terminal-owner cleanup on final exits, idle-shard sweeps, and
   * OR-aggregation of the process-scoped host signals.
   */
  private emitFromShard(shard: PtyShard, event: string, args: unknown[]): boolean {
    if (event === "exit") {
      const id = args[0] as string;
      // Owner entries live until no incarnation of the id remains: a kill
      // followed by a same-id respawn keeps the entry (retargeted by spawn),
      // while the final exit releases it.
      if (!this.pendingSpawns.has(id) && !this.pendingKillCount.has(id)) {
        this.terminalOwners.delete(id);
      }
      const emitted = this.emit(event, ...args);
      this.scheduleIdleSweep();
      return emitted;
    }
    if (event === "spawn-result") {
      const result = args[1] as SpawnResult;
      if (!result.success) {
        const id = args[0] as string;
        if (!this.pendingSpawns.has(id) && !this.pendingKillCount.has(id)) {
          this.terminalOwners.delete(id);
        }
        const emitted = this.emit(event, ...args);
        this.scheduleIdleSweep();
        return emitted;
      }
      return this.emit(event, ...args);
    }
    if (event === "host-throttled") {
      return this.emitAggregatedThrottle(shard, args[0] as HostThrottlePayload);
    }
    if (event === "host-memory-warning") {
      return this.emitAggregatedMemoryWarning(shard, args[0] as HostMemoryWarningPayload);
    }
    return this.emit(event, ...args);
  }

  private emitAggregatedThrottle(shard: PtyShard, payload: HostThrottlePayload): boolean {
    return this.signalAggregator.recordThrottle(shard.key, payload);
  }

  private emitAggregatedMemoryWarning(shard: PtyShard, payload: HostMemoryWarningPayload): boolean {
    return this.signalAggregator.recordMemoryWarning(shard.key, payload);
  }

  /**
   * `host-crash-details` drives the renderer's global "backend recovering"
   * state (`terminal:backend-recovering` broadcast to every window), and that
   * state is only cleared by a `terminal:backend-ready` — which the fabric
   * sends targeted, to the crashed shard's windows alone. Broadcasting a
   * project shard's crash would therefore wedge every unrelated window in
   * "recovering" forever. Keep the global event for the default shard (and
   * the singleton path) and contain project-shard crashes to a log; their
   * recovery is the shard restart + targeted port refresh.
   */
  private emitCrashDetailsForShard(
    shard: PtyShard,
    payload: Parameters<ConstructorParameters<typeof PtyShard>[1]["emitCrashDetails"]>[1]
  ): void {
    if (shard.key === DEFAULT_SHARD_KEY || !this.fabricEnabled) {
      this.emit("host-crash-details", payload);
      return;
    }
    logWarn(
      `[PtyClient] PTY shard '${shard.key}' crashed (${payload.crashType}, code ${payload.code}); recovering shard-locally`
    );
  }

  /**
   * Drop a departed shard's attribution from the aggregated signals and emit
   * the release edge if the aggregate flipped — a retired/crashed shard must
   * not pin "throttled"/"memory warning" on forever.
   */
  private dropShardSignals(shardKey: string): void {
    this.signalAggregator.dropShard(shardKey);
  }

  /**
   * Fork the PTY host shards. Called automatically from the constructor unless
   * `deferStart` was set, in which case the caller invokes this once the early
   * PATH refresh has resolved so node-pty inherits the user's full PATH
   * (#8625/#8827). Idempotent — a second call once the host has already been
   * requested is a no-op, so the multi-window boot path can call it
   * unconditionally. Auto-restarts go through each shard's `lifecycle.start()`
   * directly and are unaffected by this guard.
   */
  start(): void {
    if (this.hostStartRequested) {
      return;
    }
    this.hostStartRequested = true;
    for (const shard of this.shards.values()) {
      shard.start();
    }
    console.log("[PtyClient] Pty Host started");
  }

  /** Whether {@link PtyClient.start} has forked (or requested) the host yet. */
  isHostStarted(): boolean {
    return this.hostStartRequested;
  }

  /**
   * Mark the host fork as a project-restoring boot: the host skips its
   * boot-time homedir pool warm because the set-active-project sent right
   * after ready drains the pool to the project path anyway (#10393). The
   * host falls back to a homedir warm if the restore falls through, and the
   * flag is re-read on every restart fork — context replay re-warms the pool
   * either way. Call before {@link start}.
   */
  setDeferInitialPoolWarm(defer: boolean): void {
    this.deferInitialPoolWarm = defer;
  }

  /** Wait for the (default-shard) host to be ready — the boot gate. */
  async waitForReady(): Promise<void> {
    return this.lifecycle.waitForReady();
  }

  // ── Placement ────────────────────────────────────────────────────────────
  // Fabric invariant: one project → one shard. A project's terminals never
  // split across shards, so per-project ops (kill-by-project, rollup rows,
  // pool warm) stay single-shard and (A)→(B) packing evolutions stay internal.

  /** Owner shard key for a terminal id; unknown ids fall back to the default shard. */
  private ownerKey(id: string): string {
    return this.placementRouter.ownerKey(id);
  }

  private shardForTerminal(id: string): PtyShard {
    return this.placementRouter.shardForTerminal(id);
  }

  /** Pure placement lookup — never creates shards or records overrides. */
  private peekPlacementKey(projectId: string | null | undefined): string {
    return this.placementRouter.peekPlacementKey(projectId);
  }

  private ensureShardForProject(projectId: string | null | undefined): PtyShard {
    return this.placementRouter.ensureShardForProject(projectId);
  }

  /** Shard that owns a project's terminals (for queries/kills) — never creates. */
  private shardForProjectQuery(projectId: string): PtyShard {
    return this.placementRouter.shardForProjectQuery(projectId);
  }

  /** Shard key a window's port should route to, from its current project context. */
  private shardKeyForWindowContext(windowId: number): string {
    return this.placementRouter.shardKeyForWindowContext(windowId);
  }

  /** Shard that receives window-scoped messages (focus): the port holder, else the context owner. */
  private shardForWindow(windowId: number): PtyShard {
    return this.placementRouter.shardForWindow(windowId);
  }

  /** Shards to fan aggregate queries over. Falls back to the default shard so callers keep the legacy timeout→sentinel path when nothing is ready. */
  private fanOutShards(): PtyShard[] {
    return this.placementRouter.fanOutShards();
  }

  // ── Shard lifecycle ──────────────────────────────────────────────────────

  private handleShardReady(shard: PtyShard): void {
    if (!shard.lifecycle.markReady()) {
      console.warn("[PtyClient] Ignoring late ready event - host is dead");
      return;
    }
    if (shard.key === DEFAULT_SHARD_KEY) {
      console.log("[PtyClient] Pty Host is ready");
    } else {
      console.log(`[PtyClient] Pty Host shard '${shard.key}' is ready`);
    }
    // Replay log-level overrides on every ready (initial spawn + restarts).
    // The child's message listener isn't attached until after it receives
    // "ready", so pushing on spawn would race.
    shard.send({
      type: "set-log-level-overrides",
      overrides: this.logLevelOverridesCache,
    });
    // Mirror the current plugin-agent registry to the (re)started host before
    // any spawn replay below, so respawned plugin-agent terminals resolve their
    // detection patterns from the first tick (#10587). Reads the authoritative
    // main-process snapshot directly — no cache needed, and a host restart
    // re-syncs whatever plugins are loaded now.
    shard.send({ type: "set-plugin-agent-registry", registry: getPluginAgentRegistry() });
    // A project shard forked mid-session missed every earlier config setter
    // (resource profile, monitoring, persistence suppression) — those are
    // host-process-wide, so replay the caches on its first ready. Restart
    // readies get the same replay from respawnPendingForShard below.
    if (shard.key !== DEFAULT_SHARD_KEY && !shard.needsRespawn) {
      this.replayGlobalConfigToShard(shard);
    }
    // Re-arm the watchdog on every successful ready — covers both the initial
    // boot and every auto-restart cycle. The original code armed it inside
    // startHost() before ready arrived, but the tick was a no-op until
    // isInitialized=true anyway, so deferring to ready is equivalent and
    // avoids a leaked timer when fork itself fails.
    if (!this.healthChecksPaused && !shard.watchdog.isHealthCheckPaused) {
      shard.watchdog.start();
    }
    if (shard.needsRespawn) {
      shard.needsRespawn = false;
      this.respawnPendingForShard(shard);
    } else if (this.pendingSpawns.size > 0) {
      // Initial host-ready replay (#8827). With deferred start the host forks
      // only after the early PATH refresh, so any spawn requested during that
      // window had its send() dropped — the host's message listener isn't
      // attached until it emits "ready" (also true for the brief construct→
      // ready window on the non-deferred path, and for a project shard forked
      // by the spawn that is being replayed). Replay this shard's spawns now
      // so a terminal launched before its host was ready isn't silently lost.
      // Double-spawn-safe: on the first "ready" no spawn could have been
      // delivered yet. The restart-only side effects (port refresh, stale-kill
      // clearing) stay in respawnPendingForShard() above.
      for (const [id, options] of this.pendingSpawns) {
        if (this.ownerKey(id) !== shard.key) continue;
        this.sendSpawnWithPostInput(shard, id, options);
      }
    }
    const pendingPortWindowIds = new Set(shard.pendingMessagePorts.keys());
    this.flushPendingMessagePortsForShard(shard);
    if (shard.shouldResyncProjectContext) {
      shard.shouldResyncProjectContext = false;
      this.syncProjectContextToShard(shard, pendingPortWindowIds);
    }
  }

  /**
   * Send a spawn to a shard. For command launches on shells that couldn't host
   * a startup wrapper, the launch command rides `options.postSpawnInput` in
   * `pendingSpawns`, and the host's spawn handler injects it right after a
   * successful spawn (#11339). Every replay path (initial pre-ready replay,
   * crash respawn, crash-budget migration) funnels through here and re-sends the
   * same options, so the terminal comes back running its command — including a
   * resume — instead of a bare prompt. Delivery is bound to spawn success on the
   * host: a rejected spawn (e.g. TERMINAL_ALREADY_LIVE, #11341) never injects
   * the command into a pre-existing live PTY.
   */
  private sendSpawnWithPostInput(shard: PtyShard, id: string, options: PtyHostSpawnOptions): void {
    // Never deliver into a shard that isn't ready yet. A post-fork/pre-ready
    // send is dropped here AND re-sent by the first-ready replay below, which
    // for a command launch would run the command (and any resume) twice. The
    // entry is already in `pendingSpawns`, so the first-ready replay (which runs
    // after `markReady`, i.e. once this guard passes) delivers it exactly once.
    // This makes the "double-spawn-safe" invariant explicit rather than relying
    // on the pre-fork transport drop.
    if (!shard.isRunning()) return;
    shard.send({ type: "spawn", id, options });
  }

  private respawnPendingForShard(shard: PtyShard): void {
    // Kills sent to the crashed shard will never receive "exit" events, so
    // its pendingKillCount entries are permanently stale. Unlike pendingSpawns
    // (replayed below to recreate terminals on the new host), they are
    // cleared — the terminals those kills targeted died with the process.
    for (const id of [...this.pendingKillCount.keys()]) {
      if (this.ownerKey(id) === shard.key) {
        this.pendingKillCount.delete(id);
      }
    }
    // Owner entries without a pending spawn were awaiting an exit event that
    // died with the shard — nothing will respawn them.
    for (const [id, owner] of [...this.terminalOwners]) {
      if (owner === shard.key && !this.pendingSpawns.has(id)) {
        this.terminalOwners.delete(id);
      }
    }

    // Notify that ports need refresh after the shard restart. Fabric mode
    // targets only the windows whose port lived on this shard; the legacy
    // single-host path keeps the refresh-everything behavior.
    if (this.onPortRefresh) {
      shard.closePendingPorts();
      if (!this.fabricEnabled) {
        this.onPortRefresh();
      } else {
        for (const [windowId, key] of [...this.windowPortShard]) {
          if (key !== shard.key) continue;
          this.windowPortShard.delete(windowId);
          this.onPortRefresh(windowId);
        }
      }
    }

    // Respawn terminals that were active when the shard crashed. Each replay
    // is a NEW incarnation — the previous PTY died with the host — so close
    // the old generation and mint a fresh one. Without this, a session
    // captured before the crash and one captured after would share a
    // generation and the journal's exactly-once gate would drop the second
    // record. (The initial host-ready replay in handleShardReady keeps its
    // generation: nothing was ever delivered, so it is the same incarnation.)
    const ledger = getLifecycleLedger();
    for (const [id, options] of this.pendingSpawns) {
      if (this.ownerKey(id) !== shard.key) continue;
      console.log(`[PtyClient] Respawning terminal: ${id}`);
      const previousGeneration = options.launchGeneration ?? ledger.currentGeneration(id);
      if (previousGeneration !== undefined && ledger.currentGeneration(id) !== undefined) {
        ledger.recordClose(id, previousGeneration, "pty-host-crash");
      }
      const generation = ledger.recordLaunch(id, ledgerFactsFromSpawnOptions(options));
      const stamped: PtyHostSpawnOptions = { ...options, launchGeneration: generation };
      this.pendingSpawns.set(id, stamped);
      this.sendSpawnWithPostInput(shard, id, stamped);
    }

    // Re-enable IPC data mirrors that were active before crash
    for (const id of this.ipcDataMirrorIds) {
      if (this.ownerKey(id) !== shard.key) continue;
      shard.send({ type: "set-ipc-data-mirror", id, enabled: true });
    }

    this.replayGlobalConfigToShard(shard);
  }

  /**
   * Replay the cached host-process-wide config to one shard: on restarts
   * (the new process booted with defaults) and on a project shard's first
   * ready (it missed every earlier live setter).
   */
  private replayGlobalConfigToShard(shard: PtyShard): void {
    // Re-enable resource monitoring if it was active
    if (this.resourceMonitoringEnabled) {
      shard.send({ type: "set-resource-monitoring", enabled: true });
    }

    // Replay session persistence suppression if disk space was critical
    if (this.sessionPersistSuppressed) {
      shard.send({ type: "set-session-persist-suppressed", suppressed: true });
    }

    // Replay the resource profile so the new host's governor and process-tree
    // cadence match what main believes is applied — ResourceProfileService only
    // re-sends on transitions. The explicit poll interval (focus throttle)
    // replays after the profile since it was the later writer when both are set.
    if (this.lastResourceProfile !== null) {
      shard.send({ type: "set-resource-profile", profile: this.lastResourceProfile });
    }
    if (this.lastProcessTreePollIntervalMs !== null) {
      shard.send({
        type: "set-process-tree-poll-interval",
        ms: this.lastProcessTreePollIntervalMs,
      });
    }
  }

  /**
   * A project shard exhausted its crash budget. Instead of declaring a global
   * host crash (the singleton behavior — its terminals ARE gone, but every
   * other project's are fine), pin the project to the default shard and
   * respawn its terminals there: graceful degradation toward the singleton,
   * never toward dropped terminals. The pin is session-sticky so a
   * crash-looping project can't ping-pong between a fresh shard and the
   * default.
   */
  private migrateShardTerminalsToDefault(shard: PtyShard, code: number | null): void {
    logWarn(
      `[PtyClient] PTY shard '${shard.key}' exceeded its crash budget (code ${code}); migrating its terminals to the default shard`
    );
    shard.retired = true;
    this.shards.delete(shard.key);
    this.cancelShardRetirement(shard.key);
    this.projectShardOverrides.set(shard.key, DEFAULT_SHARD_KEY);

    // Kills in flight against the dead shard are moot, and owner entries
    // without a pending spawn have nothing left to migrate.
    for (const id of [...this.pendingKillCount.keys()]) {
      if (this.ownerKey(id) === shard.key) {
        this.pendingKillCount.delete(id);
      }
    }
    for (const [id, owner] of [...this.terminalOwners]) {
      if (owner === shard.key && !this.pendingSpawns.has(id)) {
        this.terminalOwners.delete(id);
      }
    }

    // Respawn the shard's live terminals on the default shard — a NEW
    // incarnation each, exactly like a crash respawn. If the default shard is
    // itself mid-restart these sends drop and its own ready replay picks the
    // (now default-owned) spawns up.
    const target = this.ensureShard(DEFAULT_SHARD_KEY);
    const ledger = getLifecycleLedger();
    const migratedIds: string[] = [];
    for (const [id, options] of this.pendingSpawns) {
      if (this.ownerKey(id) !== shard.key) continue;
      console.log(`[PtyClient] Migrating terminal to default shard: ${id}`);
      const previousGeneration = options.launchGeneration ?? ledger.currentGeneration(id);
      if (previousGeneration !== undefined && ledger.currentGeneration(id) !== undefined) {
        ledger.recordClose(id, previousGeneration, "pty-host-crash");
      }
      const generation = ledger.recordLaunch(id, ledgerFactsFromSpawnOptions(options));
      const stamped: PtyHostSpawnOptions = { ...options, launchGeneration: generation };
      this.pendingSpawns.set(id, stamped);
      this.terminalOwners.set(id, DEFAULT_SHARD_KEY);
      migratedIds.push(id);
      this.sendSpawnWithPostInput(target, id, stamped);
    }
    for (const id of migratedIds) {
      if (this.ipcDataMirrorIds.has(id)) {
        target.send({ type: "set-ipc-data-mirror", id, enabled: true });
      }
    }

    // Undelivered window ports re-route through the normal path (placement
    // now resolves to the default shard); delivered ports get a targeted
    // refresh so the renderer reconnects to the new owner.
    for (const [windowId, port] of [...shard.pendingMessagePorts]) {
      shard.pendingMessagePorts.delete(windowId);
      this.connectMessagePort(windowId, port);
    }
    for (const [windowId, key] of [...this.windowPortShard]) {
      if (key !== shard.key) continue;
      this.windowPortShard.delete(windowId);
      this.onPortRefresh?.(windowId);
    }

    shard.dispose();
    this.dropShardSignals(shard.key);
  }

  // ── Idle shard retirement ────────────────────────────────────────────────
  // A project shard's process lives while its project has terminals or a
  // window; when the last reference drops it lingers briefly, then exits,
  // releasing every FD and byte of heap it held. This binds terminal-tier
  // resource lifetime to the shard instead of the renderer view — the
  // structural fix for eviction leaking PTY FDs/RSS into a shared host.

  private shardIsIdle(key: string): boolean {
    for (const owner of this.terminalOwners.values()) {
      if (owner === key) return false;
    }
    for (const ctx of this.windowProjectContexts.values()) {
      if (ctx.projectId !== null && this.peekPlacementKey(ctx.projectId) === key) return false;
    }
    for (const portKey of this.windowPortShard.values()) {
      if (portKey === key) return false;
    }
    return true;
  }

  private scheduleIdleSweep(): void {
    if (!this.fabricEnabled || this.isDisposed) return;
    for (const key of this.shards.keys()) {
      if (key === DEFAULT_SHARD_KEY) continue;
      this.maybeScheduleShardRetirement(key);
    }
  }

  private maybeScheduleShardRetirement(key: string): void {
    if (!this.shardIsIdle(key)) return;
    const existing = this.shardRetirementTimers.get(key);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.shardRetirementTimers.delete(key);
      if (this.isDisposed || !this.shardIsIdle(key)) return;
      const shard = this.shards.get(key);
      if (!shard) return;
      console.log(`[PtyClient] Retiring idle PTY shard '${key}'`);
      this.shards.delete(key);
      shard.dispose();
      this.dropShardSignals(key);
    }, PTY_SHARD_IDLE_LINGER_MS);
    timer.unref?.();
    this.shardRetirementTimers.set(key, timer);
  }

  private cancelShardRetirement(key: string): void {
    const timer = this.shardRetirementTimers.get(key);
    if (timer) {
      clearTimeout(timer);
      this.shardRetirementTimers.delete(key);
    }
  }

  /**
   * When a window's project context now places it on a different shard than
   * the one holding its MessagePort, move the port: an undelivered pending
   * port transfers directly; a delivered one is re-minted via the targeted
   * port-refresh callback (a transferred MessagePort cannot be recalled from
   * a utility process).
   */
  private rerouteWindowPortIfNeeded(windowId: number): void {
    if (!this.fabricEnabled) return;
    const currentKey = this.windowPortShard.get(windowId);
    if (currentKey === undefined) return;
    const targetKey = this.shardKeyForWindowContext(windowId);
    if (currentKey === targetKey) return;
    const current = this.shards.get(currentKey);
    const pendingPort = current?.pendingMessagePorts.get(windowId);
    if (current && pendingPort) {
      current.pendingMessagePorts.delete(windowId);
      this.connectMessagePort(windowId, pendingPort);
      return;
    }
    if (!this.onPortRefresh) return;
    console.log(
      `[PtyClient] Rerouting window ${windowId} PTY port: shard '${currentKey}' → '${targetKey}'`
    );
    this.onPortRefresh(windowId);
  }

  private cleanupOrphanedPtysForShard(shard: PtyShard, crashType: CrashType): void {
    if (crashType === "CLEAN_EXIT" || this.terminalPids.size === 0) {
      return;
    }

    // Scope to the crashed shard's terminals — killing a sibling shard's
    // healthy PTY trees would turn one project's crash into an app-wide one.
    const ownedIds: string[] = [];
    const uniquePids = new Set<number>();
    for (const [id, pid] of this.terminalPids) {
      if (this.ownerKey(id) !== shard.key) continue;
      ownedIds.push(id);
      uniquePids.add(pid);
    }
    if (uniquePids.size === 0) {
      return;
    }

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

    for (const id of ownedIds) {
      this.terminalPids.delete(id);
    }
  }

  /**
   * Set callback for MessagePort refresh. Called with no argument on a legacy
   * full-host restart (refresh every window) and with a windowId when the
   * fabric restarts or reroutes a single window's shard.
   */
  setPortRefreshCallback(callback: (windowId?: number) => void): void {
    this.onPortRefresh = callback;
  }

  /**
   * Update the cached log-level overrides and push immediately to every ready
   * shard. On every subsequent restart the cached map is replayed via the
   * `ready` handler — callers don't need to track restarts themselves.
   */
  setLogLevelOverrides(overrides: Record<string, string>): void {
    this.logLevelOverridesCache = { ...overrides };
    for (const shard of this.shards.values()) {
      if (shard.lifecycle.isInitialized && shard.lifecycle.child) {
        shard.send({ type: "set-log-level-overrides", overrides: this.logLevelOverridesCache });
      }
    }
  }

  /**
   * Push the current plugin-agent registry to every ready shard so their
   * activity monitors can resolve plugin detection patterns (#10587). Called
   * by `PluginService` after a plugin load/unload changes the registry. Reads
   * the authoritative main snapshot at call time; on a host restart the
   * registry is replayed from the `ready` handler, so callers don't track
   * restarts themselves. No-op for shards that aren't ready yet — the ready
   * replay covers that window.
   */
  syncPluginAgentRegistry(): void {
    for (const shard of this.shards.values()) {
      if (shard.lifecycle.isInitialized && shard.lifecycle.child) {
        shard.send({ type: "set-plugin-agent-registry", registry: getPluginAgentRegistry() });
      }
    }
  }

  private flushPendingMessagePortsForShard(shard: PtyShard): void {
    if (!shard.lifecycle.child || shard.pendingMessagePorts.size === 0) {
      return;
    }

    const pending = new Map(shard.pendingMessagePorts);
    shard.pendingMessagePorts.clear();
    // Re-enter connectMessagePort rather than posting directly: placement may
    // have moved while the port waited (project switch, crash migration), and
    // the connect path re-derives the owning shard.
    for (const [windowId, port] of pending) {
      this.connectMessagePort(windowId, port);
    }
  }

  /**
   * Forward MessagePort to the owning shard for direct Renderer↔PtyHost
   * communication. The owning shard is derived from the window's current
   * project context; when the port previously lived on a different shard the
   * old shard gets an explicit disconnect so it can tear down its per-window
   * queue/batcher state.
   */
  connectMessagePort(windowId: number, port: MessagePortMain): void {
    const targetKey = this.shardKeyForWindowContext(windowId);
    const target = this.ensureShard(targetKey);

    const previousKey = this.windowPortShard.get(windowId);
    if (previousKey !== undefined && previousKey !== targetKey) {
      const previous = this.shards.get(previousKey);
      if (previous) {
        const stalePending = previous.pendingMessagePorts.get(windowId);
        if (stalePending && stalePending !== port) {
          try {
            stalePending.close();
          } catch {
            // ignore
          }
        }
        previous.pendingMessagePorts.delete(windowId);
        previous.send({ type: "disconnect-port", windowId });
      }
    }
    this.windowPortShard.set(windowId, targetKey);

    const existingPending = target.pendingMessagePorts.get(windowId);
    if (existingPending && existingPending !== port) {
      try {
        existingPending.close();
      } catch {
        // ignore
      }
      target.pendingMessagePorts.delete(windowId);
    }

    if (!target.lifecycle.child) {
      console.warn("[PtyClient] Cannot connect MessagePort - host not running, will retry");
      target.pendingMessagePorts.set(windowId, port);
      return;
    }

    try {
      target.lifecycle.child.postMessage({ type: "connect-port", windowId }, [port]);
      if (process.env.DAINTREE_VERBOSE) {
        console.log(`[PtyClient] MessagePort forwarded to Pty Host for window ${windowId}`);
      }
      // Re-send project context for this window (handles page reload case where
      // disconnectWindow in the host clears windowProjectMap on port-replace).
      // The target IS the owner of this window's project, so the pool-warming
      // projectPath is included.
      const ctx = this.windowProjectContexts.get(windowId);
      if (ctx) {
        if (ctx.mode === "switch" && ctx.projectId !== null) {
          target.send({
            type: "project-switch",
            windowId,
            projectId: ctx.projectId,
            ...(ctx.projectPath ? { projectPath: ctx.projectPath } : {}),
          });
        } else {
          target.send({
            type: "set-active-project",
            windowId,
            projectId: ctx.projectId,
            ...(ctx.projectPath ? { projectPath: ctx.projectPath } : {}),
          });
        }
      }
      // Re-send the focused terminal too: the host clears windowFocusedTerminalMap
      // on port-replace, and the renderer won't re-fire without a focus change.
      const focusedId = this.windowFocusedTerminals.get(windowId);
      if (focusedId !== undefined) {
        target.send({ type: "set-focused-terminal", windowId, id: focusedId });
      }
    } catch (error) {
      console.error("[PtyClient] Failed to forward MessagePort to Pty Host:", error);
      target.pendingMessagePorts.set(windowId, port);
    }
  }

  /**
   * Forward a dedicated worker-ingest MessagePort (issue #10960) to the shard
   * that owns the terminal — routed by terminal, not by window, so PTY-fabric
   * placement stays correct when a window views terminals on another shard.
   * No pending-port queue across host restarts: the renderer's engage timeout
   * falls back and re-requests lazily, so an undeliverable port just closes.
   */
  connectTerminalMessagePort(windowId: number, terminalId: string, port: MessagePortMain): void {
    const shard = this.shardForTerminal(terminalId);
    if (!shard.lifecycle.child) {
      try {
        port.close();
      } catch {
        // ignore
      }
      return;
    }
    try {
      shard.lifecycle.child.postMessage(
        { type: "connect-terminal-port", windowId, id: terminalId },
        [port]
      );
    } catch (error) {
      console.error("[PtyClient] Failed to forward worker-ingest MessagePort to Pty Host:", error);
      try {
        port.close();
      } catch {
        // ignore
      }
    }
  }

  /** Tear down one dedicated worker-ingest port on the owning shard. */
  disconnectTerminalMessagePort(windowId: number, terminalId: string): void {
    this.shardForTerminal(terminalId).send({
      type: "disconnect-terminal-port",
      windowId,
      id: terminalId,
    });
  }

  /** Notify the owning shard that a window's MessagePort should be disconnected */
  disconnectMessagePort(windowId: number): void {
    for (const shard of this.shards.values()) {
      shard.pendingMessagePorts.delete(windowId);
    }
    const portKey = this.windowPortShard.get(windowId);
    this.windowPortShard.delete(windowId);
    this.windowProjectContexts.delete(windowId);
    this.windowFocusedTerminals.delete(windowId);
    (this.shards.get(portKey ?? DEFAULT_SHARD_KEY) ?? this.defaultShard).send({
      type: "disconnect-port",
      windowId,
    });
    this.scheduleIdleSweep();
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
    const projectResolvedOptions: PtyHostSpawnOptions =
      resolvedProjectId !== undefined ? { ...options, projectId: resolvedProjectId } : options;
    // Mint the launch generation here — every spawn (fresh, restart, resume)
    // funnels through this method, so the ledger sees each incarnation exactly
    // once. The pty-host adopts the stamped generation and echoes it on exits
    // and session captures, which is what lets close/journal events reject
    // stale or duplicate completions instead of relying on timing.
    const generation = getLifecycleLedger().recordLaunch(
      id,
      ledgerFactsFromSpawnOptions(projectResolvedOptions)
    );
    const resolvedOptions: PtyHostSpawnOptions = {
      ...projectResolvedOptions,
      launchGeneration: generation,
    };

    // Placement: the terminal is admitted to its project's shard (the default
    // shard with the fabric off, for projectless terminals, and for projects
    // pinned by cap overflow / crash migration). Ownership is recorded before
    // the send so events and per-terminal requests route consistently.
    const shard = this.ensureShardForProject(resolvedProjectId);
    this.terminalOwners.set(id, shard.key);
    this.pendingSpawns.set(id, resolvedOptions);
    this.sendSpawnWithPostInput(shard, id, resolvedOptions);
  }

  /**
   * Raw plugin-PTY lane (#11300). These four bypass every terminal concern this
   * class otherwise owns — no project shard placement, no terminal-owner entry,
   * no lifecycle ledger, no pendingSpawns cap, no DAINTREE_* metadata stamping.
   * A plugin's interactive process is not a terminal panel; it rides the default
   * shard purely to reuse the pty-host's crash isolation and native-module
   * rebuild machinery.
   *
   * Like {@link spawn}, `spawnPluginPty` is void — the outcome arrives as a
   * `"plugin-pty"` event, so the caller must attach its listener BEFORE calling
   * and filter by `(id, generation)`.
   */
  spawnPluginPty(id: string, generation: number, options: PluginPtyHostSpawnOptions): void {
    this.defaultShard.send({ type: "plugin-pty-spawn", id, generation, options });
  }

  writePluginPty(id: string, generation: number, data: string): void {
    this.defaultShard.send({ type: "plugin-pty-write", id, generation, data });
  }

  resizePluginPty(id: string, generation: number, cols: number, rows: number): void {
    this.defaultShard.send({ type: "plugin-pty-resize", id, generation, cols, rows });
  }

  killPluginPty(id: string, generation: number, signal: "SIGTERM" | "SIGKILL"): void {
    this.defaultShard.send({ type: "plugin-pty-kill", id, generation, signal });
  }

  write(id: string, data: string, traceId?: string): void {
    this.shardForTerminal(id).send({ type: "write", id, data, traceId });
  }

  submit(id: string, text: string): void {
    this.shardForTerminal(id).send({ type: "submit", id, text });
  }

  /**
   * Stage text into a terminal's input without submitting it (no Enter). The
   * no-execute counterpart to {@link submit}; see {@link TerminalProcess.stage}.
   */
  stage(id: string, text: string): void {
    this.shardForTerminal(id).send({ type: "stage", id, text });
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
    for (const [shard, shardIds] of this.groupByOwnerShard(validIds)) {
      shard.send({ type: "batch-double-escape", ids: shardIds });
    }
  }

  /**
   * Fan one data payload to every id in a single per-shard pty-host message.
   * Used by fleet broadcast: every keystroke becomes one main→host message per
   * shard instead of N renderer→main IPC hops, cutting fan-out latency on
   * large fleets.
   */
  broadcastWrite(ids: string[], data: string): void {
    if (!Array.isArray(ids) || ids.length === 0 || typeof data !== "string" || data.length === 0)
      return;
    const validIds = ids.filter((id) => typeof id === "string" && id.length > 0);
    if (validIds.length === 0) return;
    for (const [shard, shardIds] of this.groupByOwnerShard(validIds)) {
      shard.send({ type: "broadcast-write", ids: shardIds, data });
    }
  }

  private groupByOwnerShard(ids: string[]): Map<PtyShard, string[]> {
    const groups = new Map<PtyShard, string[]>();
    for (const id of ids) {
      const shard = this.shardForTerminal(id);
      const list = groups.get(shard);
      if (list) {
        list.push(id);
      } else {
        groups.set(shard, [id]);
      }
    }
    return groups;
  }

  resize(id: string, cols: number, rows: number): void {
    this.shardForTerminal(id).send({ type: "resize", id, cols, rows });
  }

  kill(id: string, reason?: string, options?: { escalationDelayMs?: number }): void {
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
    this.shardForTerminal(id).send({
      type: "kill",
      id,
      reason,
      escalationDelayMs: options?.escalationDelayMs,
    });
  }

  /** Check if a terminal exists (based on local tracking) */
  hasTerminal(id: string): boolean {
    return this.pendingSpawns.has(id);
  }

  /**
   * Owning project of a terminal, from the locally tracked spawn options
   * (spawn() resolves a missing projectId from the active project context).
   * Null for unknown terminals — callers fall back to unscoped delivery.
   */
  getTerminalProjectId(id: string): string | null {
    const projectId = this.pendingSpawns.get(id)?.projectId;
    return typeof projectId === "string" && projectId.length > 0 ? projectId : null;
  }

  trash(id: string): void {
    void getTrashedPidTracker()
      .persistTrashed(id, this.terminalPids.get(id))
      .catch((err) => {
        console.warn("[PtyClient] persistTrashed failed:", err);
      });
    this.shardForTerminal(id).send({ type: "trash", id });
  }

  /** Restore terminal from trash. Returns true if terminal was tracked. */
  restore(id: string): boolean {
    getTrashedPidTracker().removeTrashed(id);
    const wasTracked = this.pendingSpawns.has(id);
    this.shardForTerminal(id).send({ type: "restore", id });
    return wasTracked;
  }

  setActivityTier(id: string, tier: PtyHostActivityTier, pollingIntervalMs?: number): void {
    this.shardForTerminal(id).send({ type: "set-activity-tier", id, tier, pollingIntervalMs });
  }

  /**
   * Report the UI-focused terminal for a window so the host's per-window
   * PortQueueManager/PortBatcher can prioritize it. Cached per window for replay
   * on port reconnect and host restart. Routed to the shard holding the
   * window's port — the focused terminal lives on the window's active project,
   * which is that shard by construction. Fire-and-forget — a dropped send only
   * loses prioritization until the next focus change or replay.
   */
  setFocusedTerminal(windowId: number, id: string | null): void {
    this.windowFocusedTerminals.set(windowId, id);
    this.shardForWindow(windowId).send({ type: "set-focused-terminal", windowId, id });
  }

  setResourceMonitoring(enabled: boolean): void {
    this.resourceMonitoringEnabled = enabled;
    for (const shard of this.shards.values()) {
      shard.send({ type: "set-resource-monitoring", enabled });
    }
  }

  setResourceProfile(profile: ResourceProfile): void {
    this.lastResourceProfile = profile;
    // The profile resets the host's process-tree cadence to its baseline; a
    // stale explicit interval must not be replayed over it after a restart.
    this.lastProcessTreePollIntervalMs = null;
    for (const shard of this.shards.values()) {
      shard.send({ type: "set-resource-profile", profile });
    }
  }

  setProcessTreePollInterval(ms: number): void {
    this.lastProcessTreePollIntervalMs = ms;
    for (const shard of this.shards.values()) {
      shard.send({ type: "set-process-tree-poll-interval", ms });
    }
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
    this.shardForTerminal(id).send({ type: "set-ipc-data-mirror", id, enabled });
  }

  private syncProjectContextToShard(shard: PtyShard, skipWindowIds?: ReadonlySet<number>): void {
    if (!shard.lifecycle.child) {
      shard.shouldResyncProjectContext = true;
      return;
    }

    for (const [windowId, ctx] of this.windowProjectContexts) {
      if (skipWindowIds?.has(windowId)) {
        continue;
      }
      // Only the shard that owns a window's project receives the projectPath:
      // the path triggers a pool drain/warm in the host, and a non-owning
      // shard warming its pool to another project's root is pure churn. The
      // bare context still lands so the shard's per-window data filter and
      // tier recompute stay correct.
      const includePath =
        ctx.projectPath !== undefined &&
        (!this.fabricEnabled || this.peekPlacementKey(ctx.projectId) === shard.key);
      if (ctx.mode === "switch" && ctx.projectId !== null) {
        shard.send({
          type: "project-switch",
          windowId,
          projectId: ctx.projectId,
          ...(includePath ? { projectPath: ctx.projectPath } : {}),
        });
      } else {
        shard.send({
          type: "set-active-project",
          windowId,
          projectId: ctx.projectId,
          ...(includePath ? { projectPath: ctx.projectPath } : {}),
        });
      }
    }

    // Replay per-window focused terminals on host restart. Windows with a
    // pending port replay via connectMessagePort instead, so skip them here to
    // avoid a duplicate send.
    for (const [windowId, focusedId] of this.windowFocusedTerminals) {
      if (skipWindowIds?.has(windowId)) continue;
      shard.send({ type: "set-focused-terminal", windowId, id: focusedId });
    }
  }

  /**
   * The project most recently marked active (across windows). Used by host-side
   * consumers — e.g. `PluginService.sendToActiveAgent` — to scope active-agent
   * resolution to the project the user is currently in.
   */
  getActiveProjectId(): string | null {
    return this.activeProjectId;
  }

  setActiveProject(
    windowId: number,
    projectId: string | null,
    projectPath?: string,
    panelCwds?: string[],
    projectEnv?: Record<string, string> | null
  ): void {
    this.activeProjectId = projectId;
    // panelCwds / projectEnv are transient warm hints for the first send only —
    // they are NOT stored in windowProjectContexts. A host restart replays via
    // syncProjectContextToShard against a freshly-empty pool with no pending
    // restore spawns, so re-warming saved panel cwds (or refiring the env hash)
    // would be wasted work.
    this.windowProjectContexts.set(windowId, { projectId, projectPath, mode: "active" });

    // Activating a project materializes its shard so the pool warm below runs
    // in the process the project's terminals will spawn in.
    const shard = this.ensureShardForProject(projectId);

    if (!shard.lifecycle.child) {
      shard.shouldResyncProjectContext = true;
      this.rerouteWindowPortIfNeeded(windowId);
      this.scheduleIdleSweep();
      return;
    }

    shard.send({
      type: "set-active-project",
      windowId,
      projectId,
      ...(projectPath ? { projectPath } : {}),
      ...(panelCwds && panelCwds.length > 0 ? { panelCwds } : {}),
      ...(projectEnv ? { projectEnv } : {}),
    });
    this.rerouteWindowPortIfNeeded(windowId);
    this.scheduleIdleSweep();
  }

  /**
   * Register the project context for an auxiliary renderer connection (a
   * paint-fabric surface view's synthetic connection id) WITHOUT the
   * window-activation side effects of setActiveProject: no global
   * active-project change, no pool warming — the owning window already did
   * both. The context is what connectMessagePort uses to derive the owning
   * shard and what it replays to the host after a port replace, so it must be
   * registered before the surface's port connects.
   */
  registerAuxConnectionContext(
    connectionId: number,
    projectId: string | null,
    projectPath?: string
  ): void {
    this.windowProjectContexts.set(connectionId, { projectId, projectPath, mode: "active" });
  }

  onProjectSwitch(windowId: number, projectId: string, projectPath?: string): void {
    this.activeProjectId = projectId;
    this.windowProjectContexts.set(windowId, { projectId, projectPath, mode: "switch" });

    const shard = this.ensureShardForProject(projectId);

    if (!shard.lifecycle.child) {
      shard.shouldResyncProjectContext = true;
      this.rerouteWindowPortIfNeeded(windowId);
      this.scheduleIdleSweep();
      return;
    }

    shard.send({
      type: "project-switch",
      windowId,
      projectId,
      ...(projectPath ? { projectPath } : {}),
    });
    this.rerouteWindowPortIfNeeded(windowId);
    this.scheduleIdleSweep();
  }

  async gracefulKill(id: string): Promise<string | null> {
    const shard = this.shardForTerminal(id);
    const promise = sendPtyHostRpc<GracefulKillResult>(
      shard,
      `graceful-kill-${id}`,
      (requestId) => ({ type: "graceful-kill", id, requestId }),
      { method: "graceful-kill", timeoutMs: PTY_TIMEOUTS["graceful-kill"] }
    );
    const result = await promise.catch((error: unknown) => {
      // Sending a kill to a host that isn't there only mutates local bookkeeping.
      // Skip whenever the host is known to be gone — either because the broker
      // clear told us via a typed BrokerError (HOST_EXITED / APP_SHUTDOWN), or
      // because we notice it ourselves (null child or disposed client, e.g.
      // restart pending, max restarts exhausted, or app quit arriving during
      // the 5s timeout window). TIMEOUT is excluded: a per-request timeout
      // with a live host should still escalate to a forced kill.
      const isHostGoneBrokerError = error instanceof BrokerError && error.code !== "TIMEOUT";
      if (isHostGoneBrokerError || !shard.lifecycle.child || this.isDisposed) {
        return { sessionId: null };
      }
      this.kill(id, "graceful-kill-timeout");
      return { sessionId: null };
    });
    return result.sessionId;
  }

  /**
   * Graceful project kill that reports whether the host actually confirmed the
   * teardown, so destructive callers (project close+kill, project/scratch
   * remove) can fail closed instead of wiping restoration state on a guess.
   *
   * Mirrors the single-terminal {@link gracefulKill} triage: a typed
   * BrokerError of HOST_EXITED/APP_SHUTDOWN (or a locally-observed dead/disposed
   * client) means the host is gone and teardown is real — confirmed, just with
   * no sessions to capture. A per-request TIMEOUT with a live host means the
   * teardown is NOT confirmed: agents may still be running, so the caller must
   * keep the project's restoration state and let the user retry. Unexpected
   * errors reject; callers treat that as fail-closed too.
   *
   * Contract of `confirmed: true`: the host acknowledged and ran the teardown
   * (graceful shutdown + a fallback hard kill per terminal, see
   * PtyManager.gracefulKillByProject), or the host is gone. It is NOT a
   * guarantee that every OS process was reaped, and it does not reconcile with
   * pty-host crash recovery, which can replay an in-flight `pendingSpawns`
   * terminal as a fresh incarnation after a host exit — that race is owned by
   * the crash-recovery path (#11339), not this method.
   */
  async gracefulKillByProjectConfirmed(
    projectId: string,
    options?: { preserveSession?: boolean }
  ): Promise<GracefulKillByProjectOutcome> {
    const shard = this.shardForProjectQuery(projectId);
    try {
      const sessions = await sendPtyHostRpc<Array<{ id: string; agentSessionId: string | null }>>(
        shard,
        `graceful-kill-by-project-${projectId}`,
        (requestId) => ({
          type: "graceful-kill-by-project",
          projectId,
          requestId,
          ...(options?.preserveSession !== undefined
            ? { preserveSession: options.preserveSession }
            : {}),
        }),
        { method: "graceful-kill-by-project", timeoutMs: PTY_TIMEOUTS["graceful-kill-by-project"] }
      );
      return { confirmed: true, sessions };
    } catch (error) {
      const isHostGoneBrokerError = error instanceof BrokerError && error.code !== "TIMEOUT";
      if (isHostGoneBrokerError || !shard.lifecycle.child || this.isDisposed) {
        // Host is gone: its terminals are gone with it. Teardown is confirmed;
        // no sessions were capturable.
        return { confirmed: true, sessions: [] };
      }
      if (error instanceof BrokerError && error.code === "TIMEOUT") {
        // Live host, per-request timeout — the kill was not acknowledged.
        return { confirmed: false, sessions: [] };
      }
      throw error;
    }
  }

  async gracefulKillByProject(
    projectId: string,
    options?: { preserveSession?: boolean }
  ): Promise<Array<{ id: string; agentSessionId: string | null }>> {
    return this.gracefulKillByProjectConfirmed(projectId, options)
      .then((outcome) => outcome.sessions)
      .catch(() => []);
  }

  async killByProject(projectId: string): Promise<number> {
    const shard = this.shardForProjectQuery(projectId);
    const promise = sendPtyHostRpc<number>(
      shard,
      `kill-by-project-${projectId}`,
      (requestId) => ({ type: "kill-by-project", projectId, requestId }),
      { method: "kill-by-project", timeoutMs: PTY_TIMEOUTS["kill-by-project"] }
    );
    return promise.catch(() => 0);
  }

  async getProjectStats(projectId: string): Promise<{
    terminalCount: number;
    processIds: number[];
    terminalTypes: Record<string, number>;
  }> {
    const shard = this.shardForProjectQuery(projectId);
    const promise = sendPtyHostRpc<{
      terminalCount: number;
      processIds: number[];
      terminalTypes: Record<string, number>;
    }>(shard, `project-stats-${projectId}`, (requestId) => ({
      type: "get-project-stats",
      projectId,
      requestId,
    }));
    return promise.catch(() => ({ terminalCount: 0, processIds: [], terminalTypes: {} }));
  }

  /**
   * On-demand rollup of resident memory across every live terminal's process
   * subtree, grouped by project. Reads the warm ProcessTreeCache in each shard —
   * no extra OS sweep — and merges across shards (a project lives on exactly
   * one shard, so rows never need cross-shard PID dedup). Resolves to an
   * unavailable rollup on IPC failure/timeout so callers never throw.
   */
  async getMemoryRollup(): Promise<MemoryRollup> {
    const shards = this.fanOutShards();
    const rollups = (
      await Promise.all(
        shards.map((shard) => {
          const promise = sendPtyHostRpc<MemoryRollup>(shard, "memory-rollup", (requestId) => ({
            type: "get-memory-rollup",
            requestId,
          }));
          return promise.catch(() => null);
        })
      )
    ).filter((rollup): rollup is MemoryRollup => rollup !== null);
    if (rollups.length === 0) {
      return {
        byProject: [],
        totalMemoryKb: 0,
        totalProcessCount: 0,
        terminalCount: 0,
        available: false,
        sampledAt: Date.now(),
      };
    }
    const merged = rollups.length === 1 ? rollups[0] : mergeMemoryRollups(rollups);
    // A shard that failed/timed out leaves its terminals unaccounted — the
    // partial numbers must not masquerade as a complete, trustworthy rollup
    // (consumers gate per-project memory displays on `available`).
    if (rollups.length < shards.length) {
      return { ...merged, available: false };
    }
    return merged;
  }

  /**
   * Acknowledge data processing for flow control.
   */
  acknowledgeData(id: string, byteCount: number): void {
    this.shardForTerminal(id).send({ type: "acknowledge-data", id, byteCount });
  }

  /**
   * Force resume a terminal that may be paused due to backpressure.
   * This is a user-initiated action to unblock a terminal when the
   * automatic flow control gets stuck.
   */
  forceResume(id: string): void {
    this.shardForTerminal(id).send({ type: "force-resume", id });
  }

  /** Get terminal IDs for a specific project */
  async getTerminalsForProjectAsync(projectId: string): Promise<string[]> {
    const shard = this.shardForProjectQuery(projectId);
    const promise = sendPtyHostRpc<string[]>(shard, `terminals-${projectId}`, (requestId) => ({
      type: "get-terminals-for-project",
      projectId,
      requestId,
    }));
    return promise.catch(() => []);
  }

  /** Get terminal info by ID */
  async getTerminalAsync(id: string): Promise<TerminalInfoResponse | null> {
    const shard = this.shardForTerminal(id);
    const promise = sendPtyHostRpc<TerminalInfoResponse | null>(
      shard,
      `terminal-${id}`,
      (requestId) => ({ type: "get-terminal", id, requestId })
    );
    return promise.catch(() => null);
  }

  /** Get available terminals (idle or waiting for user input), across all shards */
  async getAvailableTerminalsAsync(): Promise<TerminalInfoResponse[]> {
    const results = await Promise.all(
      this.fanOutShards().map((shard) => {
        const promise = sendPtyHostRpc<TerminalInfoResponse[]>(
          shard,
          "available-terminals",
          (requestId) => ({ type: "get-available-terminals", requestId })
        );
        return promise.catch(() => [] as TerminalInfoResponse[]);
      })
    );
    return results.flat();
  }

  /** Get terminals filtered by agent state, across all shards */
  async getTerminalsByStateAsync(
    state: import("../../shared/types/agent.js").AgentState
  ): Promise<TerminalInfoResponse[]> {
    const results = await Promise.all(
      this.fanOutShards().map((shard) => {
        const promise = sendPtyHostRpc<TerminalInfoResponse[]>(
          shard,
          `terminals-by-state-${state}`,
          (requestId) => ({ type: "get-terminals-by-state", state, requestId })
        );
        return promise.catch(() => [] as TerminalInfoResponse[]);
      })
    );
    return results.flat();
  }

  /** Get all terminals, across all shards */
  async getAllTerminalsAsync(): Promise<TerminalInfoResponse[]> {
    const results = await Promise.all(
      this.fanOutShards().map((shard) => {
        const promise = sendPtyHostRpc<TerminalInfoResponse[]>(
          shard,
          "all-terminals",
          (requestId) => ({ type: "get-all-terminals", requestId })
        );
        return promise.catch(() => [] as TerminalInfoResponse[]);
      })
    );
    return results.flat();
  }

  /**
   * Get an on-demand structured flow-control snapshot from the pty-host fabric
   * (per-terminal flow status, held pause tokens, queue depths, backpressure
   * stats, and resource-governor state). With multiple shards the top-level
   * governor/event-loop fields carry the worst-shard view and `shards` the
   * per-shard breakdown. Used by `DiagnosticsCollector` for support bundles.
   * Resolves to an empty snapshot on IPC failure/timeout — the diagnostics
   * caller never throws.
   */
  async getFlowControlSnapshotAsync(): Promise<FlowControlSnapshot> {
    const shards = this.fanOutShards();
    const results = (
      await Promise.all(
        shards.map((shard) => {
          const promise = sendPtyHostRpc<FlowControlSnapshot>(
            shard,
            "flow-control-snapshot",
            (requestId) => ({ type: "get-flow-control-snapshot", requestId })
          );
          return promise.then(
            (snapshot) => ({ shardKey: shard.key, snapshot }),
            () => null
          );
        })
      )
    ).filter(
      (entry): entry is { shardKey: string; snapshot: FlowControlSnapshot } => entry !== null
    );
    if (results.length === 0) {
      return {
        timestamp: Date.now(),
        terminals: [],
        queueDepth: [],
        totalPendingBytes: 0,
        stats: { pauseCount: 0, resumeCount: 0, suspendCount: 0, forceResumeCount: 0 },
        resourceGovernor: {
          isThrottling: false,
          isWarning: false,
          activeProfile: "balanced",
          smoothedUtilizationPercent: null,
          throttleDurationMs: 0,
        },
        eventLoop: null,
      };
    }
    // With every shard reporting and only one shard live, pass the snapshot
    // through untouched (legacy shape). A partial fan-out (a shard timed out)
    // always goes through the merge so the `shards` breakdown makes the
    // missing shard observable to diagnostics instead of silently vanishing.
    if (results.length === 1 && shards.length === 1) {
      return results[0].snapshot;
    }
    return mergeFlowControlSnapshots(results);
  }

  /**
   * On-demand worker-governance snapshot from the pty-host fabric (per-slot
   * analysis worker pool state + host process memory, summed across shards).
   * Resolves null when every shard fails/times out — the governance caller
   * reports the provider as errored rather than throwing.
   */
  async getWorkerGovernanceSnapshotAsync(): Promise<PtyHostWorkerGovernanceSnapshot | null> {
    const snapshots = (
      await Promise.all(
        this.fanOutShards().map((shard) => {
          const promise = sendPtyHostRpc<PtyHostWorkerGovernanceSnapshot>(
            shard,
            "worker-governance-snapshot",
            (requestId) => ({ type: "get-worker-governance-snapshot", requestId })
          );
          return promise.catch(() => null);
        })
      )
    ).filter((snapshot): snapshot is PtyHostWorkerGovernanceSnapshot => snapshot !== null);
    if (snapshots.length === 0) return null;
    if (snapshots.length === 1) return snapshots[0];
    return {
      timestamp: Math.max(...snapshots.map((s) => s.timestamp)),
      workers: snapshots.flatMap((s) => s.workers),
      hostMemory: {
        rssBytes: snapshots.reduce((sum, s) => sum + s.hostMemory.rssBytes, 0),
        heapUsedBytes: snapshots.reduce((sum, s) => sum + s.hostMemory.heapUsedBytes, 0),
        externalBytes: snapshots.reduce((sum, s) => sum + s.hostMemory.externalBytes, 0),
      },
    };
  }

  /**
   * Scan every terminal's semantic buffer for `query` and return one
   * ANSI-stripped snippet per matching terminal, across all shards. Substring
   * (case-insensitive) unless `isRegex` is true. Returns an empty array on
   * regex compile error or IPC failure — UI never throws on bad input.
   */
  async searchSemanticBuffersAsync(
    query: string,
    isRegex: boolean
  ): Promise<import("../../shared/types/ipc/terminal.js").SemanticSearchMatch[]> {
    const results = await Promise.all(
      this.fanOutShards().map((shard) => {
        const promise = sendPtyHostRpc<
          import("../../shared/types/ipc/terminal.js").SemanticSearchMatch[]
        >(shard, "semantic-search", (requestId) => ({
          type: "search-semantic-buffers",
          query,
          isRegex,
          requestId,
        }));
        return promise.catch(
          () => [] as import("../../shared/types/ipc/terminal.js").SemanticSearchMatch[]
        );
      })
    );
    return results.flat();
  }

  /** Replay terminal history */
  async replayHistoryAsync(id: string, maxLines: number = 100): Promise<number> {
    const shard = this.shardForTerminal(id);
    const promise = sendPtyHostRpc<number>(shard, `replay-${id}`, (requestId) => ({
      type: "replay-history",
      id,
      maxLines,
      requestId,
    }));
    return promise.catch(() => 0);
  }

  /**
   * Get serialized terminal state for fast restoration.
   * Returns the serialized state from the headless xterm instance.
   * @param id - Terminal identifier
   * @returns Serialized state string or null if terminal not found
   */
  async getSerializedStateAsync(id: string): Promise<string | null> {
    const shard = this.shardForTerminal(id);
    // Extended timeout for large terminals with lots of scrollback (see PTY_TIMEOUTS).
    const promise = sendPtyHostRpc<string | null>(
      shard,
      `serialize-${id}`,
      (requestId) => ({ type: "get-serialized-state", id, requestId }),
      { method: "get-serialized-state", timeoutMs: PTY_TIMEOUTS["get-serialized-state"] }
    );
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
    const shard = this.shardForTerminal(id);
    const promise = sendPtyHostRpc<import("../../shared/types/ipc.js").TerminalInfoPayload | null>(
      shard,
      `terminal-info-${id}`,
      (requestId) => ({ type: "get-terminal-info", id, requestId })
    );
    return promise.catch(() => null);
  }

  /** Get a snapshot of terminal state (async due to IPC) */
  async getTerminalSnapshot(id: string): Promise<TerminalSnapshot | null> {
    const shard = this.shardForTerminal(id);
    const promise = sendPtyHostRpc<TerminalSnapshot | null>(
      shard,
      `snapshot-${id}`,
      (requestId) => ({ type: "get-snapshot", id, requestId }),
      { method: "get-snapshot", timeoutMs: PTY_TIMEOUTS["get-snapshot"] }
    );
    return promise.catch(() => null);
  }

  /** Get snapshots for all terminals (async due to IPC), across all shards */
  async getAllTerminalSnapshots(): Promise<TerminalSnapshot[]> {
    const results = await Promise.all(
      this.fanOutShards().map((shard) => {
        const promise = sendPtyHostRpc<TerminalSnapshot[]>(
          shard,
          "all-snapshots",
          (requestId) => ({ type: "get-all-snapshots", requestId }),
          { method: "get-all-snapshots", timeoutMs: PTY_TIMEOUTS["get-all-snapshots"] }
        );
        return promise.catch(() => [] as TerminalSnapshot[]);
      })
    );
    return results.flat();
  }

  markChecked(id: string): void {
    this.shardForTerminal(id).send({ type: "mark-checked", id });
  }

  updateObservedTitle(id: string, title: string): void {
    this.shardForTerminal(id).send({ type: "update-observed-title", id, title });
  }

  async transitionState(
    id: string,
    event: { type: string; [key: string]: unknown },
    trigger: AgentStateChangeTrigger,
    confidence: number,
    spawnedAt?: number
  ): Promise<boolean> {
    const shard = this.shardForTerminal(id);
    const promise = sendPtyHostRpc<boolean>(
      shard,
      `transition-${id}`,
      (requestId) => ({
        type: "transition-state",
        id,
        requestId,
        event,
        trigger,
        confidence,
        spawnedAt,
      }),
      { method: "transition-state", timeoutMs: PTY_TIMEOUTS["transition-state"] }
    );
    return promise.catch(() => false);
  }

  /** Request every shard to trim scrollback on all terminals to reduce memory */
  trimState(targetLines: number): void {
    for (const shard of this.shards.values()) {
      shard.send({ type: "trim-state", targetLines });
    }
  }

  /** Suppress or resume terminal session persistence across all shards */
  suppressSessionPersistence(suppressed: boolean): void {
    this.sessionPersistSuppressed = suppressed;
    for (const shard of this.shards.values()) {
      shard.send({ type: "set-session-persist-suppressed", suppressed });
    }
  }

  /** Pause all PTY processes during system sleep to prevent buffer overflow */
  pauseAll(): void {
    for (const shard of this.shards.values()) {
      shard.send({ type: "pause-all" });
    }
  }

  /** Resume all PTY processes after system wake with incremental stagger */
  resumeAll(): void {
    for (const shard of this.shards.values()) {
      shard.send({ type: "resume-all" });
    }
  }

  /** Pause health checks during system sleep to prevent time-drift false positives */
  pauseHealthCheck(): void {
    this.healthChecksPaused = true;
    for (const shard of this.shards.values()) {
      shard.watchdog.pause();
    }
  }

  /** Resume health checks after system wake with handshake verification */
  resumeHealthCheck(): void {
    this.healthChecksPaused = false;
    for (const shard of this.shards.values()) {
      shard.watchdog.resume();
    }
  }

  manualRestart(): void {
    for (const shard of this.shards.values()) {
      shard.lifecycle.manualRestart();
    }
  }

  dispose(): void {
    if (this.isDisposed) return;
    this.isDisposed = true;

    getTrashedPidTracker().clearAll();
    console.log("[PtyClient] Disposing...");

    for (const timer of this.shardRetirementTimers.values()) {
      clearTimeout(timer);
    }
    this.shardRetirementTimers.clear();

    // Per shard: watchdog, lifecycle (posts `dispose` to the host, force-kills
    // after 1s), pending ports, and the broker (rejects pending promises with
    // "Broker disposed"; callers convert to sentinel values via .catch()).
    for (const shard of this.shards.values()) {
      shard.dispose();
    }
    this.shards.clear();

    this.pendingSpawns.clear();
    this.pendingKillCount.clear();
    this.windowProjectContexts.clear();
    this.windowFocusedTerminals.clear();
    this.ipcDataMirrorIds.clear();
    this.terminalPids.clear();
    this.terminalOwners.clear();
    this.projectShardOverrides.clear();
    this.windowPortShard.clear();
    this.signalAggregator.clear();
    this.removeAllListeners();

    console.log("[PtyClient] Disposed");
  }

  /** Check if the (default-shard) host is running and initialized */
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

/**
 * Per-shard emitter handed to the event router: every `emit` the router (or
 * the events bridge callbacks) performs is redirected into the fabric's
 * {@link PtyClient} funnel, which does cross-shard bookkeeping and then
 * re-emits on the public client emitter. The proxy itself never has
 * listeners.
 */
class ShardEventEmitter extends EventEmitter {
  constructor(private readonly forward: (event: string, args: unknown[]) => boolean) {
    super();
  }

  override emit(event: string | symbol, ...args: unknown[]): boolean {
    return this.forward(String(event), args);
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
