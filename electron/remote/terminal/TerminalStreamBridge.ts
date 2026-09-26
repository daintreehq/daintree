import {
  IPC_HIGH_WATERMARK_PERCENT,
  IPC_MAX_PAUSE_MS,
  IPC_MAX_QUEUE_BYTES,
  IPC_TOTAL_QUEUE_HIGH_WATERMARK_BYTES,
} from "../../services/pty/types.js";
import {
  isValidTerminalGeometry,
  type SerializedTerminalSnapshot,
} from "../../../shared/types/terminal.js";
import { Lane } from "../link/frames.js";
import { InteractiveKind } from "../link/messages.js";
import type { LinkSession } from "../link/session.js";
import type { EnqueueResult } from "../link/scheduler.js";
import { safePost, type PortLike } from "./ports.js";
import {
  TERMINAL_RESUME_METHOD,
  TerminalInPortMessageSchema,
  TerminalResumeRequestSchema,
  type TerminalResumeOutcome,
  type TerminalResumeRequest,
  type TerminalResumeResult,
} from "./protocol.js";
import { DEFAULT_TERMINAL_RING_BYTES, RingBudget, TerminalRing, type RingFrame } from "./ring.js";

/**
 * Host side of one remote endpoint's terminal stream.
 *
 * The endpoint is connected to the pty-host as a synthetic window, so it gets
 * the same per-window batching, project filtering and ack-based flow control a
 * local view does. This bridge sits between that port and the link: output is
 * stamped with the PTY's incarnation and a per-terminal sequence number, kept
 * in a bounded ring, and posted on the interactive lane; input (write, resize,
 * ack) goes the other way, and only for terminals the endpoint's project owns.
 *
 * Acks stay end to end while the client is attached, so a slow renderer still
 * throttles its PTY. While the client is away the bridge acks everything
 * itself, so no PTY stalls waiting for a renderer that is not there, and the
 * ring holds the output for the client's resume. A client that falls too far
 * behind, or stops acking for too long, is dropped to a snapshot resync well
 * before the pty-host would pause the PTY on its account.
 */

export interface TerminalStreamBridgeOptions {
  endpointId: string;
  /**
   * Connect this endpoint to the pty-host for `projectId` and return this
   * side's port, or null when the pty-host is unavailable. Called again on
   * every reconnect; each call replaces the previous connection.
   */
  openPort(projectId: string): PortLike | null;
  /** Disconnect the endpoint from the pty-host (dispose, or unbinding its project). */
  releasePort(): void;
  /** The PTY's current launch generation. */
  getIncarnation(terminalId: string): number;
  /**
   * The project that owns a terminal, from the host's own spawn records, or
   * null when the host does not know it (never spawned, or gone). Terminal ids
   * arriving from the client are never trusted on their own.
   */
  ownerOf(terminalId: string): string | null;
  /**
   * Whether this endpoint drives its project right now, and under which lease:
   * `false` when someone else does, the lease id when this endpoint holds it,
   * `null` when nobody does. Input and resizes are gated on it and stamped
   * with the lease id, so the pty-host can refuse what a takeover made stale
   * while it waited in the port. Absent means always, unstamped.
   */
  driveLease?(): number | null | false;
  budget?: RingBudget;
  ringBytesPerTerminal?: number;
  /**
   * Unacked bytes a client may hold for one terminal before it is dropped to a
   * snapshot resync. Must stay below the pty-host's pause watermark, or the
   * PTY is paused before the bridge ever notices.
   */
  maxOutstandingBytes?: number;
  /** Unacked bytes across all of this endpoint's terminals before the busiest one is resynced. */
  maxTotalOutstandingBytes?: number;
  /** How long outstanding output may go without an ack before its terminal is resynced. */
  ackTimeoutMs?: number;
  /** Queued interactive-lane bytes above which output waits in the ring. */
  busyBytes?: number;
  /** Delay before reconnecting a pty-host port that closed underneath us. */
  reconnectDelayMs?: number;
  /** Largest snapshot sent in a reset; a larger one resets to a cleared screen. */
  maxSnapshotBytes?: number;
  /** How long a snapshot may take before the reset goes out with a cleared screen. */
  snapshotTimeoutMs?: number;
  /** Terminals tracked at once; the least recently active beyond it are retired. */
  maxStreams?: number;
}

