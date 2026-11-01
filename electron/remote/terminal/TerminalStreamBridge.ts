import {
  IPC_HIGH_WATERMARK_PERCENT,
  IPC_MAX_PAUSE_MS,
  IPC_MAX_QUEUE_BYTES,
  IPC_TOTAL_QUEUE_HIGH_WATERMARK_BYTES,
} from "../../services/pty/types.js";
import {
  isValidTerminalGeometry,
  toSnapshotContinuation,
  type SerializedTerminalSnapshot,
} from "../../../shared/types/terminal.js";
import { Lane } from "../link/frames.js";
import { InteractiveKind } from "../link/messages.js";
import { terminalFlow, type LinkSession } from "../link/session.js";
import type { EnqueueResult } from "../link/scheduler.js";
import { createLogger } from "../../utils/logger.js";
import { createKeyedLogLimiter } from "../../utils/keyedLogLimiter.js";
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
 * behind, or leaves output it was sent unacked for too long, is dropped to a
 * snapshot resync well before the pty-host would pause the PTY on its account.
 * Output that follows a resync is acked here too until the client shows it has
 * applied the snapshot, so a snapshot slow to arrive or restore never times
 * out the output queued behind it.
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
  /** Input or a resize from the client went to a PTY: someone is using the host. */
  onInput?(): void;
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
  /** How long output written to the link may go without an ack before its terminal is resynced. */
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

const logger = createLogger("main:TerminalStreamBridge");
const logLimiter = createKeyedLogLimiter();

type ResetReason =
  | "pty-port-replaced"
  | "stream-missing"
  | "client-requested"
  | "incarnation-mismatch"
  | "client-ahead"
  | "ring-gap"
  | "outstanding-bytes"
  | "aggregate-outstanding-bytes"
  | "ack-timeout";

interface StreamState {
  id: string;
  incarnation: number;
  /** Seq of the newest frame. */
  seq: number;
  ring: TerminalRing;
  /** Newest seq queued for the client. */
  sentSeq: number;
  /** Output bytes the pty-host still counts against this port, sent or not. */
  outstanding: number;
  /** Seq through which output is settled with the pty-host; later frames are still charged. */
  settledThrough: number;
  /** Since when output written to the link has waited for an ack; 0 when none does. */
  owedSince: number;
  /** Order of last output, for retiring the least recently active stream. */
  lastActivity: number;
  needsReset: boolean;
  /** Why the reset that is owed was first asked for; kept until one lands. */
  resetReason: ResetReason | null;
  resetting: boolean;
  /**
   * Owed a repaint because the pty-host connection it streamed on was
   * replaced. A restarted pty-host numbers its streams afresh, so until that
   * reset lands the client's restore fence may sit above the new offsets.
   */
  owedReplacement: boolean;
  /** A reset the link refused, kept to post again as it is rather than snapshot afresh. */
  heldReset: { boundary: number; snapshot: SerializedTerminalSnapshot | null } | null;
  ledger: AckLedger;
}

/**
 * The client's acks, set against what was posted to it. They carry only byte
 * counts, in the order the frames went out, so a position in the posted bytes
 * says which frames an ack covers: frames settled with the pty-host already (a
 * replay, output that followed a reset) pay nothing back. Positions run over a
 * terminal's life on this bridge, across sessions and PTY restarts, because
 * the renderer's ack queue does.
 */
interface AckLedger {
  /** Output bytes posted to the client: where the next frame starts. */
  posted: number;
  /** Bytes the client has acked, as it sent them. */
  acked: number;
  /** Where the client's next ack starts. */
  ackedTo: number;
  /** Through where posted frames have been written to the link. */
  writtenTo: number;
  /** Where posted output still charged against the pty-host starts; null when none is. */
  chargedFrom: number | null;
  /** Resets the renderer has not yet said it took: where each was posted, oldest first. */
  unconfirmedResets: { at: number; incarnation: number; seq: number }[];
  /**
   * The latest reset, until the client shows it has applied it: where it was
   * posted and how much the client had acked by then. Output meanwhile is
   * settled on arrival.
   */
  applying: { at: number; acked: number } | null;
}

