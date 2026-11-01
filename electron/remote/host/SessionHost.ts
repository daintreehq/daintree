import os from "node:os";
import type {
  ClientRef,
  EndpointInvocation,
  EndpointRegistry,
  EndpointRequestOptions,
  HostFrame,
  RemoteEndpointCloseCause,
} from "../../ipc/endpoint.js";
import type { IpcEnvelope } from "../../../shared/types/ipc/errors.js";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";
import { AppError } from "../../utils/errorTypes.js";
import { createLogger } from "../../utils/logger.js";
import { toTransportSafeError } from "../../ipc/transportSafeError.js";
import { appErrorEnvelope } from "../link/envelopes.js";
import { Lane } from "../link/frames.js";
import { ControlKind, EventKind } from "../link/messages.js";
import { DEFAULT_LANE_LIMITS } from "../link/scheduler.js";
import type { LinkSession } from "../link/session.js";
import type { HostSessionContext, HostSessionExpired } from "./HostServer.js";
import {
  DescribeProjectPayloadSchema,
  EmptyPayloadSchema,
  EndpointReconcilePayloadSchema,
  LinkMethod,
  MAX_LISTED_PROJECTS,
  type EndpointAgentActivityPayload,
  type EndpointMcpBindingPayload,
  type EndpointResidencyPayload,
  type EndpointAssistantPayload,
  type EndpointResyncPayload,
  type EndpointResyncReason,
  type HostInfo,
  type HostProjectList,
  type ProjectDescription,
} from "./linkMethods.js";
import { RemoteViewEndpoint, type RemoteEndpointTransport } from "./RemoteViewEndpoint.js";

const logger = createLogger("main:SessionHost");

/**
 * The Host's half of an attached Shell: turns a link session's endpoint
 * lifecycle messages into {@link RemoteViewEndpoint}s in the endpoint
 * registry, runs INVOKE/SEND through the same dispatcher `ipcMain` feeds, and
 * carries events back on the EVENTS lane.
 *
 * Endpoints belong to the session id, not to one `LinkSession`: a resumed
 * session is a new stream with the same id, and its endpoints carry on. They
 * close only when the server gives the session up for good (the grace window
 * passed, or the Shell said goodbye).
 *
 * Events cannot pause, so a Shell that stops reading is not allowed to grow
 * this process's memory: once its EVENTS lane refuses a frame, or stays over
 * high water past a short grace, its events are dropped and it is told to
 * repaint from a snapshot once the lane has drained.
 */

export interface SessionHostServer {
  onSession(listener: (ctx: HostSessionContext) => void): () => void;
  onSessionExpired(listener: (info: HostSessionExpired) => void): () => void;
}

export interface SessionHostDispatcher {
  invokeForEndpoint(
    invocation: EndpointInvocation,
    channel: string,
    args: unknown[]
  ): Promise<IpcEnvelope>;
  sendForEndpoint(invocation: EndpointInvocation, channel: string, args: unknown[]): void;
}

export interface SessionHostOptions {
  dispatcher: SessionHostDispatcher;
  registry: EndpointRegistry;
  /**
   * Shells using this host, for the power policy: a host someone is working
   * on stays awake. Counted only while the Shell has a view open here and has
   * done something with it (opened or switched a view, typed or resized a
   * terminal) within {@link SessionHostOptions.activityWindowMs}. A link with
   * no view (a Shell reading summaries, notifications or listings) never
   * counts, and neither does a window left open and untouched.
   */
  setAttachedFrontendCount?: (count: number) => void;
  /** How long one use keeps the host awake; renewed by the next. */
  activityWindowMs?: number;
  hostInfo?: () => HostInfo;
  /**
   * Whether a live Daintree Assistant is pinned to this endpoint. The assistant
   * runs here, and closing its view's endpoint revokes it, so the Shell can
   * only keep that view out of its eviction pass if this host tells it (#13349).
   * Read synchronously on every refresh; absent, every endpoint reads as having none.
   */
  assistantLive?: (endpoint: RemoteViewEndpoint) => boolean;
  /**
   * Whether an agent in this endpoint's project is working, waiting or
   * directing, by this host's own agent state. Grid agents run here, so the
   * Shell can only rank the view with its own active-agent views if this host
   * tells it (#13359). Read synchronously on every refresh; absent, every
   * endpoint reads as having none.
   */
  agentActive?: (endpoint: RemoteViewEndpoint) => boolean;
  /**
   * Whether the user granted this endpoint's project residency on this host.
   * The grant lives in this host's store, so the Shell's eviction pass can only
   * honour it if this host tells it (#13933). Read synchronously on every
   * refresh; absent, every endpoint reads as having none.
   */
  keepResident?: (endpoint: RemoteViewEndpoint) => boolean;
  /**
   * Whether an external MCP session on this host is bound, over a live
   * transport, to this endpoint's project. The session runs here, so the
   * Shell's eviction pass can only rank the view with its own bound views if
   * this host tells it (#14228). Read synchronously on every refresh; absent,
   * every endpoint reads as having none.
   */
  mcpBindingLive?: (endpoint: RemoteViewEndpoint) => boolean;
  describeProject?: (projectId: string) => ProjectDescription | null;
  listProjects?: () => HostProjectList;
  eventsHighWaterBytes?: number;
  /** How long the EVENTS lane may stay over high water before the Shell is resynced. */
  overHighWaterGraceMs?: number;
  maxEndpointsPerSession?: number;
}

