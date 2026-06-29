import type * as pty from "node-pty";
import type { Terminal as HeadlessTerminal } from "@xterm/headless";
import type { SerializeAddon } from "@xterm/addon-serialize";
import type { AgentState, AgentId, WaitingReason } from "../../../shared/types/agent.js";
import type { TerminalCheckResult } from "../../../shared/types/checkResult.js";
import type { PanelKind, PanelTitleMode } from "../../../shared/types/panel.js";
import type { BuiltInAgentId } from "../../../shared/config/agentIds.js";
import type { PtyHostSpawnOptions } from "../../../shared/types/pty-host.js";
import type { ProcessDetector } from "../ProcessDetector.js";

// Re-export PtyHostSpawnOptions as PtySpawnOptions for backward compatibility/internal usage
export type PtySpawnOptions = PtyHostSpawnOptions;

/**
 * TerminalPublicState - JSON-serializable state that can safely cross IPC boundaries.
 * Contains all the "identity" and "observable state" of a terminal, but NO runtime resources.
 * This type should be used for:
 * - State persistence
 * - IPC payloads
 * - External APIs
 *
 * Identity fields follow the canonical model in
 * `docs/architecture/terminal-identity.md`: `detectedAgentId` is live
 * detection, while `launchAgentId` is durable launch affinity until a strong
 * exit signal (`agentState: "exited"` / terminal exit) demotes the terminal.
 */
export interface TerminalPublicState {
  id: string;
  projectId?: string;
  cwd: string;
  shell: string;
  kind?: PanelKind;
  /**
   * Durable launch affinity — the agent this terminal was launched to run.
   * Used to key agent-specific settings, auto-inject commands, and keep
   * restored agent terminals branded until explicit exit.
   */
  launchAgentId?: AgentId;
  title?: string;
  titleMode?: PanelTitleMode;
  /** Command submitted immediately after shell spawn, if any. */
  command?: string;
  spawnedAt: number;
  /** Wall-clock timestamp of the first PTY data byte after spawn. */
  firstByteAt?: number;
  /** Wall-clock timestamp when BootDetector first declared boot complete. */
  bootCompleteAt?: number;
  wasKilled?: boolean;
  isExited?: boolean;
  agentState?: AgentState;
  waitingReason?: WaitingReason;
  lastStateChange?: number;
  traceId?: string;
  analysisEnabled: boolean;
  lastInputTime: number;
  lastOutputTime: number;
  lastCheckTime: number;
  /**
   * Live detected identity — the agent currently running in this PTY. The ONE
   * field that drives chrome. Cleared when the detected agent exits.
   * Not persisted. See `docs/architecture/terminal-identity.md`.
   */
  detectedAgentId?: BuiltInAgentId;
  /** Runtime-detected non-agent process icon id (npm, yarn, python, etc.). Cleared when the process exits. */
  detectedProcessIconId?: string;
  /**
   * Sticky live-session flag. True once runtime detection fires in this session,
   * even if no agent is currently detected. Not persisted.
   */
  everDetectedAgent?: boolean;
  restartCount: number;
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
  /** Resolved argv passed to pty.spawn() at launch time (for diagnostics) */
  spawnArgs?: string[];
  /** Exit code from the PTY process (set on any exit, preserved or not) */
  exitCode?: number;
  /** Raw OS signal number that terminated the PTY process, when applicable. */
  exitSignal?: number;
  /**
   * Parsed test/lint/build result from the most recently observed check
   * summary (issue #10682). Best-effort, not an authoritative exit code — see
   * `TerminalCheckResult`. Updated in `AgentStateService` on settling
   * transitions; ephemeral (not persisted).
   */
  lastCheckResult?: TerminalCheckResult;
  /** Worktree the terminal was spawned in; used when persisting agent session history */
  worktreeId?: string;
  /** Last non-useless title observed from xterm OSC updates (renderer-synced) */
  lastObservedTitle?: string;
  /** Currently active preset ID (updated on each fallback hop). */
  agentPresetId?: string;
  /** Preset brand color captured at launch time. */
  agentPresetColor?: string;
  /** User-originally-selected preset ID; immutable across fallback hops. */
  originalAgentPresetId?: string;
}

