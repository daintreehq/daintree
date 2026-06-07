/**
 * Message protocol types for Pty Host IPC communication.
 *
 * This module defines the message format for communication between
 * the Main process (PtyClient) and the Pty Host (UtilityProcess).
 *
 * All types are serializable (no functions, no circular refs) for IPC transport.
 */

import type { AgentState, AgentId, WaitingReason } from "./agent.js";
import type { PanelKind, TerminalFlowStatus, PanelTitleMode } from "./panel.js";
import type { ResourceProfile } from "./resourceProfile.js";
import type { BuiltInAgentId } from "../config/agentIds.js";
import type { SemanticSearchMatch, TerminalInfoPayload } from "./ipc/terminal.js";

export type { TerminalFlowStatus };

/**
 * Discriminator for the wire-level `agent-state-transition-dropped` event.
 * Lives in this file (rather than the schema) because it crosses the pty-host
 * wire protocol — every reason must be representable as a serializable
 * string. Mirrors `AgentStateTransitionDropReasonSchema` in
 * `electron/schemas/agent.ts`; keep the two in lockstep.
 *
 * Note: the bus event (`agent:state-transition-dropped` after the bridge)
 * is the source of truth for diagnostics — the `transition-result` wire
 * does NOT carry this discriminator; it only carries `success: boolean`.
 */
export type AgentStateTransitionDropReason =
  | "no-op"
  | "hysteresis"
  | "stale-session"
  | "schema-invalid";

/** Options for spawning a new PTY process (matches PtyManager interface) */
export interface PtyHostSpawnOptions {
  cwd: string;
  shell?: string;
  args?: string[];
  env?: Record<string, string>;
  cols: number;
  rows: number;
  /**
   * Optional command submitted immediately after spawn. Used as detector seed
   * so toolbar-launched agents and command-launched processes enter the same
   * runtime identity path as typed shell commands.
   */
  command?: string;
  kind?: PanelKind;
  /**
   * Launch hint — the agent this terminal is being launched to run. NOT an
   * identity. Used only to key agent-specific settings (model, flags, session
   * resume) and to pick the right auto-inject command. See
   * `docs/architecture/terminal-identity.md`.
   */
  launchAgentId?: AgentId;
  title?: string;
  projectId?: string;
  /** Whether to restore previous session content (default: true). Set to false on restart. */
  restore?: boolean;
  /** Whether to kill the PTY when the frontend disconnects (no terminal registry entry) */
  isEphemeral?: boolean;
  /** Process-level flags captured at launch time (e.g. --dangerously-skip-permissions) */
  agentLaunchFlags?: string[];
  /** Model ID selected at launch time for per-panel model selection */
  agentModelId?: string;
  /** Worktree the terminal was spawned in; used when persisting agent session history */
  worktreeId?: string;
  /** Preset ID the agent was launched with (needed for fallback chain lookup on exit). */
  agentPresetId?: string;
  /** Preset brand color captured by the renderer for reconnect/orphan chrome recovery. */
  agentPresetColor?: string;
  /** Original user-selected preset ID; unchanged across fallback hops for revert UX. */
  originalAgentPresetId?: string;
}

/**
 * Requests sent from Main → Host.
 * Each request is a discriminated union type for compile-time safety.
 */
