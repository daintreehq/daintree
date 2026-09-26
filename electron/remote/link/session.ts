import type { Duplex } from "node:stream";
import type { z } from "zod";
import type { IpcEnvelope } from "../../../shared/types/ipc/errors.js";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";
import type { EncodingLimits } from "./encoding.js";
import {
  DEFAULT_MAX_FRAME_BYTES,
  FRAME_HEADER_BYTES,
  FrameDecoder,
  FrameProtocolError,
  Lane,
  encodeFrame,
  type LinkFrame,
} from "./frames.js";
import {
  ControlKind,
  RpcKind,
  messageToFrame,
  type InvokeMessage,
  type LinkMessage,
  type ReverseRequestMessage,
  type SendMessage,
} from "./messages.js";
import {
  DEFAULT_LANE_LIMITS,
  LaneScheduler,
  type EnqueueResult,
  type LaneLimits,
} from "./scheduler.js";
import { assertOutboundMessage, parseInboundFrame } from "./schemas.js";
import {
  appErrorEnvelope,
  hostDisconnectedEnvelope,
  linkErrorEnvelope,
  linkSuccessEnvelope,
  unwrapEnvelope,
} from "./envelopes.js";
import { LinkTransfers, type LinkTransfersOptions } from "./transfer.js";

/**
 * One authenticated conversation over one byte stream. Owns framing in both
 * directions, the outbound lane scheduler, message validation, request/response
 * correlation, liveness (ping/RTT and idle timeout) and bulk transfers. The
 * handshake itself is decided by the host server or link client; until they
 * call {@link LinkSession.open}, the only messages accepted are the handshake
 * ones, and anything else ends the session.
 */

export type LinkRole = "host" | "client";

export interface LinkSessionOptions {
  role: LinkRole;
  maxFrameBytes?: number;
  laneLimits?: Record<Lane, LaneLimits>;
  encodingLimits?: EncodingLimits;
  /** Interval between pings once open; 0 disables. */
  pingIntervalMs?: number;
  /** Close when nothing has been received for this long once open; 0 disables. */
  idleTimeoutMs?: number;
  /** Close when the handshake has not completed within this long; 0 disables. */
  handshakeTimeoutMs?: number;
  /** Default timeout for CALL and REVERSE_REQUEST; 0 disables. */
  requestTimeoutMs?: number;
  /**
   * Default timeout for INVOKE; 0 (the default) leaves long mutations to the
   * session's lifetime. Deliberately unbounded: operation-backed mutations
   * resolve through the operation's status, and a disconnect settles the
   * invoke as OUTCOME_UNKNOWN, so a timer would only invent an unknown outcome
   * for a mutation that is still making progress.
   */
  invokeTimeoutMs?: number;
  /** Outbound INVOKE/CALL/REVERSE_REQUEST awaiting an answer; beyond it new ones are RATE_LIMITED. */
  maxPendingRequests?: number;
  /** Inbound INVOKE/CALL/REVERSE_REQUEST handlers allowed to run at once. */
  maxInboundRequests?: number;
  transfers?: LinkTransfersOptions;
  now?: () => number;
}

export interface LinkCloseInfo {
  reason: string;
  /** Who ended it: us, the peer (GOODBYE), or the byte stream itself. */
  by: "local" | "remote" | "transport";
}

export interface RequestOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

type Body<L extends Lane, K extends number> = Extract<LinkMessage, { lane: L; kind: K }>["body"];

type Listener = (body: unknown) => void;

interface Pending {
  kind: PendingKind;
  resolve: (envelope: IpcEnvelope) => void;
  /** The request frame reached the socket, so the peer may have acted on it. */
  written: boolean;
}

type PendingKind = typeof RpcKind.INVOKE | typeof RpcKind.CALL | typeof RpcKind.REVERSE_REQUEST;

const RESULT_KIND: Record<PendingKind, number> = {
  [RpcKind.INVOKE]: RpcKind.INVOKE_RESULT,
  [RpcKind.CALL]: RpcKind.CALL_RESULT,
  [RpcKind.REVERSE_REQUEST]: RpcKind.REVERSE_RESULT,
};

interface CallHandlerEntry {
  schema: z.ZodType;
  handler: (payload: unknown) => unknown;
}

