import type { AgentState } from "../../../../shared/types/agent.js";
import type { ActivityStateMetadata } from "../../ActivityMonitor.js";
import type { PatternDetectionConfig } from "../AgentPatternDetector.js";
import type { AnalysisBackend, MonitorStartOptions } from "./AnalysisBackend.js";
import type {
  AnalysisChunkFlags,
  AnalysisFinalSnapshot,
  AnalysisRequestOp,
  AnalysisRequestResult,
  HostToWorkerMessage,
  WorkerToHostMessage,
} from "../analysisWorkerProtocol.js";

// Cadence for mirroring host process-tree state (CPU / child liveness) into
// the worker's ProcessStateValidator. The underlying ProcessTreeCache refresh
// is ~1.5s, so 2s keeps the mirror as fresh as the source without hot-path cost.
const PROCESS_STATE_PUSH_INTERVAL_MS = 2000;

export interface WorkerAnalysisDelegate {
  onActivityState(
    spawnedAt: number,
    state: "busy" | "idle" | "completed",
    metadata?: ActivityStateMetadata
  ): void;
  onWaitingTimeout(spawnedAt: number): void;
  onBootComplete(timestamp: number): void;
  onPtyResponse(data: string): void;
  getProcessState(): { hasActiveChildren: boolean; cpuUsage: number } | null;
  getAgentContext(): { agentLive: boolean; agentState?: AgentState };
}

export interface WorkerBackendSpec {
  terminalId: string;
  cols: number;
  rows: number;
  scrollback: number;
  restore: boolean;
  spawnedAt: number;
}

/** The pool surface a backend needs; implemented by AnalysisWorkerPool. */
export interface AnalysisPoolHost {
  post(terminalId: string, msg: HostToWorkerMessage): void;
  request(terminalId: string, op: AnalysisRequestOp): Promise<AnalysisRequestResult>;
  unregister(terminalId: string): void;
}

export class WorkerAnalysisBackend implements AnalysisBackend {
  readonly kind = "worker" as const;

