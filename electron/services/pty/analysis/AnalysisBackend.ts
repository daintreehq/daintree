import type { PatternDetectionConfig } from "../AgentPatternDetector.js";
import type { AnalysisChunkFlags } from "../analysisWorkerProtocol.js";
import type { SerializedTerminalSnapshot } from "../../../../shared/types/terminal.js";

/**
 * Backend-level counterpart of the worker-wire `AnalysisFinalSnapshot`: the
 * same two serializations, each carrying the grid it was captured at. Both
 * backends read that grid off the mirror in the same synchronous step as the
 * serialize — the host cannot infer it, because a restore replay moves the
 * mirror's grid without a host-posted resize (#11552).
 */
export interface AnalysisFinalCapture {
  /** Full-buffer serialize (banner included) for the preserved snapshot. */
  snapshot: SerializedTerminalSnapshot | null;
  /** Banner-stripped serialize for on-disk session persistence. */
  persistence: SerializedTerminalSnapshot | null;
}

export interface MonitorStartOptions {
  agentId?: string;
  initialState: "busy" | "idle";
  skipInitialStateEmit: boolean;
}

/**
 * The per-terminal analysis stack (headless xterm mirror + SerializeAddon +
 * ActivityMonitor + agent-output temperature) behind a mode-agnostic seam.
 *
 * - `InThreadAnalysisBackend`: the legacy path — everything runs on the
 *   pty-host main thread (kill-switch fallback, keeps all existing tests
 *   meaningful).
 * - `WorkerAnalysisBackend`: proxies to a persistent worker_threads pool so
 *   the pty-host main thread only does I/O.
 */
export interface AnalysisBackend {
  readonly kind: "in-thread" | "worker";

  /** Per-chunk pipeline: monitor onData, headless write, output temperature. */
  feedChunk(data: string, flags: AnalysisChunkFlags): void;
  /** Pooled-shell prelude replay: headless write only, no monitor feed. */
  feedPrelude(data: string): void;
  /** Headless resize + monitor resize suppression + temperature reset. */
  resize(cols: number, rows: number): void;
  /**
   * Re-assert the mirror's grid without any of `resize`'s side effects
   * (#11719).
   *
   * Called when the PTY is ALREADY at the requested size, so there is no
   * reflow to suppress and no temperature event to record — only a mirror that
   * may have drifted and can otherwise never re-converge, because every later
   * re-assertion short-circuits on the same PTY-dims check. Implementations
   * must no-op when the mirror is already at this grid: it runs on routine
   * re-assertions, and firing `notifyResize()` here would repeatedly blind
   * agent detection for 500ms at a time.
   */
  resyncGeometry(cols: number, rows: number): void;

  notifyInput(data: string): void;
  notifyFocus(): void;
  notifySubmission(): void;

  startMonitor(opts: MonitorStartOptions): void;
  stopMonitor(): void;
  reconfigureMonitor(agentId: string, patternConfig?: PatternDetectionConfig): void;
  setPollingInterval(intervalMs: number): void;
  hasMonitor(): boolean;

  /** Returns false when there is no live buffer to apply the cap to. */
  setScrollback(lines: number): boolean;

  getViewportLines(n: number): string[];
  getCursorLine(): string | null;

  /**
   * Snapshot of the mirror's buffer bundled with the grid it was captured at.
   * The geometry is not decoration: SerializeAddon output only decodes at the
   * capture width, so every replay site sizes its target to these numbers
   * before writing (#11552).
   */
  serialize(): Promise<SerializedTerminalSnapshot | null>;
  serializeForPersistence(): Promise<SerializedTerminalSnapshot | null>;
  /** Drain pending parses, then capture both preserved + persistence forms. */
  captureFinalSnapshot(): Promise<AnalysisFinalCapture>;

  /** Free the analysis resources (worker slot / headless instance). Idempotent. */
  release(): void;
}
