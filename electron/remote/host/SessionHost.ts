import os from "node:os";
import type {
  ClientRef,
  EndpointInvocation,
  EndpointRegistry,
  EndpointRequestOptions,
  HostFrame,
} from "../../ipc/endpoint.js";
import type { IpcEnvelope } from "../../../shared/types/ipc/errors.js";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";
import { AppError } from "../../utils/errorTypes.js";
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
  LinkMethod,
  type EndpointResyncPayload,
  type EndpointResyncReason,
  type HostInfo,
  type ProjectDescription,
} from "./linkMethods.js";
import { RemoteViewEndpoint, type RemoteEndpointTransport } from "./RemoteViewEndpoint.js";

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
  /** Attached Shells, for the power policy: a watched host stays awake. */
  setAttachedFrontendCount?: (count: number) => void;
  hostInfo?: () => HostInfo;
  describeProject?: (projectId: string) => ProjectDescription | null;
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

const DEFAULT_OVER_HIGH_WATER_GRACE_MS = 5_000;
const DEFAULT_MAX_ENDPOINTS_PER_SESSION = 256;

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
  overHighWaterTimer: ReturnType<typeof setTimeout> | null;
  handle: EndpointSessionHandle;
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

export class SessionHost {
  private readonly states = new Map<string, SessionState>();
  private readonly openedListeners = new Set<EndpointOpenedListener>();
  private readonly unsubscribe: Array<() => void> = [];
  private readonly highWaterBytes: number;
  private readonly graceMs: number;
  private readonly maxEndpoints: number;
  private lastFrontendCount = -1;
  private disposed = false;

  constructor(
    server: SessionHostServer,
    private readonly options: SessionHostOptions
  ) {
    this.highWaterBytes =
      options.eventsHighWaterBytes ?? DEFAULT_LANE_LIMITS[Lane.EVENTS].highWaterBytes;
    this.graceMs = options.overHighWaterGraceMs ?? DEFAULT_OVER_HIGH_WATER_GRACE_MS;
    this.maxEndpoints = options.maxEndpointsPerSession ?? DEFAULT_MAX_ENDPOINTS_PER_SESSION;
    this.unsubscribe.push(server.onSession((ctx) => this.attach(ctx)));
    this.unsubscribe.push(server.onSessionExpired((info) => this.expire(info.sessionId)));
  }

  /** Seam for bridges that follow an endpoint (terminal streams, the worktree port). */
  onEndpointOpened(listener: EndpointOpenedListener): () => void {
    this.openedListeners.add(listener);
    return () => this.openedListeners.delete(listener);
  }

  /** Shells with a live link right now. */
  get attachedCount(): number {
    let count = 0;
    for (const state of this.states.values()) if (state.link && !state.link.isClosed) count++;
    return count;
  }

  getEndpoint(sessionId: string, clientEndpointId: string): RemoteViewEndpoint | undefined {
    return this.states.get(sessionId)?.endpoints.get(clientEndpointId);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const off of this.unsubscribe.splice(0)) off();
    for (const sessionId of [...this.states.keys()]) this.expire(sessionId);
    this.openedListeners.clear();
    this.publishFrontendCount();
  }

  private attach(ctx: HostSessionContext): void {
    if (this.disposed) return;
    let state = this.states.get(ctx.sessionId);
    if (state && !ctx.resumed) {
      this.expire(ctx.sessionId);
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
        },
        link: null,
        detach: [],
        endpoints: new Map(),
        resyncing: false,
        stale: new Set(),
        staleReason: "reattached",
        overHighWaterTimer: null,
        handle: undefined as unknown as EndpointSessionHandle,
      };
      created.handle = {
        sessionId: created.sessionId,
        client: created.client,
        link: () => created.link,
      };
      state = created;
      this.states.set(ctx.sessionId, state);
    }
    this.bindLink(state, ctx.session);
    this.publishFrontendCount();
  }

  /**
   * Handlers are attached synchronously: the server dispatches whatever
   * followed HELLO in the same read as soon as this returns.
   */
  private bindLink(state: SessionState, link: LinkSession): void {
    this.unbindLink(state);
    state.link = link;
    const s = state;
    s.detach.push(
      link.on(Lane.CONTROL, ControlKind.ENDPOINT_OPEN, (body) =>
        this.openEndpoint(s, body.endpointId, body.projectId)
      ),
      link.on(Lane.CONTROL, ControlKind.ENDPOINT_REBIND, (body) =>
        this.rebindEndpoint(s, body.endpointId, body.projectId)
      ),
      link.on(Lane.CONTROL, ControlKind.ENDPOINT_CLOSE, (body) =>
        s.endpoints.get(body.endpointId)?.close()
      ),
      link.onWritable(() => this.maybeFinishResync(s)),
      link.registerCallHandler(LinkMethod.HOST_INFO, EmptyPayloadSchema, () =>
        (this.options.hostInfo ?? defaultHostInfo)()
      ),
      link.registerCallHandler(
        LinkMethod.DESCRIBE_PROJECT,
        DescribeProjectPayloadSchema,
        ({ projectId }) => this.options.describeProject?.(projectId) ?? null
      ),
      link.onClose(() => {
        if (s.link !== link) return;
        this.unbindLink(s);
        // Whatever is pushed while the Shell is away is lost to it.
        for (const id of s.endpoints.keys()) s.stale.add(id);
        s.staleReason = "reattached";
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
  }

  private openEndpoint(state: SessionState, clientEndpointId: string, projectId: string | null) {
    const existing = state.endpoints.get(clientEndpointId);
    if (existing && !existing.isClosed()) {
      this.rebindEndpoint(state, clientEndpointId, projectId);
      return;
    }
    if (state.endpoints.size >= this.maxEndpoints) {
      console.warn(
        `[SessionHost] Session ${state.sessionId} is at its endpoint cap; ignoring ${clientEndpointId}`
      );
      return;
    }
    const endpoint = new RemoteViewEndpoint(
      {
        endpointId: `remote:${state.sessionId}:${clientEndpointId}`,
        clientEndpointId,
        clientId: state.client.clientId,
        projectId,
      },
      this.transportFor(state)
    );
    state.endpoints.set(clientEndpointId, endpoint);
    endpoint.onClose(() => {
      if (state.endpoints.get(clientEndpointId) === endpoint) {
        state.endpoints.delete(clientEndpointId);
        state.stale.delete(clientEndpointId);
      }
    });
    this.options.registry.add(endpoint);
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
    if (!endpoint || endpoint.isClosed() || endpoint.projectId === projectId) return;
    this.options.registry.rebind(endpoint.endpointId, projectId);
    endpoint.markRebound();
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
      console.warn(
        `[SessionHost] Dropped event ${frame.channel}: ${formatErrorMessage(error, "unsendable")}`
      );
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
    console.warn(
      `[SessionHost] Shell ${state.client.clientName} is not keeping up; dropping its events until it resyncs`
    );
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

  private expire(sessionId: string): void {
    const state = this.states.get(sessionId);
    if (!state) return;
    this.states.delete(sessionId);
    this.unbindLink(state);
    for (const endpoint of [...state.endpoints.values()]) endpoint.close();
    state.endpoints.clear();
    this.publishFrontendCount();
  }

  private publishFrontendCount(): void {
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