export type PtyHostRequest =
  | { type: "spawn"; id: string; options: PtyHostSpawnOptions }
  | { type: "resize"; id: string; cols: number; rows: number }
  | { type: "write"; id: string; data: string; traceId?: string }
  | { type: "broadcast-write"; ids: string[]; data: string }
  | { type: "submit"; id: string; text: string }
  | { type: "batch-double-escape"; ids: string[] }
  | { type: "kill"; id: string; reason?: string; escalationDelayMs?: number }
  | { type: "trash"; id: string }
  | { type: "restore"; id: string }
  | {
      type: "set-activity-tier";
      id: string;
      tier: PtyHostActivityTier;
      /**
       * Optional renderer-side cadence hint. Lets the PTY-host scheduler use a
       * polling interval other than the binary tier default (active=50ms,
       * background=500ms) without widening the {@link PtyHostActivityTier}
       * union. Issue #8596 introduces 200ms for VISIBLE-unfocused panes; the
       * PTY host falls back to the tier default when this field is omitted.
       */
      pollingIntervalMs?: number;
    }
  | { type: "wake-terminal"; id: string; requestId: string }
  | {
      type: "set-active-project";
      windowId: number;
      projectId: string | null;
      /** Filesystem path of the project; used to warm the PTY pool at the project root. */
      projectPath?: string;
      /**
       * Per-panel working directories from restored session state, in
       * warm-priority order (active worktree first, then most-recently-active).
       * On session restore each panel spawns at its own worktree cwd rather
       * than the project root, so warming only `projectPath` always misses the
       * first terminal. The pty-host warms these extra cwds after the root
       * drain/refill so the first restored panel hits the pool (#9774).
       */
      panelCwds?: string[];
      /**
       * Merged project env (global + project settings) computed at the Main
       * process, sent so the pty-host can warm non-empty envHash slots for
       * plain PTY panels (#9810). `null` when neither global nor project env
       * is present — the pty-host falls back to the env-empty warm path. The
       * pty-host is the single owner of hash computation, which guarantees
       * the warmed key matches the `acquireByKey` lookup at spawn time.
       */
      projectEnv?: Record<string, string> | null;
    }
  | {
      type: "project-switch";
      windowId: number;
      projectId: string;
      /** Filesystem path of the project; used to warm the PTY pool at the project root. */
      projectPath?: string;
    }
  | { type: "disconnect-port"; windowId: number }
  | { type: "kill-by-project"; projectId: string; requestId: string }
  | { type: "get-project-stats"; projectId: string; requestId: string }
  | { type: "get-snapshot"; id: string; requestId: string }
  | { type: "get-all-snapshots"; requestId: string }
  | { type: "mark-checked"; id: string }
  | { type: "update-observed-title"; id: string; title: string }
  | {
      type: "transition-state";
      id: string;
      requestId: string;
      event: { type: string; [key: string]: unknown };
      trigger: string;
      confidence: number;
      spawnedAt?: number;
    }
  | { type: "health-check" }
  | { type: "pause-all" }
  | { type: "resume-all" }
  | { type: "dispose" }
  | { type: "set-log-level-overrides"; overrides: Record<string, string> }
  | { type: "get-terminals-for-project"; projectId: string; requestId: string }
  | { type: "get-terminal"; id: string; requestId: string }
  | { type: "replay-history"; id: string; maxLines: number; requestId: string }
  | { type: "get-serialized-state"; id: string; requestId: string }
  | {
      type: "init-buffers";
      visualBuffers: SharedArrayBuffer[];
      analysisBuffer: SharedArrayBuffer;
      visualSignalBuffer: SharedArrayBuffer;
    }
  | { type: "connect-port"; windowId: number }
  | { type: "get-terminal-info"; id: string; requestId: string }
  | { type: "force-resume"; id: string }
  | { type: "acknowledge-data"; id: string; byteCount: number }
  | { type: "set-analysis-enabled"; id: string; enabled: boolean }
  | { type: "get-available-terminals"; requestId: string }
  | { type: "get-terminals-by-state"; state: AgentState; requestId: string }
  | { type: "get-all-terminals"; requestId: string }
  | {
      type: "search-semantic-buffers";
      query: string;
      isRegex: boolean;
      requestId: string;
    }
  | { type: "set-ipc-data-mirror"; id: string; enabled: boolean }
  | { type: "graceful-kill"; id: string; requestId: string }
  | {
      type: "graceful-kill-by-project";
      projectId: string;
      requestId: string;
      preserveSession?: boolean;
    }
  | { type: "trim-state"; targetLines: number }
  | { type: "set-resource-monitoring"; enabled: boolean }
  | { type: "set-session-persist-suppressed"; suppressed: boolean }
  | { type: "set-resource-profile"; profile: ResourceProfile }
  | { type: "set-process-tree-poll-interval"; ms: number };

/**
 * Terminal snapshot data sent from Host → Main for state queries.
 */
export interface PtyHostTerminalSnapshot {
  id: string;
  lines: string[];
  lastInputTime: number;
  lastOutputTime: number;
  lastCheckTime: number;
  kind?: PanelKind;
  /** Launch hint — agent this terminal was launched to run. Not identity. */
  launchAgentId?: AgentId;
  agentState?: AgentState;
  lastStateChange?: number;
  spawnedAt: number;
}

/**
 * Events sent from Host → Main.
 * Forward processed events back to Main process.
 */
