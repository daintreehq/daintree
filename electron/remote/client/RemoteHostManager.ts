import type { IpcEnvelope } from "../../../shared/types/ipc/errors.js";
import type {
  HostConnectionState,
  HostDescriptor,
  HostHandshakeInfo,
  HostId,
} from "../../../shared/types/remoteHosts.js";
import { getChannelLocality } from "../../ipc/channelLocality.js";
import { appErrorEnvelope, hostDisconnectedEnvelope } from "../link/envelopes.js";
import { Lane } from "../link/frames.js";
import {
  ControlKind,
  EventKind,
  type EventMessage,
  type LinkClientInfo,
} from "../link/messages.js";
import type { LinkSession, LinkSessionOptions } from "../link/session.js";
import {
  EndpointResyncPayloadSchema,
  HostInfoSchema,
  LinkMethod,
  ProjectDescriptionSchema,
  type EndpointResyncReason,
  type HostInfo,
  type ProjectDescription,
} from "../host/linkMethods.js";
import type { HostRegistry } from "./HostRegistry.js";
import { LinkClient, type LinkClientOptions, type LinkClientState } from "./LinkClient.js";
import type { LinkTransport } from "./transport.js";

/**
 * Where events from a host land: the local views bound to its endpoints. The
 * connection names views by `WebContents` id and never holds the objects.
 */
export interface ViewSink {
  /** Deliver to one local view; false when it is gone. */
  send(webContentsId: number, channel: string, args: unknown[]): boolean;
  /** Call `onGone` once when the view is destroyed; returns an unsubscribe. */
  watch(webContentsId: number, onGone: () => void): () => void;
  /** The host asked this view to repaint from a snapshot. */
  resync(webContentsId: number, hostId: HostId, reason: EndpointResyncReason): void;
}

interface OpenEndpoint {
  endpointId: string;
  projectId: string | null;
}

/**
 * One host's link, as the Shell sees it: the {@link LinkClient} that keeps it
 * up, the endpoints this Shell has opened on the current session (one per
 * local view that has called through it), and routing of the host's events
 * back to those views.
 */
export class HostConnection {
  readonly hostId: HostId;
  private readonly link: LinkClient;
  private session: LinkSession | null = null;
  private readonly endpoints = new Map<number, OpenEndpoint>();
  private readonly viewsByEndpoint = new Map<string, number>();
  private readonly watched = new Map<number, () => void>();
  private info: HostInfo | null = null;
  private started = false;

  constructor(
    private readonly descriptor: () => HostDescriptor | null,
    options: LinkClientOptions & { hostId: HostId },
    private readonly views: ViewSink
  ) {
    this.hostId = options.hostId;
    this.link = new LinkClient(options);
    this.link.onSession(({ session, resumed }) => this.attach(session, resumed));
  }

  get isStarted(): boolean {
    return this.started;
  }

  get linkState(): LinkClientState {
    return this.link.getState();
  }

  get lastSeen(): number | null {
    return this.link.lastSeen;
  }

  get hostInfo(): HostInfo | null {
    return this.info;
  }

  onStateChange(listener: (state: LinkClientState) => void): () => void {
    return this.link.onStateChange(listener);
  }

  start(): void {
    this.started = true;
    this.link.start();
  }

  retryNow(): void {
    this.link.retryNow();
  }

  async stop(): Promise<void> {
    this.started = false;
    await this.link.stop();
    this.session = null;
    this.forgetEndpoints();
    // A discarded connection must not stay reachable through live views' listeners.
    for (const unwatch of this.watched.values()) unwatch();
    this.watched.clear();
  }

  state(): HostConnectionState {
    const state = this.link.getState();
    switch (state.status) {
      case "disconnected":
        return { status: "disconnected" };
      case "connecting":
        return { status: "connecting", attempt: state.attempt };
      case "connected":
        return { status: "connected", rttMs: state.rttMs, handshake: state.handshake };
      case "unreachable":
        return {
          status: "unreachable",
          lastSeenAt: state.lastSeenAt ?? this.descriptor()?.lastSeenAt ?? null,
          detail: state.detail,
        };
      case "version-mismatch":
        return { status: "version-mismatch", mismatch: state.mismatch, remote: state.remote };
    }
  }

