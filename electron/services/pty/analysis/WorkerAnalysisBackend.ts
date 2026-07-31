import type { AgentState } from "../../../../shared/types/agent.js";
import type { ActivityStateMetadata } from "../../ActivityMonitor.js";
import type { PatternDetectionConfig } from "../AgentPatternDetector.js";
import type {
  AnalysisBackend,
  AnalysisFinalCapture,
  MonitorStartOptions,
} from "./AnalysisBackend.js";
import type { SerializedTerminalSnapshot } from "../../../../shared/types/terminal.js";
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

// Flow control on the analysis feed (worker_threads postMessage queues
// unbounded in the receiver, so a saturated worker would otherwise accumulate
// data messages without limit). Units are string length — the same measure the
// worker acks. Above HIGH, chunks coalesce into one host-side pending string;
// acks dropping outstanding to LOW flush it as a single data message
// (hysteresis, one alloc). HOLD_HARD_CAP bounds the host-side hold: past it
// the held data is dropped and the slot is rebuilt fresh (analysis-only
// degradation; the renderer path is untouched). Exported for tests.
export const ANALYSIS_FEED_HIGH_WATERMARK = 4 * 1024 * 1024;
export const ANALYSIS_FEED_LOW_WATERMARK = 1024 * 1024;
export const ANALYSIS_FEED_HOLD_HARD_CAP = 32 * 1024 * 1024;

export interface AnalysisFeedFlowControl {
  highWatermark: number;
  lowWatermark: number;
  holdHardCap: number;
}

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
  /** Test hook: override the feed flow-control watermarks. */
  flowControl?: AnalysisFeedFlowControl;
}

/** The pool surface a backend needs; implemented by AnalysisWorkerPool. */
export interface AnalysisPoolHost {
  /** Returns true when the message was actually handed to a live worker. */
  post(terminalId: string, msg: HostToWorkerMessage): boolean;
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
  // Flow control: string-length units posted-but-unacked, and the coalesced
  // hold accumulated while above the high watermark.
  private outstandingFeedBytes = 0;
  private heldFeed: { data: string; flags: AnalysisChunkFlags } | null = null;
  private readonly flowControl: AnalysisFeedFlowControl;
  // Monotonic slot generation. Bumped on every fresh-slot rebuild (worker
  // loss, feed overflow); stamped on create/data and echoed in data-ack so a
  // late ack from a superseded generation can't debit the fresh ledger.
  private feedEpoch = 0;

