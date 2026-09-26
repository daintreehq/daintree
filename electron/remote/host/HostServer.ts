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
import { withHostSocketLock } from "./hostSocketLock.js";

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
  /** Cap on attached plus parked (resumable) sessions. */
  maxSessions?: number;
  session?: Omit<LinkSessionOptions, "role">;
  now?: () => number;
  /**
   * Agents working here, for a build refusal to an authenticated client (see
   * RejectMessage.observed). Null when they can't all be seen.
   */
  observeWorkingAgents?: () => Promise<number | null>;
}

/**
 * What a parked session keeps: only what a resume has to match. The dropped
 * LinkSession and its context are not retained, so a parked slot costs a few
 * strings and a timer however much the session carried.
 */
interface Resumable {
  sessionId: string;
  clientId: string;
  timer: ReturnType<typeof setTimeout>;
}

const DEFAULT_RESUME_GRACE_MS = 10 * 60 * 1000;
const DEFAULT_MAX_SESSIONS = 32;
const CLOSE_GRACE_MS = 1_000;
const STALE_PROBE_TIMEOUT_MS = 2_000;
const OBSERVE_TIMEOUT_MS = 2_000;

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
  // listen()/close() are serialized: every call bumps the generation, a start
  // that finds itself superseded tears down what it built, and close() waits
  // for any in-flight start before it tears down.
  private generation = 0;
  private starting: Promise<void> | null = null;
  private stopping: Promise<void> | null = null;
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

  /** Concurrent calls share one start; a close() before it finishes makes it reject. */
  listen(): Promise<void> {
    if (this.server) return Promise.resolve();
    if (this.starting) return this.starting;
    const generation = ++this.generation;
    const stopping = this.stopping;
    const start = (async () => {
      await stopping?.catch(() => {});
      this.assertCurrent(generation);
      this.closing = false;
      await this.start(generation);
    })();
    this.starting = start;
    const settled = () => {
      if (this.starting === start) this.starting = null;
    };
    start.then(settled, settled);
    return start;
  }

  close(): Promise<void> {
    this.generation++;
    this.closing = true;
    const starting = this.starting;
    this.starting = null;
    const server = this.server;
    this.server = null;
    const previous = this.stopping;
    const stop = (async () => {
      await previous?.catch(() => {});
      // A start in flight cleans up after itself once it sees the new generation.
      await starting?.catch(() => {});
      await this.teardown(server);
    })();
    this.stopping = stop;
    const settled = () => {
      if (this.stopping === stop) this.stopping = null;
    };
    stop.then(settled, settled);
    return stop;
  }

  private assertCurrent(generation: number): void {
    if (generation !== this.generation) {
      throw new HostServerError("Host server was closed before it finished starting");
    }
  }

  private async start(generation: number): Promise<void> {
    const { dir, socketPath } = this.options.location;
    assertSocketPathFits(socketPath);
    await prepareOwnerOnlyDir(dir);
    // Probe, unlink, bind and advertise as one step per socket path, so two
    // starts can't both judge the same socket stale and unlink each other's.
    await withHostSocketLock(socketPath, () => this.bindAndAdvertise(generation));
  }

  private async bindAndAdvertise(generation: number): Promise<void> {
    const { socketPath, discoveryPath } = this.options.location;
    this.assertCurrent(generation);
    await clearStaleSocket(socketPath);
    this.assertCurrent(generation);

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
      this.assertCurrent(generation);
      // Advertise only once the socket is live and locked down.
      await writeDiscoveryFile(discoveryPath, {
        version: 1,
        socketPath,
        token: this.token,
        pid: process.pid,
      });
      this.assertCurrent(generation);
    } catch (err) {
      this.closeSessions();
      await this.closeListener(server);
      // Still under the lock, so this can only be our own socket file.
      await fs.rm(socketPath, { force: true }).catch(() => {});
      await removeDiscoveryFile(discoveryPath, this.token).catch(() => false);
      throw err;
    }
    // Published in the same tick as the last generation check, so a close()
    // from here on sees the listener it has to tear down.
    this.server = server;
  }

  private async teardown(server: net.Server | null): Promise<void> {
    this.closeSessions();
    if (!server) return;
    await this.closeListener(server);
    // Closing the listener already unlinked the socket file (libuv does it
    // for pipe servers). Under the lock, so a start publishing its own file
    // can't land between the token check and the removal.
    const { socketPath, discoveryPath } = this.options.location;
    await withHostSocketLock(socketPath, () =>
      removeDiscoveryFile(discoveryPath, this.token)
    ).catch(() => false);
  }

  private closeSessions(): void {
    for (const ctx of [...this.live.values()]) ctx.session.close("shutting-down");
    this.live.clear();
    for (const entry of this.resumable.values()) clearTimeout(entry.timer);
    this.resumable.clear();
  }

  private async closeListener(server: net.Server): Promise<void> {
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

  /**
   * Refuse a client on another build, telling it what the host's agents are
   * doing: it can't open a session to ask, and an update restarts this host.
   */
  private async rejectBuild(session: LinkSession, mismatch: HandshakeMismatch): Promise<void> {
    const workingAgents = await this.observeWorkingAgentsBounded();
    if (session.isClosed) return;
    session.reject({
      reason: mismatch.kind === "protocol" ? "protocol" : "version-mismatch",
      handshake: this.options.handshake,
      detail: describeMismatch(mismatch),
      ...(this.options.observeWorkingAgents ? { observed: { workingAgents } } : {}),
    });
  }

  private async observeWorkingAgentsBounded(): Promise<number | null> {
    const observe = this.options.observeWorkingAgents;
    if (!observe) return null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const value = await Promise.race([
        observe(),
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), OBSERVE_TIMEOUT_MS);
        }),
      ]);
      return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
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
      void this.rejectBuild(session, mismatch);
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
    if (!resumed && !this.makeRoomForSession()) {
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
   * Parked sessions count against the cap too, so a client that keeps
   * dropping can't grow the resumable set without bound. When the cap is hit
   * the oldest parked session is given up first; attached ones never are.
   */
  private makeRoomForSession(): boolean {
    const max = this.options.maxSessions ?? DEFAULT_MAX_SESSIONS;
    while (this.live.size + this.resumable.size >= max) {
      const oldest = this.resumable.values().next();
      if (oldest.done) return false;
      clearTimeout(oldest.value.timer);
      this.resumable.delete(oldest.value.sessionId);
      this.expire(oldest.value.sessionId, oldest.value.clientId);
    }
    return true;
  }

  /**
   * Keep a lost session resumable for the grace window. A client that said
   * GOODBYE, or broke the protocol, left on purpose and expires at once.
   */
  private park(ctx: HostSessionContext, close: LinkCloseInfo): void {
    if (this.live.get(ctx.sessionId) !== ctx) return;
    this.live.delete(ctx.sessionId);
    if (this.closing) return;
    const { sessionId } = ctx;
    const clientId = ctx.client.clientId;
    const deliberate = close.by === "remote" || close.reason.startsWith("protocol error");
    if (deliberate) {
      this.expire(sessionId, clientId);
      return;
    }
    const grace = this.options.resumeGraceMs ?? DEFAULT_RESUME_GRACE_MS;
    // The timer closes over ids only, never ctx, so the dropped session can be collected.
    const timer = setTimeout(() => {
      if (this.resumable.get(sessionId)?.timer !== timer) return;
      this.resumable.delete(sessionId);
      this.expire(sessionId, clientId);
    }, grace);
    timer.unref?.();
    this.resumable.set(sessionId, { sessionId, clientId, timer });
  }

  private expire(sessionId: string, clientId: string): void {
    const info = { sessionId, clientId };
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
 * process is serving, and never something that isn't a socket. Runs under the
 * socket lock; the file is also re-checked to be the one probed before it is
 * unlinked, for a process that doesn't take the lock.
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
  let current;
  try {
    current = await fs.lstat(socketPath);
  } catch {
    return;
  }
  if (current.dev !== stat.dev || current.ino !== stat.ino) {
    throw new HostServerError(`Another process is already listening on ${socketPath}`);
  }
  await fs.unlink(socketPath).catch((err: NodeJS.ErrnoException) => {
    if (err.code !== "ENOENT") throw err;
  });
}
