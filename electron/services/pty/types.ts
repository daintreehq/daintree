import type * as pty from "node-pty";
import type { Terminal as HeadlessTerminal } from "@xterm/headless";
import type { SerializeAddon } from "@xterm/addon-serialize";
import type { AgentState, TerminalType } from "../../../shared/types/domain.js";
import type { PtyHostSpawnOptions } from "../../../shared/types/pty-host.js";
import type { ProcessDetector } from "../ProcessDetector.js";

// Re-export PtyHostSpawnOptions as PtySpawnOptions for backward compatibility/internal usage
export type PtySpawnOptions = PtyHostSpawnOptions;

export interface TerminalInfo {
  id: string;
  projectId?: string;
  ptyProcess: pty.IPty;
  cwd: string;
  shell: string;
  type?: TerminalType;
  title?: string;
  worktreeId?: string;
  agentId?: string;
  spawnedAt: number;
  wasKilled?: boolean;
  agentState?: AgentState;
  lastStateChange?: number;
  error?: string;
  outputBuffer: string;
  traceId?: string;

  lastInputTime: number;
  lastOutputTime: number;
  lastCheckTime: number;

  semanticBuffer: string[];

  processDetector?: ProcessDetector;
  detectedAgentType?: TerminalType;

  pendingSemanticData: string;
  semanticFlushTimer: NodeJS.Timeout | null;

  inputWriteQueue: string[];
  inputWriteTimeout: NodeJS.Timeout | null;

  headlessTerminal: HeadlessTerminal;
  serializeAddon: SerializeAddon;

  restartCount: number;
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
  type?: TerminalType;
  worktreeId?: string;
  agentId?: string;
  agentState?: AgentState;
  lastStateChange?: number;
  error?: string;
  spawnedAt: number;
}

// Constants
export const OUTPUT_BUFFER_SIZE = 2000;
export const SEMANTIC_BUFFER_MAX_LINES = 50;
export const SEMANTIC_BUFFER_MAX_LINE_LENGTH = 1000;
export const SEMANTIC_FLUSH_INTERVAL_MS = 100;

// Input chunking constants
export const WRITE_MAX_CHUNK_SIZE = 50;
export const WRITE_INTERVAL_MS = 5;

// Scrollback configuration per terminal type
export const SCROLLBACK_BY_TYPE: Record<TerminalType, number> = {
  claude: 10000,
  gemini: 10000,
  codex: 10000,
  custom: 10000,
  shell: 2000,
  npm: 500,
  yarn: 500,
  pnpm: 500,
  bun: 500,
};
export const DEFAULT_SCROLLBACK = 1000;

export const TRASH_TTL_MS = 120 * 1000;
