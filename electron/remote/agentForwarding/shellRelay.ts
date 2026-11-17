import net from "node:net";
import { AppError } from "../../utils/errorTypes.js";
import type { LinkSession } from "../link/session.js";
import {
  AgentClosePayloadSchema,
  AgentForwardMethod,
  AgentRequestPayloadSchema,
  type AgentReply,
} from "./linkMethods.js";
import {
  AGENT_FAILURE_BODY,
  AgentMessageReader,
  frameAgentMessage,
  isForwardableRequest,
} from "./protocol.js";

/**
 * Shell side of agent forwarding: each Host connection gets its own
 * connection to this computer's agent, opened on its first request and kept
 * for its life, since ssh binds an agent connection to the session it signs
 * for. Requests the relay won't forward, and every request while the switch
 * is off or no agent is running here, are answered with a failure without
 * reaching the agent.
 */

export interface ShellAgentRelayOptions {
  /** Read on every request: the switch can go off while a connection is open. */
  isEnabled(): boolean;
  /** The agent socket this computer's ssh uses for the host; null when there is none. */
  agentSocket(): Promise<string | null>;
  connect?: (socketPath: string) => Promise<net.Socket>;
  /** Long enough for a hardware key's touch or a password manager's approval. */
  replyTimeoutMs?: number;
  maxConnections?: number;
}

const DEFAULT_REPLY_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_CONNECTIONS = 64;
const CONNECT_TIMEOUT_MS = 5_000;

const FAILURE: AgentReply = { message: AGENT_FAILURE_BODY };

interface Upstream {
  socket: net.Socket;
  reader: AgentMessageReader;
  waiting: { resolve(body: Uint8Array): void; reject(error: Error): void } | null;
}

export function connectAgentSocket(
  socketPath: string,
  timeoutMs = CONNECT_TIMEOUT_MS
): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPath);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("Connecting to the ssh agent timed out"));
    }, timeoutMs);
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.removeAllListeners("error");
      resolve(socket);
    });
  });
}

export class ShellAgentRelay {
  private readonly upstreams = new Map<number, Upstream>();
  private readonly busy = new Set<number>();
  private opening = 0;
  private disposed = false;
  private readonly disposers: Array<() => void> = [];
  private readonly connect: (socketPath: string) => Promise<net.Socket>;
  private readonly replyTimeoutMs: number;
  private readonly maxConnections: number;

  constructor(
    session: LinkSession,
    private readonly options: ShellAgentRelayOptions
  ) {
    this.connect = options.connect ?? ((socketPath) => connectAgentSocket(socketPath));
    this.replyTimeoutMs = options.replyTimeoutMs ?? DEFAULT_REPLY_TIMEOUT_MS;
    this.maxConnections = options.maxConnections ?? DEFAULT_MAX_CONNECTIONS;
    if (session.isClosed) {
      this.disposed = true;
      return;
    }
    this.disposers.push(
      session.registerCallHandler(
        AgentForwardMethod.REQUEST,
        AgentRequestPayloadSchema,
        (payload) => this.request(payload.connectionId, payload.message)
      ),
      session.registerCallHandler(
        AgentForwardMethod.CLOSE,
        AgentClosePayloadSchema,
        ({ connectionId }) => {
          this.closeConnection(connectionId);
          return null;
        }
      ),
      session.onClose(() => this.dispose())
    );
  }

  get connectionCount(): number {
    return this.upstreams.size;
  }

  /** The switch went off: nothing open keeps using the agent. */
  closeAll(): void {
    for (const id of [...this.upstreams.keys()]) this.closeConnection(id);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const dispose of this.disposers.splice(0).reverse()) dispose();
    this.closeAll();
  }

  private async request(connectionId: number, message: Uint8Array): Promise<AgentReply> {
    // The Host sends a connection's next request only once this one is
    // answered; one that doesn't would get replies out of order.
    if (this.busy.has(connectionId)) {
      throw new AppError({
        code: "VALIDATION",
        message: "An agent request is already waiting on this connection",
      });
    }
    if (this.disposed || !this.options.isEnabled()) {
      this.closeConnection(connectionId);
      return FAILURE;
    }
    if (!isForwardableRequest(message)) return FAILURE;
    this.busy.add(connectionId);
    try {
      let upstream = this.upstreams.get(connectionId) ?? null;
      if (!upstream) {
        if (this.upstreams.size + this.opening >= this.maxConnections) return FAILURE;
        upstream = await this.open(connectionId);
        if (!upstream) return FAILURE;
      }
      if (this.disposed || !this.options.isEnabled()) {
        this.closeConnection(connectionId);
        return FAILURE;
      }
      return { message: await this.exchange(connectionId, upstream, message) };
    } finally {
      this.busy.delete(connectionId);
    }
  }

  private async open(connectionId: number): Promise<Upstream | null> {
    this.opening++;
    let socket: net.Socket;
    try {
      const socketPath = await this.options.agentSocket();
      if (!socketPath) return null;
      socket = await this.connect(socketPath);
    } catch {
      return null;
    } finally {
      this.opening--;
    }
    if (this.disposed) {
      socket.destroy();
      return null;
    }
    const upstream: Upstream = { socket, reader: new AgentMessageReader(), waiting: null };
    this.upstreams.set(connectionId, upstream);
    const fail = (error: Error): void => {
      const waiting = upstream.waiting;
      upstream.waiting = null;
      waiting?.reject(error);
      socket.destroy();
    };
    socket.on("data", (chunk: Buffer) => {
      let replies: Uint8Array[];
      try {
        replies = upstream.reader.push(chunk);
      } catch (error) {
        fail(error as Error);
        return;
      }
      for (const reply of replies) {
        const waiting = upstream.waiting;
        if (!waiting) {
          fail(new Error("The ssh agent sent a reply nobody asked for"));
          return;
        }
        upstream.waiting = null;
        waiting.resolve(reply);
      }
    });
    socket.on("error", () => {
      // "close" follows and settles anything waiting.
    });
    socket.once("close", () => {
      if (this.upstreams.get(connectionId) === upstream) this.upstreams.delete(connectionId);
      fail(new Error("The ssh agent closed the connection"));
    });
    return upstream;
  }

  private exchange(
    connectionId: number,
    upstream: Upstream,
    message: Uint8Array
  ): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        // A late reply can't be matched to anything once given up on, so the
        // connection goes with it.
        this.closeConnection(connectionId);
      }, this.replyTimeoutMs);
      upstream.waiting = {
        resolve: (body) => {
          clearTimeout(timer);
          resolve(body);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(new AppError({ code: "OUTCOME_UNKNOWN", message: error.message, cause: error }));
        },
      };
      upstream.socket.write(frameAgentMessage(message));
    });
  }

  private closeConnection(connectionId: number): void {
    const upstream = this.upstreams.get(connectionId);
    if (!upstream) return;
    this.upstreams.delete(connectionId);
    upstream.socket.destroy();
  }
}
