import type * as pty from "node-pty";
import type { Terminal as HeadlessTerminal } from "@xterm/headless";
import type { SerializeAddon } from "@xterm/addon-serialize";
import type { AgentState, AgentId, WaitingReason } from "../../../shared/types/agent.js";
import type { TerminalType, PanelKind } from "../../../shared/types/panel.js";
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
 */
export interface TerminalPublicState {
  id: string;
  projectId?: string;
  cwd: string;
  shell: string;
  kind?: PanelKind;
  type?: TerminalType;
  agentId?: AgentId;
  title?: string;
  worktreeId?: string;
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
  detectedAgentType?: TerminalType;
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
  inputWriteQueue: string[];
  inputWriteTimeout: NodeJS.Timeout | null;
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
  /** @deprecated Internal queue - use TerminalProcess.write() */
  inputWriteQueue: string[];
  /** @deprecated Internal timer */
  inputWriteTimeout: NodeJS.Timeout | null;
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
  type?: TerminalType;
  worktreeId?: string;
  agentId?: AgentId;
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
// Headless PTY scrollback is intentionally equal to the renderer default (1000)
// because headless terminals only need enough buffer for agent state detection,
// not full user-visible scroll history.
export const DEFAULT_SCROLLBACK = 1000;
export const AGENT_SCROLLBACK = 10000;

// Raw output buffer for non-headless terminals (100KB max)
export const RAW_OUTPUT_BUFFER_MAX_SIZE = 100 * 1024;

export { TRASH_TTL_MS } from "../../../shared/config/trash.js";

// Graceful shutdown configuration
export const GRACEFUL_SHUTDOWN_TIMEOUT_MS = 2500;
export const GRACEFUL_SHUTDOWN_BUFFER_SIZE = 8 * 1024;

// IPC Flow Control Configuration
export const IPC_MAX_QUEUE_BYTES = 8 * 1024 * 1024; // 8MB max per terminal
export const IPC_HIGH_WATERMARK_PERCENT = 95; // Pause PTY at 95% full
export const IPC_LOW_WATERMARK_PERCENT = 60; // Resume PTY when drops to 60%
export const IPC_MAX_PAUSE_MS = 5000; // Force resume after 5 seconds to prevent indefinite pause

// MessagePort adaptive batching configuration
export const PORT_BATCH_THRESHOLD_BYTES = 64 * 1024; // 64KB — sync-flush when buffered data exceeds this
export const PORT_BATCH_THROUGHPUT_DELAY_MS = 16; // ~60Hz frame — setTimeout window in throughput mode
