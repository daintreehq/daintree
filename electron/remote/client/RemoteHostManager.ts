import type { IpcEnvelope } from "../../../shared/types/ipc/errors.js";
import type {
  HostConnectionState,
  HostDescriptor,
  HostHandshakeInfo,
  HostId,
} from "../../../shared/types/remoteHosts.js";
import { AppError } from "../../utils/errorTypes.js";
import { acceptHostPush } from "../hybrid/eventsPush.js";
import { appErrorEnvelope, hostDisconnectedEnvelope } from "../link/envelopes.js";
import { Lane } from "../link/frames.js";
import {
  ControlKind,
  EventKind,
  type EventMessage,
  type LinkClientInfo,
  type ReverseRequestMessage,
} from "../link/messages.js";
import type { LinkSession, LinkSessionOptions } from "../link/session.js";
import {
  EndpointResyncPayloadSchema,
  HostInfoSchema,
  HostProjectListSchema,
  LinkMethod,
  ProjectDescriptionSchema,
  type EndpointResyncReason,
  type HostInfo,
  type HostProjectList,
  type ProjectDescription,
} from "../host/linkMethods.js";
import type { HostRegistry } from "./HostRegistry.js";
import {
  ResyncCoordinator,
  type SessionAttachedInfo,
  type ViewResyncReason,
} from "./reconnect/ResyncCoordinator.js";
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
  /** The view must refetch its host state: the host asked, or the link came back fresh. */
  resync(
    webContentsId: number,
    hostId: HostId,
    reason: EndpointResyncReason | ViewResyncReason
  ): void;
  /**
   * The host the view is authoritatively bound to (its project key, else its
   * window's binding), or null for a local view. When present, a connection
   * delivers nothing to, and carries no streams for, a view bound elsewhere.
   */
  hostOf?(webContentsId: number): HostId | null;
}

interface OpenEndpoint {
  endpointId: string;
  projectId: string | null;
}

/** A local view's endpoint is live on a session: newly opened, or carried over by a resume. */
export interface EndpointSessionInfo {
  session: LinkSession;
  webContentsId: number;
  endpointId: string;
}

export type EndpointOpenedListener = (info: EndpointSessionInfo) => void;

/** A local view's endpoint is gone: the view went away, moved host, or the connection stopped. */
export interface EndpointClosedInfo {
  webContentsId: number;
  endpointId: string;
}

export type EndpointClosedListener = (info: EndpointClosedInfo) => void;

export type SessionAttachedListener = (info: SessionAttachedInfo) => void;

/** A host asked one of this Shell's views something (MCP dispatch, a notification to show). */
export interface ViewReverseRequest {
  hostId: HostId;
  webContentsId: number;
  method: string;
  payload: unknown;
}

/** Answers a {@link ViewReverseRequest}; a rejection goes back to the host as its error. */
export type ReverseRequestAnswerer = (request: ViewReverseRequest) => Promise<unknown>;

/** How {@link HostConnection.whenReady} settled. */
export type HostReadiness = "ready" | "version-mismatch" | "timeout" | "stopped";