const HANDSHAKE_KINDS: Record<LinkRole, ReadonlySet<number>> = {
  host: new Set([ControlKind.HELLO, ControlKind.GOODBYE]),
  client: new Set([ControlKind.WELCOME, ControlKind.REJECT, ControlKind.GOODBYE]),
};

const MAX_REQUEST_ID = 0xffffffff;
const END_GRACE_MS = 2_000;
const DEFAULT_MAX_PENDING_REQUESTS = 4096;
// Messages that follow WELCOME before the client has attached its handlers
// are only the rest of the read that carried it; a peer filling this is broken.
const MAX_HELD_MESSAGES = 4096;

function listenerKey(lane: number, kind: number): number {
  return lane * 256 + kind;
}

export class LinkSession {
  readonly role: LinkRole;
  readonly transfers: LinkTransfers;

  private state: "handshake" | "open" | "closed" = "handshake";
  private readonly decoder: FrameDecoder;
  private readonly scheduler: LaneScheduler;
  private readonly maxFrameBytes: number;
  private readonly encodingLimits: EncodingLimits | undefined;
  private readonly now: () => number;
  private readonly opts: LinkSessionOptions;

  private flushScheduled = false;
  private waitingForDrain = false;
  private readonly tickListeners = new Set<() => void>();

  private nextRequestId = 1;
  private readonly pending = new Map<number, Map<number, Pending>>([
    [RpcKind.INVOKE, new Map()],
    [RpcKind.CALL, new Map()],
    [RpcKind.REVERSE_REQUEST, new Map()],
  ]);
  private pendingCount = 0;
  private readonly requestFrames = new WeakMap<LinkFrame, Pending>();
  private inboundInFlight = 0;
  private held: LinkMessage[] | null = null;

  private readonly listeners = new Map<number, Set<Listener>>();
  private handshakeListener: ((message: LinkMessage) => void) | null = null;
  private invokeHandler: ((message: InvokeMessage) => Promise<IpcEnvelope>) | null = null;
  private sendHandler: ((message: SendMessage) => void) | null = null;
  private reverseHandler: ((message: ReverseRequestMessage) => Promise<unknown>) | null = null;
  private readonly callHandlers = new Map<string, CallHandlerEntry>();
  private readonly closeListeners = new Set<(info: LinkCloseInfo) => void>();
  private readonly rttListeners = new Set<(rttMs: number) => void>();

  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private idleTimer: ReturnType<typeof setInterval> | null = null;
  private handshakeTimer: ReturnType<typeof setTimeout> | null = null;
  private closeInfo: LinkCloseInfo | null = null;

  private _rttMs: number | null = null;
  private _lastReceivedAt: number;

  constructor(
    private readonly socket: Duplex,
    options: LinkSessionOptions
  ) {
    this.opts = options;
    this.role = options.role;
    this.maxFrameBytes = options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
    this.encodingLimits = options.encodingLimits;
    this.now = options.now ?? Date.now;
    this.decoder = new FrameDecoder(this.maxFrameBytes);
    this.scheduler = new LaneScheduler(options.laneLimits ?? DEFAULT_LANE_LIMITS);
    this._lastReceivedAt = this.now();
    this.transfers = new LinkTransfers(
      {
        role: this.role,
        post: (message) => this.post(message),
        isOpen: () => this.state === "open",
        protocolError: (reason) => this.protocolError(reason),
      },
      options.transfers
    );
    this.scheduler.onDrain((lane) => {
      if (lane === Lane.BULK) this.transfers.onBulkDrain();
    });

    socket.on("data", (chunk: Buffer) => this.onData(chunk));
    socket.on("drain", () => {
      this.waitingForDrain = false;
      this.flush();
    });
    socket.on("error", () => {});
    socket.on("close", () => this.finish({ reason: "socket closed", by: "transport" }));

    const handshakeTimeout = options.handshakeTimeoutMs ?? 10_000;
    if (handshakeTimeout > 0) {
      this.handshakeTimer = setTimeout(() => {
        if (this.state === "handshake") this.close("handshake timed out");
      }, handshakeTimeout);
      this.handshakeTimer.unref?.();
    }
  }

  get isOpen(): boolean {
    return this.state === "open";
  }