export type PtyHostEvent =
  | { type: "data"; id: string; data: string }
  | { type: "exit"; id: string; exitCode: number; signal?: number }
  | { type: "error"; id: string; error: string }
  | { type: "spawn-result"; id: string; result: SpawnResult }
  | {
      type: "wake-result";
      requestId: string;
      id: string;
      state: string | null;
      warnings?: string[];
    }
  | { type: "kill-by-project-result"; requestId: string; killed: number }
  | {
      type: "project-stats";
      requestId: string;
      stats: {
        terminalCount: number;
        processIds: number[];
        detectedAgents: Record<string, number>;
      };
    }
  | {
      type: "agent-state";
      id: string;
      agentId?: AgentId;
      state: AgentState;
      previousState: AgentState;
      timestamp: number;
      traceId?: string;
      trigger: string;
      confidence: number;
      /** Terminal cwd (used by PreAgentSnapshotService as the git target). */
      cwd?: string;
      waitingReason?: WaitingReason;
      sessionCost?: number;
      sessionTokens?: number;
      /**
       * Live activity-temperature reading at the moment the transition was
       * committed. Present only for transitions that flow through the activity
       * detector. The resize `suppressed` flag is intentionally NOT carried —
       * it is a different signal and would conflate transition-level decisions
       * with resize-quiet observation in the diagnostics view.
       */
      temperature?: number;
      /** Heat impulse that drove the live temperature sample. */
      heatAdded?: number;
      /** Number of changed characters in the most recent sample. */
      changedChars?: number;
    }
  | {
      type: "agent-state-transition-dropped";
      id: string;
      agentId?: AgentId;
      worktreeId?: string;
      outcome: AgentStateTransitionDropReason;
      currentState: AgentState;
      attemptedState?: AgentState;
      trigger?: string;
      confidence?: number;
      cwd?: string;
      spawnedAt?: number;
      terminalSpawnedAt?: number;
      reason?: string;
      validationErrors?: string[];
      traceId?: string;
      timestamp: number;
    }
  | {
      type: "agent-detected";
      terminalId: string;
      /** Detected agent identity (lowercase built-in agent id) if a known agent is running. */
      agentType?: string;
      /** Non-agent process icon id (npm, yarn, etc.) if a recognised plain process is running. */
      processIconId?: string;
      processName: string;
      /** Default title derived from detection — written into panel.title when titleMode === "default". */
      defaultTitle?: string;
      timestamp: number;
    }
  | {
      type: "agent-exited";
      terminalId: string;
      agentType?: string;
      /** Default title derived from the demoted/launched identity — written into panel.title when titleMode === "default". */
      defaultTitle?: string;
      timestamp: number;
      exitKind?: "subcommand" | "terminal";
    }
  | { type: "agent-spawned"; payload: AgentSpawnedPayload }
  | { type: "agent-output"; payload: AgentOutputPayload }
  | { type: "agent-completed"; payload: AgentCompletedPayload }
  | { type: "agent-killed"; payload: AgentKilledPayload }
  | { type: "terminal-trashed"; id: string; expiresAt: number }
  | { type: "terminal-restored"; id: string }
  | { type: "terminal-pid"; id: string; pid: number }
  | { type: "snapshot"; id: string; requestId: string; snapshot: PtyHostTerminalSnapshot | null }
  | { type: "all-snapshots"; requestId: string; snapshots: PtyHostTerminalSnapshot[] }
  | { type: "transition-result"; id: string; requestId: string; success: boolean }
  | { type: "pong" }
  | { type: "ready" }
  | { type: "terminals-for-project"; requestId: string; terminalIds: string[] }
  | { type: "terminal-info"; requestId: string; terminal: PtyHostTerminalInfo | null }
  | { type: "replay-history-result"; requestId: string; replayed: number }
  | { type: "serialized-state"; requestId: string; id: string; state: string | null }
  | { type: "terminal-diagnostic-info"; requestId: string; info: TerminalInfoPayload | null }
  | { type: "available-terminals"; requestId: string; terminals: PtyHostTerminalInfo[] }
  | { type: "terminals-by-state"; requestId: string; terminals: PtyHostTerminalInfo[] }
  | { type: "all-terminals"; requestId: string; terminals: PtyHostTerminalInfo[] }
  | {
      type: "semantic-search-result";
      requestId: string;
      matches: SemanticSearchMatch[];
      error?: "invalid-regex";
    }
  | {
      type: "terminal-status";
      id: string;
      status: TerminalFlowStatus;
      bufferUtilization?: number;
      pauseDuration?: number;
      reason?: string;
      /** Byte count discarded — only set when status is "data-loss". */
      droppedBytes?: number;
      timestamp: number;
    }
  | {
      type: "host-memory-warning";
      isWarning: boolean;
      utilizationPercent: number;
      timestamp: number;
    }
  | {
      type: "host-throttled";
      isThrottled: boolean;
      reason?: string;
      duration?: number;
      forced?: boolean;
      timestamp: number;
    }
  | {
      type: "terminal-reliability-metric";
      payload: TerminalReliabilityMetricPayload;
    }
  | {
      type: "graceful-kill-result";
      requestId: string;
      id: string;
      agentSessionId: string | null;
    }
  | {
      type: "graceful-kill-by-project-result";
      requestId: string;
      results: Array<{ id: string; agentSessionId: string | null }>;
    }
  | {
      type: "fd-leak-warning";
      fdCount: number;
      activeTerminals: number;
      estimatedLeaked: number;
      orphanedPids: number[];
      ptmxLimit: number | null;
      timestamp: number;
    }
  | {
      type: "resource-metrics";
      metrics: TerminalResourceBatchPayload;
      timestamp: number;
    }
  | {
      type: "broadcast-write-result";
      results: BroadcastWriteTargetResult[];
    };