/**
 * TerminalRuntime - Internal runtime resources that should NEVER cross IPC boundaries.
 * These are Node.js/native objects that cannot be serialized.
 * This type is private to the PTY host layer.
 */
export interface TerminalRuntime {
  ptyProcess: pty.IPty;
  headlessTerminal?: HeadlessTerminal;
  serializeAddon?: SerializeAddon;
  processDetector?: ProcessDetector;
  outputBuffer: string;
  semanticBuffer: string[];
}

/**
 * TerminalInfo - Combined interface for backward compatibility.
 * New code should prefer using TerminalPublicState + TerminalRuntime separately.
 *
 * @deprecated Access public state via TerminalProcess.getPublicState() and
 * runtime resources via TerminalProcess methods (getPid(), write(), etc.)
 */
export interface TerminalInfo extends TerminalPublicState {
  // Runtime resources - access via TerminalProcess methods instead
  /** @deprecated Use TerminalProcess.getPtyProcess() internally */
  ptyProcess: pty.IPty;
  /** @deprecated Use TerminalProcess.getHeadlessTerminal() */
  headlessTerminal?: HeadlessTerminal;
  /** @deprecated Use TerminalProcess.getSerializeAddon() */
  serializeAddon?: SerializeAddon;
  /** @deprecated Internal to TerminalProcess */
  processDetector?: ProcessDetector;
  /** @deprecated Use TerminalProcess.getOutputBuffer() */
  outputBuffer: string;
  /** @deprecated Use TerminalProcess.getSemanticBuffer() */
  semanticBuffer: string[];
  /**
   * Runtime-only hysteresis bookkeeping. Timestamp (`performance.now()`) until which
   * opposite-direction low-confidence transitions are suppressed after a
   * recent high-confidence transition. Not persisted, not crossed over IPC.
   * See `AgentStateService` for the suppression policy.
   */
  hysteresisLockedUntil?: number;
  /**
   * Final serialized buffer captured when a preserved terminal exits and its
   * headless xterm is disposed to reclaim memory. Served by
   * `serializeTerminal`/`serializeTerminalAsync` in place of the live buffer.
   * Runtime-only; not persisted, not crossed over IPC.
   */
  preservedSnapshot?: string;
  /**
   * Wall-clock timestamp (`Date.now()`) captured when `preservedSnapshot` is
   * assigned. Drives oldest-first eviction in
   * `TerminalRegistry.evictPreservedSnapshots` (issue #10839). Runtime-only;
   * not persisted, not crossed over IPC.
   */
  preservedAt?: number;
  /**
   * Wall-clock timestamp (`Date.now()`) of the last time `preservedSnapshot`
   * was served by `serializeTerminal`/`serializeTerminalAsync`, seeded at
   * capture time. Guards a currently-viewed snapshot from eviction within
   * `PRESERVED_SNAPSHOT_RECENT_ACCESS_GUARD_MS`. Runtime-only; not persisted,
   * not crossed over IPC.
   */
  preservedSnapshotLastAccessedAt?: number;
  /**
   * Monotonic count of buffer mutations: PTY output chunks (bumped at the
   * pty-host routing site), resize reflows, and the preserved-snapshot
   * capture. Runtime-only; not persisted, not crossed over IPC. Vestigial: the
   * only reader was the wake no-change short-circuit, removed with the rest of
   * the hibernation/wake teardown — kept as a write-only counter for now.
   */
  contentEpoch: number;
  /**
   * Headless xterm writes issued but whose parse callback hasn't fired yet.
   * Runtime-only. Vestigial: the only reader was the wake serialize path,
   * removed with the hibernation/wake teardown — kept as a write-only counter
   * (the same write callback also drives `noteAgentOutputActivity`).
   */
  pendingHeadlessWrites?: number;
}

export interface PtyManagerEvents {
  data: (id: string, data: string | Uint8Array) => void;
  exit: (id: string, exitCode: number, signal?: number) => void;
  error: (id: string, error: string) => void;
}