interface StreamState {
  id: string;
  incarnation: number;
  /** Seq of the newest frame. */
  seq: number;
  ring: TerminalRing;
  /** Newest seq queued for the client. */
  sentSeq: number;
  /** Bytes queued for the client that the pty-host still counts against this port. */
  outstanding: number;
  /** When the oldest unacked output went out without an ack since; 0 when nothing is owed. */
  owedSince: number;
  /** Order of last output, for retiring the least recently active stream. */
  lastActivity: number;
  needsReset: boolean;
  resetting: boolean;
}

/** A snapshot requested through the pty-host port, fenced against the stream. */
interface PendingFence {
  stream: StreamState;
  /** Seq of the last frame before the fence marker; null until it arrives. */
  boundary: number | null;
  timer: ReturnType<typeof setTimeout>;
}

let sharedBudget: RingBudget | null = null;

/** The host-wide budget every bridge charges unless given its own. */
export function getSharedRingBudget(): RingBudget {
  sharedBudget ??= new RingBudget();
  return sharedBudget;
}

const PAUSE_WATERMARK_BYTES = (IPC_MAX_QUEUE_BYTES * IPC_HIGH_WATERMARK_PERCENT) / 100;
/** Half the pty-host's pause watermark: resynced long before the PTY would pause. */
export const DEFAULT_MAX_OUTSTANDING_BYTES = Math.floor(PAUSE_WATERMARK_BYTES / 2);
/** Half the pty-host's aggregate pause watermark, for the same reason. */
export const DEFAULT_MAX_TOTAL_OUTSTANDING_BYTES = Math.floor(
  IPC_TOTAL_QUEUE_HIGH_WATERMARK_BYTES / 2
);
/** Well inside the pty-host's safety timeout, so a silent client never holds a PTY that long. */
export const DEFAULT_ACK_TIMEOUT_MS = Math.floor(IPC_MAX_PAUSE_MS / 4);
export const DEFAULT_MAX_STREAMS = 4096;

const DEFAULT_BUSY_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024;
const DEFAULT_RECONNECT_DELAY_MS = 1_000;
const DEFAULT_SNAPSHOT_TIMEOUT_MS = 15_000;
/** Streams tracked before the first sweep for terminals that are gone. */
const MIN_SWEEP_AT = 64;

function toIncarnation(value: number): number {
  return Number.isInteger(value) && value >= 0 ? value % 0x1_0000_0000 : 0;
}

function toSnapshot(value: unknown): SerializedTerminalSnapshot | null {
  if (!isValidTerminalGeometry(value)) return null;
  const data = (value as { data?: unknown }).data;
  if (typeof data !== "string") return null;
  return { data, cols: value.cols, rows: value.rows };
}

export class TerminalStreamBridge {
  readonly endpointId: string;

  private readonly opts: TerminalStreamBridgeOptions;
  private readonly budget: RingBudget;
  private readonly ringBytes: number;
  private readonly maxOutstanding: number;
  private readonly maxTotalOutstanding: number;
  private readonly ackTimeoutMs: number;
  private readonly busyBytes: number;
  private readonly maxSnapshotBytes: number;
  private readonly maxStreams: number;

  private projectId: string | null = null;
  private port: PortLike | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** A pty-host connection has existed for the current project. */
  private connected = false;

  private session: LinkSession | null = null;
  private sessionCleanup: (() => void)[] = [];
  private resumed = false;