export interface FdLeakWarningPayload {
  fdCount: number;
  activeTerminals: number;
  estimatedLeaked: number;
  orphanedPids: number[];
  ptmxLimit: number | null;
  timestamp: number;
}

/**
 * Sub-union of host-to-main events that carry a `requestId` field — i.e. broker
 * responses correlated with a `register()` call on the main side. Use this with
 * `isPtyHostResponseEvent()` to safely call `broker.resolve(event.requestId, …)`
 * without `as any` casts: the discriminant union of `PtyHostEvent` already types
 * `requestId` on every response member, but a switch case can't reach it without
 * narrowing first.
 */
export type PtyHostResponseEvent = Extract<PtyHostEvent, { requestId: string }>;

export function isPtyHostResponseEvent(event: PtyHostEvent): event is PtyHostResponseEvent {
  return "requestId" in event && typeof (event as { requestId?: unknown }).requestId === "string";
}

/** Terminal info sent from Host → Main for getTerminal queries */
export interface PtyHostTerminalInfo {
  id: string;
  projectId?: string;
  kind?: PanelKind;
  /** Launch hint — agent this terminal was launched to run. Not identity. */
  launchAgentId?: AgentId;
  title?: string;
  titleMode?: PanelTitleMode;
  cwd: string;
  agentState?: AgentState;
  waitingReason?: WaitingReason;
  lastStateChange?: number;
  spawnedAt: number;
  isTrashed?: boolean;
  trashExpiresAt?: number;
  /** Current activity tier: "active" (foreground) or "background" (project switched away) */
  activityTier?: "active" | "background";
  /** Whether this terminal has an active PTY process (false for orphaned terminals that exited) */
  hasPty?: boolean;
  /** Captured agent session ID from graceful shutdown */
  agentSessionId?: string;
  /** Process-level flags captured at launch time (e.g. --dangerously-skip-permissions) */
  agentLaunchFlags?: string[];
  /** Model ID selected at launch time for per-panel model selection */
  agentModelId?: string;
  /** Worktree the terminal was spawned in; used when persisting agent session history */
  worktreeId?: string;
  /** Preset ID the agent was launched with. */
  agentPresetId?: string;
  /** Preset brand color captured at launch time. */
  agentPresetColor?: string;
  /** Original user-selected preset ID; unchanged across fallback hops. */
  originalAgentPresetId?: string;
  /** Set once on first runtime agent detection; never cleared. Sticky across agent exit/re-enter within session. */
  everDetectedAgent?: boolean;
  /** Runtime-detected agent identity (cleared when the agent exits). */
  detectedAgentId?: BuiltInAgentId;
  /** Runtime-detected non-agent process icon id (npm, yarn, etc.). Cleared when the process exits. */
  detectedProcessId?: string;
}

/** Payload for agent:spawned event */
export interface AgentSpawnedPayload {
  agentId: string;
  terminalId: string;
  timestamp: number;
}

/** Payload for agent:output event */
export interface AgentOutputPayload {
  agentId: string;
  data: string;
  timestamp: number;
  traceId?: string;
  terminalId?: string;
}

