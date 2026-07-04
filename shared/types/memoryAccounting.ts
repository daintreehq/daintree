// Composite memory accounting: the memory users actually care about is
// Electron-owned processes PLUS the descendant trees their terminals spawned
// (agent CLIs, dev servers, language servers, test runners). The two sources
// have independent sampling pipelines and failure modes, so each slice carries
// its own timestamp and availability flag — stale process-tree data must never
// read as a real zero.

import type { TerminalResourceProcess } from "./pty-host.js";

/**
 * A terminal-workload sample older than this is flagged stale. The
 * ProcessTreeCache polls at 2–5s with adaptive backoff capped at 15s, so a
 * healthy cache is never older than the ceiling; 2× the ceiling separates
 * "adaptive backoff" from "the ps/PowerShell path is wedged".
 */
export const TERMINAL_WORKLOAD_STALE_MS = 30_000;

/** Working-set summary of Daintree's own Electron processes (app.getAppMetrics()). */
export interface ElectronMemorySlice {
  /** False when the metrics sweep threw — totals are 0 and must not be shown as data. */
  available: boolean;
  /** Summed working-set across all Electron processes, in MB (shared pages double-count). */
  totalWorkingSetMb: number;
  processCount: number;
  /** Wall-clock time of the underlying metrics sweep (0 = never sampled). */
  sampledAt: number;
}

/** Per-project terminal workload attribution, PID-deduplicated within the project. */
export interface TerminalWorkloadProject {
  /** Resolved project id, or null for terminals not attributable to a project. */
  projectId: string | null;
  terminalCount: number;
  processCount: number;
  /** Summed RSS (MB) across the project's terminal process trees. */
  memoryMb: number;
  /** Highest-RSS processes — basenames only, never command lines or paths. */
  topProcesses: TerminalResourceProcess[];
}

/**
 * RSS rollup across every live terminal's process subtree, sourced from the
 * pty-host's ProcessTreeCache. Sums resident set size, so shared pages are
 * counted per process — a pressure heuristic, not unique footprint.
 */
export interface TerminalWorkloadSlice {
  /** False when the OS process table couldn't be read (ps/PowerShell failed or pty-host unreachable). */
  available: boolean;
  /** True when the last successful process-table sweep is older than {@link TERMINAL_WORKLOAD_STALE_MS}. */
  stale: boolean;
  /** Age of the last successful sweep at snapshot time; null when never sampled. */
  ageMs: number | null;
  /** Wall-clock time of the last successful process-table sweep (0 = never). */
  sampledAt: number;
  /** Summed RSS (MB), globally PID-deduplicated across overlapping trees. */
  totalMemoryMb: number;
  processCount: number;
  terminalCount: number;
  byProject: TerminalWorkloadProject[];
}

/** The unified snapshot combining both slices, each with independent freshness. */
export interface CompositeMemorySnapshot {
  /** When this snapshot was assembled (not when either slice was sampled). */
  timestamp: number;
  electron: ElectronMemorySlice;
  terminalWorkloads: TerminalWorkloadSlice;
}