/** What a later bridge (terminal streams, the worktree port) needs to follow an endpoint. */
export interface EndpointSessionHandle {
  sessionId: string;
  client: ClientRef;
  /** The stream the endpoint rides right now; null while its Shell is away. */
  link(): LinkSession | null;
}

export type EndpointOpenedListener = (
  endpoint: RemoteViewEndpoint,
  handle: EndpointSessionHandle
) => void;

/**
 * A Shell's link dropped (`attached` false) or resumed, for the registry ids of
 * the endpoints it carries. The endpoints themselves live on through the
 * session's resume window; this says whether anyone is behind them.
 */
export type TransportChangeListener = (endpointIds: string[], attached: boolean) => void;

const DEFAULT_OVER_HIGH_WATER_GRACE_MS = 5_000;
const DEFAULT_ACTIVITY_WINDOW_MS = 5 * 60_000;
const DEFAULT_MAX_ENDPOINTS_PER_SESSION = 256;
/** How soon an attached Shell that failed to take an assistant or agent answer is asked again. */
export const ANSWER_RETRY_MS = 1_000;
/** Shell machines whose last project a host remembers; the oldest is dropped first. */
const MAX_REMEMBERED_CLIENTS = 64;

/**
 * What the host tells a Shell about each of its views, for the Shell's
 * eviction pass: a live assistant pinned to the view (#13349), an active
 * agent in the view's project (#13359), the user's keep-resident grant for
 * the view's project (#13933), and an MCP session bound to the view's project
 * (#14228).
 */
type EndpointAnswer = "assistant" | "agents" | "resident" | "mcpBinding";
const ENDPOINT_ANSWERS: readonly EndpointAnswer[] = [
  "assistant",
  "agents",
  "resident",
  "mcpBinding",
];

interface SessionState {
  sessionId: string;
  client: ClientRef;
  link: LinkSession | null;
  detach: Array<() => void>;
  endpoints: Map<string, RemoteViewEndpoint>;
  /** Events are being dropped until the lane drains and the Shell is told to resync. */
  resyncing: boolean;
  /** Client endpoint ids that missed events and must be told to resync. */
  stale: Set<string>;
  staleReason: EndpointResyncReason;
  /**
   * Live endpoints an ENDPOINT_OPEN named on the current link, and those it
   * created rather than found. A resumed Shell repeats its opens before it
   * says which endpoints it holds, so an open it made after saying so (which
   * the control lane can put ahead of the call) is told from one it lost.
   */
  openedOnLink: Set<string>;
  createdOnLink: Set<string>;
  /**
   * Opens the current link refused at the endpoint cap, as the Shell has
   * since moved them (a close drops one), for its reconcile to retry once
   * closing what it no longer holds has made room.
   */
  refusedOnLink: Map<string, { projectId: string | null; openId: string | undefined }>;
  /**
   * What the Shell was last told about each endpoint, per answer, by client
   * endpoint id. An endpoint missing here is owed an answer: cleared when the
   * link drops, so a resumed Shell hears every endpoint again.
   */
  told: Record<EndpointAnswer, Map<string, boolean>>;
  /** A retry of answers the attached Shell failed to take; cleared with its link. */
  answerRetry: Record<EndpointAnswer, ReturnType<typeof setTimeout> | null>;
  overHighWaterTimer: ReturnType<typeof setTimeout> | null;
  handle: EndpointSessionHandle;
  /** When the Shell last used this host through a view; null until it does. */
  lastActiveAt: number | null;
  /** Channels already logged as unsendable here, so one that always fails warns once. */
  unsendableChannels: Set<string>;
}

/**
 * The Shell is another machine: whatever this build would show its own
 * renderer, an error leaves here with paths, stacks and context stripped.
 */
function transportSafe(envelope: IpcEnvelope): IpcEnvelope {
  if (envelope.ok) return envelope;
  return { ...envelope, error: toTransportSafeError({ ...envelope.error }) };
}