/** Payload for agent:completed event */
export interface AgentCompletedPayload {
  agentId: string;
  exitCode: number;
  duration: number;
  timestamp: number;
  traceId?: string;
  terminalId?: string;
}

/** Payload for agent:killed event */
export interface AgentKilledPayload {
  agentId: string;
  reason?: string;
  timestamp: number;
  traceId?: string;
  terminalId?: string;
}

/**
 * Terminal activity tier (streaming policy).
 *
 * Controls backend streaming behavior and resource allocation:
 * - `active`: Full visual streaming to SAB/IPC (50ms ActivityMonitor polling)
 * - `background`: Visual streaming suppressed, wake snapshots only (500ms polling)
 *                 Analysis buffer writes continue for agent state detection
 *
 * Maps from renderer TerminalRefreshTier:
 * - BURST/FOCUSED → active
 * - VISIBLE → active (for now, may become background in future)
 * - BACKGROUND → background
 */
export type PtyHostActivityTier = "active" | "background";

/** Error codes for spawn failures */
export type SpawnErrorCode =
  | "ENOENT" // Shell or command not found
  | "EACCES" // Permission denied
  | "ENOTDIR" // Working directory does not exist (or path component is not a directory)
  | "EIO" // I/O error (e.g., PTY allocation failure)
  | "EMFILE" // Per-process file descriptor limit reached
  | "EAGAIN" // Process limit reached (fork failed)
  | "ENOMEM" // Out of memory at spawn time
  | "ENXIO" // PTY pool exhausted on macOS
  | "EBUSY" // Terminal device busy
  | "DISCONNECTED" // Terminal process no longer exists in backend (e.g., after project switch)
  | "PENDING_SPAWNS_CAPPED" // PtyClient.pendingSpawns admission cap hit (restart-storm guard)
  | "UNKNOWN"; // Unknown error

/** Result of a spawn operation */
export interface SpawnResult {
  success: boolean;
  id: string;
  error?: SpawnError;
}

/** Details of a spawn error */
export interface SpawnError {
  code: SpawnErrorCode;
  message: string;
  errno?: number;
  syscall?: string;
  path?: string;
}

/** Crash type classification based on exit codes */
export type CrashType =
  | "OUT_OF_MEMORY"
  | "ASSERTION_FAILURE"
  | "SIGNAL_TERMINATED"
  | "UNKNOWN_CRASH"
  | "CLEAN_EXIT";

/** Payload for terminal status events (flow control) */
export interface TerminalStatusPayload {
  id: string;
  status: TerminalFlowStatus;
  bufferUtilization?: number;
  pauseDuration?: number;
  reason?: string;
  /** Byte count discarded — only set when status is "data-loss". */
  droppedBytes?: number;
  timestamp: number;
}

/**
 * Per-target outcome from a fleet `broadcast-write`. `ok: true` means the
 * pty-host successfully called `pty.write()` for that target. `ok: false`
 * means the synchronous write threw — typically a dead pipe (EPIPE/EIO/EBADF/
 * ECONNRESET) — and the renderer should treat the target as gone.
 */
export interface BroadcastWriteTargetResult {
  id: string;
  ok: boolean;
  error?: { code?: string; message: string };
}

/** Payload delivered to the renderer after every fleet broadcast write. */
export interface BroadcastWriteResultPayload {
  results: BroadcastWriteTargetResult[];
}

/** Payload for host crash events */
export interface HostCrashPayload {
  code: number | null;
  signal: string | null;
  crashType: CrashType;
  timestamp: number;
}

/** Payload for host throttle events (memory pressure) */
export interface HostThrottlePayload {
  isThrottled: boolean;
  reason?: string;
  duration?: number;
  forced?: boolean;
  timestamp: number;
}