  private released = false;
  private detached = false;
  // After a worker respawn the fresh empty buffer must not clobber previously
  // persisted scrollback: persistence-oriented serialization returns null
  // until real PTY output has landed in the new buffer.
  private persistSuppressed = false;
  private viewportLines: string[] = [];
  private cursorLine: string | null = null;
  private monitorSpec: MonitorStartOptions | null = null;
  private pollingIntervalMs: number | undefined;
  private lastCols: number;
  private lastRows: number;
  private currentScrollback: number;
  private processPushTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly spec: WorkerBackendSpec,
    private readonly delegate: WorkerAnalysisDelegate,
    private readonly pool: AnalysisPoolHost
  ) {
    this.lastCols = spec.cols;
    this.lastRows = spec.rows;
    this.currentScrollback = spec.scrollback;
  }

  get terminalId(): string {
    return this.spec.terminalId;
  }

  init(): void {
    this.pool.post(this.spec.terminalId, {
      type: "create",
      terminalId: this.spec.terminalId,
      cols: this.spec.cols,
      rows: this.spec.rows,
      scrollback: this.spec.scrollback,
      restore: this.spec.restore,
      spawnedAt: this.spec.spawnedAt,
    });
  }

  feedChunk(data: string, flags: AnalysisChunkFlags): void {
    if (this.inactive()) return;
    this.persistSuppressed = false;
    this.pool.post(this.spec.terminalId, {
      type: "data",
      terminalId: this.spec.terminalId,
      data,
      flags,
    });
  }

  feedPrelude(data: string): void {
    if (this.inactive()) return;
    this.pool.post(this.spec.terminalId, {
      type: "prelude",
      terminalId: this.spec.terminalId,
      data,
    });
  }

  resize(cols: number, rows: number): void {
    if (this.inactive()) return;
    this.lastCols = cols;
    this.lastRows = rows;
    this.pool.post(this.spec.terminalId, {
      type: "resize",
      terminalId: this.spec.terminalId,
      cols,
      rows,
    });
  }

  notifyInput(data: string): void {
    if (this.inactive() || !this.monitorSpec) return;
    this.pool.post(this.spec.terminalId, {
      type: "input",
      terminalId: this.spec.terminalId,
      data,
    });
  }

  notifyFocus(): void {
    if (this.inactive() || !this.monitorSpec) return;
    this.pool.post(this.spec.terminalId, { type: "focus", terminalId: this.spec.terminalId });
  }

  notifySubmission(): void {
    if (this.inactive() || !this.monitorSpec) return;
    this.pool.post(this.spec.terminalId, {
      type: "submission",
      terminalId: this.spec.terminalId,
    });
  }

  startMonitor(opts: MonitorStartOptions): void {
    if (this.inactive() || this.monitorSpec) return;
    this.monitorSpec = opts;
    this.postAgentContext();
    this.pool.post(this.spec.terminalId, {
      type: "monitor-start",
      terminalId: this.spec.terminalId,
      agentId: opts.agentId,
      initialState: opts.initialState,
      skipInitialStateEmit: opts.skipInitialStateEmit,
      hasProcessValidator: this.delegate.getProcessState() !== null,
      pollingIntervalMs: this.pollingIntervalMs,
    });
    this.startProcessStatePush();
  }

  stopMonitor(): void {
    if (this.released) return;
    this.stopProcessStatePush();
    if (!this.monitorSpec) return;
    this.monitorSpec = null;
    if (this.detached) return;
    this.pool.post(this.spec.terminalId, {
      type: "monitor-stop",
      terminalId: this.spec.terminalId,
    });
  }

  reconfigureMonitor(agentId: string, _patternConfig?: PatternDetectionConfig): void {
    if (this.inactive() || !this.monitorSpec) return;
    // The worker recompiles the pattern config from the (mirrored) agent
    // registry — RegExp banks never cross the thread boundary.
    this.monitorSpec = { ...this.monitorSpec, agentId };
    this.postAgentContext();
    this.pool.post(this.spec.terminalId, {
      type: "monitor-reconfigure",
      terminalId: this.spec.terminalId,
      agentId,
    });
  }

  setPollingInterval(intervalMs: number): void {
    this.pollingIntervalMs = intervalMs;
    if (this.inactive() || !this.monitorSpec) return;
    this.pool.post(this.spec.terminalId, {
      type: "set-polling-interval",
      terminalId: this.spec.terminalId,
      intervalMs,
    });
  }

  hasMonitor(): boolean {
    return this.monitorSpec !== null;
  }

  setScrollback(lines: number): boolean {
    if (this.inactive()) return false;
    this.currentScrollback = lines;
    this.pool.post(this.spec.terminalId, {
      type: "set-scrollback",
      terminalId: this.spec.terminalId,
      lines,
    });
    return true;
  }

  getViewportLines(n: number): string[] {
    return this.viewportLines.slice(-n);
  }

  getCursorLine(): string | null {
    return this.cursorLine;
  }

  async serialize(): Promise<string | null> {
    if (this.inactive()) return null;
    const result = await this.pool.request(this.spec.terminalId, "serialize");
    return typeof result === "string" ? result : null;
  }

  async serializeForPersistence(): Promise<string | null> {
    if (this.inactive() || this.persistSuppressed) return null;
    const result = await this.pool.request(this.spec.terminalId, "serialize-persistence");
    return typeof result === "string" ? result : null;
  }

  async captureFinalSnapshot(): Promise<AnalysisFinalSnapshot> {
    if (this.inactive()) return { snapshot: null, persistence: null };
    const result = await this.pool.request(this.spec.terminalId, "final-snapshot");
    if (result !== null && typeof result === "object") {
      return this.persistSuppressed ? { ...result, persistence: null } : result;
    }
    return { snapshot: null, persistence: null };
  }

  release(): void {
    if (this.released) return;
    this.released = true;
    this.stopProcessStatePush();
    this.monitorSpec = null;
    if (!this.detached) {
      this.pool.post(this.spec.terminalId, {
        type: "free",
        terminalId: this.spec.terminalId,
      });
    }
    this.pool.unregister(this.spec.terminalId);
  }

  handleWorkerEvent(msg: WorkerToHostMessage): void {
    if (this.released) return;
    switch (msg.type) {
      case "activity-state":
        this.delegate.onActivityState(msg.spawnedAt, msg.state, msg.metadata);
        return;
      case "waiting-timeout":
        this.delegate.onWaitingTimeout(msg.spawnedAt);
        return;
      case "boot-complete":
        this.delegate.onBootComplete(msg.timestamp);
        return;
      case "pty-response":
        this.delegate.onPtyResponse(msg.data);
        return;
      case "viewport":
        this.viewportLines = msg.lines;
        this.cursorLine = msg.cursorLine;
        return;
      default:
        return;
    }
  }

  /**
   * Called by the pool after the assigned worker died and a replacement is
   * available (respawn or reassignment). Rebuilds the slot with FRESH state:
   * no session restore (a phantom restore banner must not surface in wake
   * snapshots) and persistence suppressed until real output dirties the new
   * buffer, so the fresh empty buffer can't clobber a good on-disk snapshot.
   */
  handleWorkerLost(): void {
    if (this.released) return;
    this.viewportLines = [];
    this.cursorLine = null;
    this.persistSuppressed = true;
    this.pool.post(this.spec.terminalId, {
      type: "create",
      terminalId: this.spec.terminalId,
      cols: this.lastCols,
      rows: this.lastRows,
      scrollback: this.currentScrollback,
      restore: false,
      spawnedAt: this.spec.spawnedAt,
    });
    if (this.monitorSpec) {
      this.postAgentContext();
      // Preserve-state semantics (mirrors the in-thread preserveState path):
      // no boot "busy" re-emit, and a host FSM mid-work seeds the fresh
      // monitor busy — the monitor's idle/completion transitions only run
      // from its internal busy state, so seeding idle would strand a quietly
      // working agent in the host's "working" state forever.
      const agentState = this.delegate.getAgentContext().agentState;
      this.pool.post(this.spec.terminalId, {
        type: "monitor-start",
        terminalId: this.spec.terminalId,
        agentId: this.monitorSpec.agentId,
        initialState: agentState === "working" ? "busy" : "idle",
        skipInitialStateEmit: true,
        hasProcessValidator: this.delegate.getProcessState() !== null,
        pollingIntervalMs: this.pollingIntervalMs,
      });
      this.pushProcessState();
    }
  }

  /** No workers left to host this terminal — degrade to inert analysis. */
  handleDetached(): void {
    if (this.released) return;
    this.detached = true;
    this.stopProcessStatePush();
    console.error(
      `[WorkerAnalysisBackend] No analysis worker available for ${this.spec.terminalId}; agent-state analysis disabled for this terminal`
    );
  }

  private inactive(): boolean {
    return this.released || this.detached;
  }

  private postAgentContext(): void {
    const ctx = this.delegate.getAgentContext();
    this.pool.post(this.spec.terminalId, {
      type: "agent-context",
      terminalId: this.spec.terminalId,
      agentLive: ctx.agentLive,
      agentState: ctx.agentState,
    });
  }

  private pushProcessState(): void {
    const state = this.delegate.getProcessState();
    if (!state) return;
    this.pool.post(this.spec.terminalId, {
      type: "process-state",
      terminalId: this.spec.terminalId,
      hasActiveChildren: state.hasActiveChildren,
      cpuUsage: state.cpuUsage,
    });
  }

  private startProcessStatePush(): void {
    if (this.processPushTimer) return;
    this.pushProcessState();
    this.processPushTimer = setInterval(() => {
      if (this.inactive() || !this.monitorSpec) return;
      this.pushProcessState();
    }, PROCESS_STATE_PUSH_INTERVAL_MS);
    this.processPushTimer.unref();
  }

  private stopProcessStatePush(): void {
    if (this.processPushTimer) {
      clearInterval(this.processPushTimer);
      this.processPushTimer = null;
    }
  }
}
