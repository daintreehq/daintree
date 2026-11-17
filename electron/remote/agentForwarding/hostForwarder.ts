import crypto from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import type { DriveTarget } from "../../services/DriveLeaseService.js";
import { createLogger } from "../../utils/logger.js";
import { clearStaleSocket, prepareOwnerOnlyDir } from "../host/HostServer.js";
import { maxSocketPathBytes } from "../host/hostSocketPath.js";
import type { LinkSession } from "../link/session.js";
import { readSshConfig, readTerminalIdentityAgent, type SshConfigReader } from "./identityAgent.js";
import {
  AgentConfigurePayloadSchema,
  AgentForwardMethod,
  AgentReplySchema,
  INSPECTED_SSH_DESTINATION,
  type AgentInspectResult,
} from "./linkMethods.js";
import {
  AGENT_FAILURE_BODY,
  AgentFramingError,
  AgentMessageReader,
  frameAgentMessage,
} from "./protocol.js";

const logger = createLogger("main:HostAgentForwarding");

declare module "../runtime.js" {
  interface RemoteServices {
    agentForwardingHost: HostAgentForwarding;
  }
}

/**
 * Host side of agent forwarding (#17432): one Unix socket per project, at a
 * path that never changes, handed to new terminals as `SSH_AUTH_SOCK` while
 * the project's driver has forwarding on. Each connection to it is carried
 * over the link to the Shell driving the project when it was opened, and
 * closes if that Shell stops driving. With no driver to carry it, it answers
 * every request with an agent failure, so ssh moves on instead of hanging.
 */

export interface HostAgentSessionContext {
  sessionId: string;
  session: LinkSession;
}

export interface HostAgentForwardingDeps {
  server: {
    readonly sessions: ReadonlyArray<HostAgentSessionContext>;
    onSession(listener: (ctx: HostAgentSessionContext) => void): () => void;
  };
  lease: {
    getDriveTarget(projectId: string): DriveTarget;
    onChange(listener: (state: { projectId: string }) => void): () => void;
  };
  /** Created owner-only; the project sockets live here. */
  socketDir: string;
  /**
   * Where they go instead when a path there wouldn't fit `sun_path` (a long
   * home folder on macOS): a short owner-only folder that stays the same.
   */
  fallbackSocketDir?: string;
  /**
   * Told when a driver may have come or gone without a holder change: an
   * endpoint closed, or a link dropped or resumed. The lease's own change
   * events cover a new holder.
   */
  onRouteMaybeChanged?: (listener: () => void) => () => void;
  readSshConfig?: SshConfigReader;
  /** How long a forwarded request may wait for the Shell's answer. */
  replyTimeoutMs?: number;
  /** A connection with nothing asked for this long is closed. */
  idleTimeoutMs?: number;
  maxConnectionsPerProject?: number;
}

export interface HostAgentForwarding {
  /**
   * The socket a terminal spawned in the project now should get, or null
   * when its driver isn't a Shell with forwarding on.
   */
  socketForSpawn(projectId: string): Promise<string | null>;
  /** Whether the project's driver still forwards an agent, checked again right before a spawn. */
  isForwarding(projectId: string): boolean;
  dispose(): Promise<void>;
}

/** Past the Shell's own two-minute wait, so the Shell gives up first and says why. */
const DEFAULT_REPLY_TIMEOUT_MS = 130_000;
const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_MAX_CONNECTIONS_PER_PROJECT = 32;
/** ssh asks one thing at a time; a client queueing more than this is broken. */
const MAX_QUEUED_REQUESTS = 4;
const INSPECT_CACHE_MS = 30_000;
const MAX_CONNECTION_ID = 0xffffffff;

/**
 * Projects whose terminals were handed a socket in this process. A Host mode
 * restart listens on them again at once, so terminals still running get an
 * answer rather than a missing socket.
 */
const issuedProjects = new Set<string>();

export function _resetIssuedAgentSocketsForTest(): void {
  issuedProjects.clear();
}