/** Payload for terminal reliability metrics (backpressure/suspend/wake) */
export interface TerminalReliabilityMetricPayload {
  terminalId: string;
  metricType:
    | "pause-start"
    | "pause-end"
    | "suspend"
    | "wake-latency"
    | "pending-byte-cap-hit"
    | "pending-bytes-gauge"
    | "throughput-rate"
    | "tier-transition"
    | "pause-duration-gauge"
    | "queue-depth-gauge"
    | "data-loss-count";
  timestamp: number;
  durationMs?: number;
  bufferUtilization?: number;
  shardIndex?: number;
  serializedStateBytes?: number;
  wakeLatencyMs?: number;
  totalPendingBytes?: number;
  perTerminal?: Array<{ terminalId: string; pendingBytes: number }>;
  totalBytesPerSecond?: number;
  pauseCountDelta?: number;
  perTerminalThroughput?: Array<{
    terminalId: string;
    bytesPerSecond: number;
    avgPacketSizeBytes: number;
  }>;
  /** Previous activity tier — only set when metricType is "tier-transition". */
  tierTransitionFrom?: PtyHostActivityTier;
  /** New activity tier — only set when metricType is "tier-transition". */
  tierTransitionTo?: PtyHostActivityTier;
  /** Call-site label identifying which path drove the transition. */
  tierTransitionReason?: string;
  /** Snapshot of pause-coordinator holds at transition time (sorted, possibly empty). */
  tierTransitionHeldTokens?: string[];
  /**
   * Used by `pause-duration-gauge`: per-paused-terminal held duration sampled
   * at the metric tick. Field name `heldDurationMs` distinguishes the gauge
   * (a point-in-time state) from `durationMs` on `pause-end` (a span resolved
   * at resume).
   */
  perTerminalHeld?: Array<{ terminalId: string; heldDurationMs: number }>;
  /**
   * Used by `queue-depth-gauge`: per-terminal queue depth for the live IPC
   * and per-window MessagePort paths. Excludes the FUTURE_SAB path
   * (dead in production) so the dead-code and live paths stay independently
   * observable. The `layer` discriminator lets consumers split per-path
   * attribution in one pass.
   */
  perTerminalQueueDepth?: Array<{
    terminalId: string;
    layer: "ipc" | "port";
    pendingBytes: number;
  }>;
  /**
   * Used by `data-loss-count`: number of bytes dropped since the last tick.
   * Always paired with `dataLossCountDelta` (one or more chunks may be
   * dropped per drop event).
   */
  droppedBytesDelta?: number;
  /** Used by `data-loss-count`: number of drop events since the last tick. */
  dataLossCountDelta?: number;
}

/**
 * Messages sent from Renderer → Pty Host via MessagePort (direct channel).
 * These bypass the Main process for low-latency terminal input.
 */
export type RendererToPtyHostMessage =
  | { type: "write"; id: string; data: string; traceId?: string }
  | { type: "resize"; id: string; cols: number; rows: number }
  | { type: "ack"; id: string; bytes: number };

/**
 * Messages sent from Pty Host → Renderer via MessagePort (direct channel).
 * These bypass the Main process for low-latency terminal output.
 *
 * `tier-changed` reconciles the renderer's dedupe baseline when the host
 * rewrites a terminal's activity tier on its own (window connect/disconnect/
 * project switch via `recomputeActivityTiers`). It rides the same per-window
 * MessagePort as `data`, so it is FIFO-ordered ahead of any subsequently
 * suppressed/emitted chunk — routing it through the Main process instead would
 * race the direct data path and lose that ordering guarantee.
 *
 * `terminal-status` carries a per-window `data-loss` pulse for the multi-window
 * fan-out case: when one window's batcher accepts a chunk but another window's
 * is saturated, the loss is local to the saturated window. The Main-process
 * `terminal-status` event is a broadcast to every window, so it can't signal a
 * single window without falsely alerting the ones that received the data. This
 * variant rides the saturated window's own MessagePort instead, FIFO-ordered
 * with its data so the discontinuity marker lands in the right place.
 */
export type PtyHostToRendererMessage =
  | {
      type: "data";
      id: string;
      data: Uint8Array;
      bytes: number;
    }
  | {
      type: "tier-changed";
      id: string;
      tier: "active" | "background";
    }
  | {
      type: "terminal-status";
      id: string;
      status: TerminalFlowStatus;
      bufferUtilization?: number;
      /** Byte count discarded — only set when status is "data-loss". */
      droppedBytes?: number;
      timestamp: number;
    };

/** Per-process resource breakdown entry */
export interface TerminalResourceProcess {
  pid: number;
  comm: string;
  cpuPercent: number;
  memoryKb: number;
}

/** Aggregated resource sample for a single terminal */
export interface TerminalResourceSample {
  cpuPercent: number;
  memoryKb: number;
  breakdown: TerminalResourceProcess[];
}

/** Batched resource metrics for all monitored terminals */
export type TerminalResourceBatchPayload = Record<string, TerminalResourceSample>;
