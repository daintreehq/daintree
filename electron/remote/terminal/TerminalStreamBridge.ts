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
 * ack) goes the other way.
 *
 * Acks stay end to end while the client is attached, so a slow renderer still
 * throttles its PTY. While the client is away the bridge acks everything
 * itself, so no PTY stalls waiting for a renderer that is not there, and the
 * ring holds the output for the client's resume. A client that stops acking
 * altogether is dropped to a snapshot resync instead of holding its PTYs.
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
  /** Serialized state of the terminal's headless mirror, or null. */
  getSnapshot(terminalId: string): Promise<string | null>;
  budget?: RingBudget;
  ringBytesPerTerminal?: number;
  /**
   * Unacked bytes a client may hold for one terminal before it is treated as
   * stuck and dropped to a snapshot resync.
   */
  maxOutstandingBytes?: number;
  /** Queued interactive-lane bytes above which output waits in the ring. */
  busyBytes?: number;
  /** Delay before reconnecting a pty-host port that closed underneath us. */
  reconnectDelayMs?: number;
  /** Largest snapshot sent in a reset; a larger one resets to a cleared screen. */
  maxSnapshotBytes?: number;
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
  needsReset: boolean;
  resetting: boolean;
}

let sharedBudget: RingBudget | null = null;

/** The host-wide budget every bridge charges unless given its own. */
export function getSharedRingBudget(): RingBudget {
  sharedBudget ??= new RingBudget();
  return sharedBudget;
}

const DEFAULT_BUSY_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024;
const DEFAULT_RECONNECT_DELAY_MS = 1_000;

function toIncarnation(value: number): number {
  return Number.isInteger(value) && value >= 0 ? value % 0x1_0000_0000 : 0;
}

export class TerminalStreamBridge {
  readonly endpointId: string;

  private readonly opts: TerminalStreamBridgeOptions;
  private readonly budget: RingBudget;
  private readonly ringBytes: number;
  private readonly maxOutstanding: number;
  private readonly busyBytes: number;
  private readonly maxSnapshotBytes: number;

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
  private disposed = false;

  constructor(options: TerminalStreamBridgeOptions) {
    this.opts = options;
    this.endpointId = options.endpointId;
    this.budget = options.budget ?? getSharedRingBudget();
    this.ringBytes = options.ringBytesPerTerminal ?? DEFAULT_TERMINAL_RING_BYTES;
    this.maxOutstanding = options.maxOutstandingBytes ?? this.ringBytes;
    this.busyBytes = options.busyBytes ?? DEFAULT_BUSY_BYTES;
    this.maxSnapshotBytes = options.maxSnapshotBytes ?? DEFAULT_MAX_SNAPSHOT_BYTES;
  }

  get isAttached(): boolean {
    return this.session !== null;
  }

  get isDisposed(): boolean {
    return this.disposed;
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
    for (const stream of this.streams.values()) stream.ring.dispose();
    this.streams.clear();
    this.behind.clear();
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
    for (const stream of this.streams.values()) {
      stream.outstanding = 0;
      if (replaced) stream.needsReset = true;
    }
    if (this.projectId !== null) {
      const port = this.opts.openPort(this.projectId);
      if (port) this.adoptPort(port);
      else this.scheduleReconnect();
    }
    previous?.close();
    if (replaced) for (const stream of this.streams.values()) this.pump(stream);
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
  }

  dispose(): void {
    if (this.disposed) return;
    this.detach();
    this.disposed = true;
    this.clearReconnectTimer();
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
      const stream = this.streams.get(entry.id);
      if (!stream) {
        outcomes.push({ id: entry.id, outcome: "unknown" });
        continue;
      }
      this.settleOutstanding(stream);
      if (stream.resetting) {
        outcomes.push({ id: entry.id, outcome: "reset" });
        continue;
      }
      const replayable =
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
    for (const id of mentioned) {
      const stream = this.streams.get(id);
      if (stream) this.pump(stream);
    }
    return { terminals: outcomes };
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
    const message = raw as { type?: unknown; id?: unknown };
    if (typeof message.id !== "string" || message.id.length === 0) return;
    if (message.type === "data") {
      const { data, bytes } = raw as { data?: unknown; bytes?: unknown };
      if (!(data instanceof Uint8Array) || typeof bytes !== "number") return;
      this.onData(message.id, data, bytes);
      return;
    }
    // Status pulses are relayed live and never replayed: they describe the
    // moment, and a resumed client learns the present from the next one.
    if (message.type === "tier-changed" || message.type === "terminal-status") {
      if (!this.canSend) return;
      const stream = this.streams.get(message.id);
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
        this.settleOutstanding(stream);
        stream.ring.dispose();
        this.behind.delete(stream);
      }
      stream = {
        id,
        incarnation,
        seq: 0,
        ring: new TerminalRing(this.ringBytes, this.budget),
        sentSeq: 0,
        outstanding: 0,
        needsReset: false,
        resetting: false,
      };
      this.streams.set(id, stream);
    }
    stream.seq++;
    stream.ring.push({ seq: stream.seq, data, bytes });
    if (!this.canSend) {
      this.ackPty(id, bytes);
      return;
    }
    stream.outstanding += bytes;
    if (stream.outstanding > this.maxOutstanding && !stream.resetting) {
      // The client has stopped acking. Holding its PTY paused would stall the
      // agent for everyone; resync it from a snapshot when it catches up.
      stream.needsReset = true;
    }
    this.pump(stream);
  }

  private pump(stream: StreamState): void {
    if (!this.canSend || stream.resetting) return;
    if (stream.needsReset) {
      void this.reset(stream);
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
        void this.reset(stream);
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

  private async reset(stream: StreamState): Promise<void> {
    if (stream.resetting) return;
    stream.resetting = true;
    stream.needsReset = false;
    this.behind.delete(stream);
    // Everything up to the boundary is covered by the snapshot, so the client
    // no longer owes acks for it.
    this.settleOutstanding(stream);
    // Output at or before this seq is in the snapshot: the mirror is fed as
    // output is produced, ahead of the port batcher that feeds this bridge.
    // Later frames may overlap its tail; that is the price of never losing any.
    const boundary = stream.seq;
    let snapshot: string | null;
    try {
      snapshot = await this.opts.getSnapshot(stream.id);
    } catch {
      snapshot = null;
    }
    stream.resetting = false;
    if (this.disposed || this.streams.get(stream.id) !== stream) return;
    if (!this.canSend) {
      stream.needsReset = true;
      return;
    }
    if (snapshot !== null && Buffer.byteLength(snapshot, "utf8") > this.maxSnapshotBytes) {
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

  private postReset(stream: StreamState, boundary: number, snapshot: string | null): EnqueueResult {
    const session = this.session;
    if (!session) return "refused";
    const build = (snap: string | null) => ({
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
    if (message.type === "ack") {
      // Clamped: acks for frames the bridge already settled (a replay, a
      // reset, an earlier session) must not be counted twice by the pty-host.
      const stream = this.streams.get(message.id);
      if (!stream) return;
      const bytes = Math.min(message.bytes, stream.outstanding);
      if (bytes <= 0) return;
      stream.outstanding -= bytes;
      this.ackPty(message.id, bytes);
      return;
    }
    safePost(this.port, message);
  }

  private settleOutstanding(stream: StreamState): void {
    if (stream.outstanding > 0) this.ackPty(stream.id, stream.outstanding);
    stream.outstanding = 0;
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
