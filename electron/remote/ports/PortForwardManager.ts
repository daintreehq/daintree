import crypto from "node:crypto";
import type net from "node:net";
import type { RemoteUpstreamResolution } from "../../services/DevPreviewProxyService.js";
import type {
  ForwardPortPayload,
  HostListeningPort,
  PortForward,
} from "../../../shared/types/ipc/portForwards.js";
import { isValidRemoteHostId, type HostId } from "../../../shared/types/remoteHosts.js";
import { AppError } from "../../utils/errorTypes.js";
import { defaultSshSpawner, type SshSpawner } from "../client/sshTransport.js";
import type { LinkSession } from "../link/session.js";
import {
  HostListenerListSchema,
  PortLinkMethod,
  PreviewResolutionSchema,
  type PreviewResolution,
} from "./linkMethods.js";
import { listenLoopback, probeFreeLoopbackPort, type LoopbackListener } from "./localListener.js";
import { buildPortForwardArgs, runSshMuxCommand, type SshMuxTarget } from "./sshForward.js";
import { PortStreamMux } from "./streamForwarder.js";

/**
 * The Shell's port forwards: a local port per Host port, so this machine's
 * browser, dev-preview proxy and system browser reach servers running on a
 * Host as if they were local. A forward goes through the Host's SSH
 * ControlMaster when there is one (`ssh -O forward`), and otherwise through a
 * local listener whose connections ride the link as streams.
 *
 * One forward per (host, remote port), whatever asked for it. Forwards made
 * for a CLI's sign-in callback close after they go idle; the rest last until
 * stopped.
 */

export type PortForwardOrigin = PortForward["origin"];

export interface PortForwardManagerDeps {
  /** The host's live link session, or null when it has none. */
  sessionFor(hostId: HostId): LinkSession | null;
  /** Hosts whose sessions can answer right now, for preview lookups. */
  connectedHosts(): HostId[];
  isKnownHost(hostId: HostId): boolean;
  /** The ControlMaster to add forwards to, or null to use link streams. */
  sshMuxFor?(hostId: HostId): SshMuxTarget | null;
  spawn?: SshSpawner;
  onChange?(forwards: PortForward[]): void;
  now?(): number;
  /** How long a sign-in callback forward may sit idle before it closes. */
  oauthIdleMs?: number;
}

interface ActiveForward {
  info: PortForward;
  driver:
    | { kind: "stream"; listener: LoopbackListener; sockets: Set<net.Socket> }
    | { kind: "ssh"; mux: SshMuxTarget };
  idleTimer: ReturnType<typeof setTimeout> | null;
}

const ORIGINS: ReadonlySet<PortForwardOrigin> = new Set([
  "dev-preview",
  "oauth-callback",
  "manual",
  "detected",
]);
const MAX_FORWARDS = 128;
const MAX_LABEL_LENGTH = 128;
const DEFAULT_OAUTH_IDLE_MS = 10 * 60 * 1000;
const PREVIEW_CACHE_MS = 2_000;
const PREVIEW_LOOKUP_TIMEOUT_MS = 5_000;

function keyOf(hostId: HostId, remotePort: number): string {
  return `${hostId}\u0000${remotePort}`;
}

function invalid(message: string): AppError {
  return new AppError({ code: "VALIDATION", message });
}

function validatePayload(payload: ForwardPortPayload): Required<
  Pick<ForwardPortPayload, "hostId" | "remotePort">
> & {
  origin: PortForwardOrigin;
  label: string | null;
} {
  if (!payload || typeof payload !== "object") throw invalid("Invalid forward request");
  const { hostId, remotePort, origin, label } = payload;
  if (typeof hostId !== "string" || !isValidRemoteHostId(hostId)) {
    throw invalid("Ports are forwarded from a remote host");
  }
  if (!Number.isInteger(remotePort) || remotePort < 1 || remotePort > 65535) {
    throw invalid(`Invalid port: ${String(remotePort)}`);
  }
  if (origin !== undefined && !ORIGINS.has(origin)) throw invalid("Invalid forward origin");
  if (label !== undefined && (typeof label !== "string" || label.length > MAX_LABEL_LENGTH)) {
    throw invalid("Invalid forward label");
  }
  return {
    hostId,
    remotePort,
    origin: origin ?? "manual",
    label: label?.trim() ? label.trim() : null,
  };
}