  get isClosed(): boolean {
    return this.state === "closed";
  }

  get rttMs(): number | null {
    return this._rttMs;
  }

  get lastReceivedAt(): number {
    return this._lastReceivedAt;
  }

  get closedWith(): LinkCloseInfo | null {
    return this.closeInfo;
  }

  queuedBytes(lane: Lane): number {
    return this.scheduler.queuedBytes(lane);
  }

  /** Receive handshake messages (HELLO on the host; WELCOME/REJECT on the client). */
  onHandshake(listener: (message: LinkMessage) => void): void {
    this.handshakeListener = listener;
  }

  /**
   * The handshake succeeded: accept all traffic and start liveness checks.
   * With `holdInbound`, application messages that arrive before
   * {@link LinkSession.releaseInbound} are queued rather than dispatched, so
   * frames the peer sent right behind its WELCOME are not dropped (or answered
   * UNSUPPORTED) before the owner has attached its subscribers and handlers.
   */
  open(options: { holdInbound?: boolean } = {}): void {
    if (this.state !== "handshake") return;
    this.state = "open";
    if (options.holdInbound) this.held = [];
    this.clearHandshakeTimer();
    this._lastReceivedAt = this.now();
    const pingMs = this.opts.pingIntervalMs ?? 5_000;
    if (pingMs > 0) {
      this.pingTimer = setInterval(() => this.ping(), pingMs);
      this.pingTimer.unref?.();
    }
    const idleMs = this.opts.idleTimeoutMs ?? 20_000;
    if (idleMs > 0) {
      this.idleTimer = setInterval(
        () => {
          if (this.now() - this._lastReceivedAt > idleMs) this.close("idle timeout");
        },
        Math.max(10, Math.floor(idleMs / 4))
      );
      this.idleTimer.unref?.();
    }
  }

  /** Dispatch, in arrival order, whatever was held since `open({ holdInbound: true })`. */
  releaseInbound(): void {
    const held = this.held;
    if (!held) return;
    this.held = null;
    for (const message of held) {
      if (this.isClosed) return;
      this.dispatch(message);
    }
  }

  ping(): void {
    if (this.state !== "open") return;
    this.post({ lane: Lane.CONTROL, kind: ControlKind.PING, body: { sentAt: this.now() } });
  }

  onRtt(listener: (rttMs: number) => void): () => void {
    this.rttListeners.add(listener);
    return () => this.rttListeners.delete(listener);
  }

