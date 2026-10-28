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

/**
 * What a memory figure measures. `footprint` is macOS physical footprint: dirty
 * memory whether resident, compressed or swapped. `resident` is RSS / working
 * set, which drops compressed and swapped pages and so reads far low under
 * memory pressure — the basis on Windows and Linux, and on macOS only when the
 * footprint reader failed to load.
 */
export type MemorySource = "footprint" | "resident";

/** Memory summary of Daintree's own Electron processes (app.getAppMetrics()). */
export interface ElectronMemorySlice {
  /** False when the metrics sweep threw — totals are 0 and must not be shown as data. */
  available: boolean;
  /**
   * Summed memory across all Electron processes, in MB: physical footprint on
   * macOS, working set elsewhere (shared pages double-count).
   */
  totalWorkingSetMb: number;
  memorySource: MemorySource;
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
  /** Summed memory (MB) across the project's terminal process trees. */
  memoryMb: number;
  /** Highest-memory processes — basenames only, never command lines or paths. */
  topProcesses: TerminalResourceProcess[];
}

/**
 * Memory rollup across every live terminal's process subtree, sourced from the
 * pty-host's ProcessTreeCache. Sums per-process figures (physical footprint on
 * macOS, RSS elsewhere), so shared pages are counted per process — a pressure
 * heuristic, not unique footprint.
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
  /** Summed memory (MB), globally PID-deduplicated across overlapping trees. */
  totalMemoryMb: number;
  memorySource: MemorySource;
  processCount: number;
  terminalCount: number;
  byProject: TerminalWorkloadProject[];
}

/** Buffer line counts one renderer reported for one of its xterm terminals. */
export interface RendererTerminalBufferCounts {
  terminalId: string;
  /** `buffer.normal.length`: scrollback plus viewport rows actually held. */
  normalLines: number;
  /** `buffer.alternate.length`: the alternate screen, viewport rows only. */
  alternateLines: number;
  cols: number;
}

/**
 * One renderer terminal's buffer footprint, estimated as
 * `(normalLines + alternateLines) × cols × 12` — cell storage only, not a heap
 * measurement. Already part of the renderer's process memory, so never added
 * to the Electron total.
 */
export interface RendererTerminalBufferEntry extends RendererTerminalBufferCounts {
  estimatedBytes: number;
}

/**
 * - `fresh` — an active view answered this request.
 * - `last-known` — the view is cached, or didn't answer in time, and these are
 *   the counts it last reported.
 * - `unavailable` — the view has never reported and can't be asked now. Never a zero.
 */
export type RendererTerminalBufferStatus = "fresh" | "last-known" | "unavailable";

/** Buffer estimate for one project view (one renderer). */
export interface RendererTerminalBufferView {
  webContentsId: number;
  windowId: number | null;
  projectId: string;
  state: "loading" | "active" | "cached";
  status: RendererTerminalBufferStatus;
  /** When the renderer read the counts; null when unavailable. */
  sampledAt: number | null;
  ageMs: number | null;
  /** Sum over `terminals`; null when unavailable. */
  estimatedBytes: number | null;
  terminals: RendererTerminalBufferEntry[] | null;
}

/** Renderer terminal buffer estimates across every resident project view, cached ones included. */
export interface RendererTerminalBufferSlice {
  views: RendererTerminalBufferView[];
  /** Sum over views that have counts; null when none do. */
  estimatedBytes: number | null;
  /** False when any view is `unavailable`, so `estimatedBytes` leaves it out. */
  complete: boolean;
}

/** The unified snapshot combining both slices, each with independent freshness. */
export interface CompositeMemorySnapshot {
  /** When this snapshot was assembled (not when either slice was sampled). */
  timestamp: number;
  electron: ElectronMemorySlice;
  terminalWorkloads: TerminalWorkloadSlice;
  /**
   * Renderer xterm buffer estimates. Absent when the caller didn't ask for it:
   * only user-pulled reads (the popover, diagnostics) sample renderers.
   */
  rendererTerminalBuffers?: RendererTerminalBufferSlice;
}