  private readonly streams = new Map<string, StreamState>();
  private readonly behind = new Set<StreamState>();
  private readonly fences = new Map<number, PendingFence>();
  private nextFenceId = 0;
  private totalOutstanding = 0;
  private ackTimer: ReturnType<typeof setTimeout> | null = null;
  private activityClock = 0;
  private sweepAt = MIN_SWEEP_AT;
  private disposed = false;

  constructor(options: TerminalStreamBridgeOptions) {
    this.opts = options;
    this.endpointId = options.endpointId;
    this.budget = options.budget ?? getSharedRingBudget();
    this.ringBytes = options.ringBytesPerTerminal ?? DEFAULT_TERMINAL_RING_BYTES;
    this.maxOutstanding = options.maxOutstandingBytes ?? DEFAULT_MAX_OUTSTANDING_BYTES;
    this.maxTotalOutstanding =
      options.maxTotalOutstandingBytes ?? DEFAULT_MAX_TOTAL_OUTSTANDING_BYTES;
    this.ackTimeoutMs = options.ackTimeoutMs ?? DEFAULT_ACK_TIMEOUT_MS;
    this.busyBytes = options.busyBytes ?? DEFAULT_BUSY_BYTES;
    this.maxSnapshotBytes = options.maxSnapshotBytes ?? DEFAULT_MAX_SNAPSHOT_BYTES;
    this.maxStreams = options.maxStreams ?? DEFAULT_MAX_STREAMS;
  }

  get isAttached(): boolean {
    return this.session !== null;
  }