  onClose(listener: (info: LinkCloseInfo) => void): () => void {
    if (this.closeInfo) {
      listener(this.closeInfo);
      return () => {};
    }
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  /** Called after each write pass; producers that were refused retry from here. */
  onWritable(listener: () => void): () => void {
    this.tickListeners.add(listener);
    return () => this.tickListeners.delete(listener);
  }

  /**
   * Subscribe to a message kind that has no dedicated handler: endpoint
   * lifecycle, summaries, lease changes, events and the interactive lane.
   * Bodies arrive already validated.
   */
  on<L extends Lane, K extends Extract<LinkMessage, { lane: L }>["kind"]>(
    lane: L,
    kind: K,
    listener: (body: Body<L, K>) => void
  ): () => void {
    const key = listenerKey(lane, kind);
    let set = this.listeners.get(key);
    if (!set) {
      set = new Set();
      this.listeners.set(key, set);
    }
    set.add(listener as Listener);
    return () => set.delete(listener as Listener);
  }

  setInvokeHandler(handler: ((message: InvokeMessage) => Promise<IpcEnvelope>) | null): void {
    this.invokeHandler = handler;
  }

  setSendHandler(handler: ((message: SendMessage) => void) | null): void {
    this.sendHandler = handler;
  }

  /** Answers REVERSE_REQUEST; the resolved value is wrapped in a success envelope. */
  setReverseRequestHandler(
    handler: ((message: ReverseRequestMessage) => Promise<unknown>) | null
  ): void {
    this.reverseHandler = handler;
  }

  /**
   * Register a session-level service method. The payload is validated against
   * `schema` before the handler sees it; an unknown method or an invalid
   * payload is answered with an error envelope.
   */
  registerCallHandler<S extends z.ZodType>(
    method: string,
    schema: S,
    handler: (payload: z.infer<S>) => unknown
  ): () => void {
    const entry: CallHandlerEntry = { schema, handler: handler as (payload: unknown) => unknown };
    this.callHandlers.set(method, entry);
    return () => {
      if (this.callHandlers.get(method) === entry) this.callHandlers.delete(method);
    };
  }

  /**
   * Queue a message. Returns the scheduler's verdict; "refused" also means the
   * session is not open (or closed). Throws only for a message that could never
   * be sent (unencodable, or larger than a frame).
   */
  post(message: LinkMessage): EnqueueResult {
    return this.enqueue(message).result;
  }

  private enqueue(message: LinkMessage): { result: EnqueueResult; frame: LinkFrame | null } {
    if (this.state === "closed") return { result: "refused", frame: null };
    if (this.state === "handshake" && message.lane !== Lane.CONTROL) {
      return { result: "refused", frame: null };
    }
    // Anything the peer would reject as malformed would end the session, so
    // catch it here and fail only this message.
    assertOutboundMessage(message);
    const frame = messageToFrame(message, this.encodingLimits);
    this.assertFrameSize(frame);
    const result = this.scheduler.enqueue(frame);
    if (result !== "refused") this.scheduleFlush();
    return { result, frame };
  }

  invoke(
    endpointId: string,
    channel: string,
    args: unknown[],
    options: RequestOptions = {}
  ): Promise<IpcEnvelope> {
    return this.request(
      RpcKind.INVOKE,
      (requestId) => ({
        lane: Lane.RPC,
        kind: RpcKind.INVOKE,
        body: { requestId, endpointId, channel, args },
      }),
      options.timeoutMs ?? this.opts.invokeTimeoutMs ?? 0,
      options.signal
    );
  }

  send(endpointId: string, channel: string, args: unknown[]): EnqueueResult {
    return this.post({ lane: Lane.RPC, kind: RpcKind.SEND, body: { endpointId, channel, args } });
  }

  async call(method: string, payload: unknown, options: RequestOptions = {}): Promise<unknown> {
    const envelope = await this.request(
      RpcKind.CALL,
      (requestId) => ({ lane: Lane.RPC, kind: RpcKind.CALL, body: { requestId, method, payload } }),
      options.timeoutMs ?? this.opts.requestTimeoutMs ?? 60_000,
      options.signal
    );
    return unwrapEnvelope(envelope);
  }

  /**
   * Ask the peer's renderer for `endpointId` to answer `method`. Request ids
   * stay inside the session; the caller sees the unwrapped value or the
   * reconstructed error, and HOST_DISCONNECTED if the session dies first.
   */
  async reverseRequest(
    endpointId: string,
    method: string,
    payload: unknown,
    options: RequestOptions = {}
  ): Promise<unknown> {
    const envelope = await this.request(
      RpcKind.REVERSE_REQUEST,
      (requestId) => ({
        lane: Lane.RPC,
        kind: RpcKind.REVERSE_REQUEST,
        body: { requestId, endpointId, method, payload },
      }),
      options.timeoutMs ?? this.opts.requestTimeoutMs ?? 60_000,
      options.signal
    );
    return unwrapEnvelope(envelope);
  }

  /** Orderly shutdown: queued control frames and a GOODBYE go out, then the stream ends. */
  close(reason: string): void {
    this.shutdown({ reason, by: "local" }, true);
  }

  /** Send a REJECT and end the stream (host side of a failed handshake). */
  reject(message: Body<typeof Lane.CONTROL, typeof ControlKind.REJECT>): void {
    if (this.state === "closed") return;
    this.post({ lane: Lane.CONTROL, kind: ControlKind.REJECT, body: message });
    this.shutdown({ reason: `rejected: ${message.reason}`, by: "local" }, false);
  }

  private request(
    kind: PendingKind,
    build: (requestId: number) => LinkMessage,
    timeoutMs: number,
    signal: AbortSignal | undefined
  ): Promise<IpcEnvelope> {
    if (this.state !== "open") {
      return Promise.resolve(hostDisconnectedEnvelope("session is not open"));
    }
    if (signal?.aborted) {
      return Promise.resolve(appErrorEnvelope("CANCELLED", "Request aborted"));
    }
    // Scheduler caps bound queued bytes, not requests whose frames were written
    // and are still waiting on the peer; this bounds the correlation state.
    if (this.pendingCount >= (this.opts.maxPendingRequests ?? DEFAULT_MAX_PENDING_REQUESTS)) {
      return Promise.resolve(
        appErrorEnvelope("RATE_LIMITED", "Too many requests awaiting the peer")
      );
    }
    const table = this.pending.get(kind)!;
    const requestId = this.allocateRequestId(table);
    return new Promise<IpcEnvelope>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      // The request may already be on the wire; the peer can still act on it.
      const onAbort = () =>
        settle(
          appErrorEnvelope(
            "OUTCOME_UNKNOWN",
            "Request aborted after it was sent; the peer may still act on it"
          )
        );
      const settle = (envelope: IpcEnvelope) => {
        if (table.get(requestId) !== entry) return;
        table.delete(requestId);
        this.pendingCount--;
        if (timer) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve(envelope);
      };
      const entry: Pending = { kind, resolve: settle, written: false };
      table.set(requestId, entry);
      this.pendingCount++;
      if (timeoutMs > 0) {
        timer = setTimeout(
          () =>
            settle(
              appErrorEnvelope(
                "OUTCOME_UNKNOWN",
                `No answer from the peer within ${timeoutMs} ms`,
                "The host didn't answer in time."
              )
            ),
          timeoutMs
        );
      }
      signal?.addEventListener("abort", onAbort, { once: true });
      let queued: { result: EnqueueResult; frame: LinkFrame | null };
      try {
        queued = this.enqueue(build(requestId));
      } catch (err) {
        settle(linkErrorEnvelope(err));
        return;
      }
      if (queued.result === "refused") {
        settle(appErrorEnvelope("RATE_LIMITED", "Link send queue is full"));
      } else if (queued.frame) {
        this.requestFrames.set(queued.frame, entry);
      }
    });
  }

  private allocateRequestId(table: Map<number, Pending>): number {
    for (;;) {
      const id = this.nextRequestId;
      this.nextRequestId = id >= MAX_REQUEST_ID ? 1 : id + 1;
      if (!table.has(id)) return id;
    }
  }

  private assertFrameSize(frame: LinkFrame): void {
    const total = FRAME_HEADER_BYTES + frame.payload.byteLength;
    if (total > this.maxFrameBytes) {
      throw new FrameProtocolError(`frame of ${total} bytes exceeds ${this.maxFrameBytes}`);
    }
  }

  private scheduleFlush(): void {
    if (this.flushScheduled || this.waitingForDrain || this.state === "closed") return;
    this.flushScheduled = true;
    // Deferred so everything queued in this tick is ordered by lane priority
    // before anything is written.
    setImmediate(() => {
      this.flushScheduled = false;
      this.flush();
    });
  }

  private flush(): void {
    if (this.state === "closed" || this.waitingForDrain) return;
    for (let frame = this.scheduler.next(); frame; frame = this.scheduler.next()) {
      const written = this.socket.write(encodeFrame(frame, this.maxFrameBytes));
      // A false return still took the bytes; only frames left in the scheduler
      // are known never to have reached the peer.
      if (frame.lane === Lane.RPC) {
        const request = this.requestFrames.get(frame);
        if (request) request.written = true;
      }
      if (!written) {
        this.waitingForDrain = true;
        break;
      }
    }
    for (const listener of this.tickListeners) listener();
    this.transfers.onWritable();
  }

  private onData(chunk: Buffer): void {
    if (this.state === "closed") return;
    let frames: LinkFrame[];
    try {
      frames = this.decoder.push(chunk);
    } catch (err) {
      this.protocolError(formatErrorMessage(err, "bad frame"));
      return;
    }
    for (const frame of frames) {
      if (this.isClosed) return;
      this._lastReceivedAt = this.now();
      let message: LinkMessage;
      try {
        message = parseInboundFrame(frame, this.encodingLimits);
      } catch (err) {
        this.protocolError(formatErrorMessage(err, "invalid message"));
        return;
      }
      if (this.state === "handshake") this.dispatchHandshake(message);
      else if (this.held) {
        if (this.held.length >= MAX_HELD_MESSAGES) {
          this.protocolError("too many messages before the session was ready");
          return;
        }
        this.held.push(message);
      } else this.dispatch(message);
    }
  }

  private dispatchHandshake(message: LinkMessage): void {
    if (message.lane !== Lane.CONTROL || !HANDSHAKE_KINDS[this.role].has(message.kind)) {
      this.protocolError("message before handshake");
      return;
    }
    if (message.kind === ControlKind.GOODBYE) {
      this.shutdown({ reason: message.body.reason, by: "remote" }, false);
      return;
    }
    const listener = this.handshakeListener;
    if (!listener) {
      this.protocolError("no handshake handler");
      return;
    }
    // One handshake message per session: after it, the owner must have opened
    // or closed the session synchronously.
    this.handshakeListener = null;
    listener(message);
  }

  private dispatch(message: LinkMessage): void {
    switch (message.lane) {
      case Lane.CONTROL:
        switch (message.kind) {
          case ControlKind.PING:
            this.post({ lane: Lane.CONTROL, kind: ControlKind.PONG, body: message.body });
            return;
          case ControlKind.PONG: {
            const rtt = this.now() - message.body.sentAt;
            if (rtt < 0 || rtt > 3_600_000) return;
            this._rttMs = rtt;
            for (const listener of this.rttListeners) listener(rtt);
            return;
          }
          case ControlKind.GOODBYE:
            this.shutdown({ reason: message.body.reason, by: "remote" }, false);
            return;
          case ControlKind.HELLO:
          case ControlKind.WELCOME:
          case ControlKind.REJECT:
            this.protocolError("handshake message after handshake");
            return;
        }
        break;
      case Lane.RPC:
        switch (message.kind) {
          case RpcKind.INVOKE:
            this.answer(RpcKind.INVOKE, message.body.requestId, () =>
              this.invokeHandler
                ? this.invokeHandler(message.body)
                : Promise.resolve(appErrorEnvelope("UNSUPPORTED", "Host does not accept invokes"))
            );
            return;
          case RpcKind.SEND:
            this.safely(() => this.sendHandler?.(message.body));
            return;
          case RpcKind.CALL:
            this.answer(RpcKind.CALL, message.body.requestId, () =>
              this.runCall(message.body.method, message.body.payload)
            );
            return;
          case RpcKind.REVERSE_REQUEST: {
            const handler = this.reverseHandler;
            this.answer(RpcKind.REVERSE_REQUEST, message.body.requestId, async () =>
              handler
                ? linkSuccessEnvelope(await handler(message.body))
                : appErrorEnvelope("UNSUPPORTED", `No handler for ${message.body.method}`)
            );
            return;
          }
          case RpcKind.INVOKE_RESULT:
            this.pending
              .get(RpcKind.INVOKE)!
              .get(message.body.requestId)
              ?.resolve(message.body.envelope);
            return;
          case RpcKind.CALL_RESULT:
            this.pending
              .get(RpcKind.CALL)!
              .get(message.body.requestId)
              ?.resolve(message.body.envelope);
            return;
          case RpcKind.REVERSE_RESULT:
            this.pending
              .get(RpcKind.REVERSE_REQUEST)!
              .get(message.body.requestId)
              ?.resolve(message.body.envelope);
            return;
        }
        break;
      case Lane.BULK:
        this.transfers.handle(message);
        return;
    }
    const set = this.listeners.get(listenerKey(message.lane, message.kind));
    if (!set) return;
    for (const listener of set) this.safely(() => listener(message.body));
  }

  private async runCall(method: string, payload: unknown): Promise<IpcEnvelope> {
    const entry = this.callHandlers.get(method);
    if (!entry) return appErrorEnvelope("UNSUPPORTED", `Unknown method: ${method}`);
    const parsed = entry.schema.safeParse(payload);
    if (!parsed.success) return appErrorEnvelope("VALIDATION", `Invalid payload for ${method}`);
    return linkSuccessEnvelope(await entry.handler(parsed.data));
  }

  private answer(kind: PendingKind, requestId: number, run: () => Promise<IpcEnvelope>): void {
    const resultKind = RESULT_KIND[kind];
    const maxInbound = this.opts.maxInboundRequests ?? 1024;
    if (this.inboundInFlight >= maxInbound) {
      this.postResult(resultKind, requestId, appErrorEnvelope("RATE_LIMITED", "Too many requests"));
      return;
    }
    this.inboundInFlight++;
    let promise: Promise<IpcEnvelope>;
    try {
      promise = run();
    } catch (err) {
      promise = Promise.resolve(linkErrorEnvelope(err));
    }
    promise
      .catch((err: unknown) => linkErrorEnvelope(err))
      .then((envelope) => {
        this.inboundInFlight--;
        this.postResult(resultKind, requestId, envelope);
      });
  }

  private postResult(kind: number, requestId: number, envelope: IpcEnvelope): void {
    if (this.state !== "open") return;
    const build = (env: IpcEnvelope) =>
      ({ lane: Lane.RPC, kind, body: { requestId, envelope: env } }) as LinkMessage;
    let result: EnqueueResult;
    try {
      result = this.post(build(envelope));
    } catch (err) {
      result = this.post(
        build(
          appErrorEnvelope(
            "PAYLOAD_TOO_LARGE",
            `Result could not be sent: ${formatErrorMessage(err, "encoding failed")}`
          )
        )
      );
    }
    // A result we cannot queue would leave the peer waiting forever; the
    // peer has stopped reading, so the session is no longer useful.
    if (result === "refused") this.close("rpc queue overflow");
  }

  private safely(fn: () => void): void {
    try {
      fn();
    } catch {
      // A throwing subscriber must not take the session down with it.
    }
  }

  private protocolError(reason: string): void {
    this.shutdown({ reason: `protocol error: ${reason}`, by: "local" }, true);
  }

  private shutdown(info: LinkCloseInfo, sendGoodbye: boolean): void {
    if (this.state === "closed") return;
    this.state = "closed";
    // Whatever control frames were already queued (a REJECT) still go out;
    // every other lane is dropped.
    const control: LinkFrame[] = [];
    for (let frame = this.scheduler.next(); frame; frame = this.scheduler.next()) {
      if (frame.lane === Lane.CONTROL) control.push(frame);
    }
    if (sendGoodbye && info.by !== "transport") {
      control.push(
        messageToFrame({
          lane: Lane.CONTROL,
          kind: ControlKind.GOODBYE,
          body: { reason: info.reason.slice(0, 1024) },
        })
      );
    }
    if (!this.socket.destroyed && info.by !== "transport") {
      try {
        for (const frame of control) this.socket.write(encodeFrame(frame, this.maxFrameBytes));
        this.socket.end();
      } catch {
        // The stream is already gone.
      }
      const killer = setTimeout(() => this.socket.destroy(), END_GRACE_MS);
      killer.unref?.();
      this.socket.once("close", () => clearTimeout(killer));
    } else {
      this.socket.destroy();
    }
    this.finish(info);
  }

  private finish(info: LinkCloseInfo): void {
    if (this.closeInfo) return;
    if (this.state !== "closed") {
      this.state = "closed";
      this.socket.destroy();
    }
    this.closeInfo = info;
    this.clearHandshakeTimer();
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.idleTimer) clearInterval(this.idleTimer);
    this.pingTimer = this.idleTimer = null;
    this.scheduler.clear();
    this.tickListeners.clear();
    this.held = null;
    const disconnected = hostDisconnectedEnvelope(info.reason);
    // An INVOKE or CALL that reached the socket may have run on the peer, so it
    // must be reconciled (operation status) rather than reported as not done.
    // Reverse requests only ask this side's peer a question and are simply off.
    const unknown = appErrorEnvelope(
      "OUTCOME_UNKNOWN",
      `Link closed before the peer answered: ${info.reason}`,
      "The host may have completed this; check before retrying."
    );
    for (const table of this.pending.values()) {
      for (const entry of [...table.values()]) {
        entry.resolve(
          entry.written && entry.kind !== RpcKind.REVERSE_REQUEST ? unknown : disconnected
        );
      }
      table.clear();
    }
    this.pendingCount = 0;
    this.transfers.closeAll(info.reason);
    const listeners = [...this.closeListeners];
    this.closeListeners.clear();
    for (const listener of listeners) this.safely(() => listener(info));
  }

  private clearHandshakeTimer(): void {
    if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
    this.handshakeTimer = null;
  }
}