function defaultHostInfo(): HostInfo {
  return {
    platform: process.platform === "darwin" ? "darwin" : "linux",
    homeDir: os.homedir(),
    tmpDir: os.tmpdir(),
  };
}

/** What a lifecycle log line says about an endpoint: ids only, never what it carries. */
function describeEndpoint(endpoint: RemoteViewEndpoint) {
  return {
    sessionId: endpoint.linkSessionId,
    clientId: endpoint.clientId,
    endpointId: endpoint.endpointId,
    clientEndpointId: endpoint.clientEndpointId,
    handle: endpoint.handle,
    projectId: endpoint.projectId,
  };
}

/** What a Shell's remembered project is filed under: its install, or its machine name if it doesn't say. */
function rememberedKey(client: ClientRef): string {
  return client.deviceId ? `device:${client.deviceId}` : `name:${client.clientName}`;
}

export class SessionHost {
  private readonly states = new Map<string, SessionState>();
  private readonly openedListeners = new Set<EndpointOpenedListener>();
  private readonly transportListeners = new Set<TransportChangeListener>();
  private readonly unsubscribe: Array<() => void> = [];
  private readonly highWaterBytes: number;
  private readonly graceMs: number;
  private readonly maxEndpoints: number;
  private lastFrontendCount = -1;
  private readonly activityWindowMs: number;
  private activityTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly lastActiveByClient = new Map<string, string>();
  private disposed = false;

  constructor(
    server: SessionHostServer,
    private readonly options: SessionHostOptions
  ) {
    this.highWaterBytes =
      options.eventsHighWaterBytes ?? DEFAULT_LANE_LIMITS[Lane.EVENTS].highWaterBytes;
    this.graceMs = options.overHighWaterGraceMs ?? DEFAULT_OVER_HIGH_WATER_GRACE_MS;
    this.maxEndpoints = options.maxEndpointsPerSession ?? DEFAULT_MAX_ENDPOINTS_PER_SESSION;
    this.activityWindowMs = options.activityWindowMs ?? DEFAULT_ACTIVITY_WINDOW_MS;
    this.unsubscribe.push(server.onSession((ctx) => this.attach(ctx)));
    this.unsubscribe.push(
      server.onSessionExpired((info) => this.expire(info.sessionId, info.cause))
    );
  }

  /** Seam for bridges that follow an endpoint (terminal streams, the worktree port). */
  onEndpointOpened(listener: EndpointOpenedListener): () => void {
    this.openedListeners.add(listener);
    return () => this.openedListeners.delete(listener);
  }

  /** Seam for state that must notice a Shell going away before its session expires (the drive lease). */
  onTransportChange(listener: TransportChangeListener): () => void {
    this.transportListeners.add(listener);
    return () => this.transportListeners.delete(listener);
  }

  /** Shells with a live link, a view open through it, and recent use of it. */
  get attachedCount(): number {
    const now = Date.now();
    let count = 0;
    for (const state of this.states.values()) if (this.isInUse(state, now)) count++;
    return count;
  }

  /**
   * Whether some Shell has a view open here over a live link: the only time an
   * endpoint's answers are read. Unlike {@link attachedCount}, a view left
   * untouched still counts.
   */
  get servesViews(): boolean {
    for (const state of this.states.values()) {
      if (state.link?.isOpen && state.endpoints.size > 0) return true;
    }
    return false;
  }

  /**
   * The Shell behind `sessionId` used this host just now (typed or resized
   * one of its terminals). Its streams report it; summaries, listings, pings
   * and acks never do.
   */
  noteActivity(sessionId: string): void {
    const state = this.states.get(sessionId);
    if (!state || this.disposed) return;
    state.lastActiveAt = Date.now();
    this.publishFrontendCount();
  }

  private isInUse(state: SessionState, now: number): boolean {
    return (
      state.link !== null &&
      !state.link.isClosed &&
      state.endpoints.size > 0 &&
      state.lastActiveAt !== null &&
      now - state.lastActiveAt < this.activityWindowMs
    );
  }

  /** Publish again when the soonest use runs out, so an idle window stops holding the host. */
  private scheduleActivityExpiry(): void {
    if (this.activityTimer) clearTimeout(this.activityTimer);
    this.activityTimer = null;
    if (this.disposed) return;
    const now = Date.now();
    let soonest = Infinity;
    for (const state of this.states.values()) {
      if (!this.isInUse(state, now)) continue;
      soonest = Math.min(soonest, state.lastActiveAt! + this.activityWindowMs);
    }
    if (soonest === Infinity) return;
    this.activityTimer = setTimeout(
      () => {
        this.activityTimer = null;
        this.publishFrontendCount();
      },
      Math.max(0, soonest - now)
    );
    this.activityTimer.unref?.();
  }