  /** The attached client has said where it is, so output flows to it. */
  get isResumed(): boolean {
    return this.session !== null && this.resumed;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  /** Terminals this bridge holds stream state for. */
  get streamCount(): number {
    return this.streams.size;
  }

  /** Stream position for a terminal, for diagnostics and tests. */
  position(terminalId: string): { incarnation: number; seq: number; sentSeq: number } | null {
    const s = this.streams.get(terminalId);
    return s ? { incarnation: s.incarnation, seq: s.seq, sentSeq: s.sentSeq } : null;
  }

  /**
   * Bind the endpoint to a project (or none). The pty-host scopes a window's
   * output by project, so a change means a fresh connection; stream state for
   * the old project's terminals is dropped with it.
   */
  setProject(projectId: string | null): void {
    if (this.disposed || projectId === this.projectId) return;
    const hadPort = this.port !== null;
    this.projectId = projectId;
    this.connected = false;
    this.abandonFences(false);
    for (const stream of [...this.streams.values()]) this.retire(stream, false);
    this.behind.clear();
    this.sweepAt = MIN_SWEEP_AT;
    if (projectId === null) {
      this.dropPort();
      if (hadPort) this.opts.releasePort();
      return;
    }
    this.reconnect();
  }

  /**
   * Replace the pty-host connection: after a pty-host restart, a shard
   * reroute, or a port that closed underneath us. The new port's flow-control
   * ledger starts empty, so nothing is outstanding against it.
   */
  reconnect(): void {
    if (this.disposed) return;
    this.clearReconnectTimer();
    const previous = this.port;
    this.port = null;
    // The pty-host discards what its batcher held for the old connection and
    // may have addressed a failed flush to an id no WebContents answers to,
    // so a stream carried across connections can have lost bytes the seq
    // cannot show. Repaint every stream the client is following.
    const replaced = this.connected;
    // A fence asked of the old connection is never answered by the new one.
    this.abandonFences(true);
    for (const stream of this.streams.values()) {
      this.setOutstanding(stream, 0);
      if (replaced) stream.needsReset = true;
    }
    if (this.projectId !== null) {
      const port = this.opts.openPort(this.projectId);
      if (port) this.adoptPort(port);
      else this.scheduleReconnect();
    }
    previous?.close();
    // A reset promised while there was no connection (a resume, or a fence
    // that could not be posted) is owed on the first one too.
    for (const stream of this.streams.values()) {
      if (replaced || stream.needsReset) this.pump(stream);
    }
  }

  /**
   * Start serving a link session. Output waits in the ring until the client
   * says where it is with a resume call; until then it is acked here.
   */
  attach(session: LinkSession): void {
    if (this.disposed) return;
    if (this.session === session) return;
    this.detach();
    this.session = session;
    this.resumed = false;
    this.sessionCleanup = [
      session.on(Lane.INTERACTIVE, InteractiveKind.TERMINAL_IN, (body) => {
        if (body.endpointId === this.endpointId) this.onClientMessage(body.message);
      }),
      session.onWritable(() => this.pumpBehind()),
      session.onClose(() => {
        if (this.session === session) this.detach();
      }),
      registerOnSession(session, this),
    ];
  }

  /** The client went away: ack what it still owed and keep the PTYs flowing. */
  detach(): void {
    const session = this.session;
    if (!session) return;
    this.session = null;
    this.resumed = false;
    for (const cleanup of this.sessionCleanup.splice(0)) cleanup();
    for (const stream of this.streams.values()) this.settleOutstanding(stream);
    this.behind.clear();
    this.clearAckTimer();
  }

  dispose(): void {
    if (this.disposed) return;
    this.detach();
    this.disposed = true;
    this.clearReconnectTimer();
    this.abandonFences(false);
    const hadPort = this.port !== null || this.projectId !== null;
    this.dropPort();
    if (hadPort) this.opts.releasePort();
    for (const stream of this.streams.values()) stream.ring.dispose();
    this.streams.clear();
  }

  /** Answer the client's resume: replay from the ring, or reset from a snapshot. */
  resume(request: TerminalResumeRequest): TerminalResumeResult {
    const firstResume = !this.resumed;
    this.resumed = true;
    const outcomes: { id: string; outcome: TerminalResumeOutcome }[] = [];
    const mentioned = new Set<string>();
    for (const entry of request.terminals) {
      if (mentioned.has(entry.id)) continue;
      mentioned.add(entry.id);
      let stream = this.streams.get(entry.id);
      if (!stream && this.owns(entry.id)) {
        // The client painted this terminal from a stream this bridge never
        // carried (the host's listener restarted, or the stream was retired),
        // so nothing here can show what it missed: repaint from a snapshot.
        stream = this.createStream(entry.id, this.incarnationOf(entry.id));
        stream.needsReset = true;
      }
      if (!stream || !this.owns(entry.id)) {
        if (stream) this.retire(stream, true);
        outcomes.push({ id: entry.id, outcome: "unknown" });
        continue;
      }
      this.settleOutstanding(stream);
      if (stream.resetting) {
        outcomes.push({ id: entry.id, outcome: "reset" });
        continue;
      }
      const replayable =
        entry.reset !== true &&
        !stream.needsReset &&
        stream.incarnation === entry.incarnation &&
        entry.lastSeq <= stream.seq &&
        stream.ring.covers(entry.lastSeq, stream.seq);
      if (replayable) {
        stream.sentSeq = entry.lastSeq;
        stream.needsReset = false;
        outcomes.push({ id: entry.id, outcome: "replayed" });
      } else {
        stream.needsReset = true;
        outcomes.push({ id: entry.id, outcome: "reset" });
      }
    }
    if (firstResume) {
      // Terminals the client never saw start live from here; its view fetches
      // their history through the normal restore path.
      for (const stream of this.streams.values()) {
        if (mentioned.has(stream.id)) continue;
        this.settleOutstanding(stream);
        stream.sentSeq = stream.seq;
        stream.needsReset = false;
      }
    }
    // Creating a stream above can retire one answered earlier in this call:
    // the client must not keep a position for a stream the host has dropped.
    for (const entry of outcomes) {
      if (!this.streams.has(entry.id)) entry.outcome = "unknown";
    }
    for (const id of mentioned) {
      const stream = this.streams.get(id);
      if (stream) this.pump(stream);
    }
    return { terminals: outcomes };
  }

  private owns(terminalId: string): boolean {
    return this.projectId !== null && this.opts.ownerOf(terminalId) === this.projectId;
  }

  private adoptPort(port: PortLike): void {
    this.port = port;
    this.connected = true;
    port.onMessage((message) => {
      if (this.port === port) this.onPtyMessage(message);
    });
    port.onClose(() => {
      if (this.port !== port) return;
      this.port = null;
      this.abandonFences(true);
      this.scheduleReconnect();
    });
  }

  private dropPort(): void {
    const port = this.port;
    this.port = null;
    port?.close();
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.reconnectTimer || this.projectId === null) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnect();
    }, this.opts.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS);
    this.reconnectTimer.unref?.();
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private get canSend(): boolean {
    return this.session !== null && this.session.isOpen && this.resumed;
  }

  private get linkBusy(): boolean {
    return (this.session?.queuedBytes(Lane.INTERACTIVE) ?? 0) >= this.busyBytes;
  }

  private onPtyMessage(raw: unknown): void {
    if (!raw || typeof raw !== "object") return;
    const message = raw as { type?: unknown; id?: unknown; requestId?: unknown };
    if (typeof message.id !== "string" || message.id.length === 0) return;
    if (message.type === "data") {
      const { data, bytes } = raw as { data?: unknown; bytes?: unknown };
      if (!(data instanceof Uint8Array) || typeof bytes !== "number") return;
      this.onData(message.id, data, bytes);
      return;
    }
    if (message.type === "serialize-fence" || message.type === "serialized-state") {
      if (typeof message.requestId !== "number") return;
      const fence = this.fences.get(message.requestId);
      if (!fence || fence.stream.id !== message.id) return;
      if (message.type === "serialize-fence") {
        // Every frame before this marker is in the snapshot on its way.
        fence.boundary = fence.stream.seq;
      } else {
        this.completeFence(
          message.requestId,
          fence,
          toSnapshot((raw as { state?: unknown }).state)
        );
      }
      return;
    }
    // Status pulses are relayed live and never replayed: they describe the
    // moment, and a resumed client learns the present from the next one.
    if (message.type === "tier-changed" || message.type === "terminal-status") {
      if (!this.canSend) return;
      const stream = this.streams.get(message.id);
      if (!stream && !this.owns(message.id)) return;
      this.post(message.id, stream?.incarnation ?? this.incarnationOf(message.id), 0, raw);
    }
    // `worker-ingest-engaged` never arrives: a remote view cannot engage.
  }

  private incarnationOf(terminalId: string): number {
    return toIncarnation(this.opts.getIncarnation(terminalId));
  }

  private onData(id: string, data: Uint8Array, bytes: number): void {
    const incarnation = this.incarnationOf(id);
    let stream = this.streams.get(id);
    if (!stream || stream.incarnation !== incarnation) {
      if (stream) {
        // The PTY restarted under the same id: its old output is history the
        // client already has; the new incarnation streams from seq 1.
        this.retire(stream, true);
      } else if (!this.owns(id)) {
        // The pty-host scopes this port to the project already; a terminal
        // the host's records do not put there is never streamed, but its
        // bytes are released so nothing stalls on them.
        this.ackPty(id, bytes);
        return;
      }
      stream = this.createStream(id, incarnation);
    }
    stream.seq++;
    stream.lastActivity = ++this.activityClock;
    stream.ring.push({ seq: stream.seq, data, bytes });
    if (!this.canSend || stream.resetting) {
      // Nobody to ack it, or it is about to be covered by a snapshot.
      this.ackPty(id, bytes);
      return;
    }
    this.setOutstanding(stream, stream.outstanding + bytes);
    if (stream.outstanding > this.maxOutstanding) {
      // Far enough behind that the pty-host would soon pause the PTY for
      // everyone; resync it from a snapshot instead.
      stream.needsReset = true;
    } else if (this.totalOutstanding > this.maxTotalOutstanding) {
      // Same for the pty-host's aggregate watermark across this endpoint.
      const busiest = this.busiestStream();
      busiest.needsReset = true;
      if (busiest !== stream) this.pump(busiest);
    }
    this.pump(stream);
  }

  private createStream(id: string, incarnation: number): StreamState {
    if (this.streams.size >= this.sweepAt) {
      this.sweep();
      this.sweepAt = Math.max(MIN_SWEEP_AT, this.streams.size * 2);
    }
    while (this.streams.size >= this.maxStreams) {
      let oldest: StreamState | null = null;
      for (const candidate of this.streams.values()) {
        if (!oldest || candidate.lastActivity < oldest.lastActivity) oldest = candidate;
      }
      if (!oldest) break;
      this.retire(oldest, true);
    }
    const stream: StreamState = {
      id,
      incarnation,
      seq: 0,
      ring: new TerminalRing(this.ringBytes, this.budget),
      sentSeq: 0,
      outstanding: 0,
      owedSince: 0,
      lastActivity: 0,
      needsReset: false,
      resetting: false,
    };
    this.streams.set(id, stream);
    return stream;
  }

  /** Retire streams for terminals the host no longer runs for this project. */
  private sweep(): void {
    for (const stream of [...this.streams.values()]) {
      if (!this.owns(stream.id)) this.retire(stream, true);
    }
  }

  /** Forget a terminal's stream, releasing what it held against the PTY and the ring budget. */
  private retire(stream: StreamState, settle: boolean): void {
    if (settle) this.settleOutstanding(stream);
    else this.setOutstanding(stream, 0);
    for (const [requestId, fence] of this.fences) {
      if (fence.stream !== stream) continue;
      clearTimeout(fence.timer);
      this.fences.delete(requestId);
    }
    stream.ring.dispose();
    this.behind.delete(stream);
    if (this.streams.get(stream.id) === stream) this.streams.delete(stream.id);
  }

  private busiestStream(): StreamState {
    let busiest: StreamState | null = null;
    for (const stream of this.streams.values()) {
      if (!busiest || stream.outstanding > busiest.outstanding) busiest = stream;
    }
    return busiest!;
  }

  private pump(stream: StreamState): void {
    if (!this.canSend || stream.resetting) return;
    if (stream.needsReset) {
      this.reset(stream);
      return;
    }
    while (stream.sentSeq < stream.seq) {
      if (this.linkBusy) {
        this.behind.add(stream);
        return;
      }
      const frame: RingFrame | null = stream.ring.get(stream.sentSeq + 1);
      if (!frame) {
        // Evicted before it could be sent: the gap can only be closed by a snapshot.
        this.reset(stream);
        return;
      }
      const result = this.post(stream.id, stream.incarnation, frame.seq, {
        type: "data",
        id: stream.id,
        data: frame.data,
        bytes: frame.bytes,
      });
      if (result === "refused") {
        this.behind.add(stream);
        return;
      }
      stream.sentSeq = frame.seq;
    }
    this.behind.delete(stream);
  }

  private pumpBehind(): void {
    if (this.behind.size === 0 || !this.canSend || this.linkBusy) return;
    for (const stream of [...this.behind]) {
      if (this.streams.get(stream.id) !== stream) {
        this.behind.delete(stream);
        continue;
      }
      this.pump(stream);
      if (this.linkBusy) return;
    }
  }

  /**
   * Resync a stream from a snapshot fenced against its output: the pty-host
   * posts a marker on this port behind everything it had sent, then takes the
   * snapshot, so frames before the marker are covered by it and frames after
   * it follow the reset. Nothing is painted twice and nothing is lost.
   */
  private reset(stream: StreamState): void {
    if (stream.resetting) return;
    stream.resetting = true;
    stream.needsReset = false;
    this.behind.delete(stream);
    // The snapshot covers everything sent so far, so the client no longer
    // owes acks for it; output until the reset goes out is acked on arrival.
    this.settleOutstanding(stream);
    const requestId = ++this.nextFenceId;
    const timer = setTimeout(() => {
      const fence = this.fences.get(requestId);
      if (fence) this.completeFence(requestId, fence, null);
    }, this.opts.snapshotTimeoutMs ?? DEFAULT_SNAPSHOT_TIMEOUT_MS);
    timer.unref?.();
    this.fences.set(requestId, { stream, boundary: null, timer });
    if (!safePost(this.port, { type: "serialize-fence", id: stream.id, requestId })) {
      // No pty-host connection: the next one repaints every stream anyway.
      clearTimeout(timer);
      this.fences.delete(requestId);
      stream.resetting = false;
      stream.needsReset = true;
    }
  }

  private completeFence(
    requestId: number,
    fence: PendingFence,
    received: SerializedTerminalSnapshot | null
  ): void {
    clearTimeout(fence.timer);
    this.fences.delete(requestId);
    const stream = fence.stream;
    stream.resetting = false;
    if (this.disposed || this.streams.get(stream.id) !== stream) return;
    if (!this.canSend) {
      stream.needsReset = true;
      return;
    }
    // Without a marker (the snapshot timed out first) nothing sent so far is
    // known to be covered; a cleared screen at the current end loses the
    // least.
    const covered = fence.boundary !== null;
    const boundary = fence.boundary ?? stream.seq;
    let snapshot = covered ? received : null;
    if (snapshot !== null && Buffer.byteLength(snapshot.data, "utf8") > this.maxSnapshotBytes) {
      snapshot = null;
    }
    const result = this.postReset(stream, boundary, snapshot);
    if (result === "refused") {
      stream.needsReset = true;
      this.behind.add(stream);
      return;
    }
    stream.sentSeq = boundary;
    this.pump(stream);
  }

  /** Give up on outstanding fences; `resync` asks for another reset once possible. */
  private abandonFences(resync: boolean): void {
    for (const fence of this.fences.values()) {
      clearTimeout(fence.timer);
      fence.stream.resetting = false;
      if (resync) fence.stream.needsReset = true;
    }
    this.fences.clear();
  }

  private postReset(
    stream: StreamState,
    boundary: number,
    snapshot: SerializedTerminalSnapshot | null
  ): EnqueueResult {
    const session = this.session;
    if (!session) return "refused";
    const build = (snap: SerializedTerminalSnapshot | null) => ({
      lane: Lane.INTERACTIVE,
      kind: InteractiveKind.TERMINAL_RESET,
      body: {
        endpointId: this.endpointId,
        terminalId: stream.id,
        incarnation: stream.incarnation,
        snapshot: snap,
        seq: boundary,
      },
    });
    try {
      return session.post(build(snapshot));
    } catch {
      // Too large for a frame: a cleared screen followed by live output beats
      // a client that never resyncs.
      return session.post(build(null));
    }
  }

  private post(id: string, incarnation: number, seq: number, message: unknown): EnqueueResult {
    const session = this.session;
    if (!session) return "refused";
    try {
      return session.post({
        lane: Lane.INTERACTIVE,
        kind: InteractiveKind.TERMINAL_OUT,
        body: { endpointId: this.endpointId, terminalId: id, incarnation, seq, message },
      });
    } catch {
      return "refused";
    }
  }

  private onClientMessage(raw: unknown): void {
    const parsed = TerminalInPortMessageSchema.safeParse(raw);
    if (!parsed.success) return;
    const message = parsed.data;
    // The id is the client's claim; the host's spawn records decide.
    if (!this.owns(message.id)) return;
    if (message.type === "ack") {
      // Clamped: acks for frames the bridge already settled (a replay, a
      // reset, an earlier session) must not be counted twice by the pty-host.
      const stream = this.streams.get(message.id);
      if (!stream) return;
      const bytes = Math.min(message.bytes, stream.outstanding);
      if (bytes <= 0) return;
      this.setOutstanding(stream, stream.outstanding - bytes);
      // Progress restarts the clock on whatever is still owed.
      if (stream.outstanding > 0) stream.owedSince = Date.now();
      this.ackPty(message.id, bytes);
      return;
    }
    // Only the driver types into or sizes the PTY; anyone else's input would
    // interleave with it and anyone else's grid would fight it.
    const leaseId = this.opts.driveLease ? this.opts.driveLease() : null;
    if (leaseId === false) return;
    safePost(this.port, leaseId === null ? message : { ...message, leaseId });
  }

  private settleOutstanding(stream: StreamState): void {
    if (stream.outstanding > 0) this.ackPty(stream.id, stream.outstanding);
    this.setOutstanding(stream, 0);
  }

  /** Every change to a stream's unacked bytes goes through here, so the total and the ack clock stay right. */
  private setOutstanding(stream: StreamState, bytes: number): void {
    this.totalOutstanding += bytes - stream.outstanding;
    if (bytes > 0 && stream.outstanding === 0) {
      stream.owedSince = Date.now();
      this.armAckTimer();
    } else if (bytes === 0) {
      stream.owedSince = 0;
    }
    stream.outstanding = bytes;
  }

  private armAckTimer(): void {
    if (this.ackTimer || this.disposed) return;
    this.ackTimer = setTimeout(() => this.checkAcks(), this.ackTimeoutMs);
    this.ackTimer.unref?.();
  }

  private clearAckTimer(): void {
    if (this.ackTimer) clearTimeout(this.ackTimer);
    this.ackTimer = null;
  }

  /**
   * A client that stops acking would leave its PTYs paused until the pty-host's
   * safety timeout; resync whatever it has owed for too long instead.
   */
  private checkAcks(): void {
    this.ackTimer = null;
    if (!this.canSend) return;
    const now = Date.now();
    let earliest = Infinity;
    for (const stream of [...this.streams.values()]) {
      if (stream.outstanding === 0) continue;
      if (now - stream.owedSince >= this.ackTimeoutMs) {
        stream.needsReset = true;
        this.pump(stream);
      } else {
        earliest = Math.min(earliest, stream.owedSince);
      }
    }
    if (earliest !== Infinity && !this.ackTimer) {
      this.ackTimer = setTimeout(
        () => this.checkAcks(),
        Math.max(1, earliest + this.ackTimeoutMs - now)
      );
      this.ackTimer.unref?.();
    }
  }

  private ackPty(id: string, bytes: number): void {
    if (bytes > 0) safePost(this.port, { type: "ack", id, bytes });
  }
}