/**
 * Why a TerminalProcess transitioned out of `alive`. Used by `teardown()` to
 * route observers (forensics, fallback classifier, agent state machine) and
 * to derive the IPC-visible `wasKilled` flag.
 *
 * - `kill`: explicit `kill()` call (user action, registry cleanup).
 * - `graceful-shutdown`: `gracefulShutdown()` finished and routed through
 *   `kill()` to capture the agent session ID before tearing down.
 * - `dispose`: `dispose()` called without a prior PTY exit — typically LRU
 *   eviction or app shutdown. SIGKILL is sent immediately.
 * - `natural`: the underlying PTY emitted `onExit` on its own (clean exit,
 *   crash, or external signal).
 */
export type ExitReason = "kill" | "graceful-shutdown" | "dispose" | "natural";

/**
 * Explicit lifecycle for a `TerminalProcess`. Replaces the previous trio of
 * implicit booleans (`wasKilled`, `isExited`, `exitCode`) with a single
 * discriminated union so every code path that gates on lifecycle state can
 * narrow on a single field.
 *
 * Transition graph:
 * ```
 *   alive ──► shutting-down ──► exited
 *     │           │               │
 *     │           ▼               ▼
 *     └───────► disposed ◄────────┘
 * ```
 *
 * `alive` is the initial state — the PTY is passed live to the constructor.
 * `shutting-down` is set the moment `teardown(reason)` begins (kill, dispose,
 * or natural exit). `exited` is the preserve-on-exit terminal state for
 * agents that exited cleanly; the headless buffer is retained so the user
 * can inspect output. `disposed` is the final state — headless buffer torn
 * down, PTY descendants killed.
 *
 * The `wasKilled` and `isExited` fields on `TerminalPublicState` remain in
 * the IPC contract for backward compatibility and are derived from this
 * state in `getPublicState()`.
 */
export type PtyState =
  | { readonly kind: "alive" }
  | { readonly kind: "shutting-down"; readonly reason: ExitReason }
  | {
      readonly kind: "exited";
      readonly code: number;
      readonly signal?: number;
      readonly reason: ExitReason;
    }
  | { readonly kind: "disposed"; readonly reason: ExitReason };

