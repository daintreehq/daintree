import crypto from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import {
  compareHandshake,
  type HandshakeMismatch,
  type HostHandshakeInfo,
} from "../../../shared/types/remoteHosts.js";
import { ControlKind, type HelloMessage, type LinkClientInfo } from "../link/messages.js";
import { Lane } from "../link/frames.js";
import { LinkSession, type LinkCloseInfo, type LinkSessionOptions } from "../link/session.js";
import { assertSocketPathFits, type HostSocketLocation } from "./hostSocketPath.js";
import { removeDiscoveryFile, tokensEqual, writeDiscoveryFile } from "./discoveryFile.js";

/**
 * Host mode's listener: a 0600 Unix socket in a 0700 directory, a per-launch
 * token advertised in an owner-only discovery file, and one {@link LinkSession}
 * per connection. A connection must authenticate with HELLO (token plus a
 * matching build) before anything else is accepted. Sessions can be resumed:
 * a client that reconnects within the grace window presenting its previous
 * session id (and the same client id) gets that session id back with
 * `resumed: true`, so later phases can reattach endpoints and replay streams.
 *
 * Nothing is dispatched here; later phases attach behaviour through
 * {@link HostServer.onSession}.
 */

export interface HostSessionContext {
  sessionId: string;
  client: LinkClientInfo;
  resumed: boolean;
  session: LinkSession;
}

export interface HostSessionExpired {
  sessionId: string;
  clientId: string;
}

export interface HostServerOptions {
  location: HostSocketLocation;
  handshake: HostHandshakeInfo;
  hostName: string;
  /** 64 hex chars; defaults to 32 fresh random bytes. */
  token?: string;
  /** How long a dropped session stays resumable. */
  resumeGraceMs?: number;
  maxSessions?: number;
  session?: Omit<LinkSessionOptions, "role">;
  now?: () => number;
}

interface Resumable {
  clientId: string;
  timer: ReturnType<typeof setTimeout>;
}

const DEFAULT_RESUME_GRACE_MS = 10 * 60 * 1000;
const DEFAULT_MAX_SESSIONS = 32;
const CLOSE_GRACE_MS = 1_000;
const STALE_PROBE_TIMEOUT_MS = 2_000;

export class HostServerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HostServerError";
  }
}

export function describeMismatch(mismatch: HandshakeMismatch): string {
  switch (mismatch.kind) {
    case "protocol":
      return `wire protocol ${mismatch.remote} does not match ${mismatch.local}`;
    case "version":
      return `version ${mismatch.remote} does not match ${mismatch.local}`;
    case "commit":
      return `build ${mismatch.remote} does not match ${mismatch.local}`;
  }
}

export class HostServer {
  readonly token: string;
  private server: net.Server | null = null;
  private closing = false;
  private readonly sockets = new Set<net.Socket>();
  private readonly live = new Map<string, HostSessionContext>();
  private readonly resumable = new Map<string, Resumable>();
  private readonly sessionListeners = new Set<(ctx: HostSessionContext) => void>();
  private readonly expiredListeners = new Set<(info: HostSessionExpired) => void>();

  constructor(private readonly options: HostServerOptions) {
    this.token = options.token ?? crypto.randomBytes(32).toString("hex");
  }

  get socketPath(): string {
    return this.options.location.socketPath;
  }

  get isListening(): boolean {
    return this.server !== null;
  }

  /** Authenticated sessions currently attached. */
  get sessions(): HostSessionContext[] {
    return [...this.live.values()];
  }

  onSession(listener: (ctx: HostSessionContext) => void): () => void {
    this.sessionListeners.add(listener);
    return () => this.sessionListeners.delete(listener);
  }

  /** A dropped session's grace window passed without a resume. */
  onSessionExpired(listener: (info: HostSessionExpired) => void): () => void {
    this.expiredListeners.add(listener);
    return () => this.expiredListeners.delete(listener);
  }

