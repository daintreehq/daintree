import type * as pty from "node-pty";
import type { Terminal as HeadlessTerminal } from "@xterm/headless";
import type { SerializeAddon } from "@xterm/addon-serialize";
import type { AgentState, AgentId, WaitingReason } from "../../../shared/types/agent.js";
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
  spawnedAt: number;
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
  /** Exit code from the PTY process (set on clean exit) */
  exitCode?: number;
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
  rawOutputBuffer?: string;
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
  /** @deprecated Use serialization methods */
  rawOutputBuffer?: string;
}

export interface PtyManagerEvents {
  data: (id: string, data: string | Uint8Array) => void;
  exit: (id: string, exitCode: number) => void;
  error: (id: string, error: string) => void;
}

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

// Raw output buffer for non-headless terminals (100KB max)
export const RAW_OUTPUT_BUFFER_MAX_SIZE = 100 * 1024;

export { TRASH_TTL_MS } from "../../../shared/config/trash.js";

// Graceful shutdown configuration
export const GRACEFUL_SHUTDOWN_TIMEOUT_MS = 2500;
export const GRACEFUL_SHUTDOWN_BUFFER_SIZE = 8 * 1024;
// Delay between writing the input-clear prelude and the quit command. Without this gap,
// the target CLI's async event loop can drop or corrupt the quit command bytes under load.
export const GRACEFUL_SHUTDOWN_CLEAR_DELAY_MS = 100;

// IPC Flow Control Configuration
export const IPC_MAX_QUEUE_BYTES = 8 * 1024 * 1024; // 8MB max per terminal
export const IPC_HIGH_WATERMARK_PERCENT = 95; // Pause PTY at 95% full
export const IPC_LOW_WATERMARK_PERCENT = 60; // Resume PTY when drops to 60%
export const IPC_MAX_PAUSE_MS = 5000; // Force resume after 5 seconds to prevent indefinite pause

// MessagePort adaptive batching configuration
export const PORT_BATCH_THRESHOLD_BYTES = 64 * 1024; // 64KB — sync-flush when buffered data exceeds this
export const PORT_BATCH_THROUGHPUT_DELAY_MS = 16; // ~60Hz frame — setTimeout window in throughput mode