export interface TerminalSnapshot {
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

export const OUTPUT_BUFFER_SIZE = 2000;
export const SEMANTIC_BUFFER_MAX_LINES = 50;
export const SEMANTIC_BUFFER_MAX_LINE_LENGTH = 1000;
export const SEMANTIC_FLUSH_INTERVAL_MS = 100;

// Input chunking constants
export const WRITE_MAX_CHUNK_SIZE = 50;
export const WRITE_INTERVAL_MS = 5;

// Scrollback configuration
// All PTY panels get a generous scrollback; there is no "agent tier" scrollback
// decision any more. The headless analysis buffer is small because only recent
// output is needed for state detection; the renderer-visible scrollback is
// larger so long agent runs don't truncate.
export const DEFAULT_SCROLLBACK = 10000;

// Preserved-snapshot eviction (issue #10839)
// Agent terminals that exit cleanly retain their full serialized scrollback
// (~1–4MB each) in memory so the user can reopen and inspect the session. They
// are otherwise removed only on explicit trash/kill or project close, so within
// an open project they accumulate without bound. Cap the in-memory count and
// evict oldest-first; worst-case heap ceiling is ~20 × ~4MB ≈ 80MB.
export const MAX_PRESERVED_TERMINAL_SNAPSHOTS = 20;
// A preserved snapshot served (or freshly captured) within this window is
// treated as currently-viewed and skipped by eviction even when over the cap,
// so a snapshot the user is actively inspecting never vanishes mid-view.
export const PRESERVED_SNAPSHOT_RECENT_ACCESS_GUARD_MS = 5 * 60 * 1000; // 5 min

export { TRASH_TTL_MS } from "../../../shared/config/trash.js";

// Graceful shutdown configuration
export const GRACEFUL_SHUTDOWN_TIMEOUT_MS = 2500;
export const GRACEFUL_SHUTDOWN_BUFFER_SIZE = 8 * 1024;
// Delay between writing the input-clear prelude and the quit command. Without this gap,
// the target CLI's async event loop can drop or corrupt the quit command bytes under load.
export const GRACEFUL_SHUTDOWN_CLEAR_DELAY_MS = 100;

// IPC Flow Control Configuration
// 3MB ceiling gives Claude Code completions, diffs, and tool outputs comfortable
// headroom — real bursts land in the low-single-digit MB range, and a tighter cap
// triggers backpressure during normal renderer micro-stalls and produces visible
// output freezes. 67/33 hysteresis makes the drain window ~1MB (vs ~1.5MB at 75/25),
// so the PTY resumes faster after a burst. Renderer watermarks (128KB high / 32KB
// low in TerminalOutputIngestService) are a separate layer and unchanged — the IPC
// queue is the burst absorber, the renderer watermarks throttle xterm consumption.
export const IPC_MAX_QUEUE_BYTES = 3 * 1024 * 1024; // 3MB max per terminal
export const IPC_HIGH_WATERMARK_PERCENT = 67; // Pause PTY at 67% full (~2MB)
export const IPC_LOW_WATERMARK_PERCENT = 33; // Resume PTY when drops to 33% (~1MB)
// Force resume after 10s. The renderer drain loop (not PTY I/O — that runs in a
// UtilityProcess unaffected by renderer throttling) is subject to Chromium 146's
// tiered background-throttling policies the moment the document is hidden or fully
// occluded:
//   - BackgroundTimerThrottling: setTimeout/setInterval clamped to 1Hz immediately.
//   - requestAnimationFrame: suspended entirely (0Hz) while the document is hidden.
//   - IntensiveWakeUpThrottling: escalates wakeups to 1/minute. With
//     QuickIntensiveWakeUpThrottlingAfterLoading default-on in Chromium 146,
//     this engages at the 60s-hidden mark for fully-loaded pages (the baseline
//     without that flag is 5min).
// 10s keeps the forced resume comfortably below the 60s IntensiveWakeUpThrottling
// boundary: it fires the drain while still only under 1Hz BackgroundTimerThrottling,
// before the far worse 1/minute intensive throttle can engage. Without it, a paused
// PTY left untouched past 60s could go a full minute between drain ticks and freeze
// visibly. (history: #3508, #4682, #4683)
export const IPC_MAX_PAUSE_MS = 10000;

// Aggregate (per-queue-manager) ceiling across ALL terminals. The per-terminal
// cap alone lets a simultaneous N-agent burst put N x ~2MB in flight to one
// renderer window before any PTY pauses — bytes that land in the receiving
// renderer's queues, outside the pty-host budget the ResourceGovernor watches.
// 16MB mirrors FUTURE_SAB_MAX_TOTAL_PENDING_BYTES (the dual per-terminal +
// total cap the SAB skeleton was designed with); 50% hysteresis gives a wide
// drain window so the aggregate gate doesn't flap under multi-agent load.
// Producers paused by the aggregate gate resume via the same ack-driven
// tryResume path (swept when the aggregate crosses back below the low
// watermark) and stay bounded by the IPC_MAX_PAUSE_MS safety timeout.
export const IPC_TOTAL_QUEUE_HIGH_WATERMARK_BYTES = 16 * 1024 * 1024;
export const IPC_TOTAL_QUEUE_LOW_WATERMARK_BYTES = 8 * 1024 * 1024;

// MessagePort adaptive batching configuration
export const PORT_BATCH_THRESHOLD_BYTES = 64 * 1024; // 64KB — sync-flush when buffered data exceeds this
export const PORT_BATCH_THROUGHPUT_DELAY_MS = 16; // ~60Hz frame — setTimeout window in throughput mode
// Output arriving within this window of the last renderer write is treated as
// keystroke echo: the batcher swaps its throughput timer for an immediate so
// typing into a flooding terminal isn't delayed by the 16ms batch window.
export const PORT_BATCH_INTERACTIVE_INPUT_WINDOW_MS = 50;