  async listen(): Promise<void> {
    if (this.server) return;
    this.closing = false;
    const { dir, socketPath, discoveryPath } = this.options.location;
    assertSocketPathFits(socketPath);
    await prepareOwnerOnlyDir(dir);
    await clearStaleSocket(socketPath);

    const server = net.createServer((socket) => this.onConnection(socket));
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
      // Advertise only once the socket is live and locked down.
      await writeDiscoveryFile(discoveryPath, {
        version: 1,
        socketPath,
        token: this.token,
        pid: process.pid,
      });
    } catch (err) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await fs.rm(socketPath, { force: true }).catch(() => {});
      throw err;
    }
    this.server = server;
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.closing = true;
    for (const ctx of [...this.live.values()]) ctx.session.close("shutting-down");
    this.live.clear();
    for (const entry of this.resumable.values()) clearTimeout(entry.timer);
    this.resumable.clear();
    if (!server) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        for (const socket of this.sockets) socket.destroy();
      }, CLOSE_GRACE_MS);
      server.close(() => {
        clearTimeout(timer);
        resolve();
      });
    });
    this.sockets.clear();
    // Closing the listener already unlinked the socket file (libuv does it
    // for pipe servers).
    await removeDiscoveryFile(this.options.location.discoveryPath, this.token);
  }

  private onConnection(socket: net.Socket): void {
    if (this.closing) {
      socket.destroy();
      return;
    }
    this.sockets.add(socket);
    socket.once("close", () => this.sockets.delete(socket));
    const session = new LinkSession(socket, { ...this.options.session, role: "host" });
    session.onHandshake((message) => {
      if (message.lane === Lane.CONTROL && message.kind === ControlKind.HELLO) {
        this.onHello(session, message.body);
      } else {
        session.close("unexpected handshake message");
      }
    });
  }

  private onHello(session: LinkSession, hello: HelloMessage): void {
    const local = this.options.handshake;
    if (this.closing) {
      session.reject({ reason: "shutting-down", handshake: null, detail: null });
      return;
    }
    if (!tokensEqual(hello.token, this.token)) {
      session.reject({ reason: "unauthorized", handshake: null, detail: null });
      return;
    }
    const mismatch = compareHandshake(local, hello.handshake);
    if (mismatch) {
      session.reject({
        reason: mismatch.kind === "protocol" ? "protocol" : "version-mismatch",
        handshake: local,
        detail: describeMismatch(mismatch),
      });
      return;
    }

    const clientId = hello.client.clientId;
    let sessionId: string | null = null;
    const resumeId = hello.resumeSessionId;
    if (resumeId !== null) {
      const parked = this.resumable.get(resumeId);
      const attached = this.live.get(resumeId);
      if (parked && parked.clientId === clientId) {
        clearTimeout(parked.timer);
        this.resumable.delete(resumeId);
        sessionId = resumeId;
      } else if (attached && attached.client.clientId === clientId) {
        // The old stream hasn't noticed it is dead yet; the new one replaces it.
        this.live.delete(resumeId);
        attached.session.close("superseded by a resumed session");
        sessionId = resumeId;
      }
    }
    const resumed = sessionId !== null;
    if (!resumed && this.live.size >= (this.options.maxSessions ?? DEFAULT_MAX_SESSIONS)) {
      session.reject({ reason: "busy", handshake: null, detail: null });
      return;
    }
    const id = sessionId ?? crypto.randomUUID();

    const ctx: HostSessionContext = { sessionId: id, client: hello.client, resumed, session };
    session.open();
    session.post({
      lane: Lane.CONTROL,
      kind: ControlKind.WELCOME,
      body: { handshake: local, hostName: this.options.hostName, sessionId: id, resumed },
    });
    this.live.set(id, ctx);
    session.onClose((info) => this.park(ctx, info));
    for (const listener of this.sessionListeners) {
      try {
        listener(ctx);
      } catch {
        // One broken subscriber must not stop the others from seeing the session.
      }
    }
  }

  /**
   * Keep a lost session resumable for the grace window. A client that said
   * GOODBYE, or broke the protocol, left on purpose and expires at once.
   */
  private park(ctx: HostSessionContext, close: LinkCloseInfo): void {
    if (this.live.get(ctx.sessionId) !== ctx) return;
    this.live.delete(ctx.sessionId);
    if (this.closing) return;
    const deliberate = close.by === "remote" || close.reason.startsWith("protocol error");
    if (deliberate) {
      this.expire(ctx);
      return;
    }
    const grace = this.options.resumeGraceMs ?? DEFAULT_RESUME_GRACE_MS;
    const timer = setTimeout(() => {
      if (this.resumable.get(ctx.sessionId)?.timer !== timer) return;
      this.resumable.delete(ctx.sessionId);
      this.expire(ctx);
    }, grace);
    timer.unref?.();
    this.resumable.set(ctx.sessionId, { clientId: ctx.client.clientId, timer });
  }

  private expire(ctx: HostSessionContext): void {
    const info = { sessionId: ctx.sessionId, clientId: ctx.client.clientId };
    for (const listener of this.expiredListeners) {
      try {
        listener(info);
      } catch {
        // Ignore subscriber failures.
      }
    }
  }
}

/**
 * Create the socket directory owner-only, and refuse one we don't own or that
 * is a symlink: a socket in someone else's directory could be swapped out
 * from under us.
 */
async function prepareOwnerOnlyDir(dir: string): Promise<void> {
  try {
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  } catch (err) {
    throw new HostServerError(
      `Could not create the host socket directory ${dir}: ${(err as Error).message}`
    );
  }
  const stat = await fs.lstat(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new HostServerError(`Host socket directory ${dir} is not a directory`);
  }
  const uid = process.getuid?.();
  if (uid !== undefined && stat.uid !== uid) {
    throw new HostServerError(`Host socket directory ${dir} is owned by another user`);
  }
  await fs.chmod(dir, 0o700);
}

/**
 * Remove a socket file left by a crashed launch, but never one another live
 * process is serving, and never something that isn't a socket.
 */
async function clearStaleSocket(socketPath: string): Promise<void> {
  let stat;
  try {
    stat = await fs.lstat(socketPath);
  } catch {
    return;
  }
  if (!stat.isSocket()) {
    throw new HostServerError(`${socketPath} exists and is not a socket`);
  }
  // Only a refused connection proves nobody is serving it; anything else
  // (a full backlog, a slow peer) is treated as a live listener.
  const stale = await new Promise<boolean>((resolve) => {
    const probe = net.connect(socketPath);
    const timer = setTimeout(() => {
      probe.destroy();
      resolve(false);
    }, STALE_PROBE_TIMEOUT_MS);
    probe.once("connect", () => {
      clearTimeout(timer);
      probe.destroy();
      resolve(false);
    });
    probe.once("error", (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      resolve(err.code === "ECONNREFUSED" || err.code === "ENOENT");
    });
  });
  if (!stale) throw new HostServerError(`Another process is already listening on ${socketPath}`);
  await fs.rm(socketPath, { force: true });
}