/** Short, so a long home folder on macOS still fits `sun_path`. */
export function agentSocketName(projectId: string): string {
  return `${crypto.createHash("sha256").update(projectId).digest("hex").slice(0, 16)}.sock`;
}

const FAILURE_FRAME = frameAgentMessage(AGENT_FAILURE_BODY);

export function installHostAgentForwarding(deps: HostAgentForwardingDeps): HostAgentForwarding {
  const replyTimeoutMs = deps.replyTimeoutMs ?? DEFAULT_REPLY_TIMEOUT_MS;
  const idleTimeoutMs = deps.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const maxPerProject = deps.maxConnectionsPerProject ?? DEFAULT_MAX_CONNECTIONS_PER_PROJECT;
  const readConfig = deps.readSshConfig ?? readSshConfig;

  const consent = new WeakMap<LinkSession, boolean>();
  const wired = new WeakSet<LinkSession>();
  /** What each live link registered here, let go when it closes or this stops. */
  const sessionCleanups = new Map<LinkSession, () => void>();
  const listeners = new Map<string, Promise<string>>();
  const servers = new Map<string, net.Server>();
  const pathOwners = new Map<string, string>();
  const connections = new Set<AgentConnection>();
  const disposers: Array<() => void> = [];
  let nextConnectionId = 1;
  let inspected: { at: number; result: Promise<AgentInspectResult> } | null = null;
  let disposed = false;

  /** The link the project's driver is on, when it has forwarding on. */
  const liveRoute = (projectId: string): LinkSession | null => {
    const target = deps.lease.getDriveTarget(projectId);
    if (target.kind !== "live" || target.endpoint.kind !== "remote-view") return null;
    const sessionId = target.endpoint.linkSessionId;
    if (!sessionId) return null;
    const session = deps.server.sessions.find((ctx) => ctx.sessionId === sessionId)?.session;
    return session && session.isOpen && consent.get(session) === true ? session : null;
  };

  /** Drop every connection that no longer reaches its project's driver. */
  const recheck = (filter: (connection: AgentConnection) => boolean): void => {
    for (const connection of [...connections]) {
      if (!filter(connection) || connection.route === null) continue;
      if (liveRoute(connection.projectId) !== connection.route) connection.close();
    }
  };

  const inspect = (): Promise<AgentInspectResult> => {
    const now = Date.now();
    if (inspected && now - inspected.at < INSPECT_CACHE_MS) return inspected.result;
    const result = readTerminalIdentityAgent(INSPECTED_SSH_DESTINATION, readConfig).then(
      (identityAgent) => ({ identityAgent }),
      () => ({ identityAgent: null })
    );
    inspected = { at: now, result };
    return result;
  };

  const wire = ({ session }: HostAgentSessionContext): void => {
    if (wired.has(session) || session.isClosed) return;
    wired.add(session);
    // A new link starts with forwarding off, a resumed session included: the
    // Shell says again on every link whether its switch is on.
    const offs = [
      session.registerCallHandler(
        AgentForwardMethod.CONFIGURE,
        AgentConfigurePayloadSchema,
        ({ enabled }) => {
          consent.set(session, enabled);
          if (!enabled) recheck((connection) => connection.route === session);
          return null;
        }
      ),
      session.registerCallHandler(AgentForwardMethod.INSPECT, z.null(), () => inspect()),
    ];
    const cleanup = (): void => {
      sessionCleanups.delete(session);
      for (const off of offs) off();
    };
    sessionCleanups.set(session, cleanup);
    offs.push(
      session.onClose(() => {
        recheck((connection) => connection.route === session);
        cleanup();
      })
    );
  };

  // Named for this profile's own folder, so two profiles of one user never share it.
  // Named for this profile's own folder, so two profiles of one user never
  // share one; under /tmp only when even the temp folder's path is too long.
  const fallbackName = `daintree-${process.getuid?.() ?? "user"}-${crypto
    .createHash("sha256")
    .update(deps.socketDir)
    .digest("hex")
    .slice(0, 8)}`;
  const socketDirs = [
    deps.socketDir,
    ...(deps.fallbackSocketDir
      ? [deps.fallbackSocketDir]
      : [path.join(os.tmpdir(), fallbackName), path.join("/tmp", fallbackName)]),
  ];

  const listen = async (projectId: string): Promise<string> => {
    const name = agentSocketName(projectId);
    const dir = socketDirs.find(
      (candidate) => Buffer.byteLength(path.join(candidate, name)) <= maxSocketPathBytes()
    );
    if (!dir) throw new Error(`No agent socket path short enough for ${name}`);
    const socketPath = path.join(dir, name);
    await prepareOwnerOnlyDir(dir);
    const owner = pathOwners.get(socketPath);
    if (owner !== undefined && owner !== projectId) {
      throw new Error("Two projects map to one agent socket");
    }
    await clearStaleSocket(socketPath);
    if (disposed) throw new Error("Agent forwarding stopped");
    const server = net.createServer((socket) => accept(projectId, socket));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => {
        server.off("error", reject);
        resolve();
      });
    });
    server.on("error", () => {});
    try {
      await fs.chmod(socketPath, 0o600);
      if (disposed) throw new Error("Agent forwarding stopped");
    } catch (error) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      throw error;
    }
    servers.set(projectId, server);
    pathOwners.set(socketPath, projectId);
    issuedProjects.add(projectId);
    return socketPath;
  };

  const ensureListener = (projectId: string): Promise<string> => {
    let ready = listeners.get(projectId);
    if (!ready) {
      ready = listen(projectId);
      listeners.set(projectId, ready);
      const settled = ready;
      settled.catch(() => {
        if (listeners.get(projectId) === settled) listeners.delete(projectId);
      });
    }
    return ready;
  };

  const accept = (projectId: string, socket: net.Socket): void => {
    if (disposed) {
      socket.destroy();
      return;
    }
    let open = 0;
    for (const connection of connections) if (connection.projectId === projectId) open++;
    if (open >= maxPerProject || nextConnectionId > MAX_CONNECTION_ID) {
      socket.destroy();
      return;
    }
    const connection = new AgentConnection(
      nextConnectionId++,
      projectId,
      socket,
      liveRoute(projectId),
      {
        stillRoutes: (c) => liveRoute(c.projectId) === c.route,
        replyTimeoutMs,
        idleTimeoutMs,
        onClosed: (c) => connections.delete(c),
      }
    );
    connections.add(connection);
  };

  for (const ctx of deps.server.sessions) wire(ctx);
  disposers.push(deps.server.onSession(wire));
  disposers.push(
    deps.lease.onChange(({ projectId }) =>
      recheck((connection) => connection.projectId === projectId)
    )
  );
  if (deps.onRouteMaybeChanged) disposers.push(deps.onRouteMaybeChanged(() => recheck(() => true)));
  for (const projectId of issuedProjects) {
    ensureListener(projectId).catch((error: unknown) => {
      logger.warn("Couldn't listen for agent requests again", { error });
    });
  }

  return {
    async socketForSpawn(projectId) {
      if (disposed || liveRoute(projectId) === null) return null;
      try {
        return await ensureListener(projectId);
      } catch (error) {
        logger.warn("Couldn't open a project's agent socket", { error });
        return null;
      }
    },
    isForwarding: (projectId) => !disposed && liveRoute(projectId) !== null,
    async dispose() {
      if (disposed) return;
      disposed = true;
      for (const dispose of disposers.splice(0)) dispose();
      for (const cleanup of [...sessionCleanups.values()]) cleanup();
      for (const connection of [...connections]) connection.close();
      // A listen still under way sees `disposed` and closes its own server.
      await Promise.allSettled([...listeners.values()]);
      const closing = [...servers.values()].map(
        (server) => new Promise<void>((resolve) => server.close(() => resolve()))
      );
      servers.clear();
      listeners.clear();
      // Closing a pipe server unlinks its socket file.
      await Promise.all(closing);
    },
  };
}