function newLedger(): AckLedger {
  return {
    posted: 0,
    acked: 0,
    ackedTo: 0,
    writtenTo: 0,
    chargedFrom: null,
    unconfirmedResets: [],
    applying: null,
  };
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
  const { data, continuation } = value as { data?: unknown; continuation?: unknown };
  if (typeof data !== "string") return null;
  const checked = toSnapshotContinuation(continuation);
  return checked
    ? { data, cols: value.cols, rows: value.rows, continuation: checked }
    : { data, cols: value.cols, rows: value.rows };
}

function toStreamEnd(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : undefined;
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
      this.markSettled(stream);
      if (stream.heldReset) {
        // Taken from the old connection's mirror; the repaint below replaces it.
        stream.heldReset = null;
        stream.resetting = false;
        this.markReset(stream, "pty-port-replaced");
      }
      if (replaced) {
        this.markReset(stream, "pty-port-replaced");
        stream.owedReplacement = true;
      }
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
    for (const stream of this.streams.values()) {
      this.settleOutstanding(stream);
      // The next session's resume says what the client has; a reset it never
      // got is owed to that one instead.
      stream.ledger.applying = null;
      stream.ledger.unconfirmedResets = [];
      if (stream.heldReset) {
        stream.heldReset = null;
        stream.resetting = false;
        stream.needsReset = true;
      }
    }
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
        this.markReset(stream, "stream-missing");
      }
      if (!stream || !this.owns(entry.id)) {
        if (stream) this.retire(stream, true);
        outcomes.push({ id: entry.id, outcome: "unknown" });
        continue;
      }
      this.settleOutstanding(stream);
      // Whatever the client still acks from before this is settled already;
      // its count says nothing about the frames that follow.
      stream.ledger.ackedTo = stream.ledger.posted;
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
        stream.resetReason = null;
        outcomes.push({ id: entry.id, outcome: "replayed" });
      } else {
        this.markReset(
          stream,
          entry.reset === true
            ? "client-requested"
            : stream.incarnation !== entry.incarnation
              ? "incarnation-mismatch"
              : entry.lastSeq > stream.seq
                ? "client-ahead"
                : "ring-gap"
        );
        outcomes.push({ id: entry.id, outcome: "reset" });
      }
    }
    if (firstResume) {
      // Terminals the client never saw start live from here; its view fetches
      // their history through the normal restore path.
      for (const stream of this.streams.values()) {
        if (mentioned.has(stream.id)) continue;
        this.settleOutstanding(stream);
        stream.ledger.ackedTo = stream.ledger.posted;
        stream.sentSeq = stream.seq;
        stream.needsReset = false;
        stream.resetReason = null;
        stream.owedReplacement = false;
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
    const unknown = outcomes.filter((entry) => entry.outcome === "unknown").length;
    if (unknown > 0) {
      const suppressedCount = logLimiter.take(`resume-unknown:${this.endpointId}`);
      if (suppressedCount !== null) {
        logger.info("Terminal resume named terminals this host has no stream for", {
          endpointId: this.endpointId,
          projectId: this.projectId,
          requested: request.terminals.length,
          unknown,
          suppressedCount,
        });
      }
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

  /**
   * A busy lane holds back only the terminals already waiting in it. One with
   * nothing queued (a keystroke's echo beside a flood of output) goes straight
   * in, and the scheduler gives it the next turn; the lane's hard cap still
   * bounds the total.
   */
  private heldBack(stream: StreamState): boolean {
    if (!this.linkBusy) return false;
    const queued = this.session?.queuedBytes(
      Lane.INTERACTIVE,
      terminalFlow(this.endpointId, stream.id)
    );
    return (queued ?? 0) > 0;
  }

  private onPtyMessage(raw: unknown): void {
    if (!raw || typeof raw !== "object") return;
    const message = raw as { type?: unknown; id?: unknown; requestId?: unknown };
    if (typeof message.id !== "string" || message.id.length === 0) return;
    if (message.type === "data") {
      const { data, bytes, streamEnd } = raw as {
        data?: unknown;
        bytes?: unknown;
        streamEnd?: unknown;
      };
      if (!(data instanceof Uint8Array) || typeof bytes !== "number") return;
      this.onData(message.id, data, bytes, toStreamEnd(streamEnd));
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

  private onData(id: string, data: Uint8Array, bytes: number, streamEnd: number | undefined): void {
    const incarnation = this.incarnationOf(id);
    let stream = this.streams.get(id);
    if (!stream || stream.incarnation !== incarnation) {
      // A repaint owed for a replaced pty-host connection is owed to the new
      // incarnation too: the PTYs it respawned emit before the old one's reset
      // lands, and only a reset retires the client's restore fence. A resync
      // for a client that fell behind is not carried; the new incarnation
      // streams from seq 1 on top of the scrollback it already has.
      const owed = stream?.owedReplacement === true;
      // The renderer's ack queue for the terminal runs on across the restart.
      const ledger = stream?.ledger;
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
      stream = this.createStream(id, incarnation, ledger);
      if (owed) this.markReset(stream, "pty-port-replaced");
      stream.owedReplacement = owed;
    }
    stream.seq++;
    stream.lastActivity = ++this.activityClock;
    stream.ring.push(
      streamEnd === undefined
        ? { seq: stream.seq, data, bytes }
        : { seq: stream.seq, data, bytes, streamEnd }
    );
    if (!this.canSend || stream.resetting || stream.ledger.applying) {
      // Nobody to ack it, or it follows a reset the client has yet to apply
      // and so can't ack in time: settled here, still sent.
      this.ackPty(id, bytes);
      stream.settledThrough = stream.seq;
      this.pump(stream);
      return;
    }
    this.setOutstanding(stream, stream.outstanding + bytes);
    if (stream.outstanding > this.maxOutstanding) {
      // Far enough behind that the pty-host would soon pause the PTY for
      // everyone; resync it from a snapshot instead.
      this.markReset(stream, "outstanding-bytes");
    } else if (this.totalOutstanding > this.maxTotalOutstanding) {
      // Same for the pty-host's aggregate watermark across this endpoint.
      const busiest = this.busiestStream();
      this.markReset(busiest, "aggregate-outstanding-bytes");
      if (busiest !== stream) this.pump(busiest);
    }
    this.pump(stream);
  }

  private createStream(id: string, incarnation: number, ledger = newLedger()): StreamState {
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
      settledThrough: 0,
      owedSince: 0,
      lastActivity: 0,
      needsReset: false,
      resetReason: null,
      resetting: false,
      owedReplacement: false,
      heldReset: null,
      ledger,
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
    stream.heldReset = null;
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
    if (!this.canSend) return;
    if (stream.heldReset && !this.deliverReset(stream)) {
      this.behind.add(stream);
      return;
    }
    if (stream.resetting) return;
    if (stream.needsReset) {
      this.reset(stream);
      return;
    }
    const ledger = stream.ledger;
    while (stream.sentSeq < stream.seq) {
      // A client still restoring a snapshot defers what follows it without
      // acking; past a window of it the rest waits here, and its acks (or the
      // end of the restore) let more through.
      if (ledger.applying && this.applyingWindowFull(ledger)) return;
      if (this.heldBack(stream)) {
        this.behind.add(stream);
        return;
      }
      const frame: RingFrame | null = stream.ring.get(stream.sentSeq + 1);
      if (!frame) {
        // Evicted before it could be sent: the gap can only be closed by a snapshot.
        this.markReset(stream, "ring-gap");
        this.reset(stream);
        return;
      }
      const message = { type: "data", id: stream.id, data: frame.data, bytes: frame.bytes };
      const from = ledger.posted;
      const to = from + frame.bytes;
      const result = this.post(
        stream.id,
        stream.incarnation,
        frame.seq,
        frame.streamEnd === undefined ? message : { ...message, streamEnd: frame.streamEnd },
        this.onFrameWritten(stream.id, ledger, to)
      );
      if (result === "refused") {
        this.behind.add(stream);
        return;
      }
      stream.sentSeq = frame.seq;
      ledger.posted = to;
      if (frame.seq > stream.settledThrough) ledger.chargedFrom ??= from;
    }
    this.behind.delete(stream);
  }

  private applyingWindowFull(ledger: AckLedger): boolean {
    const applying = ledger.applying!;
    const unacked = ledger.posted - applying.at - (ledger.acked - applying.acked);
    return unacked >= this.maxOutstanding;
  }

  /** The ack clock starts once charged output has left for the client, not when it arrived. */
  private onFrameWritten(id: string, ledger: AckLedger, to: number): () => void {
    const session = this.session;
    return () => {
      const stream = this.streams.get(id);
      if (this.session !== session || stream?.ledger !== ledger) return;
      ledger.writtenTo = Math.max(ledger.writtenTo, to);
      this.updateAckClock(stream, false);
    };
  }

  /**
   * On every write pass, each waiting terminal is asked again on its own
   * terms: one whose frames have left the lane goes on even while others keep
   * it busy. A terminal that got to send goes to the back, so the earliest
   * waiters don't always take the room a refusal leaves.
   */
  private pumpBehind(): void {
    if (this.behind.size === 0 || !this.canSend) return;
    for (const stream of [...this.behind]) {
      if (this.streams.get(stream.id) !== stream) {
        this.behind.delete(stream);
        continue;
      }
      const sentBefore = stream.sentSeq;
      this.pump(stream);
      if (stream.sentSeq !== sentBefore && this.behind.delete(stream)) this.behind.add(stream);
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
    this.logReset(stream);
    stream.resetting = true;
    stream.needsReset = false;
    this.behind.delete(stream);
    // The snapshot covers everything sent so far, so the client no longer
    // owes acks for it; output until the reset goes out is acked on arrival.
    this.settleOutstanding(stream);
    const requestId = ++this.nextFenceId;
    const timer = setTimeout(() => {
      const fence = this.fences.get(requestId);
      if (fence) this.completeFence(requestId, fence, null, true);
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
    received: SerializedTerminalSnapshot | null,
    timedOut = false
  ): void {
    clearTimeout(fence.timer);
    this.fences.delete(requestId);
    const stream = fence.stream;
    if (this.disposed || this.streams.get(stream.id) !== stream) {
      stream.resetting = false;
      return;
    }
    if (!this.canSend) {
      stream.resetting = false;
      stream.needsReset = true;
      return;
    }
    // Without a marker (the snapshot timed out first) nothing sent so far is
    // known to be covered; a cleared screen at the current end loses the
    // least.
    const covered = fence.boundary !== null;
    const boundary = fence.boundary ?? stream.seq;
    let snapshot = covered ? received : null;
    let snapshotLost: string | null = timedOut
      ? "timeout"
      : covered
        ? received
          ? null
          : "snapshot-missing"
        : "fence-marker-missing";
    if (snapshot !== null && Buffer.byteLength(snapshot.data, "utf8") > this.maxSnapshotBytes) {
      snapshot = null;
      snapshotLost = "snapshot-too-large";
    }
    if (snapshotLost !== null) this.logSnapshotLost(stream, snapshotLost);
    // Still resetting until the link takes it: output meanwhile is settled on
    // arrival and follows the reset.
    stream.heldReset = { boundary, snapshot };
    this.pump(stream);
  }

  /** Post a captured reset; false when the link refused it, to be tried again as it is. */
  private deliverReset(stream: StreamState): boolean {
    const held = stream.heldReset!;
    if (this.postReset(stream, held.boundary, held.snapshot) === "refused") return false;
    stream.heldReset = null;
    stream.resetting = false;
    stream.owedReplacement = false;
    stream.resetReason = null;
    stream.sentSeq = held.boundary;
    const ledger = stream.ledger;
    ledger.unconfirmedResets.push({
      at: ledger.posted,
      incarnation: stream.incarnation,
      seq: held.boundary,
    });
    ledger.applying = { at: ledger.posted, acked: ledger.acked };
    return true;
  }

  /** Records why a reset is owed; the first reason stands until a reset lands. */
  private markReset(stream: StreamState, reason: ResetReason): void {
    stream.needsReset = true;
    stream.resetReason ??= reason;
  }

  private logReset(stream: StreamState): void {
    const reason = stream.resetReason ?? "unknown";
    const suppressedCount = logLimiter.take(`reset:${this.endpointId}:${stream.id}:${reason}`);
    if (suppressedCount === null) return;
    logger.info("Terminal stream reset", {
      endpointId: this.endpointId,
      projectId: this.projectId,
      terminalId: stream.id,
      incarnation: stream.incarnation,
      reason,
      seq: stream.seq,
      sentSeq: stream.sentSeq,
      outstandingBytes: stream.outstanding,
      ringFirstSeq: stream.ring.firstSeq,
      ringBytes: stream.ring.sizeBytes,
      suppressedCount,
    });
  }

  private logSnapshotLost(stream: StreamState, reason: string): void {
    const suppressedCount = logLimiter.take(`snapshot:${this.endpointId}:${stream.id}:${reason}`);
    if (suppressedCount === null) return;
    logger.info("Terminal stream reset goes out without a snapshot", {
      endpointId: this.endpointId,
      terminalId: stream.id,
      reason,
      suppressedCount,
    });
  }

  /** Give up on outstanding fences; `resync` asks for another reset once possible. */
  private abandonFences(resync: boolean): void {
    for (const fence of this.fences.values()) {
      clearTimeout(fence.timer);
      fence.stream.resetting = false;
      if (resync) this.markReset(fence.stream, "pty-port-replaced");
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

  private post(
    id: string,
    incarnation: number,
    seq: number,
    message: unknown,
    onWritten?: () => void
  ): EnqueueResult {
    const session = this.session;
    if (!session) return "refused";
    try {
      return session.post(
        {
          lane: Lane.INTERACTIVE,
          kind: InteractiveKind.TERMINAL_OUT,
          body: { endpointId: this.endpointId, terminalId: id, incarnation, seq, message },
        },
        onWritten
      );
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
    if (message.type === "ack" || message.type === "reset-ack") {
      const stream = this.streams.get(message.id);
      if (!stream) return;
      if (message.type === "ack") this.onAck(stream, message.bytes);
      else this.onResetAck(stream, message.incarnation, message.seq);
      return;
    }
    // Only the driver types into or sizes the PTY; anyone else's input would
    // interleave with it and anyone else's grid would fight it.
    const leaseId = this.opts.driveLease ? this.opts.driveLease() : null;
    if (leaseId === false) {
      const suppressedCount = logLimiter.take(`input-refused:${this.endpointId}`);
      if (suppressedCount !== null) {
        logger.info("Terminal input refused: another window drives the project", {
          code: "DRIVEN_ELSEWHERE",
          endpointId: this.endpointId,
          projectId: this.projectId,
          terminalId: message.id,
          suppressedCount,
        });
      }
      return;
    }
    safePost(this.port, leaseId === null ? message : { ...message, leaseId });
    this.opts.onInput?.();
  }

  /**
   * Pay back what an ack covers. Only the part that lands on output still
   * charged against the pty-host reaches it; the part for frames settled here
   * already (a replay, a reset's catch-up) pays down nothing newer.
   */
  private onAck(stream: StreamState, bytes: number): void {
    if (bytes <= 0) return;
    const ledger = stream.ledger;
    ledger.acked += bytes;
    const applying = ledger.applying;
    if (applying) {
      if (ledger.unconfirmedResets.length === 0) {
        // The renderer took the reset before sending this, and acks output
        // after a reset only once it has restored the snapshot.
        ledger.applying = null;
      } else if (ledger.acked > applying.at) {
        // A client that predates reset-ack: it has now acked more than was
        // ever posted before the reset, so some of this is for output after
        // it. Which of its acks since were late ones for output before the
        // reset can't be told, so it is placed as if none were: at worst a
        // few catch-up acks then pay down live output, never the reverse,
        // which would leave live output owed for good.
        ledger.unconfirmedResets = [];
        ledger.ackedTo = Math.min(ledger.posted, applying.at + ledger.acked - applying.acked);
        ledger.applying = null;
        this.updateAckClock(stream, true);
        this.pump(stream);
        return;
      }
    }
    const start = ledger.ackedTo;
    const end = Math.min(ledger.posted, start + bytes);
    ledger.ackedTo = end;
    const charged =
      ledger.chargedFrom === null ? 0 : Math.max(0, end - Math.max(start, ledger.chargedFrom));
    const credit = Math.min(charged, stream.outstanding);
    if (credit > 0) {
      this.setOutstanding(stream, stream.outstanding - credit);
      this.ackPty(stream.id, credit);
    }
    this.updateAckClock(stream, end > start);
    if (applying) this.pump(stream);
  }

  /**
   * Every ack the renderer sent before this was for output from before the
   * reset; it dropped the rest. Resets ahead of the one named never reached
   * it. One that matches no reset posted on this session is ignored.
   */
  private onResetAck(stream: StreamState, incarnation?: number, seq?: number): void {
    const ledger = stream.ledger;
    const matches = (reset: { incarnation: number; seq: number }) =>
      (incarnation === undefined || reset.incarnation === incarnation) &&
      (seq === undefined || reset.seq === seq);
    let index = ledger.unconfirmedResets.findIndex(matches);
    if (index < 0) return;
    // Resets that share a seq had nothing posted between them: the last is the one it took.
    while (
      index + 1 < ledger.unconfirmedResets.length &&
      matches(ledger.unconfirmedResets[index + 1]!)
    ) {
      index++;
    }
    const [reset] = ledger.unconfirmedResets.splice(0, index + 1).slice(-1);
    ledger.ackedTo = reset!.at;
    // From here an ack is for output after the reset, so only those count
    // toward the restore window. Before it they can't be told apart from
    // late ones for output before it, and let output through too.
    if (ledger.applying && ledger.unconfirmedResets.length === 0) {
      ledger.applying.acked = ledger.acked;
    }
  }

  private settleOutstanding(stream: StreamState): void {
    if (stream.outstanding > 0) this.ackPty(stream.id, stream.outstanding);
    this.setOutstanding(stream, 0);
    this.markSettled(stream);
  }

  /** Nothing up to the newest frame is charged any more: the client owes no ack for it. */
  private markSettled(stream: StreamState): void {
    stream.settledThrough = stream.seq;
    stream.ledger.chargedFrom = null;
    stream.owedSince = 0;
  }

  /** Every change to a stream's unacked bytes goes through here, so the total stays right. */
  private setOutstanding(stream: StreamState, bytes: number): void {
    this.totalOutstanding += bytes - stream.outstanding;
    stream.outstanding = bytes;
  }

  /**
   * The clock runs while charged output the link has written waits for an
   * ack: never for bytes still in the ring or the lane. Any progress restarts
   * it on what is still owed.
   */
  private updateAckClock(stream: StreamState, progressed: boolean): void {
    const ledger = stream.ledger;
    const owed =
      ledger.chargedFrom !== null &&
      ledger.writtenTo > Math.max(ledger.ackedTo, ledger.chargedFrom);
    if (!owed) {
      stream.owedSince = 0;
    } else if (progressed || stream.owedSince === 0) {
      stream.owedSince = Date.now();
      this.armAckTimer();
    }
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
      if (stream.owedSince === 0) continue;
      if (now - stream.owedSince >= this.ackTimeoutMs) {
        this.markReset(stream, "ack-timeout");
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
