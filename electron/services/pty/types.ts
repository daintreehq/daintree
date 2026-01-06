import type * as pty from "node-pty";
import type { Terminal as HeadlessTerminal } from "@xterm/headless";
import type { SerializeAddon } from "@xterm/addon-serialize";
import type {
  AgentState,
  TerminalType,
  TerminalKind,
  AgentId,
} from "../../../shared/types/domain.js";
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
  kind?: TerminalKind;
  type?: TerminalType;
  agentId?: AgentId;
  title?: string;
  worktreeId?: string;
  spawnedAt: number;
  wasKilled?: boolean;
  agentState?: AgentState;
  lastStateChange?: number;
  error?: string;
  traceId?: string;
  analysisEnabled: boolean;
  lastInputTime: number;
  lastOutputTime: number;
  lastCheckTime: number;
  detectedAgentType?: TerminalType;
  restartCount: number;
  isTrashed?: boolean;
  trashExpiresAt?: number;
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
  pendingSemanticData: string;
  semanticFlushTimer: NodeJS.Timeout | null;
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
  /** @deprecated Internal buffer - use TerminalProcess.getSemanticBuffer() */
  pendingSemanticData: string;
  /** @deprecated Internal timer */
  semanticFlushTimer: NodeJS.Timeout | null;
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
  kind?: TerminalKind;
  type?: TerminalType;
  worktreeId?: string;
  agentId?: AgentId;
  agentState?: AgentState;
  lastStateChange?: number;
  error?: string;
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
export const DEFAULT_SCROLLBACK = 1000;
export const AGENT_SCROLLBACK = 10000;

// Raw output buffer for non-headless terminals (100KB max)
export const RAW_OUTPUT_BUFFER_MAX_SIZE = 100 * 1024;

export const TRASH_TTL_MS = 120 * 1000;

// IPC Flow Control Configuration
export const IPC_MAX_QUEUE_BYTES = 4 * 1024 * 1024; // 4MB max per terminal
export const IPC_HIGH_WATERMARK_PERCENT = 90; // Pause PTY at 90% full
export const IPC_LOW_WATERMARK_PERCENT = 50; // Resume PTY when drops to 50%
export const IPC_BACKPRESSURE_CHECK_INTERVAL_MS = 100; // Check every 100ms during backpressure
export const IPC_MAX_PAUSE_MS = 5000; // Force resume after 5 seconds to prevent indefinite pause
