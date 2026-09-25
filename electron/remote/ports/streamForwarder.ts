import net from "node:net";
import { AppError } from "../../utils/errorTypes.js";
import type { LinkSession } from "../link/session.js";
import {
  PORT_DATA_CHUNK_BYTES,
  PortDataPayloadSchema,
  PortLinkMethod,
  PortOpenPayloadSchema,
  PortStreamPayloadSchema,
} from "./linkMethods.js";

/**
 * TCP streams carried over one link session: the Shell accepts a connection
 * on a local listener and opens a stream; the Host dials `localhost:<port>`
 * on its side and the two sockets are spliced through data calls. Bytes pass
 * through untouched, so Host headers, cookies, redirects and WebSocket
 * upgrades behave exactly as they would on the Host itself.
 *
 * Flow control: each side keeps at most `windowBytes` of a stream's data
 * unacknowledged and pauses its socket beyond that; the receiver answers a
 * data call only once the bytes are written (or its socket has drained), so a
 * slow reader holds its sender back instead of filling the link.
 */

export interface PortStreamMuxOptions {
  /** Host side: dial a port on this machine's loopback. Without it OPEN is refused. */
  connect?: (port: number) => Promise<net.Socket>;
  windowBytes?: number;
  maxStreams?: number;
  /** How long one data call may wait for the far side's acknowledgement. */
  dataTimeoutMs?: number;
}

interface Stream {
  id: number;
  socket: net.Socket;
  inFlight: number;
  paused: boolean;
  closed: boolean;
  /** The far side closed it, so there is nothing to tell it. */
  closedRemotely: boolean;
  onActivity: (() => void) | null;
}

const DEFAULT_WINDOW_BYTES = 256 * 1024;
const DEFAULT_MAX_STREAMS = 256;
const DEFAULT_DATA_TIMEOUT_MS = 60_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const MAX_STREAM_ID = 0xffffffff;

/** Dial `localhost:<port>`, letting Happy Eyeballs pick whichever family the server bound. */
export function connectLoopback(
  port: number,
  timeoutMs = DEFAULT_CONNECT_TIMEOUT_MS
): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: "localhost", port, allowHalfOpen: true });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(
        new AppError({
          code: "OUTCOME_UNKNOWN",
          message: `Connecting to port ${port} timed out`,
        })
      );
    }, timeoutMs);
    const onError = (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(
        new AppError({
          code: err.code === "ECONNREFUSED" ? "NOT_FOUND" : "INTERNAL",
          message:
            err.code === "ECONNREFUSED"
              ? `Nothing is listening on port ${port}`
              : `Couldn't connect to port ${port}: ${err.code ?? "error"}`,
        })
      );
    };
    socket.once("error", onError);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.removeListener("error", onError);
      resolve(socket);
    });
  });
}

export class PortStreamMux {
  private readonly streams = new Map<number, Stream>();
  /** Host side: streams still dialling, and those the Shell gave up on meanwhile. */
  private readonly opening = new Set<number>();
  private readonly cancelledOpens = new Set<number>();
  private readonly disposers: Array<() => void> = [];
  private nextId = 1;
  private disposed = false;
  private readonly windowBytes: number;
  private readonly maxStreams: number;
  private readonly dataTimeoutMs: number;

  constructor(
    private readonly session: LinkSession,
    options: PortStreamMuxOptions = {}
  ) {
    this.windowBytes = options.windowBytes ?? DEFAULT_WINDOW_BYTES;
    this.maxStreams = options.maxStreams ?? DEFAULT_MAX_STREAMS;
    this.dataTimeoutMs = options.dataTimeoutMs ?? DEFAULT_DATA_TIMEOUT_MS;
    if (session.isClosed) {
      this.disposed = true;
      return;
    }

    this.disposers.push(
      session.registerCallHandler(PortLinkMethod.DATA, PortDataPayloadSchema, (payload) =>
        this.receiveData(payload.streamId, payload.data)
      ),
      session.registerCallHandler(PortLinkMethod.END, PortStreamPayloadSchema, ({ streamId }) => {
        this.streams.get(streamId)?.socket.end();
        return null;
      }),
      session.registerCallHandler(PortLinkMethod.CLOSE, PortStreamPayloadSchema, ({ streamId }) => {
        const stream = this.streams.get(streamId);
        if (stream) {
          stream.closedRemotely = true;
          stream.socket.destroy();
        } else if (this.opening.has(streamId)) {
          this.cancelledOpens.add(streamId);
        }
        return null;
      }),
      session.onClose(() => this.dispose())
    );
    if (options.connect) {
      const connect = options.connect;
      this.disposers.push(
        session.registerCallHandler(PortLinkMethod.OPEN, PortOpenPayloadSchema, (payload) =>
          this.acceptOpen(payload.streamId, payload.port, connect)
        )
      );
    }
  }

