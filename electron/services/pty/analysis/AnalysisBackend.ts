import type { PatternDetectionConfig } from "../AgentPatternDetector.js";
import type { AnalysisChunkFlags, AnalysisFinalSnapshot } from "../analysisWorkerProtocol.js";

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

  serialize(): Promise<string | null>;
  serializeForPersistence(): Promise<string | null>;
  /** Drain pending parses, then capture both preserved + persistence forms. */
  captureFinalSnapshot(): Promise<AnalysisFinalSnapshot>;

  /** Free the analysis resources (worker slot / headless instance). Idempotent. */
  release(): void;
}
