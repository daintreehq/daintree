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

/** One shard's answer to `get-process-inventory`. */
export interface HostProcessInventory {
  terminals: HostProcessInventoryTerminal[];
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

export interface ProcessInventorySnapshot {
  terminals: ProcessInventoryTerminal[];
  plugins: ProcessInventoryPluginProcess[];
  /** False when any pty-host shard failed to answer, so terminals are missing. */
  complete: boolean;
  /** False when a shard's OS census failed, so its samples are retained readings. */
  samplesAvailable: boolean;
  /** Oldest successful census across the shards that answered, or 0 when none. */
  sampledAt: number;
}