  /**
   * Why a call can't go to this host right now, as the envelope it resolves
   * to, or null when it can. A build mismatch is its own typed state: nothing
   * is routed to such a host until the builds agree.
   */
  unavailableEnvelope(): IpcEnvelope | null {
    const state = this.link.getState();
    if (state.status === "version-mismatch") {
      return appErrorEnvelope(
        "HOST_VERSION_MISMATCH",
        `Host ${this.hostId} runs a different build`,
        "This host runs a different Daintree build. Update it to connect."
      );
    }
    const session = this.session;
    if (state.status !== "connected" || !session || !session.isOpen) {
      return hostDisconnectedEnvelope(`host ${this.hostId} is ${state.status}`);
    }
    return null;
  }

  invoke(
    webContentsId: number,
    projectId: string | null,
    channel: string,
    args: unknown[]
  ): Promise<IpcEnvelope> {
    const blocked = this.unavailableEnvelope();
    if (blocked) return Promise.resolve(blocked);
    const session = this.session!;
    const endpointId = this.ensureEndpoint(session, webContentsId, projectId);
    if (!endpointId) {
      return Promise.resolve(hostDisconnectedEnvelope("the endpoint could not be opened"));
    }
    return session.invoke(endpointId, channel, args);
  }

  send(webContentsId: number, projectId: string | null, channel: string, args: unknown[]): void {
    if (this.unavailableEnvelope()) return;
    const session = this.session!;
    const endpointId = this.ensureEndpoint(session, webContentsId, projectId);
    if (!endpointId) return;
    if (session.send(endpointId, channel, args) === "refused") {
      console.warn(`[RemoteHosts] Dropped send on ${channel}: link queue is full`);
    }
  }

  /** The host's own path for a project, before a view for it is opened. */
  async describeProject(projectId: string): Promise<ProjectDescription | null> {
    const session = this.session;
    if (!session || !session.isOpen) return null;
    const answer = await session.call(LinkMethod.DESCRIBE_PROJECT, { projectId });
    const parsed = ProjectDescriptionSchema.safeParse(answer);
    return parsed.success ? parsed.data : null;
  }

  /** Local views that have an endpoint on the host right now. */
  boundViews(): number[] {
    return [...this.endpoints.keys()];
  }

  private attach(session: LinkSession, resumed: boolean): void {
    // A fresh session means the host dropped every endpoint of the old one.
    if (!resumed) this.forgetEndpoints();
    this.session = session;
    session.on(Lane.EVENTS, EventKind.EVENT, (body) => this.deliver(body));
    session.registerCallHandler(
      LinkMethod.ENDPOINT_RESYNC,
      EndpointResyncPayloadSchema,
      ({ endpointIds, reason }) => {
        for (const endpointId of endpointIds) {
          const webContentsId = this.viewsByEndpoint.get(endpointId);
          if (webContentsId !== undefined) this.views.resync(webContentsId, this.hostId, reason);
        }
        return null;
      }
    );
    session.onClose(() => {
      if (this.session === session) this.session = null;
    });
    void session.call(LinkMethod.HOST_INFO, null).then(
      (answer) => {
        const parsed = HostInfoSchema.safeParse(answer);
        if (parsed.success && this.session === session) this.info = parsed.data;
      },
      () => {}
    );
  }

  private ensureEndpoint(
    session: LinkSession,
    webContentsId: number,
    projectId: string | null
  ): string | null {
    const open = this.endpoints.get(webContentsId);
    if (open) {
      if (open.projectId !== projectId) {
        const result = session.post({
          lane: Lane.CONTROL,
          kind: ControlKind.ENDPOINT_REBIND,
          body: { endpointId: open.endpointId, projectId },
        });
        if (result === "refused") return null;
        open.projectId = projectId;
      }
      return open.endpointId;
    }
    const endpointId = `view-${webContentsId}`;
    const result = session.post({
      lane: Lane.CONTROL,
      kind: ControlKind.ENDPOINT_OPEN,
      body: { endpointId, projectId },
    });
    if (result === "refused") return null;
    this.endpoints.set(webContentsId, { endpointId, projectId });
    this.viewsByEndpoint.set(endpointId, webContentsId);
    if (!this.watched.has(webContentsId)) {
      this.watched.set(
        webContentsId,
        this.views.watch(webContentsId, () => this.closeEndpoint(webContentsId))
      );
    }
    return endpointId;
  }

  private closeEndpoint(webContentsId: number): void {
    this.watched.get(webContentsId)?.();
    this.watched.delete(webContentsId);
    const open = this.endpoints.get(webContentsId);
    if (!open) return;
    this.endpoints.delete(webContentsId);
    this.viewsByEndpoint.delete(open.endpointId);
    const session = this.session;
    if (session?.isOpen) {
      session.post({
        lane: Lane.CONTROL,
        kind: ControlKind.ENDPOINT_CLOSE,
        body: { endpointId: open.endpointId },
      });
    }
  }