export class PortForwardManager {
  private readonly forwards = new Map<string, ActiveForward>();
  private readonly pending = new Map<string, Promise<PortForward>>();
  private readonly muxes = new WeakMap<LinkSession, PortStreamMux>();
  private readonly previewCache = new Map<
    string,
    { at: number; result: Promise<RemoteUpstreamResolution | null> }
  >();
  /** Which forward each preview subdomain last resolved to, so a moved dev server frees the old one. */
  private readonly previewForwards = new Map<string, string>();
  /** Latest lookup per subdomain; an older lookup that finishes later changes nothing. */
  private readonly previewGenerations = new Map<string, number>();
  private previewGeneration = 0;
  private readonly now: () => number;
  private readonly spawn: SshSpawner;
  private disposed = false;

  constructor(private readonly deps: PortForwardManagerDeps) {
    this.now = deps.now ?? Date.now;
    this.spawn = deps.spawn ?? defaultSshSpawner();
  }

  list(): PortForward[] {
    return [...this.forwards.values()]
      .map((forward) => ({ ...forward.info }))
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  /** Local ports forwarded to `hostId`: what counts as that host's localhost here. */
  localPortsFor(hostId: HostId): Set<number> {
    const ports = new Set<number>();
    for (const forward of this.forwards.values()) {
      if (forward.info.hostId === hostId) ports.add(forward.info.localPort);
    }
    return ports;
  }

  async forward(payload: ForwardPortPayload): Promise<PortForward> {
    const request = validatePayload(payload);
    if (!this.deps.isKnownHost(request.hostId)) {
      throw new AppError({
        code: "NOT_FOUND",
        message: `No host with id "${request.hostId}"`,
        userMessage: "That host isn't in the host list.",
      });
    }
    const key = keyOf(request.hostId, request.remotePort);
    const existing = this.forwards.get(key);
    if (existing) return this.reuse(existing, request.origin, request.label);
    const inFlight = this.pending.get(key);
    if (inFlight) {
      const info = await inFlight;
      const created = this.forwards.get(key);
      return created ? this.reuse(created, request.origin, request.label) : info;
    }
    if (this.forwards.size >= MAX_FORWARDS) {
      throw new AppError({
        code: "RATE_LIMITED",
        message: "Too many forwarded ports",
        userMessage: "Stop a forwarded port before adding another.",
      });
    }
    const creating = this.create(key, request).finally(() => this.pending.delete(key));
    this.pending.set(key, creating);
    return creating;
  }

  async stop(forwardId: string): Promise<void> {
    if (typeof forwardId !== "string") throw invalid("Invalid forward id");
    const entry = [...this.forwards.entries()].find(([, f]) => f.info.forwardId === forwardId);
    if (!entry) return;
    const [key, forward] = entry;
    this.forwards.delete(key);
    if (!(await this.teardown(forward))) {
      // ssh still holds the port: keep it listed so it can be stopped again.
      this.forwards.set(key, forward);
      throw new AppError({
        code: "INTERNAL",
        message: `ssh refused to cancel the forward of port ${forward.info.remotePort}`,
        userMessage: "Couldn't stop forwarding this port. Try again.",
      });
    }
    for (const [subdomain, id] of this.previewForwards) {
      if (id === forwardId) this.previewForwards.delete(subdomain);
    }
    this.previewCache.clear();
    this.emit();
  }

  async listHostPorts(hostId: HostId): Promise<HostListeningPort[]> {
    if (typeof hostId !== "string" || !isValidRemoteHostId(hostId)) {
      throw invalid("Ports are listed for a remote host");
    }
    const session = this.requireSession(hostId);
    const answer = await session.call(PortLinkMethod.LIST_LISTENERS, null);
    const parsed = HostListenerListSchema.safeParse(answer);
    if (!parsed.success) {
      throw new AppError({ code: "INTERNAL", message: `Host ${hostId} sent an invalid port list` });
    }
    return parsed.data;
  }

  /**
   * A dev-preview subdomain this machine doesn't serve, looked up on the
   * connected hosts. When one runs it, the dev server's actual port is
   * forwarded and the preview proxy is given the local end.
   */
  resolvePreview(subdomain: string): Promise<RemoteUpstreamResolution | null> | null {
    const hosts = this.deps.connectedHosts();
    if (hosts.length === 0) return null;
    const cached = this.previewCache.get(subdomain);
    if (cached && this.now() - cached.at < PREVIEW_CACHE_MS) return cached.result;
    const generation = ++this.previewGeneration;
    this.previewGenerations.set(subdomain, generation);
    const result = this.lookupPreview(subdomain, hosts, generation);
    this.previewCache.set(subdomain, { at: this.now(), result });
    result.catch(() => this.previewCache.delete(subdomain));
    return result;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    const all = [...this.forwards.values()];
    this.forwards.clear();
    this.previewForwards.clear();
    this.previewCache.clear();
    await Promise.all(all.map((forward) => this.teardown(forward)));
  }

  private reuse(
    forward: ActiveForward,
    origin: PortForwardOrigin,
    label: string | null
  ): PortForward {
    let changed = false;
    // A lasting reason to forward outranks a sign-in's temporary one.
    if (forward.info.origin === "oauth-callback" && origin !== "oauth-callback") {
      forward.info.origin = origin;
      changed = true;
    }
    if (label && !forward.info.label) {
      forward.info.label = label;
      changed = true;
    }
    this.touch(forward);
    if (changed) this.emit();
    return { ...forward.info };
  }

  private async create(
    key: string,
    request: { hostId: HostId; remotePort: number; origin: PortForwardOrigin; label: string | null }
  ): Promise<PortForward> {
    // Fail before binding anything when the host can't carry the forward.
    const session = this.requireSession(request.hostId);
    const info: PortForward = {
      forwardId: crypto.randomUUID(),
      hostId: request.hostId,
      remotePort: request.remotePort,
      localPort: 0,
      origin: request.origin,
      label: request.label,
      createdAt: this.now(),
    };
    const forward =
      (await this.createSshForward(info)) ?? (await this.createStreamForward(info, session));
    if (this.disposed) {
      await this.teardown(forward);
      throw new AppError({ code: "CANCELLED", message: "Port forwarding stopped" });
    }
    this.forwards.set(key, forward);
    this.touch(forward);
    this.emit();
    return { ...forward.info };
  }

  private async createSshForward(info: PortForward): Promise<ActiveForward | null> {
    const mux = this.deps.sshMuxFor?.(info.hostId) ?? null;
    if (!mux) return null;
    let localPort: number;
    try {
      localPort = await probeFreeLoopbackPort(info.remotePort);
    } catch {
      return null;
    }
    const args = buildPortForwardArgs(mux, localPort, info.remotePort, "forward");
    if (!(await runSshMuxCommand(this.spawn, args))) return null;
    return {
      info: { ...info, localPort },
      driver: { kind: "ssh", mux },
      idleTimer: null,
    };
  }

  private async createStreamForward(
    info: PortForward,
    session: LinkSession
  ): Promise<ActiveForward> {
    const sockets = new Set<net.Socket>();
    let forward: ActiveForward | null = null;
    const listener = await listenLoopback(info.remotePort, (socket) => {
      if (!forward) {
        socket.destroy();
        return;
      }
      this.acceptLocal(forward, socket);
    });
    forward = {
      info: { ...info, localPort: listener.port },
      driver: { kind: "stream", listener, sockets },
      idleTimer: null,
    };
    // Fail fast if the session died while binding; later connections use whatever session is live.
    if (session.isClosed && !this.deps.sessionFor(info.hostId)) {
      await this.teardown(forward);
      throw this.disconnected(info.hostId);
    }
    return forward;
  }

  private acceptLocal(forward: ActiveForward, socket: net.Socket): void {
    if (forward.driver.kind !== "stream") return;
    const { sockets } = forward.driver;
    const session = this.deps.sessionFor(forward.info.hostId);
    if (!session || !session.isOpen) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.once("close", () => {
      sockets.delete(socket);
      this.touch(forward);
    });
    this.muxFor(session)
      .openStream(socket, forward.info.remotePort, () => this.touch(forward))
      .catch(() => {
        // openStream already destroyed the socket; the browser sees a reset connection.
      });
  }

  private muxFor(session: LinkSession): PortStreamMux {
    let mux = this.muxes.get(session);
    if (!mux || mux.isDisposed) {
      mux = new PortStreamMux(session);
      this.muxes.set(session, mux);
    }
    return mux;
  }

  private touch(forward: ActiveForward): void {
    if (forward.idleTimer) clearTimeout(forward.idleTimer);
    forward.idleTimer = null;
    if (forward.info.origin !== "oauth-callback" || this.disposed) return;
    const idleMs = this.deps.oauthIdleMs ?? DEFAULT_OAUTH_IDLE_MS;
    forward.idleTimer = setTimeout(() => {
      forward.idleTimer = null;
      if (forward.driver.kind === "stream" && forward.driver.sockets.size > 0) {
        this.touch(forward);
        return;
      }
      this.stop(forward.info.forwardId).catch(() => {});
    }, idleMs);
    forward.idleTimer.unref?.();
  }

  /** False only when ssh refused to cancel, so the local port is still forwarded. */
  private async teardown(forward: ActiveForward): Promise<boolean> {
    if (forward.idleTimer) clearTimeout(forward.idleTimer);
    forward.idleTimer = null;
    if (forward.driver.kind === "stream") {
      for (const socket of forward.driver.sockets) socket.destroy();
      forward.driver.sockets.clear();
      await forward.driver.listener.close();
      return true;
    }
    const args = buildPortForwardArgs(
      forward.driver.mux,
      forward.info.localPort,
      forward.info.remotePort,
      "cancel"
    );
    return runSshMuxCommand(this.spawn, args);
  }

  private async lookupPreview(
    subdomain: string,
    hosts: HostId[],
    generation: number
  ): Promise<RemoteUpstreamResolution | null> {
    const answers = await Promise.all(
      hosts.map(async (hostId) => {
        const session = this.deps.sessionFor(hostId);
        if (!session) return null;
        try {
          const answer = await session.call(
            PortLinkMethod.RESOLVE_PREVIEW,
            { subdomain },
            { timeoutMs: PREVIEW_LOOKUP_TIMEOUT_MS }
          );
          const parsed = PreviewResolutionSchema.safeParse(answer);
          return parsed.success ? { hostId, resolution: parsed.data } : null;
        } catch {
          return null;
        }
      })
    );
    const running = answers.find(
      (
        answer
      ): answer is { hostId: HostId; resolution: Extract<PreviewResolution, { kind: "ok" }> } =>
        answer?.resolution.kind === "ok"
    );
    const current = () => this.previewGenerations.get(subdomain) === generation;
    if (running) {
      const forward = await this.forward({
        hostId: running.hostId,
        remotePort: running.resolution.port,
        origin: "dev-preview",
        label: "Dev preview",
      });
      if (current()) await this.notePreviewForward(subdomain, forward.forwardId);
      return {
        kind: "ok",
        port: forward.localPort,
        isHttps: running.resolution.isHttps,
        advertisedPort: running.resolution.port,
      };
    }
    // The dev server is gone: its forward would otherwise reach whatever takes the port next.
    if (current()) await this.notePreviewForward(subdomain, null);
    const stopped = answers.find((answer) => answer?.resolution.kind === "not-running");
    return stopped ? stopped.resolution : null;
  }

  private async notePreviewForward(subdomain: string, forwardId: string | null): Promise<void> {
    const previous = this.previewForwards.get(subdomain);
    if (forwardId) this.previewForwards.set(subdomain, forwardId);
    else this.previewForwards.delete(subdomain);
    if (!previous || previous === forwardId) return;
    const stillUsed = [...this.previewForwards.values()].includes(previous);
    const old = [...this.forwards.values()].find((f) => f.info.forwardId === previous);
    if (!stillUsed && old?.info.origin === "dev-preview") {
      await this.stop(previous).catch(() => {});
    }
  }

  private requireSession(hostId: HostId): LinkSession {
    const session = this.deps.sessionFor(hostId);
    if (!session || !session.isOpen) throw this.disconnected(hostId);
    return session;
  }

  private disconnected(hostId: HostId): AppError {
    return new AppError({
      code: "HOST_DISCONNECTED",
      message: `Host ${hostId} is not connected`,
      userMessage: "Couldn't reach this host. Open a window on it and try again.",
    });
  }

  private emit(): void {
    if (this.disposed) return;
    try {
      this.deps.onChange?.(this.list());
    } catch {
      // A broken subscriber must not undo a forward.
    }
  }
}