  /**
   * Remember which project a Shell last showed, so switching back to this host
   * lands there. Keyed by the Shell's install rather than its client id: the
   * id is minted per launch, and "the project you had open there" should
   * outlive a restart of the Shell. A Shell too old to say which install it is
   * falls back to its machine name, which two machines can share. Only a
   * project this host has is kept.
   */
  noteActiveProject(client: ClientRef, projectId: string): void {
    if (!this.options.describeProject?.(projectId)) return;
    const key = rememberedKey(client);
    this.lastActiveByClient.delete(key);
    this.lastActiveByClient.set(key, projectId);
    while (this.lastActiveByClient.size > MAX_REMEMBERED_CLIENTS) {
      const oldest = this.lastActiveByClient.keys().next().value;
      if (oldest === undefined) break;
      this.lastActiveByClient.delete(oldest);
    }
  }

  /** The project the Shell last showed here, or null when it showed none or the host no longer has it. */
  lastActiveProject(client: ClientRef): ProjectDescription | null {
    const key = rememberedKey(client);
    const projectId = this.lastActiveByClient.get(key);
    if (projectId === undefined) return null;
    const description = this.options.describeProject?.(projectId) ?? null;
    if (!description) this.lastActiveByClient.delete(key);
    return description;
  }

  getEndpoint(sessionId: string, clientEndpointId: string): RemoteViewEndpoint | undefined {
    return this.states.get(sessionId)?.endpoints.get(clientEndpointId);
  }

  /**
   * An assistant may have started or stopped: tell each attached Shell about
   * every endpoint whose answer changed since it was last told.
   */
  refreshAssistants(): void {
    if (this.disposed) return;
    for (const state of this.states.values()) this.announce(state, "assistant");
  }

  /**
   * An agent may have started or stopped working: tell each attached Shell
   * about every endpoint whose answer changed since it was last told.
   */
  refreshAgentActivity(): void {
    if (this.disposed) return;
    for (const state of this.states.values()) this.announce(state, "agents");
  }

  /**
   * A residency grant may have been set or cleared: tell each attached Shell
   * about every endpoint whose answer changed since it was last told.
   */
  refreshResidency(): void {
    if (this.disposed) return;
    for (const state of this.states.values()) this.announce(state, "resident");
  }

