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
 * for. Requests the relay won't forward, and every request while forwarding
 * isn't allowed or no agent is running here, are answered with a failure
 * without reaching the agent.
 *
 * A Host connection whose agent connection ended (the agent closed it, the
 * switch went off, it sat idle) is retired rather than quietly given a fresh
 * one, which would carry none of its session binding: its next request is
 * refused, and the Host closes it.
 */

export interface ShellAgentRelayOptions {
  /** Read on every request: the switch can go off, or the last window close, mid-connection. */
  isEnabled(): boolean;
  /** The agent socket this computer's ssh uses for the host; null when there is none. */
  agentSocket(): Promise<string | null>;
  connect?: (socketPath: string) => Promise<net.Socket>;
  /** Long enough for a hardware key's touch or a password manager's approval. */
  replyTimeoutMs?: number;
  /** Past the Host's own idle limit, for a close notice that never arrived. */
  idleTimeoutMs?: number;
  maxConnections?: number;
}

const DEFAULT_REPLY_TIMEOUT_MS = 120_000;
const DEFAULT_IDLE_TIMEOUT_MS = 11 * 60_000;
const DEFAULT_MAX_CONNECTIONS = 64;
const CONNECT_TIMEOUT_MS = 5_000;
/**
 * Retired ids the Host hasn't closed yet. It always does, so this fills only
 * from lost close notices; when it does, new connections are refused rather
 * than an old id forgotten and opened afresh.
 */
const MAX_RETIRED = 1024;

const FAILURE: AgentReply = { message: AGENT_FAILURE_BODY };

interface Upstream {
  socket: net.Socket;
  reader: AgentMessageReader;
  waiting: { resolve(body: Uint8Array): void; reject(error: Error): void } | null;
  idle: ReturnType<typeof setTimeout> | null;
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

function refused(message: string): AppError {
  return new AppError({ code: "CANCELLED", message });
}

export class ShellAgentRelay {
  private readonly upstreams = new Map<number, Upstream>();
  /** Opens still waiting on the agent's path or socket; `cancelled` once the Host let go. */
  private readonly opening = new Map<number, { cancelled: boolean }>();
  private readonly retired = new Set<number>();
  private readonly busy = new Set<number>();
  private disposed = false;
  private readonly disposers: Array<() => void> = [];
  private readonly connect: (socketPath: string) => Promise<net.Socket>;
  private readonly replyTimeoutMs: number;
  private readonly idleTimeoutMs: number;
  private readonly maxConnections: number;

