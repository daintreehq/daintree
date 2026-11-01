import { randomUUID } from "node:crypto";
import type { IpcEnvelope } from "../../../shared/types/ipc/errors.js";
import type {
  HostConnectionState,
  HostDescriptor,
  HostHandshakeInfo,
  HostId,
  HostPreviousEnd,
} from "../../../shared/types/remoteHosts.js";
import { AppError } from "../../utils/errorTypes.js";
import { createLogger } from "../../utils/logger.js";
import { createKeyedLogLimiter } from "../../utils/keyedLogLimiter.js";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";
import { acceptHostPush, unclassifiedPushName } from "../hybrid/eventsPush.js";
import { CANOPY_VIEWER_ENDPOINT_PREFIX, isCanopyViewerEndpointId } from "../canopy/linkMethods.js";
import { appErrorEnvelope, hostDisconnectedEnvelope } from "../link/envelopes.js";
import { Lane } from "../link/frames.js";
import {
  ControlKind,
  EventKind,
  InteractiveKind,
  type EventMessage,
  type LinkClientInfo,
  type ReverseRequestMessage,
} from "../link/messages.js";
import type { LinkSession, LinkSessionOptions } from "../link/session.js";
import {
  EndpointAgentActivityPayloadSchema,
  EndpointMcpBindingPayloadSchema,
  EndpointResidencyPayloadSchema,
  EndpointAssistantPayloadSchema,
  EndpointResyncPayloadSchema,
  HostInfoSchema,
  HostProjectListSchema,
  LinkMethod,
  ProjectDescriptionSchema,
  type EndpointReconcilePayload,
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
import { explainMissingChannel } from "./missingChannel.js";
import type { LinkTransport } from "./transport.js";

const logger = createLogger("main:RemoteHostManager");
const droppedSendLimiter = createKeyedLogLimiter();

const MAX_UNKNOWN_PUSH_NAMES = 64;

/**
 * Why this Shell closed a view's endpoint on a host. The host only hears that
 * the Shell closed it; this is the Shell's half of that story.
 */
type ShellEndpointCloseCause =
  /** The view was destroyed (closed, or evicted to save memory). */
  | "view-closed"
  /** The view is bound to another host, or to this machine, now. */
  | "view-moved"
  /** A fresh session could not reopen it. */
  | "reopen-refused"
  /** The connection itself was stopped (idle release, forgetting the host, quit). */
  | "connection-stopped";

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
    reason: EndpointResyncReason | ViewResyncReason,
    previousEnd?: HostPreviousEnd
  ): void;
  /**
   * The host the view is authoritatively bound to (its project key, else its
   * window's binding), or null for a local view. When present, a connection
   * delivers nothing to, and carries no streams for, a view bound elsewhere.
   */
  hostOf?(webContentsId: number): HostId | null;
  /**
   * The host now says an agent in the view's project is active, where before
   * it said none was (#15879). A view frozen in the meantime must wake: the
   * host streams that agent's output into it, and a frozen renderer can't
   * acknowledge any of it.
   */
  agentActivated?(webContentsId: number): void;
}