  /**
   * An MCP session may have bound to a project or dropped: tell each attached
   * Shell about every endpoint whose answer changed since it was last told.
   */
  refreshMcpBindings(): void {
    if (this.disposed) return;
    for (const state of this.states.values()) this.announce(state, "mcpBinding");
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const off of this.unsubscribe.splice(0)) off();
    for (const sessionId of [...this.states.keys()]) this.expire(sessionId, "host-shutdown");
    this.openedListeners.clear();
    this.transportListeners.clear();
    this.publishFrontendCount();
    if (this.activityTimer) clearTimeout(this.activityTimer);
    this.activityTimer = null;
  }

  private attach(ctx: HostSessionContext): void {
    if (this.disposed) return;
    let state = this.states.get(ctx.sessionId);
    if (state && !ctx.resumed) {
      this.expire(ctx.sessionId, "session-replaced");
      state = undefined;
    }
    if (!state) {
      const created: SessionState = {
        sessionId: ctx.sessionId,
        client: {
          clientId: ctx.client.clientId,
          clientName: ctx.client.clientName,
          platform: ctx.client.platform,
          kind: "remote",
          ...(ctx.client.deviceId ? { deviceId: ctx.client.deviceId } : {}),
        },
        link: null,
        detach: [],
        endpoints: new Map(),
        resyncing: false,
        stale: new Set(),
        staleReason: "reattached",
        openedOnLink: new Set(),
        createdOnLink: new Set(),
        refusedOnLink: new Map(),
        told: {
          assistant: new Map(),
          agents: new Map(),
          resident: new Map(),
          mcpBinding: new Map(),
        },
        answerRetry: { assistant: null, agents: null, resident: null, mcpBinding: null },
        overHighWaterTimer: null,
        handle: undefined as unknown as EndpointSessionHandle,
        lastActiveAt: null,
        unsendableChannels: new Set(),
      };
      created.handle = {
        sessionId: created.sessionId,
        client: created.client,
        link: () => created.link,
      };
      state = created;
      this.states.set(ctx.sessionId, state);
    }
    const resumed = state.link === null && state.endpoints.size > 0;
    this.bindLink(state, ctx.session);
    if (resumed) this.notifyTransport(state, true);
    this.publishFrontendCount();
  }

  private notifyTransport(state: SessionState, attached: boolean): void {
    const endpointIds = [...state.endpoints.values()].map((endpoint) => endpoint.endpointId);
    if (endpointIds.length === 0) return;
    for (const listener of [...this.transportListeners]) {
      try {
        listener(endpointIds, attached);
      } catch (error) {
        console.error("[SessionHost] transport-change listener failed:", error);
      }
    }
  }

  /**
   * Handlers are attached synchronously: the server dispatches whatever
   * followed HELLO in the same read as soon as this returns.
   */
  private bindLink(state: SessionState, link: LinkSession): void {
    this.unbindLink(state);
    state.link = link;
    state.openedOnLink.clear();
    state.createdOnLink.clear();
    state.refusedOnLink.clear();
    const s = state;
    s.detach.push(
      link.on(Lane.CONTROL, ControlKind.ENDPOINT_OPEN, (body) =>
        this.openEndpoint(s, body.endpointId, body.projectId, body.openId)
      ),
      link.on(Lane.CONTROL, ControlKind.ENDPOINT_REBIND, (body) =>
        this.rebindEndpoint(s, body.endpointId, body.projectId)
      ),
      link.on(Lane.CONTROL, ControlKind.ENDPOINT_CLOSE, (body) => {
        s.refusedOnLink.delete(body.endpointId);
        s.endpoints.get(body.endpointId)?.close("client-closed");
      }),
      link.onWritable(() => this.maybeFinishResync(s)),
      link.registerCallHandler(LinkMethod.HOST_INFO, EmptyPayloadSchema, () =>
        (this.options.hostInfo ?? defaultHostInfo)()
      ),
      link.registerCallHandler(
        LinkMethod.DESCRIBE_PROJECT,
        DescribeProjectPayloadSchema,
        ({ projectId }) => this.options.describeProject?.(projectId) ?? null
      ),
      link.registerCallHandler(LinkMethod.LIST_PROJECTS, EmptyPayloadSchema, () =>
        (this.options.listProjects?.() ?? []).slice(0, MAX_LISTED_PROJECTS)
      ),
      link.registerCallHandler(
        LinkMethod.NOTE_ACTIVE_PROJECT,
        DescribeProjectPayloadSchema,
        ({ projectId }) => {
          this.noteActiveProject(s.client, projectId);
          return null;
        }
      ),
      link.registerCallHandler(LinkMethod.LAST_ACTIVE_PROJECT, EmptyPayloadSchema, () =>
        this.lastActiveProject(s.client)
      ),
      link.registerCallHandler(
        LinkMethod.ENDPOINT_RECONCILE,
        EndpointReconcilePayloadSchema,
        ({ endpointIds }) => this.reconcileEndpoints(s, endpointIds)
      ),
      link.onClose(() => {
        if (s.link !== link) return;
        this.unbindLink(s);
        // Whatever is pushed while the Shell is away is lost to it.
        for (const id of s.endpoints.keys()) s.stale.add(id);
        s.staleReason = "reattached";
        for (const answer of ENDPOINT_ANSWERS) s.told[answer].clear();
        this.notifyTransport(s, false);
        this.publishFrontendCount();
      })
    );
    link.setInvokeHandler((message) => {
      const endpoint = s.endpoints.get(message.endpointId);
      if (!endpoint || endpoint.isClosed()) {
        return Promise.resolve(
          appErrorEnvelope("NOT_FOUND", `No endpoint ${message.endpointId} on this host`)
        );
      }
      return this.options.dispatcher
        .invokeForEndpoint({ endpoint, client: s.client }, message.channel, message.args)
        .then(transportSafe);
    });
    link.setSendHandler((message) => {
      const endpoint = s.endpoints.get(message.endpointId);
      if (!endpoint || endpoint.isClosed()) return;
      this.options.dispatcher.sendForEndpoint(
        { endpoint, client: s.client },
        message.channel,
        message.args
      );
    });
    if (s.stale.size > 0 && !s.resyncing) this.announceResync(s);
    for (const answer of ENDPOINT_ANSWERS) this.announce(s, answer);
  }

  private unbindLink(state: SessionState): void {
    for (const off of state.detach.splice(0)) off();
    const link = state.link;
    if (link) {
      link.setInvokeHandler(null);
      link.setSendHandler(null);
    }
    state.link = null;
    state.resyncing = false;
    this.clearOverHighWater(state);
    for (const answer of ENDPOINT_ANSWERS) {
      const retry = state.answerRetry[answer];
      if (retry) clearTimeout(retry);
      state.answerRetry[answer] = null;
    }
  }

  private openEndpoint(
    state: SessionState,
    clientEndpointId: string,
    projectId: string | null,
    openId: string | undefined
  ) {
    const existing = state.endpoints.get(clientEndpointId);
    if (existing && !existing.isClosed()) {
      if (openId === undefined || existing.openId === null || existing.openId === openId) {
        state.openedOnLink.add(clientEndpointId);
        this.rebindEndpoint(state, clientEndpointId, projectId);
        return;
      }
      // The Shell closed this view and opened it again, and the close was lost
      // with a dropped link: the reopened view starts afresh, as it would have.
      existing.close("client-closed");
    }
    state.refusedOnLink.delete(clientEndpointId);
    if (state.endpoints.size >= this.maxEndpoints) {
      logger.warn("Remote session is at its endpoint cap; ignoring a view", {
        sessionId: state.sessionId,
        clientId: state.client.clientId,
        clientEndpointId,
        maxEndpoints: this.maxEndpoints,
      });
      state.refusedOnLink.set(clientEndpointId, { projectId, openId });
      const oldest = state.refusedOnLink.keys().next().value;
      if (state.refusedOnLink.size > this.maxEndpoints && oldest !== undefined) {
        state.refusedOnLink.delete(oldest);
      }
      return;
    }
    const endpoint = new RemoteViewEndpoint(
      {
        endpointId: `remote:${state.sessionId}:${clientEndpointId}`,
        clientEndpointId,
        clientId: state.client.clientId,
        linkSessionId: state.sessionId,
        projectId,
        openId,
      },
      this.transportFor(state)
    );
    state.endpoints.set(clientEndpointId, endpoint);
    state.openedOnLink.add(clientEndpointId);
    state.createdOnLink.add(clientEndpointId);
    logger.info("Remote view endpoint opened", describeEndpoint(endpoint));
    // A new endpoint has no assistant yet, which is what the Shell assumes.
    // Its project's agents may already be working, so that answer is owed.
    state.told.assistant.set(clientEndpointId, false);
    endpoint.onClose(() => {
      logger.info("Remote view endpoint closed", {
        ...describeEndpoint(endpoint),
        cause: endpoint.closeCause,
      });
      if (state.endpoints.get(clientEndpointId) === endpoint) {
        state.endpoints.delete(clientEndpointId);
        state.stale.delete(clientEndpointId);
        state.openedOnLink.delete(clientEndpointId);
        state.createdOnLink.delete(clientEndpointId);
        for (const answer of ENDPOINT_ANSWERS) state.told[answer].delete(clientEndpointId);
        this.publishFrontendCount();
      }
    });
    this.options.registry.add(endpoint);
    // Opening a view here is using the host.
    state.lastActiveAt = Date.now();
    this.publishFrontendCount();
    this.announce(state, "agents");
    this.announce(state, "resident");
    this.announce(state, "mcpBinding");
    for (const listener of [...this.openedListeners]) {
      try {
        listener(endpoint, state.handle);
      } catch (error) {
        console.error("[SessionHost] endpoint-opened listener failed:", error);
      }
    }
  }

  private rebindEndpoint(state: SessionState, clientEndpointId: string, projectId: string | null) {
    const endpoint = state.endpoints.get(clientEndpointId);
    if (!endpoint || endpoint.isClosed()) {
      // Moved since its open was refused: opened where it is now, if room is made.
      const refused = state.refusedOnLink.get(clientEndpointId);
      if (refused) refused.projectId = projectId;
      return;
    }
    if (endpoint.projectId === projectId) return;
    logger.info("Remote view endpoint rebound", {
      ...describeEndpoint(endpoint),
      nextProjectId: projectId,
    });
    this.options.registry.rebind(endpoint.endpointId, projectId);
    endpoint.markRebound();
    // Switching project in a view is using the host.
    state.lastActiveAt = Date.now();
    this.publishFrontendCount();
    // The assistant was the old project's, and the move revokes it. The Shell
    // drops the other answers when the view moves, so the new project's are
    // owed even when they read the same as the old project's.
    state.told.agents.delete(clientEndpointId);
    state.told.resident.delete(clientEndpointId);
    state.told.mcpBinding.delete(clientEndpointId);
    for (const answer of ENDPOINT_ANSWERS) this.announce(state, answer);
  }

  /**
   * A resumed Shell holds `held` and has repeated each one's open on this
   * link. Any other endpoint kept for it was closed in a frame the drop lost;
   * one of `held` this link had to create was opened in one, and its view
   * missed everything sent since.
   */
  private reconcileEndpoints(state: SessionState, held: string[]): null {
    const holds = new Set(held);
    const lost = [...state.endpoints.values()].filter(
      (endpoint) =>
        !holds.has(endpoint.clientEndpointId) &&
        !state.openedOnLink.has(endpoint.clientEndpointId) &&
        !endpoint.isClosed()
    );
    if (lost.length > 0) {
      logger.info("Closing remote view endpoints whose close a dropped link lost", {
        sessionId: state.sessionId,
        clientId: state.client.clientId,
        clientEndpointIds: lost.map((endpoint) => endpoint.clientEndpointId),
      });
    }
    // The ordinary close, so the lease, streams and rings go as they would have.
    for (const endpoint of lost) endpoint.close("client-closed");
    // Opens the lost ones crowded out of the endpoint cap get their room now,
    // before the views' stream requests queued behind this call arrive.
    for (const [id, refused] of [...state.refusedOnLink]) {
      this.openEndpoint(state, id, refused.projectId, refused.openId);
    }
    for (const id of holds) if (state.createdOnLink.has(id)) state.stale.add(id);
    if (state.stale.size > 0 && !state.resyncing) this.announceResync(state);
    return null;
  }

  private transportFor(state: SessionState): RemoteEndpointTransport {
    return {
      sendEvent: (endpoint, frame) => this.sendEvent(state, endpoint, frame),
      request: (endpoint, method, payload, options) =>
        this.request(state, endpoint, method, payload, options),
    };
  }

  private request(
    state: SessionState,
    endpoint: RemoteViewEndpoint,
    method: string,
    payload: unknown,
    options: EndpointRequestOptions | undefined
  ): Promise<unknown> {
    const link = state.link;
    if (!link || !link.isOpen) {
      return Promise.reject(
        new AppError({
          code: "HOST_DISCONNECTED",
          message: `Shell for ${endpoint.endpointId} is not attached`,
        })
      );
    }
    return link.reverseRequest(endpoint.clientEndpointId, method, payload, options);
  }

  private sendEvent(state: SessionState, endpoint: RemoteViewEndpoint, frame: HostFrame): void {
    const link = state.link;
    if (!link || !link.isOpen || state.resyncing) {
      state.stale.add(endpoint.clientEndpointId);
      return;
    }
    let result;
    try {
      result = link.post({
        lane: Lane.EVENTS,
        kind: EventKind.EVENT,
        body: { endpointId: endpoint.clientEndpointId, channel: frame.channel, args: frame.args },
      });
    } catch (error) {
      // Unencodable or oversized: only this event is lost, but the Shell's view
      // of it is now wrong, so it repaints.
      if (!state.unsendableChannels.has(frame.channel)) {
        state.unsendableChannels.add(frame.channel);
        logger.warn("Dropped an event to a remote view; later ones on its channel go unlogged", {
          ...describeEndpoint(endpoint),
          channel: frame.channel,
          reason: formatErrorMessage(error, "unsendable"),
        });
      }
      state.stale.add(endpoint.clientEndpointId);
      state.staleReason = "overflow";
      this.maybeFinishResync(state);
      return;
    }
    if (result === "refused") {
      this.startResync(state);
      state.stale.add(endpoint.clientEndpointId);
    } else if (result === "over-high-water") {
      this.armOverHighWater(state);
    }
  }

  private armOverHighWater(state: SessionState): void {
    if (state.overHighWaterTimer) return;
    const timer = setTimeout(() => {
      if (state.overHighWaterTimer !== timer) return;
      state.overHighWaterTimer = null;
      const link = state.link;
      if (link && link.queuedBytes(Lane.EVENTS) > this.highWaterBytes) this.startResync(state);
    }, this.graceMs);
    timer.unref?.();
    state.overHighWaterTimer = timer;
  }

  private clearOverHighWater(state: SessionState): void {
    if (state.overHighWaterTimer) clearTimeout(state.overHighWaterTimer);
    state.overHighWaterTimer = null;
  }

  private startResync(state: SessionState): void {
    if (state.resyncing) return;
    state.resyncing = true;
    state.staleReason = "overflow";
    this.clearOverHighWater(state);
    for (const id of state.endpoints.keys()) state.stale.add(id);
    logger.warn("Remote Shell is not keeping up; dropping its events until it resyncs", {
      sessionId: state.sessionId,
      clientId: state.client.clientId,
      clientName: state.client.clientName,
      endpointCount: state.endpoints.size,
    });
  }

  /** Resume delivery once everything already queued has gone out. */
  private maybeFinishResync(state: SessionState): void {
    const link = state.link;
    if (!link || !link.isOpen) return;
    if (!state.resyncing && state.stale.size === 0) return;
    if (link.queuedBytes(Lane.EVENTS) > 0) return;
    // Cleared even when every stale endpoint has since closed, or later
    // endpoints would have their events dropped with nothing left to announce.
    state.resyncing = false;
    this.announceResync(state);
  }

  private announceResync(state: SessionState): void {
    const link = state.link;
    if (!link || !link.isOpen) return;
    const payload: EndpointResyncPayload = {
      endpointIds: [...state.stale].filter((id) => state.endpoints.has(id)),
      reason: state.staleReason,
    };
    state.stale.clear();
    if (payload.endpointIds.length === 0) return;
    void link.call(LinkMethod.ENDPOINT_RESYNC, payload).catch(() => {
      // Keep the Shell owing a resync: retried on the next write pass while
      // this link lives, and announced on reattach if it doesn't.
      if (state.link !== link && state.link !== null) return;
      for (const id of payload.endpointIds) if (state.endpoints.has(id)) state.stale.add(id);
      state.staleReason = payload.reason;
    });
  }

  private announce(state: SessionState, answer: EndpointAnswer): void {
    const read = this.answerReader(answer);
    const link = state.link;
    if (!read || !link || !link.isOpen) return;
    const told = state.told[answer];
    const changed: Array<{ endpointId: string; projectId: string | null; value: boolean }> = [];
    for (const [id, endpoint] of state.endpoints) {
      if (endpoint.isClosed()) continue;
      let value: boolean;
      try {
        value = read(endpoint);
      } catch (error) {
        console.error(`[SessionHost] ${answer} answer read failed:`, error);
        continue;
      }
      if (told.get(id) === value) continue;
      told.set(id, value);
      changed.push({ endpointId: id, projectId: endpoint.projectId, value });
    }
    if (changed.length === 0) return;
    const call = this.callAnswer(link, answer, changed);
    void call.catch((error: unknown) => {
      // A Shell from before this call refuses it, and always will.
      const code = (error as { code?: unknown } | null)?.code;
      if (code === "UNSUPPORTED" || code === "VALIDATION") return;
      // The Shell may not have heard: owe it these answers again. A link that
      // dropped hears everything when it reattaches; one still attached (its
      // request allowance was full, say) is asked again shortly, since a
      // missed start leaves its view open to eviction until something else
      // changes.
      for (const { endpointId, value } of changed) {
        if (told.get(endpointId) === value) told.delete(endpointId);
      }
      if (state.link !== link || !link.isOpen || state.answerRetry[answer]) return;
      const retry = setTimeout(() => {
        state.answerRetry[answer] = null;
        this.announce(state, answer);
      }, ANSWER_RETRY_MS);
      retry.unref?.();
      state.answerRetry[answer] = retry;
    });
  }

  private answerReader(
    answer: EndpointAnswer
  ): ((endpoint: RemoteViewEndpoint) => boolean) | undefined {
    switch (answer) {
      case "assistant":
        return this.options.assistantLive;
      case "agents":
        return this.options.agentActive;
      case "resident":
        return this.options.keepResident;
      case "mcpBinding":
        return this.options.mcpBindingLive;
    }
  }

  private callAnswer(
    link: LinkSession,
    answer: EndpointAnswer,
    changed: Array<{ endpointId: string; projectId: string | null; value: boolean }>
  ): Promise<unknown> {
    switch (answer) {
      case "assistant":
        return link.call(LinkMethod.ENDPOINT_ASSISTANT, {
          endpoints: changed.map(({ endpointId, projectId, value }) => ({
            endpointId,
            projectId,
            live: value,
          })),
        } satisfies EndpointAssistantPayload);
      case "agents":
        return link.call(LinkMethod.ENDPOINT_AGENT_ACTIVITY, {
          endpoints: changed.map(({ endpointId, projectId, value }) => ({
            endpointId,
            projectId,
            active: value,
          })),
        } satisfies EndpointAgentActivityPayload);
      case "resident":
        return link.call(LinkMethod.ENDPOINT_RESIDENCY, {
          endpoints: changed.map(({ endpointId, projectId, value }) => ({
            endpointId,
            projectId,
            keepResident: value,
          })),
        } satisfies EndpointResidencyPayload);
      case "mcpBinding":
        return link.call(LinkMethod.ENDPOINT_MCP_BINDING, {
          endpoints: changed.map(({ endpointId, projectId, value }) => ({
            endpointId,
            projectId,
            liveBinding: value,
          })),
        } satisfies EndpointMcpBindingPayload);
    }
  }

  private expire(sessionId: string, cause: RemoteEndpointCloseCause): void {
    const state = this.states.get(sessionId);
    if (!state) return;
    this.states.delete(sessionId);
    this.unbindLink(state);
    for (const endpoint of [...state.endpoints.values()]) endpoint.close(cause);
    state.endpoints.clear();
    this.publishFrontendCount();
  }

  private publishFrontendCount(): void {
    this.scheduleActivityExpiry();
    const count = this.attachedCount;
    if (count === this.lastFrontendCount) return;
    this.lastFrontendCount = count;
    try {
      this.options.setAttachedFrontendCount?.(count);
    } catch (error) {
      console.error("[SessionHost] setAttachedFrontendCount failed:", error);
    }
  }
}