interface AgentConnectionHooks {
  stillRoutes(connection: AgentConnection): boolean;
  replyTimeoutMs: number;
  idleTimeoutMs: number;
  onClosed(connection: AgentConnection): void;
}

class AgentConnection {
  private readonly reader = new AgentMessageReader();
  private readonly queue: Uint8Array[] = [];
  private inFlight = false;
  /** A request reached the Shell, which may hold an agent connection for it. */
  private relayed = false;
  private closed = false;
  /** The client stopped reading: nothing more is answered until it drains. */
  private draining = false;
  private idle: ReturnType<typeof setTimeout> | null = null;
  /** Withdraws a request the link hasn't sent yet, so a former driver never sees it. */
  private readonly abort = new AbortController();

  constructor(
    readonly id: number,
    readonly projectId: string,
    private readonly socket: net.Socket,
    /** The driver's link when the connection opened; null answers every request with a failure. */
    readonly route: LinkSession | null,
    private readonly hooks: AgentConnectionHooks
  ) {
    socket.on("data", (chunk: Buffer) => this.receive(chunk));
    socket.on("error", () => {
      // "close" follows.
    });
    socket.once("close", () => this.close());
    this.armIdle();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.abort.abort();
    if (this.idle) clearTimeout(this.idle);
    this.idle = null;
    this.socket.destroy();
    if (this.relayed && this.route?.isOpen) {
      // No deadline: a notice that settles unsent is dropped, and the Shell's
      // agent connection goes with its link anyway.
      void this.route
        .call(AgentForwardMethod.CLOSE, { connectionId: this.id }, { timeoutMs: 0 })
        .catch(() => {});
    }
    this.hooks.onClosed(this);
  }