function notifyEndpointOpened(
  listeners: Iterable<EndpointOpenedListener>,
  info: EndpointSessionInfo
): void {
  for (const listener of [...listeners]) {
    try {
      listener(info);
    } catch (error) {
      console.error("[RemoteHostManager] endpoint-opened listener failed:", error);
    }
  }
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
  private readonly openedListeners = new Set<EndpointOpenedListener>();
  private readonly closedListeners = new Set<EndpointClosedListener>();
  private readonly attachedListeners = new Set<SessionAttachedListener>();
  private hadSession = false;
  /**
   * Endpoints closed while the link was down. The host keeps a dropped
   * session's endpoints for a resume, so these are closed there once it
   * resumes; without that every disconnect-close-resume cycle would leave one
   * behind and wear down the host's per-session endpoint allowance.
   */
  private readonly pendingCloses = new Set<string>();
  private readonly readyWaiters = new Set<() => void>();
  private info: HostInfo | null = null;
  private started = false;

  constructor(
    private readonly descriptor: () => HostDescriptor | null,
    options: LinkClientOptions & { hostId: HostId },
    private readonly views: ViewSink,
    private readonly answerReverse: ReverseRequestAnswerer | null = null
  ) {
    this.hostId = options.hostId;
    this.link = new LinkClient(options);
    this.link.onSession(({ session, resumed }) => this.attach(session, resumed));
    this.link.onStateChange(() => this.checkReady());
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

  /**
   * The host's open link session, or null while it has none. Session-level
   * callers (port forwards, project switches) use it when no local view has
   * an endpoint on the host.
   */
  get currentSession(): LinkSession | null {
    return this.session?.isOpen ? this.session : null;
  }

  onStateChange(listener: (state: LinkClientState) => void): () => void {
    return this.link.onStateChange(listener);
  }

  /**
   * Seam for per-view streams (terminals, the worktree port) that ride the
   * link beside invokes: told whenever a view's endpoint is on a session.
   */
  onEndpointOpened(listener: EndpointOpenedListener): () => void {
    this.openedListeners.add(listener);
    return () => this.openedListeners.delete(listener);
  }

  /** Told whenever one of this connection's endpoints for a view is discarded. */
  onEndpointClosed(listener: EndpointClosedListener): () => void {
    this.closedListeners.add(listener);
    return () => this.closedListeners.delete(listener);
  }

  /**
   * Told once per reconnect, after endpoints are back on the new session and
   * their streams have moved. Not told for the connection's first session.
   */
  onSessionAttached(listener: SessionAttachedListener): () => void {
    this.attachedListeners.add(listener);
    return () => this.attachedListeners.delete(listener);
  }

  start(): void {
    this.started = true;
    this.link.start();
  }

  /**
   * Settle once calls can go to the host, the host turns out to run another
   * build, the connection is stopped, or `timeoutMs` passes. Never rejects,
   * so a caller maps each outcome to its own error.
   */
  whenReady(timeoutMs: number): Promise<HostReadiness> {
    const settledNow = this.readiness();
    if (settledNow) return Promise.resolve(settledNow);
    return new Promise((resolve) => {
      const check = () => {
        const outcome = this.readiness();
        if (outcome) finish(outcome);
      };
      const finish = (outcome: HostReadiness) => {
        clearTimeout(timer);
        this.readyWaiters.delete(check);
        resolve(outcome);
      };
      const timer = setTimeout(() => finish("timeout"), timeoutMs);
      this.readyWaiters.add(check);
    });
  }

  private readiness(): HostReadiness | null {
    if (!this.started) return "stopped";
    if (this.link.getState().status === "version-mismatch") return "version-mismatch";
    return this.unavailableEnvelope() === null ? "ready" : null;
  }

  private checkReady(): void {
    for (const check of [...this.readyWaiters]) check();
  }

  retryNow(): void {
    this.link.retryNow();
  }

  async stop(): Promise<void> {
    this.started = false;
    this.checkReady();
    await this.link.stop();
    this.session = null;
    const discarded = [...this.endpoints];
    this.forgetEndpoints();
    this.pendingCloses.clear();
    for (const [webContentsId, open] of discarded) {
      this.notifyClosed({ webContentsId, endpointId: open.endpointId });
    }
    // A discarded connection must not stay reachable through live views' listeners.
    for (const unwatch of this.watched.values()) unwatch();
    this.watched.clear();
    this.openedListeners.clear();
    this.closedListeners.clear();
    this.attachedListeners.clear();
    this.hadSession = false;
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

  /**
   * Every project the host has, asked at session level so no view has to be
   * bound to the host to list it. Rejects while the host can't be reached.
   */
  async listProjects(): Promise<HostProjectList> {
    const session = this.session;
    if (this.unavailableEnvelope() || !session) {
      throw new AppError({
        code: "HOST_DISCONNECTED",
        message: `Host ${this.hostId} is not connected`,
        userMessage: "Couldn't reach this host. Check that it is on and try again.",
      });
    }
    const answer = await session.call(LinkMethod.LIST_PROJECTS, null);
    const parsed = HostProjectListSchema.safeParse(answer);
    if (!parsed.success) {
      throw new AppError({
        code: "INTERNAL",
        message: `Host ${this.hostId} sent an invalid project list`,
      });
    }
    return parsed.data;
  }

  /** Local views that have an endpoint on the host right now. */
  boundViews(): number[] {
    return [...this.endpoints.keys()];
  }

  /** The view now belongs to another host (or this machine): close its endpoint here. */
  retireView(webContentsId: number): void {
    this.closeEndpoint(webContentsId);
  }

  /** Whether the view still belongs to this host, by its authoritative binding. */
  private isBoundHere(webContentsId: number): boolean {
    return this.views.hostOf ? this.views.hostOf(webContentsId) === this.hostId : true;
  }

  private attach(session: LinkSession, resumed: boolean): void {
    // A fresh session means the host dropped every endpoint of the old one,
    // including any still waiting to be closed.
    const reopen = resumed ? [] : [...this.endpoints];
    if (!resumed) {
      this.forgetEndpoints();
      this.pendingCloses.clear();
    }
    this.session = session;
    session.on(Lane.EVENTS, EventKind.EVENT, (body) => this.deliver(body));
    // Every session, fresh or resumed: a resume is a new LinkSession, and one
    // without a handler answers the host UNSUPPORTED.
    session.setReverseRequestHandler((message) => this.reverseRequest(message));
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
      this.checkReady();
    });
    this.flushPendingCloses(session);
    // A resume keeps the host's endpoints, so the views' streams move to the new session.
    for (const [webContentsId, open] of [...this.endpoints]) {
      if (!this.isBoundHere(webContentsId)) {
        this.closeEndpoint(webContentsId);
        continue;
      }
      notifyEndpointOpened(this.openedListeners, {
        session,
        webContentsId,
        endpointId: open.endpointId,
      });
    }
    // A fresh session reopens the endpoints of views still bound here, so
    // their terminal and worktree streams come back without waiting for the
    // view's next call; the rest are discarded.
    const reopened: number[] = [];
    for (const [webContentsId, open] of reopen) {
      const endpointId = this.isBoundHere(webContentsId)
        ? this.ensureEndpoint(session, webContentsId, open.projectId)
        : null;
      if (endpointId === null) {
        this.unwatch(webContentsId);
        this.notifyClosed({ webContentsId, endpointId: open.endpointId });
      } else {
        reopened.push(webContentsId);
      }
    }
    const isReconnect = this.hadSession;
    this.hadSession = true;
    if (isReconnect) this.notifyAttached({ resumed, reopened });
    this.checkReady();
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
    this.pendingCloses.delete(endpointId);
    this.endpoints.set(webContentsId, { endpointId, projectId });
    this.viewsByEndpoint.set(endpointId, webContentsId);
    if (!this.watched.has(webContentsId)) {
      this.watched.set(
        webContentsId,
        this.views.watch(webContentsId, () => this.closeEndpoint(webContentsId))
      );
    }
    notifyEndpointOpened(this.openedListeners, { session, webContentsId, endpointId });
    return endpointId;
  }

  private closeEndpoint(webContentsId: number): void {
    this.unwatch(webContentsId);
    const open = this.endpoints.get(webContentsId);
    if (!open) return;
    this.endpoints.delete(webContentsId);
    this.viewsByEndpoint.delete(open.endpointId);
    if (!this.postClose(this.session, open.endpointId)) this.pendingCloses.add(open.endpointId);
    this.notifyClosed({ webContentsId, endpointId: open.endpointId });
  }

  private postClose(session: LinkSession | null, endpointId: string): boolean {
    if (!session?.isOpen) return false;
    try {
      return (
        session.post({
          lane: Lane.CONTROL,
          kind: ControlKind.ENDPOINT_CLOSE,
          body: { endpointId },
        }) !== "refused"
      );
    } catch {
      return false;
    }
  }

  private flushPendingCloses(session: LinkSession): void {
    for (const endpointId of [...this.pendingCloses]) {
      // Reopened under the same id since: the host's endpoint is live again.
      if (this.viewsByEndpoint.has(endpointId)) {
        this.pendingCloses.delete(endpointId);
        continue;
      }
      if (!this.postClose(session, endpointId)) return;
      this.pendingCloses.delete(endpointId);
    }
  }

  private unwatch(webContentsId: number): void {
    this.watched.get(webContentsId)?.();
    this.watched.delete(webContentsId);
  }

  private notifyAttached(info: SessionAttachedInfo): void {
    for (const listener of [...this.attachedListeners]) {
      try {
        listener(info);
      } catch (error) {
        console.error("[RemoteHostManager] session-attached listener failed:", error);
      }
    }
  }

  private notifyClosed(info: EndpointClosedInfo): void {
    for (const listener of [...this.closedListeners]) {
      try {
        listener(info);
      } catch (error) {
        console.error("[RemoteHostManager] endpoint-closed listener failed:", error);
      }
    }
  }

  private forgetEndpoints(): void {
    this.endpoints.clear();
    this.viewsByEndpoint.clear();
  }

  /**
   * A host may only ask the view behind one of this connection's endpoints,
   * and only while that view is still bound to it.
   */
  private reverseRequest(message: ReverseRequestMessage): Promise<unknown> {
    const webContentsId = this.viewsByEndpoint.get(message.endpointId);
    if (webContentsId === undefined || !this.isBoundHere(webContentsId)) {
      return Promise.reject(
        new AppError({
          code: "HOST_DISCONNECTED",
          message: `No view is attached as ${message.endpointId}`,
        })
      );
    }
    if (!this.answerReverse) {
      return Promise.reject(
        new AppError({ code: "UNSUPPORTED", message: `No handler for ${message.method}` })
      );
    }
    return this.answerReverse({
      hostId: this.hostId,
      webContentsId,
      method: message.method,
      payload: message.payload,
    });
  }

  /**
   * Host events go only to the views bound to the endpoint they name (or, for
   * a session-wide event, to every view bound to this host). Channels a Shell
   * answers for itself, and the Shell-owned halves of hybrid ones, are never
   * taken from a host.
   */
  private deliver(event: EventMessage): void {
    if (!acceptHostPush(event.channel, event.args)) return;
    if (event.endpointId === null) {
      for (const webContentsId of this.endpoints.keys()) {
        if (this.isBoundHere(webContentsId)) {
          this.views.send(webContentsId, event.channel, event.args);
        }
      }
      return;
    }
    const webContentsId = this.viewsByEndpoint.get(event.endpointId);
    if (webContentsId !== undefined && this.isBoundHere(webContentsId)) {
      this.views.send(webContentsId, event.channel, event.args);
    }
  }
}