  constructor(
    private readonly spec: WorkerBackendSpec,
    private readonly delegate: WorkerAnalysisDelegate,
    private readonly pool: AnalysisPoolHost
  ) {
    this.lastCols = spec.cols;
    this.lastRows = spec.rows;
    this.currentScrollback = spec.scrollback;
    this.flowControl = spec.flowControl ?? {
      highWatermark: ANALYSIS_FEED_HIGH_WATERMARK,
      lowWatermark: ANALYSIS_FEED_LOW_WATERMARK,
      holdHardCap: ANALYSIS_FEED_HOLD_HARD_CAP,
    };
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
      epoch: this.feedEpoch,
    });
  }

  feedChunk(data: string, flags: AnalysisChunkFlags): void {
    if (this.inactive()) return;
    this.persistSuppressed = false;

    // Above the high watermark (or while a hold already exists — FIFO), stop
    // posting and coalesce host-side. Acks release the hold below the low
    // watermark; the hard cap rebuilds the slot fresh instead of growing
    // without bound.
    if (this.heldFeed !== null || this.outstandingFeedBytes >= this.flowControl.highWatermark) {
      if (this.heldFeed === null) {
        this.heldFeed = { data, flags };
      } else {
        this.heldFeed.data += data;
        this.heldFeed.flags = flags;
      }
      if (this.heldFeed.data.length > this.flowControl.holdHardCap) {
        this.overflowResetSlot();
      }
      return;
    }

    this.postData(data, flags);
  }

  // Posts a data message stamped with the current epoch, crediting outstanding
  // bytes ONLY when the worker actually received it (a no-op/failed post must
  // not leave phantom outstanding bytes that never ack).
  private postData(data: string, flags: AnalysisChunkFlags): void {
    const sent = this.pool.post(this.spec.terminalId, {
      type: "data",
      terminalId: this.spec.terminalId,
      data,
      flags,
      epoch: this.feedEpoch,
    });
    if (sent) {
      this.outstandingFeedBytes += data.length;
    }
  }

  // Force-posts any host-side hold, regardless of the low watermark. Called
  // before every serialize request so the per-terminal barrier in the worker
  // runtime orders request-after-data — otherwise a request would overtake the
  // coalesced hold and serialize a buffer missing up to the whole hold.
  private flushHeldFeed(): void {
    if (this.heldFeed === null || this.inactive()) return;
    const held = this.heldFeed;
    this.heldFeed = null;
    this.postData(held.data, held.flags);
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

  /**
   * The grid the worker's mirror will serialize at, sampled synchronously at
   * the call site that is about to post the request (#11552).
   *
   * Correct without a worker round-trip because the ordering is total: this
   * function and the `pool.request()` that follows run in one JS turn, every
   * earlier `resize` post is already ahead of the request in the worker's FIFO,
   * and any later resize necessarily queues behind it. Reading `lastCols` after
   * the await would instead report a grid the payload was NOT produced at.
   */
  private captureGeometry(): { cols: number; rows: number } {
    return { cols: this.lastCols, rows: this.lastRows };
  }

  async serialize(): Promise<SerializedTerminalSnapshot | null> {
    if (this.inactive()) return null;
    this.flushHeldFeed();
    const geometry = this.captureGeometry();
    const result = await this.pool.request(this.spec.terminalId, "serialize");
    return typeof result === "string" ? { data: result, ...geometry } : null;
  }

  async serializeForPersistence(): Promise<SerializedTerminalSnapshot | null> {
    if (this.inactive() || this.persistSuppressed) return null;
    this.flushHeldFeed();
    const geometry = this.captureGeometry();
    const result = await this.pool.request(this.spec.terminalId, "serialize-persistence");
    return typeof result === "string" ? { data: result, ...geometry } : null;
  }

  async captureFinalSnapshot(): Promise<AnalysisFinalCapture> {
    if (this.inactive()) return { snapshot: null, persistence: null };
    this.flushHeldFeed();
    const geometry = this.captureGeometry();
    const result = await this.pool.request(this.spec.terminalId, "final-snapshot");
    if (result !== null && typeof result === "object") {
      const wire = result as AnalysisFinalSnapshot;
      return {
        snapshot: wire.snapshot === null ? null : { data: wire.snapshot, ...geometry },
        persistence:
          this.persistSuppressed || wire.persistence === null
            ? null
            : { data: wire.persistence, ...geometry },
      };
    }
    return { snapshot: null, persistence: null };
  }

  release(): void {
    if (this.released) return;
    this.released = true;
    this.stopProcessStatePush();
    this.monitorSpec = null;
    // Drop any host-side hold (up to the hard cap) — no future ack will arrive
    // to flush it once the slot is freed.
    this.heldFeed = null;
    this.outstandingFeedBytes = 0;
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
      case "data-ack":
        this.handleDataAck(msg.epoch, msg.bytes);
        return;
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
    // The dead worker's queued messages (and their acks) are gone — the ledger
    // reset and epoch bump happen in rebuildFreshSlot.
    this.rebuildFreshSlot();
  }

  private handleDataAck(epoch: number, bytes: number): void {
    // Stale ack from a superseded generation (worker loss / feed overflow
    // recreated the slot). Ignoring it keeps the fresh ledger honest —
    // otherwise a late pre-reset ack debits bytes the new generation never
    // posted, and under sustained output that skew defeats hold decisions.
    if (epoch !== this.feedEpoch) return;
    this.outstandingFeedBytes = Math.max(0, this.outstandingFeedBytes - bytes);
    if (
      this.heldFeed !== null &&
      this.outstandingFeedBytes <= this.flowControl.lowWatermark &&
      !this.inactive()
    ) {
      const held = this.heldFeed;
      this.heldFeed = null;
      this.postData(held.data, held.flags);
    }
  }

  // Hard-cap escape hatch: the worker is so far behind that the host-side
  // hold has grown past the cap. Drop the hold and rebuild the slot fresh —
  // detection continues from live output with a fresh buffer instead of the
  // host accumulating unbounded memory. Analysis-only degradation (renderer
  // path unaffected); persistence stays suppressed until real output dirties
  // the fresh buffer (same machinery as worker respawn).
  private overflowResetSlot(): void {
    const heldLength = this.heldFeed?.data.length ?? 0;
    console.error(
      `[WorkerAnalysisBackend] Analysis feed overflow for ${this.spec.terminalId} ` +
        `(held ${heldLength} chars past cap ${this.flowControl.holdHardCap}); ` +
        `dropping held output and rebuilding the analysis slot fresh`
    );
    this.rebuildFreshSlot();
  }

  // Shared slot rebuild for worker-loss and feed-overflow: fresh buffer, no
  // session restore (a phantom restore banner must not surface in wake
  // snapshots), persistence suppressed until real output dirties the new
  // buffer, monitor restarted with preserve-state semantics. Bumps the feed
  // epoch and resets the flow-control ledger so acks from the old generation
  // (and the dropped hold) can't debit the new one.
  private rebuildFreshSlot(): void {
    this.feedEpoch++;
    this.outstandingFeedBytes = 0;
    this.heldFeed = null;
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
      epoch: this.feedEpoch,
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
    // No worker to flush a hold into — drop it and zero the ledger.
    this.heldFeed = null;
    this.outstandingFeedBytes = 0;
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
