import type { ActivityMonitor } from "../../ActivityMonitor.js";
import type { PatternDetectionConfig } from "../AgentPatternDetector.js";
import type { AnalysisBackend, MonitorStartOptions } from "./AnalysisBackend.js";
import type { AnalysisChunkFlags, AnalysisFinalSnapshot } from "../analysisWorkerProtocol.js";

/**
 * The legacy single-threaded analysis path, adapted to the AnalysisBackend
 * seam. All state (headless terminal, ActivityMonitor, output temperature)
 * stays on TerminalProcess/TerminalInfo where the existing code — and the
 * existing test suite — expects it; this class is a thin dispatch table.
 * Selected when analysis workers are disabled (DAINTREE_DISABLE_ANALYSIS_WORKERS=1)
 * or the worker pool is unavailable.
 */
export interface InThreadAnalysisHost {
  feedChunk(data: string): void;
  feedPrelude(data: string): void;
  resize(cols: number, rows: number): void;
  handleFocus(): void;
  getMonitor(): ActivityMonitor | null;
  startMonitor(opts: MonitorStartOptions): void;
  stopMonitor(): void;
  setScrollback(lines: number): boolean;
  readViewportLines(n: number): string[];
  readCursorLine(): string | null;
  serialize(): Promise<string | null>;
  serializeForPersistence(): string | null;
  captureFinalSnapshot(): Promise<AnalysisFinalSnapshot>;
  releaseHeadless(): void;
}

export class InThreadAnalysisBackend implements AnalysisBackend {
  readonly kind = "in-thread" as const;

  constructor(private readonly host: InThreadAnalysisHost) {}

  feedChunk(data: string, _flags: AnalysisChunkFlags): void {
    this.host.feedChunk(data);
  }

  feedPrelude(data: string): void {
    this.host.feedPrelude(data);
  }

  resize(cols: number, rows: number): void {
    this.host.resize(cols, rows);
  }

  notifyInput(data: string): void {
    this.host.getMonitor()?.onInput(data);
  }

  notifyFocus(): void {
    this.host.handleFocus();
  }

  notifySubmission(): void {
    this.host.getMonitor()?.notifySubmission();
  }

  startMonitor(opts: MonitorStartOptions): void {
    this.host.startMonitor(opts);
  }

  stopMonitor(): void {
    this.host.stopMonitor();
  }

  reconfigureMonitor(agentId: string, patternConfig?: PatternDetectionConfig): void {
    this.host.getMonitor()?.reconfigure(agentId, patternConfig);
  }

  setPollingInterval(intervalMs: number): void {
    this.host.getMonitor()?.setPollingInterval(intervalMs);
  }

  hasMonitor(): boolean {
    return this.host.getMonitor() !== null;
  }

  setScrollback(lines: number): boolean {
    return this.host.setScrollback(lines);
  }

  getViewportLines(n: number): string[] {
    return this.host.readViewportLines(n);
  }

  getCursorLine(): string | null {
    return this.host.readCursorLine();
  }

  serialize(): Promise<string | null> {
    return this.host.serialize();
  }

  serializeForPersistence(): Promise<string | null> {
    return Promise.resolve(this.host.serializeForPersistence());
  }

  captureFinalSnapshot(): Promise<AnalysisFinalSnapshot> {
    return this.host.captureFinalSnapshot();
  }

  release(): void {
    this.host.releaseHeadless();
  }
}