  constructor(
    session: LinkSession,
    private readonly options: ShellAgentRelayOptions
  ) {
    this.connect = options.connect ?? ((socketPath) => connectAgentSocket(socketPath));
    this.replyTimeoutMs = options.replyTimeoutMs ?? DEFAULT_REPLY_TIMEOUT_MS;
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
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
          this.release(connectionId);
          return null;
        }
      ),
      session.onClose(() => this.dispose())
    );
  }

  get connectionCount(): number {
    return this.upstreams.size;
  }

  /** Forwarding stopped here: nothing open keeps using the agent. */
  closeAll(): void {
    for (const id of [...this.upstreams.keys()]) this.retire(id);
    for (const [id, open] of this.opening) {
      // One the Host already let go of has no request coming to be refused.
      if (open.cancelled) continue;
      open.cancelled = true;
      this.markRetired(id);
    }
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
    if (this.retired.has(connectionId)) throw refused("This agent connection has ended");
    if (this.disposed || !this.options.isEnabled()) {
      if (this.upstreams.has(connectionId)) {
        this.retire(connectionId);
        throw refused("Agent forwarding is off");
      }
      return FAILURE;
    }
    if (!isForwardableRequest(message)) return FAILURE;
    this.busy.add(connectionId);
    try {
      let upstream = this.upstreams.get(connectionId) ?? null;
      if (!upstream) {
        if (
          this.upstreams.size + this.opening.size >= this.maxConnections ||
          this.retired.size >= MAX_RETIRED
        ) {
          return FAILURE;
        }
        upstream = await this.open(connectionId);
        if (!upstream) return FAILURE;
      }
      const reply = await this.exchange(connectionId, upstream, message);
      // The last window on the host closed, or the switch went off, while the
      // agent was answering (a key's touch, an approval): the answer stays here.
      if (this.disposed || !this.options.isEnabled()) {
        this.retire(connectionId);
        throw refused("Agent forwarding stopped while the agent answered");
      }
      return { message: reply };
    } finally {
      this.busy.delete(connectionId);
    }
  }

  private async open(connectionId: number): Promise<Upstream | null> {
    const open = { cancelled: false };
    this.opening.set(connectionId, open);
    let socket: net.Socket;
    try {
      const socketPath = await this.options.agentSocket();
      if (!socketPath || open.cancelled) return null;
      socket = await this.connect(socketPath);
    } catch {
      return null;
    } finally {
      if (this.opening.get(connectionId) === open) this.opening.delete(connectionId);
    }
    // The Host let go, or forwarding stopped, while the agent was being reached.
    if (open.cancelled || this.disposed || !this.options.isEnabled()) {
      socket.destroy();
      throw refused("The agent connection was closed while it opened");
    }
    const upstream: Upstream = {
      socket,
      reader: new AgentMessageReader(),
      waiting: null,
      idle: null,
    };
    this.upstreams.set(connectionId, upstream);
    const fail = (error: Error): void => {
      const waiting = upstream.waiting;
      upstream.waiting = null;
      waiting?.reject(error);
      socket.destroy();
    };
    socket.on("data", (chunk: Buffer) => {
      // An agent speaks only when asked, and answers each request once.
      if (!upstream.waiting) {
        fail(new Error("The ssh agent sent a reply nobody asked for"));
        return;
      }
      let replies: Uint8Array[];
      try {
        replies = upstream.reader.push(chunk);
      } catch (error) {
        fail(error as Error);
        return;
      }
      if (replies.length === 0) return;
      if (replies.length > 1 || upstream.reader.pendingBytes > 0) {
        fail(new Error("The ssh agent sent more than one reply"));
        return;
      }
      const waiting = upstream.waiting;
      upstream.waiting = null;
      waiting.resolve(replies[0]!);
    });
    socket.on("error", () => {
      // "close" follows and settles anything waiting.
    });
    socket.once("close", () => {
      if (upstream.idle) clearTimeout(upstream.idle);
      if (this.upstreams.get(connectionId) === upstream) {
        this.upstreams.delete(connectionId);
        this.markRetired(connectionId);
      }
      fail(new Error("The ssh agent closed the connection"));
    });
    return upstream;
  }

  private exchange(
    connectionId: number,
    upstream: Upstream,
    message: Uint8Array
  ): Promise<Uint8Array> {
    if (upstream.idle) clearTimeout(upstream.idle);
    upstream.idle = null;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        // A late reply can't be matched to anything once given up on, so the
        // connection goes with it.
        this.retire(connectionId);
      }, this.replyTimeoutMs);
      upstream.waiting = {
        resolve: (body) => {
          clearTimeout(timer);
          upstream.idle = setTimeout(() => this.retire(connectionId), this.idleTimeoutMs);
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

  /** The Host is done with the connection: forget it entirely. */
  private release(connectionId: number): void {
    // Still counted against the cap until its lookup or connect settles.
    const open = this.opening.get(connectionId);
    if (open) open.cancelled = true;
    this.destroyUpstream(connectionId);
    this.retired.delete(connectionId);
  }

  /** End the agent connection while the Host still holds its side: its next request is refused. */
  private retire(connectionId: number): void {
    this.destroyUpstream(connectionId);
    this.markRetired(connectionId);
  }

  private markRetired(connectionId: number): void {
    this.retired.add(connectionId);
  }

  private destroyUpstream(connectionId: number): void {
    const upstream = this.upstreams.get(connectionId);
    if (!upstream) return;
    this.upstreams.delete(connectionId);
    if (upstream.idle) clearTimeout(upstream.idle);
    upstream.socket.destroy();
  }
}