interface SessionBridges {
  bridges: Map<string, TerminalStreamBridge>;
  unregisterCall: () => void;
}

const bridgesBySession = new WeakMap<LinkSession, SessionBridges>();

/**
 * One resume handler per session, dispatching by endpoint: a session carries
 * every endpoint of its client, and a call method has a single handler.
 */
function registerOnSession(session: LinkSession, bridge: TerminalStreamBridge): () => void {
  let entry = bridgesBySession.get(session);
  if (!entry) {
    const bridges = new Map<string, TerminalStreamBridge>();
    const unregisterCall = session.registerCallHandler(
      TERMINAL_RESUME_METHOD,
      TerminalResumeRequestSchema,
      (request) => {
        const target = bridges.get(request.endpointId);
        if (!target) throw new Error(`No terminal stream for endpoint ${request.endpointId}`);
        return target.resume(request);
      }
    );
    entry = { bridges, unregisterCall };
    bridgesBySession.set(session, entry);
  }
  const current = entry;
  current.bridges.set(bridge.endpointId, bridge);
  return () => {
    if (current.bridges.get(bridge.endpointId) !== bridge) return;
    current.bridges.delete(bridge.endpointId);
    if (current.bridges.size === 0) {
      current.unregisterCall();
      bridgesBySession.delete(session);
    }
  };
}