interface OpenEndpoint {
  endpointId: string;
  projectId: string | null;
  /** The session it was opened on, which a resume keeps and a fresh session replaces. */
  sessionId: string | null;
  /** Names this open, so the host can tell it from an earlier one under the same id. */
  openId: string;
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

/** A session (fresh or resumed) is live on the connection, whether or not any view uses it. */
export type SessionOpenedListener = (session: LinkSession) => void;

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
export type HostReadiness =
  | "ready"
  | "version-mismatch"
  /** ssh reached the host and found no Daintree in Host mode there: waiting won't change it. */
  | "host-mode-off"
  /** Gave up until asked again (ssh couldn't log in): waiting won't change it either. */
  | "stopped-retrying"
  | "timeout"
  | "stopped";

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
/** How long a host gets to list its projects before the listing counts as failed. */
export const HOST_PROJECT_LIST_TIMEOUT_MS = 8_000;

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
  private readonly sessionListeners = new Set<SessionOpenedListener>();
  private readonly viewerEventListeners = new Set<(event: EventMessage) => void>();
  private hadSession = false;
  /**
   * Endpoints closed while the link was down. The host keeps a dropped
   * session's endpoints for a resume, so these are closed there once it
   * resumes; without that every disconnect-close-resume cycle would leave one
   * behind and wear down the host's per-session endpoint allowance.
   */
  private readonly pendingCloses = new Set<string>();
  /**
   * Views the host says have a live Daintree Assistant pinned to their
   * endpoint (#13349). Closing such a view's endpoint revokes the assistant
   * there, so eviction leaves them be. Kept through a dropped link: the host
   * keeps the endpoint for a resume, and still revokes on the close that
   * would follow.
   */
  private readonly liveAssistants = new Set<number>();
  /**
   * Views the host says have an agent working, waiting or directing in their
   * project there (#13359), so eviction ranks them with this machine's own
   * active-agent views. Kept through a dropped link like `liveAssistants`: the
   * agents run on regardless, and a resumed session repeats every answer.
   */
  private readonly activeAgentViews = new Set<number>();
  /** Push names from a host on another build that this build doesn't know, logged once per host build. */
  private readonly unknownPushNames = new Set<string>();
  /**
   * Views whose project the user granted residency on this host (#13933). The
   * grant is the host's, so the eviction pass reads it here rather than from
   * this machine's store. Kept through a dropped link like `activeAgentViews`.
   */
  private readonly residentViews = new Set<number>();
  /**
   * Views whose project an MCP session on the host is bound to, live (#14228).
   * The session runs there, so this machine's MCP service never sees it. Kept
   * through a dropped link like `activeAgentViews`: the session lives on the
   * host regardless, and a resumed session repeats every answer.
   */
  private readonly mcpBoundViews = new Set<number>();
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
    this.link.onSession(({ session, resumed, hostRestarted, previousEnd }) =>
      this.attach(session, resumed, hostRestarted, previousEnd)
    );
    this.link.onStateChange(() => this.checkReady());
  }

  get isStarted(): boolean {
    return this.started;
  }

  /** A local view has an endpoint on this host: someone is using it from a window. */
  get hasViews(): boolean {
    return this.endpoints.size > 0;
  }

  get linkState(): LinkClientState {
    return this.link.getState();
  }

  get lastSeen(): number | null {
    return this.link.lastSeen;
  }

  /** The session id the host last gave this connection, kept while the link is down. */
  get lastSessionId(): string | null {
    return this.link.lastSessionId;
  }

  /** See {@link LinkClient.restarting}. */
  get restarting(): boolean {
    return this.link.restarting;
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

  /**
   * Told of every session as it attaches, before any view has called
   * through it: host summaries and session-level services ride here, so a
   * host no window is bound to still reports.
   */
  onSessionOpened(listener: SessionOpenedListener): () => void {
    this.sessionListeners.add(listener);
    return () => this.sessionListeners.delete(listener);
  }

  /** Told of the host's pushes to a Canopy viewer, which no bound view takes. */
  onViewerEvent(listener: (event: EventMessage) => void): () => void {
    this.viewerEventListeners.add(listener);
    return () => this.viewerEventListeners.delete(listener);
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
    const link = this.link.getState();
    if (link.status === "version-mismatch") return "version-mismatch";
    // Still retrying, it's a host restarting rather than one switched off.
    if (link.status === "unreachable" && link.hostModeOff && link.retryAt === null) {
      return "host-mode-off";
    }
    if (link.status === "unreachable" && link.retryAt === null) return "stopped-retrying";
    return this.unavailableEnvelope() === null ? "ready" : null;
  }

  private checkReady(): void {
    for (const check of [...this.readyWaiters]) check();
  }

  retryNow(options?: { restart?: boolean }): void {
    this.link.retryNow(options);
  }

  /** {@link LinkClient.noteSystemResumed}. */
  noteSystemResumed(): void {
    this.link.noteSystemResumed();
  }

  /**
   * Agents the host reports working while it refuses this build, asked
   * afresh (another handshake) unless the last refusal is recent enough. Null
   * when the link isn't in a build mismatch, the host didn't say, or it didn't
   * answer in time: unknown, never zero.
   */
  async workingAgentsWhileMismatched(options: {
    maxAgeMs: number;
    timeoutMs: number;
    now?: () => number;
  }): Promise<number | null> {
    const now = options.now ?? Date.now;
    const current = this.link.getState();
    if (current.status !== "version-mismatch") return null;
    if (current.observed && now() - current.observed.at < options.maxAgeMs) {
      return current.observed.workingAgents;
    }
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value: number | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        off();
        resolve(value);
      };
      const timer = setTimeout(() => finish(null), options.timeoutMs);
      const off = this.link.onStateChange((state) => {
        if (state.status === "connecting") return;
        finish(
          state.status === "version-mismatch" ? (state.observed?.workingAgents ?? null) : null
        );
      });
      this.link.retryNow();
      // A stopped link doesn't retry: nothing fresh is coming, and a stale count isn't one.
      if (this.link.getState() === current) finish(null);
    });
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
      this.logEndpointClosed(webContentsId, open, "connection-stopped");
      this.notifyClosed({ webContentsId, endpointId: open.endpointId });
    }
    // A discarded connection must not stay reachable through live views' listeners.
    for (const unwatch of this.watched.values()) unwatch();
    this.watched.clear();
    this.openedListeners.clear();
    this.closedListeners.clear();
    this.attachedListeners.clear();
    this.sessionListeners.clear();
    this.viewerEventListeners.clear();
    this.hadSession = false;
  }

  state(): HostConnectionState {
    const state = this.link.getState();
    switch (state.status) {
      case "disconnected":
        return { status: "disconnected" };
      case "connecting":
        return {
          status: "connecting",
          attempt: state.attempt,
          ...(state.restarting ? { restarting: true as const } : {}),
        };
      case "connected":
        return {
          status: "connected",
          rttMs: state.rttMs,
          ...(state.rttSampledAt !== null ? { rttSampledAt: state.rttSampledAt } : {}),
          handshake: state.handshake,
          ...(state.buildMismatch ? { buildMismatch: state.buildMismatch } : {}),
          ...(state.quietSince !== null ? { quietSince: state.quietSince } : {}),
        };
      case "unreachable":
        return {
          status: "unreachable",
          lastSeenAt: state.lastSeenAt ?? this.descriptor()?.lastSeenAt ?? null,
          detail: state.detail,
          ...(state.hostModeOff && state.retryAt === null ? { hostModeOff: true as const } : {}),
          ...(state.restarting ? { restarting: true as const } : {}),
          ...(state.retryAt === null ? { stoppedRetrying: true as const } : {}),
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
    const call = session.invoke(endpointId, channel, args);
    // The builds of the session the call went out on: a reconnect before the
    // answer may be to another build.
    const link = this.link.getState();
    if (link.status !== "connected" || link.buildMismatch === null) return call;
    const { buildMismatch, handshake } = link;
    const hostName = this.descriptor()?.name ?? this.hostId;
    return call.then((envelope) =>
      explainMissingChannel(envelope, channel, hostName, buildMismatch, handshake)
    );
  }

  send(webContentsId: number, projectId: string | null, channel: string, args: unknown[]): void {
    if (this.unavailableEnvelope()) return;
    const session = this.session!;
    const endpointId = this.ensureEndpoint(session, webContentsId, projectId);
    if (!endpointId) return;
    if (session.send(endpointId, channel, args) === "refused") {
      const suppressedCount = droppedSendLimiter.take(`${this.hostId}:${channel}`);
      if (suppressedCount !== null) {
        logger.info("Remote host send dropped", {
          hostId: this.hostId,
          channel,
          reason: "queue-full",
          suppressedCount,
        });
      }
    }
  }

  /**
   * The host's own path for a project, before a view for it is opened. Null
   * only when the host answered that it has no such project; a link that is
   * down, drops mid-call or sends something unreadable rejects instead, so a
   * blip is never reported as the project being gone.
   */
  async describeProject(projectId: string): Promise<ProjectDescription | null> {
    const session = this.session;
    if (!session || !session.isOpen) {
      throw new AppError({
        code: "HOST_DISCONNECTED",
        message: `Host ${this.hostId} is not connected`,
        userMessage: "Couldn't reach this host. Check that it is on and try again.",
      });
    }
    const answer = await session.call(LinkMethod.DESCRIBE_PROJECT, { projectId });
    if (answer === null) return null;
    const parsed = ProjectDescriptionSchema.safeParse(answer);
    if (!parsed.success) {
      throw new AppError({
        code: "INTERNAL",
        message: `Host ${this.hostId} sent an invalid project description`,
      });
    }
    return parsed.data;
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
    // Bounded well under the link's 60 s default: a listing feeds a palette the
    // user is waiting on, and a wedged host should read as failed, not loading.
    const answer = await session.call(LinkMethod.LIST_PROJECTS, null, {
      timeoutMs: HOST_PROJECT_LIST_TIMEOUT_MS,
    });
    const parsed = HostProjectListSchema.safeParse(answer);
    if (!parsed.success) {
      throw new AppError({
        code: "INTERNAL",
        message: `Host ${this.hostId} sent an invalid project list`,
      });
    }
    return parsed.data;
  }

  /**
   * Tell the host this Shell now shows `projectId`, so a later bare switch to
   * the host lands on it. Best effort: a note lost with the link only means the
   * next switch here opens the project list instead.
   */
  noteActiveProject(projectId: string): void {
    const session = this.session;
    if (!session || !session.isOpen) return;
    session.call(LinkMethod.NOTE_ACTIVE_PROJECT, { projectId }).catch(() => {});
  }

  /** The project this Shell last showed on the host, as the host describes it now; null for none. */
  async lastActiveProject(): Promise<ProjectDescription | null> {
    const session = this.session;
    if (!session || !session.isOpen) return null;
    const answer = await session.call(LinkMethod.LAST_ACTIVE_PROJECT, null);
    const parsed = ProjectDescriptionSchema.safeParse(answer);
    return parsed.success ? parsed.data : null;
  }

  /**
   * A session-level method on the host, needing no view bound to it. Rejects
   * while the host can't be reached.
   */
  async callHost(method: string, payload: unknown): Promise<unknown> {
    const session = this.session;
    if (this.unavailableEnvelope() || !session) {
      throw new AppError({
        code: "HOST_DISCONNECTED",
        message: `Host ${this.hostId} is not connected`,
        userMessage: "Couldn't reach this host. Check that it is on and try again.",
      });
    }
    return session.call(method, payload);
  }

  /** Local views that have an endpoint on the host right now. */
  boundViews(): number[] {
    return [...this.endpoints.keys()];
  }

  /** Whether the host last said a live Daintree Assistant is pinned to this view's endpoint. */
  hasLiveAssistant(webContentsId: number): boolean {
    return this.liveAssistants.has(webContentsId) && this.endpoints.has(webContentsId);
  }

  /** Whether the host last said an agent in this view's project is active there. */
  hasActiveAgent(webContentsId: number): boolean {
    return this.activeAgentViews.has(webContentsId) && this.endpoints.has(webContentsId);
  }

  /** Whether the host last said the user granted this view's project residency there. */
  hasKeepResident(webContentsId: number): boolean {
    return this.residentViews.has(webContentsId) && this.endpoints.has(webContentsId);
  }

  /** Whether the host last said an MCP session there is bound to this view's project, live. */
  hasLiveMcpBinding(webContentsId: number): boolean {
    return this.mcpBoundViews.has(webContentsId) && this.endpoints.has(webContentsId);
  }

  /** The view now belongs to another host (or this machine): close its endpoint here. */
  retireView(webContentsId: number): void {
    this.closeEndpoint(webContentsId, "view-moved");
  }

  /** Whether the view still belongs to this host, by its authoritative binding. */
  private isBoundHere(webContentsId: number): boolean {
    return this.views.hostOf ? this.views.hostOf(webContentsId) === this.hostId : true;
  }

  private attach(
    session: LinkSession,
    resumed: boolean,
    hostRestarted: boolean,
    previousEnd?: HostPreviousEnd
  ): void {
    // A fresh session means the host dropped every endpoint of the old one,
    // including any still waiting to be closed.
    const reopen = resumed ? [] : [...this.endpoints];
    if (!resumed) {
      this.forgetEndpoints();
      this.pendingCloses.clear();
    }
    this.session = session;
    for (const listener of [...this.sessionListeners]) {
      try {
        listener(session);
      } catch (error) {
        console.error("[RemoteHostManager] session-opened listener failed:", error);
      }
    }
    session.on(Lane.EVENTS, EventKind.EVENT, (body) => this.deliver(body));
    // Only a Canopy viewer's terminal rides this kind; anything else naming it is dropped.
    session.on(Lane.INTERACTIVE, InteractiveKind.CANOPY_TERMINAL, (body) => {
      if (isCanopyViewerEndpointId(body.endpointId)) this.deliver(body);
    });
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
    session.registerCallHandler(
      LinkMethod.ENDPOINT_ASSISTANT,
      EndpointAssistantPayloadSchema,
      ({ endpoints }) => {
        for (const { endpointId, projectId, live } of endpoints) {
          const webContentsId = this.viewsByEndpoint.get(endpointId);
          if (webContentsId === undefined) continue;
          // Said about a binding the view has since left.
          if (this.endpoints.get(webContentsId)?.projectId !== projectId) continue;
          if (live) this.liveAssistants.add(webContentsId);
          else this.liveAssistants.delete(webContentsId);
        }
        return null;
      }
    );
    session.registerCallHandler(
      LinkMethod.ENDPOINT_AGENT_ACTIVITY,
      EndpointAgentActivityPayloadSchema,
      ({ endpoints }) => {
        const activated: number[] = [];
        for (const { endpointId, projectId, active } of endpoints) {
          const webContentsId = this.viewsByEndpoint.get(endpointId);
          if (webContentsId === undefined) continue;
          // Said about a binding the view has since left.
          if (this.endpoints.get(webContentsId)?.projectId !== projectId) continue;
          if (active && !this.activeAgentViews.has(webContentsId)) activated.push(webContentsId);
          if (active) this.activeAgentViews.add(webContentsId);
          else this.activeAgentViews.delete(webContentsId);
        }
        for (const webContentsId of activated) {
          try {
            this.views.agentActivated?.(webContentsId);
          } catch (error) {
            console.error("[RemoteHostManager] agent-activated sink failed:", error);
          }
        }
        return null;
      }
    );
    session.registerCallHandler(
      LinkMethod.ENDPOINT_RESIDENCY,
      EndpointResidencyPayloadSchema,
      ({ endpoints }) => {
        for (const { endpointId, projectId, keepResident } of endpoints) {
          const webContentsId = this.viewsByEndpoint.get(endpointId);
          if (webContentsId === undefined) continue;
          // Said about a binding the view has since left.
          if (this.endpoints.get(webContentsId)?.projectId !== projectId) continue;
          if (keepResident) this.residentViews.add(webContentsId);
          else this.residentViews.delete(webContentsId);
        }
        return null;
      }
    );
    session.registerCallHandler(
      LinkMethod.ENDPOINT_MCP_BINDING,
      EndpointMcpBindingPayloadSchema,
      ({ endpoints }) => {
        for (const { endpointId, projectId, liveBinding } of endpoints) {
          const webContentsId = this.viewsByEndpoint.get(endpointId);
          if (webContentsId === undefined) continue;
          // Said about a binding the view has since left.
          if (this.endpoints.get(webContentsId)?.projectId !== projectId) continue;
          if (liveBinding) this.mcpBoundViews.add(webContentsId);
          else this.mcpBoundViews.delete(webContentsId);
        }
        return null;
      }
    );
    session.onClose(() => {
      if (this.session === session) this.session = null;
      this.checkReady();
    });
    this.flushPendingCloses(session);
    // Only a resume still holds endpoints here: a fresh session forgot them above.
    for (const [webContentsId, open] of [...this.endpoints]) {
      if (!this.isBoundHere(webContentsId)) {
        this.closeEndpoint(webContentsId, "view-moved");
        continue;
      }
      // An open or move still queued when the link dropped never reached the
      // host. Saying each again costs nothing where it did: the host takes the
      // same open on the same project as a no-op.
      if (!this.postOpen(session, open)) this.closeEndpoint(webContentsId, "reopen-refused");
    }
    // So is a close, which leaves the host keeping an endpoint (and any lease
    // it holds) for a view that is gone. Asked before the views' streams move,
    // so no stream's requests stand ahead of it. A host from before this call
    // refuses it and keeps such endpoints until the session ends.
    if (resumed) {
      const reconcile: EndpointReconcilePayload = {
        endpointIds: [...this.endpoints.values()].map((open) => open.endpointId),
      };
      // No deadline: a notice that settles unsent is dropped, and nothing sends it again.
      session.call(LinkMethod.ENDPOINT_RECONCILE, reconcile, { timeoutMs: 0 }).catch(() => {});
    }
    // A resume keeps the host's endpoints, so the views' streams move to the new session.
    for (const [webContentsId, open] of [...this.endpoints]) {
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
      const boundHere = this.isBoundHere(webContentsId);
      const endpointId = boundHere
        ? this.ensureEndpoint(session, webContentsId, open.projectId)
        : null;
      if (endpointId === null) {
        this.logEndpointClosed(webContentsId, open, boundHere ? "reopen-refused" : "view-moved");
        this.unwatch(webContentsId);
        this.notifyClosed({ webContentsId, endpointId: open.endpointId });
      } else {
        reopened.push(webContentsId);
      }
    }
    const isReconnect = this.hadSession;
    this.hadSession = true;
    if (isReconnect) {
      this.notifyAttached({
        resumed,
        reopened,
        hostRestarted,
        ...(hostRestarted && previousEnd && { previousEnd }),
      });
    }
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
        // The host revokes the old project's assistant when the endpoint moves.
        this.liveAssistants.delete(webContentsId);
        // The old project's agents say nothing about the new one's.
        this.activeAgentViews.delete(webContentsId);
        this.residentViews.delete(webContentsId);
        this.mcpBoundViews.delete(webContentsId);
      }
      return open.endpointId;
    }
    const endpointId = `view-${webContentsId}`;
    const sessionId = this.link.lastSessionId;
    const opened: OpenEndpoint = { endpointId, projectId, sessionId, openId: randomUUID() };
    if (!this.postOpen(session, opened)) return null;
    this.pendingCloses.delete(endpointId);
    this.endpoints.set(webContentsId, opened);
    this.viewsByEndpoint.set(endpointId, webContentsId);
    logger.info("Remote host view endpoint opened", {
      hostId: this.hostId,
      sessionId,
      endpointId,
      webContentsId,
      projectId,
    });
    if (!this.watched.has(webContentsId)) {
      this.watched.set(
        webContentsId,
        this.views.watch(webContentsId, () => this.closeEndpoint(webContentsId, "view-closed"))
      );
    }
    notifyEndpointOpened(this.openedListeners, { session, webContentsId, endpointId });
    return endpointId;
  }

  private closeEndpoint(webContentsId: number, cause: ShellEndpointCloseCause): void {
    this.unwatch(webContentsId);
    const open = this.endpoints.get(webContentsId);
    if (!open) return;
    this.endpoints.delete(webContentsId);
    this.viewsByEndpoint.delete(open.endpointId);
    this.liveAssistants.delete(webContentsId);
    this.activeAgentViews.delete(webContentsId);
    this.residentViews.delete(webContentsId);
    this.mcpBoundViews.delete(webContentsId);
    const posted = this.postClose(this.session, open.endpointId);
    if (!posted) this.pendingCloses.add(open.endpointId);
    this.logEndpointClosed(webContentsId, open, cause, { closeQueued: !posted });
    this.notifyClosed({ webContentsId, endpointId: open.endpointId });
  }

  private logEndpointClosed(
    webContentsId: number,
    open: OpenEndpoint,
    cause: ShellEndpointCloseCause,
    extra: { closeQueued?: boolean } = {}
  ): void {
    logger.info("Remote host view endpoint closed", {
      hostId: this.hostId,
      sessionId: open.sessionId,
      endpointId: open.endpointId,
      webContentsId,
      projectId: open.projectId,
      cause,
      ...extra,
    });
  }

  private postOpen(session: LinkSession, open: OpenEndpoint): boolean {
    const { endpointId, projectId, openId } = open;
    return (
      session.post({
        lane: Lane.CONTROL,
        kind: ControlKind.ENDPOINT_OPEN,
        body: { endpointId, projectId, openId },
      }) !== "refused"
    );
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
    this.liveAssistants.clear();
    this.activeAgentViews.clear();
    this.residentViews.clear();
    this.mcpBoundViews.clear();
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
    if (!acceptHostPush(event.channel, event.args)) {
      this.noteUnknownPush(event);
      return;
    }
    // A Canopy panel reading this host from a view bound elsewhere.
    if (event.endpointId?.startsWith(CANOPY_VIEWER_ENDPOINT_PREFIX)) {
      for (const listener of [...this.viewerEventListeners]) {
        try {
          listener(event);
        } catch (error) {
          console.error("[RemoteHostManager] viewer-event listener failed:", error);
        }
      }
      return;
    }
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

  /**
   * A host on another build pushed something this build never classified, so
   * it is dropped rather than guessed at. Said once per name, with both
   * builds, since whatever listens for it here stays as it was.
   */
  private noteUnknownPush(event: EventMessage): void {
    const state = this.link.getState();
    if (state.status !== "connected" || state.buildMismatch === null) return;
    const name = unclassifiedPushName(event.channel, event.args);
    if (name === null) return;
    // Per host build: one that moves on may send it for a different reason.
    const key = `${state.handshake.version}\u0000${state.handshake.commit}\u0000${name}`;
    // A host can name anything: past the budget the rest go unsaid, rather
    // than forgetting what was said and saying it all again.
    if (this.unknownPushNames.has(key) || this.unknownPushNames.size >= MAX_UNKNOWN_PUSH_NAMES) {
      return;
    }
    this.unknownPushNames.add(key);
    logger.warn("Dropped a push from a host on another build that this build doesn't know", {
      hostId: this.hostId,
      channel: event.channel,
      name,
      buildMismatch: state.buildMismatch,
    });
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
  /** How long a connection nothing uses stays up before it is closed; 0 never closes one. */
  idleReleaseMs?: number;
  /** How long this machine was awake since a moment `now` gave; time asleep isn't time unused. */
  awakeSince?: (since: number) => number;
}

/** Long enough to cover a quick switch away and back, or a pause in the overview. */
export const IDLE_RELEASE_MS = 5 * 60_000;
const IDLE_SWEEP_MS = 30_000;

/**
 * One {@link HostConnection} per host something asked for. Connections are
 * created on demand, so nothing is dialled for a host nobody opened, and one
 * nothing has used for {@link IDLE_RELEASE_MS} (no window on it, no forward,
 * notifications off, no recent call) is closed again.
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
  private readonly sessionListeners = new Set<(hostId: HostId, session: LinkSession) => void>();
  private readonly viewerEventListeners = new Set<(hostId: HostId, event: EventMessage) => void>();
  private readonly now: () => number;
  private readonly awakeSince: (since: number) => number;
  /** When each connection was last asked for or found in use. */
  private readonly lastUsed = new Map<HostId, number>();
  private readonly useChecks = new Set<(hostId: HostId) => boolean>();
  /** Work in flight on a host that needs its connection kept (a transfer), by count. */
  private readonly holds = new Map<HostId, number>();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly options: RemoteHostManagerOptions) {
    this.now = options.now ?? Date.now;
    this.awakeSince = options.awakeSince ?? ((since) => this.now() - since);
    const coordinator = new ResyncCoordinator({
      resync: (webContentsId, hostId, reason, previousEnd) =>
        this.options.views.resync(webContentsId, hostId, reason, previousEnd),
    });
    this.attachedListeners.add((hostId, info) => coordinator.onSessionAttached(hostId, info));
  }

  get(hostId: HostId): HostConnection | undefined {
    return this.connections.get(hostId);
  }

  /** Who this Shell launch is to every host it dials. */
  get localClient(): LinkClientInfo {
    return this.options.client;
  }

  /**
   * Something that keeps a host's connection open while it says so (a
   * window bound to it, a port forward). Asked on every idle sweep.
   */
  addUseCheck(check: (hostId: HostId) => boolean): () => void {
    this.useChecks.add(check);
    return () => this.useChecks.delete(check);
  }

  /**
   * Keep the host's connection open until the returned release is called,
   * however long that takes. For work that outlasts the release window.
   */
  hold(hostId: HostId): () => void {
    this.holds.set(hostId, (this.holds.get(hostId) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = (this.holds.get(hostId) ?? 1) - 1;
      if (left > 0) this.holds.set(hostId, left);
      else this.holds.delete(hostId);
      this.touch(hostId);
    };
  }

  /** Mark the host's connection used now, so the idle release starts counting again. */
  touch(hostId: HostId): void {
    if (this.connections.has(hostId)) this.lastUsed.set(hostId, this.now());
  }

  private inUse(hostId: HostId): boolean {
    if ((this.holds.get(hostId) ?? 0) > 0) return true;
    // A host whose notifications are on keeps its light connection.
    if (this.options.registry.get(hostId)?.notificationsEnabled === true) return true;
    if (this.connections.get(hostId)?.hasViews) return true;
    for (const check of this.useChecks) {
      try {
        if (check(hostId)) return true;
      } catch (error) {
        console.error("[RemoteHostManager] use check failed:", error);
      }
    }
    return false;
  }

  /** Close the connections nothing has used for the release window. */
  sweepIdle(): void {
    const releaseMs = this.options.idleReleaseMs ?? IDLE_RELEASE_MS;
    if (releaseMs <= 0) return;
    const now = this.now();
    for (const hostId of [...this.connections.keys()]) {
      if (this.inUse(hostId)) {
        this.lastUsed.set(hostId, now);
        continue;
      }
      const idleMs = this.awakeSince(this.lastUsed.get(hostId) ?? now);
      if (idleMs < releaseMs) continue;
      // A link that stopped retrying (ssh can't log in, Host mode off, another
      // build) costs nothing, and closing it would forget why it stopped.
      const link = this.connections.get(hostId)?.linkState;
      if (link?.status === "version-mismatch") continue;
      if (link?.status === "unreachable" && link.retryAt === null) continue;
      const idle = {
        hostId,
        sessionId: this.connections.get(hostId)?.lastSessionId ?? null,
        idleMs,
      };
      logger.info("Closing the unused connection to a remote host", idle);
      void this.disconnect(hostId).catch((error: unknown) => {
        logger.warn("Closing the unused connection to a remote host failed", {
          ...idle,
          reason: formatErrorMessage(error, "disconnect failed"),
        });
      });
    }
  }

  private ensureSweep(): void {
    if (this.sweepTimer || (this.options.idleReleaseMs ?? IDLE_RELEASE_MS) <= 0) return;
    this.sweepTimer = setInterval(() => this.sweepIdle(), IDLE_SWEEP_MS);
    this.sweepTimer.unref?.();
  }

  /** The machine just woke: every link checks itself now rather than at its next timer. */
  systemResumed(): void {
    for (const connection of this.connections.values()) connection.noteSystemResumed();
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

  /** {@link HostConnection.onSessionOpened} across every connection, including later ones. */
  onSessionOpened(listener: (hostId: HostId, session: LinkSession) => void): () => void {
    this.sessionListeners.add(listener);
    return () => this.sessionListeners.delete(listener);
  }

  /** {@link HostConnection.onViewerEvent} across every connection, including later ones. */
  onViewerEvent(listener: (hostId: HostId, event: EventMessage) => void): () => void {
    this.viewerEventListeners.add(listener);
    return () => this.viewerEventListeners.delete(listener);
  }

  /**
   * Start (or nudge) the host's link. Resolves once the attempt is under way,
   * not connected. `restart` abandons an attempt already under way: a
   * person's Retry, never a caller that only needs the link.
   */
  connect(hostId: HostId, options?: { restart?: boolean }): HostConnection {
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
          lastSeenAt: () => this.options.registry.get(hostId)?.lastSeenAt ?? null,
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
      conn.onSessionOpened((session) => {
        if (this.connections.get(hostId) !== conn) return;
        for (const listener of [...this.sessionListeners]) {
          try {
            listener(hostId, session);
          } catch (error) {
            console.error("[RemoteHostManager] session-opened listener failed:", error);
          }
        }
      });
      conn.onViewerEvent((event) => {
        if (this.connections.get(hostId) !== conn) return;
        for (const listener of [...this.viewerEventListeners]) listener(hostId, event);
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
    this.lastUsed.set(hostId, this.now());
    this.ensureSweep();
    if (connection.isStarted) connection.retryNow(options);
    else connection.start();
    return connection;
  }

  async disconnect(hostId: HostId): Promise<void> {
    const connection = this.connections.get(hostId);
    if (!connection) return;
    this.connections.delete(hostId);
    this.lastUsed.delete(hostId);
    if (this.connections.size === 0 && this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
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
