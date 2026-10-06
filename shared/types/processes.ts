import type { AgentId } from "./agent.js";
import type { PanelKind } from "./panel.js";
import type { BuiltInAgentId } from "../config/agentIds.js";

/** One process in a sampled tree: basename only, never a command line. */
export interface ProcessTreeMember {
  pid: number;
  comm: string;
  cpuPercent: number;
  memoryKb: number;
}

/**
 * A process tree's resources as the last OS census saw them. Summed resident
 * memory counts shared pages once per process, so it overstates unique
 * footprint; CPU is the census's own per-process reading, summed.
 */
export interface ProcessTreeSample {
  cpuPercent: number;
  memoryKb: number;
  processCount: number;
  /** Largest members first, capped by the host. */
  members: ProcessTreeMember[];
}

/** A live PTY as one pty-host shard reports it. */
export interface HostProcessInventoryTerminal {
  id: string;
  projectId: string | null;
  kind?: PanelKind;
  title?: string;
  cwd: string;
  worktreeId?: string;
  launchAgentId?: AgentId;
  detectedAgentId?: BuiltInAgentId;
  isAssistantTerminal: boolean;
  spawnedAt: number;
  isTrashed: boolean;
  trashExpiresAt?: number;
  rootPid: number | null;
  /** Null when the census has no entry for the root pid. */
  sample: ProcessTreeSample | null;
}

/**
 * What started a root, recorded when it spawned. The record is all there is:
 * the terminal or plugin PTY is gone by the time its descendants are reported.
 */
export interface ClosedProcessOrigin {
  kind: "terminal" | "plugin";
  /** The terminal id, or the plugin PTY's id. */
  id: string;
  projectId?: string;
  title?: string;
  panelKind?: PanelKind;
  launchAgentId?: AgentId;
  spawnedAt?: number;
}

/**
 * A process the lineage ledger recorded under a terminal (or plugin PTY) that
 * has since closed, and which the last successful census still listed under the
 * start time it was recorded with. Ownership comes from that recorded ancestry,
 * not the PID, so it holds after the process reparented or called `setsid`.
 */
export interface HostClosedTerminalProcess {
  pid: number;
  /** OS start time as recorded; the identity a kill request must match. */
  startTime: string;
  /** Executable basename, never a command line. Empty when the census lacks it. */
  comm: string;
  /** Null when the last census has no entry for it. */
  memoryKb: number | null;
  cpuPercent: number | null;
  origin: ClosedProcessOrigin | null;
  /** When the ledger saw its root close. */
  closedAt: number;
}

/** One shard's answer to `get-process-inventory`. */
export interface HostProcessInventory {
  terminals: HostProcessInventoryTerminal[];
  /** Absent from hosts that predate it or run without lineage tracking. */
  closedTerminalProcesses?: HostClosedTerminalProcess[];
  /** Tree samples for the extra pids Main asked about, keyed by pid. */
  pidSamples: Record<number, ProcessTreeSample>;
  /** False when the last OS census failed, so samples are retained readings. */
  available: boolean;
  /** Last successful census, or 0 when none has run. */
  sampledAt: number;
}

export interface ProcessInventoryTerminal extends HostProcessInventoryTerminal {
  projectName: string | null;
}

/** A process a plugin runs: a managed child, or the plugin's own worker. */
export interface ProcessInventoryPluginProcess {
  source: "plugin-process" | "plugin-worker";
  id: string;
  pluginId: string;
  /** Executable basename for a child; null for a worker. */
  label: string | null;
  pid: number;
  /** Null for a worker, whose start time the host does not keep. */
  spawnedAt: number | null;
  sample: ProcessTreeSample | null;
}

export interface ProcessInventoryClosedProcess extends HostClosedTerminalProcess {
  projectName: string | null;
}

/**
 * What automatic cleanup of previous sessions' recorded processes observed
 * since Daintree started — at launch, or after a terminal host exited. Counts
 * are processes.
 */
export interface ProcessCleanupReport {
  /** Still running under their recorded identity when cleanup checked. */
  found: number;
  /** Of `found`, no longer listed when cleanup looked again. */
  ended: number;
  /** Of `found`, still listed under the same identity after being signalled. */
  stillRunning: number;
  /** Recorded processes no probe could answer for. */
  unchecked: number;
  lastAt: number;
}

export interface ProcessInventorySnapshot {
  terminals: ProcessInventoryTerminal[];
  /** Processes still running after the terminal that started them closed. */
  closedTerminalProcesses: ProcessInventoryClosedProcess[];
  /** Null when automatic cleanup has found and failed to check nothing this session. */
  cleanup: ProcessCleanupReport | null;
  plugins: ProcessInventoryPluginProcess[];
  /** False when any pty-host shard failed to answer, so terminals are missing. */
  complete: boolean;
  /** False when a shard's OS census failed, so its samples are retained readings. */
  samplesAvailable: boolean;
  /** Oldest successful census across the shards that answered, or 0 when none. */
  sampledAt: number;
}

/** One recorded process identity a kill request names. */
export interface ClosedProcessKillTarget {
  pid: number;
  startTime: string;
}

/** What a kill of closed-terminal processes observed, per process. */
export interface ClosedProcessKillResult {
  /** No longer listed under the recorded identity after signalling. */
  ended: number;
  /** Still listed under the recorded identity after SIGKILL. */
  stillRunning: number;
  /** Not signalled, or not confirmed, because the OS couldn't be asked. */
  unchecked: number;
  /** Named in the request but not in any host's record, so never signalled. */
  notTracked: number;
}