  private armIdle(): void {
    if (this.idle) clearTimeout(this.idle);
    this.idle = this.inFlight ? null : setTimeout(() => this.close(), this.hooks.idleTimeoutMs);
  }

  private receive(chunk: Buffer): void {
    if (this.closed) return;
    let messages: Uint8Array[];
    try {
      messages = this.reader.push(chunk);
    } catch (error) {
      if (!(error instanceof AgentFramingError)) throw error;
      this.close();
      return;
    }
    this.queue.push(...messages);
    if (this.queue.length > MAX_QUEUED_REQUESTS) {
      this.close();
      return;
    }
    this.armIdle();
    this.pump();
  }

  private write(frame: Buffer): void {
    if (this.socket.write(frame)) return;
    this.draining = true;
    this.socket.once("drain", () => {
      this.draining = false;
      this.pump();
    });
  }

  private pump(): void {
    if (this.closed || this.inFlight || this.draining) return;
    const message = this.queue.shift();
    if (!message) return;
    if (this.route === null) {
      this.write(FAILURE_FRAME);
      this.pump();
      return;
    }
    // The driver moved on, turned forwarding off or lost its link since the
    // connection opened: it never reaches anyone else's agent.
    if (!this.hooks.stillRoutes(this)) {
      this.close();
      return;
    }
    this.inFlight = true;
    this.relayed = true;
    this.armIdle();
    this.route
      .call(
        AgentForwardMethod.REQUEST,
        { connectionId: this.id, message },
        { timeoutMs: this.hooks.replyTimeoutMs, signal: this.abort.signal }
      )
      .then(
        (result) => {
          const reply = AgentReplySchema.safeParse(result);
          if (this.closed) return;
          // A signature for a driver that has since gone is not handed over.
          if (!reply.success || !this.hooks.stillRoutes(this)) {
            this.close();
            return;
          }
          this.inFlight = false;
          this.write(frameAgentMessage(reply.data.message));
          this.armIdle();
          this.pump();
        },
        () => this.close()
      );
  }
}