  get streamCount(): number {
    return this.streams.size;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  /**
   * Shell side: carry a local connection to `port` on the Host. Pass the
   * socket paused (a listener with `pauseOnConnect`) so nothing it sends is
   * read before the Host has its end open. Resolves once the stream is
   * connected; rejects (and destroys the socket) when it can't be.
   */
  async openStream(socket: net.Socket, port: number, onActivity?: () => void): Promise<void> {
    if (this.disposed || !this.session.isOpen) {
      socket.destroy();
      throw new AppError({ code: "HOST_DISCONNECTED", message: "The host link is closed" });
    }
    if (this.streams.size >= this.maxStreams) {
      socket.destroy();
      throw new AppError({ code: "RATE_LIMITED", message: "Too many forwarded connections" });
    }
    const stream = this.register(this.allocateId(), socket, onActivity ?? null);
    try {
      await this.session.call(PortLinkMethod.OPEN, { streamId: stream.id, port });
    } catch (error) {
      stream.closedRemotely = true;
      socket.destroy();
      throw error;
    }
    if (stream.closed) return;
    this.pump(stream);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const dispose of this.disposers.splice(0).reverse()) dispose();
    for (const stream of [...this.streams.values()]) {
      stream.closedRemotely = true;
      stream.socket.destroy();
    }
    this.streams.clear();
  }

  private async acceptOpen(
    streamId: number,
    port: number,
    connect: (port: number) => Promise<net.Socket>
  ): Promise<null> {
    if (this.streams.has(streamId) || this.opening.has(streamId)) {
      throw new AppError({ code: "VALIDATION", message: `Stream ${streamId} is already open` });
    }
    if (this.streams.size + this.opening.size >= this.maxStreams) {
      throw new AppError({ code: "RATE_LIMITED", message: "Too many forwarded connections" });
    }
    this.opening.add(streamId);
    let socket: net.Socket;
    try {
      socket = await connect(port);
    } catch (error) {
      this.opening.delete(streamId);
      this.cancelledOpens.delete(streamId);
      throw error;
    }
    this.opening.delete(streamId);
    const cancelled = this.cancelledOpens.delete(streamId);
    if (this.disposed || cancelled) {
      socket.destroy();
      throw new AppError({ code: "CANCELLED", message: "The connection was closed first" });
    }
    this.pump(this.register(streamId, socket, null));
    return null;
  }

  private allocateId(): number {
    // Never reused within a session, so a late CLOSE for an old stream can't hit a new one.
    const id = this.nextId;
    if (id > MAX_STREAM_ID) {
      throw new AppError({ code: "RATE_LIMITED", message: "Stream ids exhausted on this link" });
    }
    this.nextId = id + 1;
    return id;
  }

  private register(id: number, socket: net.Socket, onActivity: (() => void) | null): Stream {
    const stream: Stream = {
      id,
      socket,
      inFlight: 0,
      paused: false,
      closed: false,
      closedRemotely: false,
      onActivity,
    };
    this.streams.set(id, stream);
    socket.on("error", () => {
      // "close" follows and does the bookkeeping.
    });
    socket.once("close", () => {
      stream.closed = true;
      if (this.streams.get(id) === stream) this.streams.delete(id);
      if (!stream.closedRemotely && !this.disposed && this.session.isOpen) {
        void this.session.call(PortLinkMethod.CLOSE, { streamId: id }).catch(() => {});
      }
      stream.onActivity?.();
    });
    return stream;
  }

  private pump(stream: Stream): void {
    const { socket } = stream;
    socket.on("data", (chunk: Buffer) => {
      for (let offset = 0; offset < chunk.byteLength; offset += PORT_DATA_CHUNK_BYTES) {
        this.sendData(stream, chunk.subarray(offset, offset + PORT_DATA_CHUNK_BYTES));
      }
    });
    socket.once("end", () => {
      if (stream.closed || this.disposed) return;
      void this.session.call(PortLinkMethod.END, { streamId: stream.id }).catch(() => {});
    });
    socket.resume();
  }

  private sendData(stream: Stream, bytes: Buffer): void {
    if (stream.closed) return;
    stream.onActivity?.();
    const size = bytes.byteLength;
    stream.inFlight += size;
    if (stream.inFlight >= this.windowBytes && !stream.paused) {
      stream.paused = true;
      stream.socket.pause();
    }
    this.session
      .call(
        PortLinkMethod.DATA,
        { streamId: stream.id, data: bytes },
        { timeoutMs: this.dataTimeoutMs }
      )
      .then(
        () => {
          stream.inFlight -= size;
          if (stream.paused && !stream.closed && stream.inFlight <= this.windowBytes / 2) {
            stream.paused = false;
            stream.socket.resume();
          }
        },
        () => {
          // The far side refused or lost the stream; nothing more can reach it.
          stream.socket.destroy();
        }
      );
  }

  private receiveData(streamId: number, data: Uint8Array): Promise<null> | null {
    const stream = this.streams.get(streamId);
    if (!stream || stream.closed) {
      throw new AppError({ code: "NOT_FOUND", message: `No open stream ${streamId}` });
    }
    stream.onActivity?.();
    if (stream.socket.write(data)) return null;
    const { socket } = stream;
    return new Promise((resolve) => {
      const done = () => {
        socket.removeListener("drain", done);
        socket.removeListener("close", done);
        resolve(null);
      };
      socket.on("drain", done);
      socket.on("close", done);
    });
  }
}