  private forgetEndpoints(): void {
    this.endpoints.clear();
    this.viewsByEndpoint.clear();
  }

  /**
   * Host events go only to the views bound to the endpoint they name (or, for
   * a session-wide event, to every view bound to this host). Channels a Shell
   * answers for itself are never taken from a host.
   */
  private deliver(event: EventMessage): void {
    const locality = getChannelLocality(event.channel);
    if (locality !== "host" && locality !== "hybrid") return;
    if (event.endpointId === null) {
      for (const webContentsId of this.endpoints.keys()) {
        this.views.send(webContentsId, event.channel, event.args);
      }
      return;
    }
    const webContentsId = this.viewsByEndpoint.get(event.endpointId);
    if (webContentsId !== undefined) this.views.send(webContentsId, event.channel, event.args);
  }
}

export interface RemoteHostManagerOptions {
  registry: HostRegistry;
  createTransport: (descriptor: HostDescriptor) => LinkTransport;
  handshake: () => HostHandshakeInfo;
  client: LinkClientInfo;
  views: ViewSink;
  session?: Omit<LinkSessionOptions, "role">;
  backoff?: LinkClientOptions["backoff"];
  now?: () => number;
}

/**
 * One {@link HostConnection} per host the user connected to. Connections are
 * created on demand, so nothing is dialled for a host nobody opened.
 */
export class RemoteHostManager {
  private readonly connections = new Map<HostId, HostConnection>();
  private readonly listeners = new Set<(hostId: HostId, state: HostConnectionState) => void>();
  private readonly now: () => number;

  constructor(private readonly options: RemoteHostManagerOptions) {
    this.now = options.now ?? Date.now;
  }

  get(hostId: HostId): HostConnection | undefined {
    return this.connections.get(hostId);
  }

  connectionState(hostId: HostId): HostConnectionState {
    return this.connections.get(hostId)?.state() ?? { status: "disconnected" };
  }

  onStateChange(listener: (hostId: HostId, state: HostConnectionState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Start (or nudge) the host's link. Resolves once the attempt is under way, not connected. */
  connect(hostId: HostId): HostConnection {
    const descriptor = this.options.registry.require(hostId);
    let connection = this.connections.get(hostId);
    if (!connection) {
      connection = new HostConnection(
        () => this.options.registry.get(hostId),
        {
          hostId,
          transport: this.options.createTransport(descriptor),
          handshake: this.options.handshake(),
          client: this.options.client,
          session: this.options.session,
          backoff: this.options.backoff,
          now: this.options.now,
        },
        this.options.views
      );
      this.connections.set(hostId, connection);
      const conn = connection;
      let wasConnected = false;
      conn.onStateChange((state) => {
        if (this.connections.get(hostId) !== conn) return;
        if (state.status === "connected" && !wasConnected) {
          wasConnected = true;
          this.options.registry.recordObservation(hostId, {
            lastSeenAt: this.now(),
            lastHandshake: state.handshake,
            platform: state.handshake.platform,
            arch: state.handshake.arch,
          });
        } else if (state.status !== "connected" && wasConnected) {
          wasConnected = false;
          const lastSeenAt = conn.lastSeen;
          if (lastSeenAt !== null) this.options.registry.recordObservation(hostId, { lastSeenAt });
        }
        if (state.status === "version-mismatch") {
          this.options.registry.recordObservation(hostId, { lastHandshake: state.remote });
        }
        this.emit(hostId, conn.state());
      });
    }
    if (connection.isStarted) connection.retryNow();
    else connection.start();
    return connection;
  }

  async disconnect(hostId: HostId): Promise<void> {
    const connection = this.connections.get(hostId);
    if (!connection) return;
    this.connections.delete(hostId);
    if (connection.linkState.status === "connected") {
      this.options.registry.recordObservation(hostId, { lastSeenAt: this.now() });
    }
    await connection.stop();
    this.emit(hostId, { status: "disconnected" });
  }

  async disposeAll(): Promise<void> {
    await Promise.all([...this.connections.keys()].map((hostId) => this.disconnect(hostId)));
  }

  private emit(hostId: HostId, state: HostConnectionState): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(hostId, state);
      } catch (error) {
        console.error("[RemoteHostManager] state listener failed:", error);
      }
    }
  }
}