export interface RemoteHostManagerOptions {
  registry: HostRegistry;
  createTransport: (descriptor: HostDescriptor) => LinkTransport;
  handshake: () => HostHandshakeInfo;
  client: LinkClientInfo;
  views: ViewSink;
  /** Answers hosts' requests to this Shell's views; without one they are refused. */
  reverseRequests?: ReverseRequestAnswerer;
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
  private readonly endpointListeners = new Set<
    (hostId: HostId, info: EndpointSessionInfo) => void
  >();
  private readonly closedListeners = new Set<(hostId: HostId, info: EndpointClosedInfo) => void>();
  private readonly attachedListeners = new Set<
    (hostId: HostId, info: SessionAttachedInfo) => void
  >();
  private readonly now: () => number;

  constructor(private readonly options: RemoteHostManagerOptions) {
    this.now = options.now ?? Date.now;
    const coordinator = new ResyncCoordinator({
      resync: (webContentsId, hostId, reason) =>
        this.options.views.resync(webContentsId, hostId, reason),
    });
    this.attachedListeners.add((hostId, info) => coordinator.onSessionAttached(hostId, info));
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

  /** {@link HostConnection.onEndpointOpened} across every connection, including later ones. */
  onEndpointOpened(listener: (hostId: HostId, info: EndpointSessionInfo) => void): () => void {
    this.endpointListeners.add(listener);
    return () => this.endpointListeners.delete(listener);
  }

  /** {@link HostConnection.onEndpointClosed} across every connection, including later ones. */
  onEndpointClosed(listener: (hostId: HostId, info: EndpointClosedInfo) => void): () => void {
    this.closedListeners.add(listener);
    return () => this.closedListeners.delete(listener);
  }

  /** {@link HostConnection.onSessionAttached} across every connection, including later ones. */
  onSessionAttached(listener: (hostId: HostId, info: SessionAttachedInfo) => void): () => void {
    this.attachedListeners.add(listener);
    return () => this.attachedListeners.delete(listener);
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
        this.options.views,
        this.options.reverseRequests ?? null
      );
      this.connections.set(hostId, connection);
      const conn = connection;
      conn.onEndpointOpened((info) => {
        if (this.connections.get(hostId) !== conn) return;
        // A view talks to one host at a time: an endpoint it still holds on
        // another host is from before it moved, and must not keep its streams.
        for (const [otherId, other] of this.connections) {
          if (otherId !== hostId) other.retireView(info.webContentsId);
        }
        for (const listener of [...this.endpointListeners]) {
          try {
            listener(hostId, info);
          } catch (error) {
            console.error("[RemoteHostManager] endpoint-opened listener failed:", error);
          }
        }
      });
      conn.onSessionAttached((info) => {
        if (this.connections.get(hostId) !== conn) return;
        for (const listener of [...this.attachedListeners]) {
          try {
            listener(hostId, info);
          } catch (error) {
            console.error("[RemoteHostManager] session-attached listener failed:", error);
          }
        }
      });
      // Unconditional on purpose: stop() reports the endpoints it discards after
      // the connection has already left the map.
      conn.onEndpointClosed((info) => {
        for (const listener of [...this.closedListeners]) {
          try {
            listener(hostId, info);
          } catch (error) {
            console.error("[RemoteHostManager] endpoint-closed listener failed:", error);
          }
        }
      });
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
