import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type net from "node:net";
import { z } from "zod";

type InvokeListener = (event: unknown, ...args: unknown[]) => unknown;

const { handlers, ipcMainMock, projectKeys } = vi.hoisted(() => {
  const handlers = new Map<string, InvokeListener>();
  return {
    handlers,
    projectKeys: new Map<number, string>(),
    ipcMainMock: {
      handle: (channel: string, listener: InvokeListener) => {
        handlers.set(channel, listener);
      },
      handleOnce: (channel: string, listener: InvokeListener) => {
        handlers.set(channel, listener);
      },
      removeHandler: (channel: string) => {
        handlers.delete(channel);
      },
      on: () => undefined,
      removeListener: () => undefined,
      removeAllListeners: () => undefined,
      off: () => undefined,
    },
  };
});

vi.mock("electron", () => ({
  app: { isPackaged: false, on: () => undefined },
  ipcMain: ipcMainMock,
  session: { defaultSession: {}, fromPartition: () => ({}) },
}));

vi.mock("../../../../shared/utils/trustedRenderer.js", () => ({
  isTrustedRendererUrl: vi.fn(() => true),
}));

vi.mock("../../../services/TelemetryService.js", () => ({
  getCurrentCorrelationId: vi.fn(() => "corr-1"),
}));

vi.mock("../../../window/webContentsRegistry.js", () => ({
  getWindowForWebContents: vi.fn(() => null),
  getProjectForWebContents: (id: number) => projectKeys.get(id) ?? null,
  getAppWebContents: vi.fn(),
  getAllAppWebContents: vi.fn(() => []),
  getWebContentsForProject: vi.fn(() => []),
  hasRegisteredProjectViews: vi.fn(() => false),
  isCachedViewWebContents: vi.fn(() => false),
}));

import { enforceIpcSenderValidation } from "../../../setup/security.js";
import { _resetIpcGuardForTesting } from "../../../ipc/ipcGuard.js";
import {
  broadcastToProjectRenderers,
  broadcastToRenderer,
  typedHandleWithContext,
} from "../../../ipc/utils.js";
import { CHANNELS } from "../../../ipc/channels.js";
import { getIpcDispatcher } from "../../../ipc/dispatcher.js";
import {
  getEndpointRegistry,
  _resetEndpointRegistryForTesting,
} from "../../../ipc/endpointRegistry.js";
import { _resetLocalEndpointsForTesting } from "../../../ipc/localEndpoint.js";
import type { IpcContext } from "../../../ipc/types.js";
import { AppError } from "../../../utils/errorTypes.js";
import { logBuffer } from "../../../services/LogBuffer.js";
import { wrapSuccess } from "../../../../shared/utils/ipcErrorSerialization.js";
import type { IpcEnvelope } from "../../../../shared/types/ipc/errors.js";
import type { HostDescriptor } from "../../../../shared/types/remoteHosts.js";
import { HostServer } from "../../host/HostServer.js";
import { hostSocketLocation } from "../../host/hostSocketPath.js";
import { SessionHost, type SessionHostOptions } from "../../host/SessionHost.js";
import { Lane } from "../../link/frames.js";
import { DEFAULT_LANE_LIMITS } from "../../link/scheduler.js";
import {
  TEST_HANDSHAKE,
  makeTempDir,
  removeTempDir,
  waitFor,
} from "../../link/__tests__/linkTestUtils.js";
import { HostRegistry, type RemoteHostsStore } from "../HostRegistry.js";
import {
  HOST_PROJECT_LOOKUP_TIMEOUT_MS,
  RemoteHostManager,
  type HostConnection,
  type ReverseRequestAnswerer,
  type ViewSink,
} from "../RemoteHostManager.js";
import { RemoteRouterImpl } from "../RemoteRouter.js";
import { HostModeOffError, createDirectTransport, type LinkTransport } from "../transport.js";
import { WindowHostBinding } from "../WindowHostBinding.js";
import { installHostMetricsHostWith } from "../../metrics/hostMetricsHost.js";
import { MetricsLinkMethod } from "../../metrics/linkMethods.js";
import { LinkMethod } from "../../host/linkMethods.js";
import type { LinkSession } from "../../link/session.js";
import { ControlKind, EventKind } from "../../link/messages.js";

const HOST_CHANNEL = "git:get-file-diff";
const SHELL_CHANNEL = "window:new";
const EVENT_CHANNEL = "terminal:data";
// A host channel the harness host never registers, as one build's host lacks a newer one's.
const MISSING_ON_HOST = "plugin:project-surfaces-get";
const HOST_ID = "studio-01";

const VIEW_A = 11; // studio-01:proj-1
const VIEW_B = 12; // studio-01:proj-2
const VIEW_LOCAL = 13; // proj-1 on this machine
const VIEW_C = 14; // studio-01:proj-1, a second view of the project

function memoryStore(): RemoteHostsStore {
  let value: { hosts: HostDescriptor[] } | undefined;
  return {
    get: () => value,
    set: (_key, next) => {
      value = next;
    },
  };
}

function sender(id: number) {
  return {
    sender: { id, isDestroyed: () => false, send: vi.fn(), once: vi.fn() },
    senderFrame: { url: "app://daintree/index.html" },
  };
}

function invoke(channel: string, fromView: number, ...args: unknown[]): Promise<IpcEnvelope> {
  const listener = handlers.get(channel);
  if (!listener) throw new Error(`no handler for ${channel}`);
  return listener(sender(fromView), ...args) as Promise<IpcEnvelope>;
}

function recordingSink() {
  const delivered = new Map<number, Array<{ channel: string; args: unknown[] }>>();
  const resyncs: Array<{ webContentsId: number; reason: string }> = [];
  const activated: number[] = [];
  const goneListeners = new Map<number, () => void>();
  const hosts = new Map<number, string | null>();
  const sink: ViewSink = {
    send(webContentsId, channel, args) {
      const list = delivered.get(webContentsId) ?? [];
      list.push({ channel, args });
      delivered.set(webContentsId, list);
      return true;
    },
    watch: (webContentsId, onGone) => {
      goneListeners.set(webContentsId, onGone);
      return () => goneListeners.delete(webContentsId);
    },
    resync(webContentsId, _hostId, reason) {
      resyncs.push({ webContentsId, reason });
    },
    // Views default to the host the test talks to; a test can move one away.
    hostOf: (webContentsId) => (hosts.has(webContentsId) ? hosts.get(webContentsId)! : HOST_ID),
    agentActivated: (webContentsId) => activated.push(webContentsId),
  };
  /** The view was destroyed. */
  const gone = (webContentsId: number) => goneListeners.get(webContentsId)?.();
  return { sink, delivered, resyncs, activated, gone, hosts };
}

interface Harness {
  dir: string;
  server: HostServer;
  sessionHost: SessionHost;
  frontendCounts: number[];
  manager: RemoteHostManager;
  sink: ReturnType<typeof recordingSink>;
  sockets: net.Socket[];
  allowConnect: { value: boolean; hostModeOff?: boolean };
}

const cleanups: Array<() => unknown> = [];
let h: Harness;

async function startHarness(
  options: {
    eventsLimits?: { high: number; cap: number };
    maxEndpoints?: number;
    reverseRequests?: ReverseRequestAnswerer;
    assistantLive?: SessionHostOptions["assistantLive"];
    agentActive?: SessionHostOptions["agentActive"];
    mcpBindingLive?: SessionHostOptions["mcpBindingLive"];
    resumeGraceMs?: number;
  } = {}
) {
  const dir = await makeTempDir();
  const location = hostSocketLocation({ platform: "darwin", userDataDir: dir });
  const laneLimits = options.eventsLimits
    ? {
        ...DEFAULT_LANE_LIMITS,
        [Lane.EVENTS]: {
          highWaterBytes: options.eventsLimits.high,
          hardCapBytes: options.eventsLimits.cap,
          maxFrames: 65536,
        },
      }
    : undefined;
  const server = new HostServer({
    location,
    handshake: TEST_HANDSHAKE,
    hostName: "studio",
    resumeGraceMs: options.resumeGraceMs ?? 150,
    session: { pingIntervalMs: 0, idleTimeoutMs: 0, laneLimits },
  });
  await server.listen();
  const frontendCounts: number[] = [];
  const sessionHost = new SessionHost(server, {
    dispatcher: getIpcDispatcher(),
    registry: getEndpointRegistry(),
    setAttachedFrontendCount: (n) => frontendCounts.push(n),
    describeProject: (projectId) =>
      projectId === "proj-1" ? { projectId, path: "/srv/proj-1", name: "one" } : null,
    listProjects: () => [
      { id: "proj-1", name: "one", path: "/srv/proj-1", emoji: "🌲", frontendAttached: false },
      // Only the listed fields cross the link, whatever else the store holds.
      { id: "proj-2", name: "two", path: "/srv/proj-2", status: "active" } as never,
    ],
    eventsHighWaterBytes: options.eventsLimits?.high,
    maxEndpointsPerSession: options.maxEndpoints,
    assistantLive: options.assistantLive,
    agentActive: options.agentActive,
    mcpBindingLive: options.mcpBindingLive,
  });

  const registry = new HostRegistry(memoryStore());
  registry.add({ name: HOST_ID, connection: { kind: "ssh", target: "studio.example" } });
  const sink = recordingSink();
  const sockets: net.Socket[] = [];
  const allowConnect: { value: boolean; hostModeOff?: boolean } = { value: true };
  const direct = createDirectTransport({ socketPath: location.socketPath, token: server.token });
  const transport: LinkTransport = {
    async open(signal) {
      if (allowConnect.hostModeOff) {
        throw new HostModeOffError("Daintree isn't running in Host mode there (no host.json).");
      }
      if (!allowConnect.value) throw new Error("host unreachable");
      const connection = await direct.open(signal);
      sockets.push(connection.socket as net.Socket);
      return connection;
    },
  };
  const manager = new RemoteHostManager({
    registry,
    createTransport: () => transport,
    handshake: () => TEST_HANDSHAKE,
    client: { clientId: "client-1", clientName: "greg-mbp", platform: "darwin" },
    views: sink.sink,
    reverseRequests: options.reverseRequests,
    session: { pingIntervalMs: 0, idleTimeoutMs: 0 },
    backoff: { initialMs: 20, maxMs: 40, jitter: 0 },
  });
  const router = new RemoteRouterImpl(manager, new WindowHostBinding(), {
    projectKeyFor: (id) => projectKeys.get(id) ?? null,
    windowIdFor: () => null,
  });
  getIpcDispatcher().setRemoteRouter(router);

  h = { dir, server, sessionHost, frontendCounts, manager, sink, sockets, allowConnect };
  cleanups.push(async () => {
    getIpcDispatcher().setRemoteRouter(null);
    await manager.disposeAll();
    sessionHost.dispose();
    await server.close();
    await removeTempDir(dir);
  });
  return h;
}

async function connect(): Promise<void> {
  h.manager.connect(HOST_ID);
  await waitFor(() => h.manager.get(HOST_ID)?.unavailableEnvelope() === null);
}

const hostContexts: IpcContext[] = [];
// enforceIpcSenderValidation wraps ipcMain; restore the bare mock so wrappers never stack.
const bareIpcMain = { ...ipcMainMock };

beforeEach(() => {
  Object.assign(ipcMainMock, bareIpcMain);
  handlers.clear();
  hostContexts.length = 0;
  projectKeys.clear();
  projectKeys.set(VIEW_A, `${HOST_ID}:proj-1`);
  projectKeys.set(VIEW_B, `${HOST_ID}:proj-2`);
  projectKeys.set(VIEW_LOCAL, "proj-1");
  _resetIpcGuardForTesting();
  _resetEndpointRegistryForTesting();
  _resetLocalEndpointsForTesting();
  enforceIpcSenderValidation();
  cleanups.push(
    typedHandleWithContext(
      HOST_CHANNEL as never,
      ((ctx: IpcContext, payload: { fail?: boolean }) => {
        hostContexts.push(ctx);
        if (payload?.fail) {
          throw new AppError({
            code: "PLUGIN_NOT_ON_HOST",
            message: "plugin missing at /Users/greg/secret",
            context: { path: "/Users/greg/secret" },
            details: { code: "PLUGIN_NOT_ON_HOST", pluginId: "acme", hostId: HOST_ID },
          });
        }
        return { answeredFor: ctx.projectId, remote: ctx.endpoint.kind === "remote-view" };
      }) as never
    ),
    typedHandleWithContext(
      SHELL_CHANNEL as never,
      ((ctx: IpcContext) => ({ ranLocally: ctx.event !== null })) as never
    )
  );
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("remote session wiring", () => {
  it("answers a host's request to a view through the Shell's answerer, on fresh and resumed sessions", async () => {
    const answerer = vi.fn<ReverseRequestAnswerer>(async (request) => ({
      echoed: request.payload,
    }));
    await startHarness({ reverseRequests: answerer });
    await connect();
    await invoke(HOST_CHANNEL, VIEW_A, {});
    const endpoint = hostContexts[0]!.endpoint;

    await expect(endpoint.request("mcp:get-manifest", { n: 1 })).resolves.toEqual({
      echoed: { n: 1 },
    });
    expect(answerer).toHaveBeenCalledWith({
      hostId: HOST_ID,
      webContentsId: VIEW_A,
      method: "mcp:get-manifest",
      payload: { n: 1 },
    });

    // A resumed session is a new LinkSession; it must answer too.
    h.sockets.at(-1)!.destroy();
    await waitFor(() => h.manager.get(HOST_ID)?.unavailableEnvelope() !== null);
    await waitFor(() => h.manager.get(HOST_ID)?.unavailableEnvelope() === null);
    await expect(endpoint.request("notification.show", { n: 2 })).resolves.toEqual({
      echoed: { n: 2 },
    });
  });

  it("refuses a host's request for a view that moved to another host", async () => {
    const answerer = vi.fn<ReverseRequestAnswerer>(async () => "answered");
    await startHarness({ reverseRequests: answerer });
    await connect();
    await invoke(HOST_CHANNEL, VIEW_A, {});
    const endpoint = hostContexts[0]!.endpoint;
    h.sink.hosts.set(VIEW_A, "studio-02");

    await expect(endpoint.request("mcp:get-manifest", {})).rejects.toMatchObject({
      code: "HOST_DISCONNECTED",
    });
    expect(answerer).not.toHaveBeenCalled();
  });

  it("answers UNSUPPORTED when the Shell installed no answerer", async () => {
    await startHarness();
    await connect();
    await invoke(HOST_CHANNEL, VIEW_A, {});
    await expect(hostContexts[0]!.endpoint.request("mcp:get-manifest", {})).rejects.toMatchObject({
      code: "UNSUPPORTED",
    });
  });

  it("never takes a Shell-owned push from a host", async () => {
    await startHarness();
    await connect();
    await invoke(HOST_CHANNEL, VIEW_A, {});

    broadcastToRenderer("accessibility:support-changed", true);
    broadcastToRenderer(EVENT_CHANNEL, "term-all", "hi");
    await waitFor(() => (h.sink.delivered.get(VIEW_A)?.length ?? 0) === 1);
    expect(h.sink.delivered.get(VIEW_A)).toEqual([
      { channel: EVENT_CHANNEL, args: ["term-all", "hi"] },
    ]);
  });

  it("runs a host handler for a remote view and returns the host's envelope", async () => {
    await startHarness();
    await connect();

    const envelope = await invoke(HOST_CHANNEL, VIEW_A, {});

    expect(envelope).toEqual(wrapSuccess({ answeredFor: "proj-1", remote: true }));
    expect(hostContexts).toHaveLength(1);
    const ctx = hostContexts[0]!;
    expect(ctx.event).toBeNull();
    expect(ctx.senderWindow).toBeNull();
    expect(ctx.webContentsId).toBeLessThan(0);
    expect(ctx.client).toMatchObject({ clientName: "greg-mbp", kind: "remote" });
    expect(ctx.endpoint).toMatchObject({ kind: "remote-view", projectId: "proj-1" });
    expect(getEndpointRegistry().getByHandle(ctx.webContentsId)).toBe(ctx.endpoint);
    expect(h.frontendCounts.at(-1)).toBe(1);
  });

  it("keeps a local view local even while remote views route to the host", async () => {
    await startHarness();
    await connect();

    const envelope = await invoke(HOST_CHANNEL, VIEW_LOCAL, {});

    expect(envelope).toEqual(wrapSuccess({ answeredFor: "proj-1", remote: false }));
    expect(hostContexts[0]!.event).not.toBeNull();
    expect(getEndpointRegistry().getRemote()).toHaveLength(0);
  });

  it("round-trips an error envelope with its code and allowlisted details", async () => {
    await startHarness();
    await connect();

    const envelope = await invoke(HOST_CHANNEL, VIEW_A, { fail: true });

    expect(envelope.ok).toBe(false);
    if (envelope.ok) return;
    const error = envelope.error as typeof envelope.error & { details?: unknown };
    expect(error.code).toBe("PLUGIN_NOT_ON_HOST");
    expect(error.details).toEqual({
      code: "PLUGIN_NOT_ON_HOST",
      pluginId: "acme",
      hostId: HOST_ID,
    });
    expect(JSON.stringify(error)).not.toContain("/Users/greg/secret");
  });

  it("answers a shell channel locally for a remote-bound view", async () => {
    await startHarness();
    await connect();

    const envelope = await invoke(SHELL_CHANNEL, VIEW_A);

    expect(envelope).toEqual(wrapSuccess({ ranLocally: true }));
    expect(getEndpointRegistry().getRemote()).toHaveLength(0);
  });

  it("delivers project events only to the bound view and global events to every view", async () => {
    await startHarness();
    await connect();
    await invoke(HOST_CHANNEL, VIEW_A, {});
    await invoke(HOST_CHANNEL, VIEW_B, {});

    broadcastToProjectRenderers("proj-1", EVENT_CHANNEL, "term-1", "hello");
    await waitFor(() => (h.sink.delivered.get(VIEW_A)?.length ?? 0) === 1);
    expect(h.sink.delivered.get(VIEW_A)).toEqual([
      { channel: EVENT_CHANNEL, args: ["term-1", "hello"] },
    ]);
    expect(h.sink.delivered.get(VIEW_B)).toBeUndefined();

    broadcastToRenderer(EVENT_CHANNEL, "term-all", "hi");
    await waitFor(() => (h.sink.delivered.get(VIEW_B)?.length ?? 0) === 1);
    await waitFor(() => (h.sink.delivered.get(VIEW_A)?.length ?? 0) === 2);
    expect(h.sink.delivered.get(VIEW_B)).toEqual([
      { channel: EVENT_CHANNEL, args: ["term-all", "hi"] },
    ]);
    expect(h.sink.delivered.has(VIEW_LOCAL)).toBe(false);
  });

  it("sends a global broadcast across the link once for all of a Shell's views (#15902)", async () => {
    projectKeys.set(VIEW_C, `${HOST_ID}:proj-1`);
    await startHarness();
    const hostLinks: LinkSession[] = [];
    cleanups.push(h.server.onSession((ctx) => hostLinks.push(ctx.session)));
    await connect();
    await invoke(HOST_CHANNEL, VIEW_A, {});
    await invoke(HOST_CHANNEL, VIEW_B, {});
    await invoke(HOST_CHANNEL, VIEW_C, {});
    expect(hostLinks).toHaveLength(1);
    const post = vi.spyOn(hostLinks[0]!, "post");

    broadcastToRenderer(EVENT_CHANNEL, "term-all", "hi");

    for (const view of [VIEW_A, VIEW_B, VIEW_C]) {
      await waitFor(() => (h.sink.delivered.get(view)?.length ?? 0) === 1);
      expect(h.sink.delivered.get(view)).toEqual([
        { channel: EVENT_CHANNEL, args: ["term-all", "hi"] },
      ]);
    }
    const events = post.mock.calls
      .map(([message]) => message)
      .filter((message) => message.lane === Lane.EVENTS && message.kind === EventKind.EVENT);
    expect(events).toHaveLength(1);
    expect(events[0]!.body).toEqual({
      endpointId: null,
      channel: EVENT_CHANNEL,
      args: ["term-all", "hi"],
    });
    expect(h.sink.delivered.has(VIEW_LOCAL)).toBe(false);

    // In order with the events addressed to one view, on the same lane.
    broadcastToProjectRenderers("proj-1", EVENT_CHANNEL, "before");
    broadcastToRenderer(EVENT_CHANNEL, "all");
    broadcastToProjectRenderers("proj-1", EVENT_CHANNEL, "after");
    const history = (view: number) =>
      (h.sink.delivered.get(view) ?? []).map((event) => event.args[0]);
    await waitFor(() => history(VIEW_A).includes("after") && history(VIEW_C).includes("after"));
    for (const view of [VIEW_A, VIEW_C]) {
      expect(history(view)).toEqual(["term-all", "before", "all", "after"]);
    }
    // proj-2's view hears only the global ones, both ahead of "after" on the lane.
    expect(history(VIEW_B)).toEqual(["term-all", "all"]);
  });

  it("keeps a global broadcast from a view the host turned away at its endpoint cap", async () => {
    projectKeys.set(VIEW_C, `${HOST_ID}:proj-1`);
    await startHarness({ maxEndpoints: 2 });
    await connect();
    await invoke(HOST_CHANNEL, VIEW_A, {});
    await invoke(HOST_CHANNEL, VIEW_B, {});
    const refused = await invoke(HOST_CHANNEL, VIEW_C, {});
    expect(refused).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });

    broadcastToRenderer(EVENT_CHANNEL, "term-all", "hi");
    // Behind the broadcast on the same lane, so once it lands the broadcast has had its chance at view C.
    broadcastToRenderer(EVENT_CHANNEL, "sentinel");
    const history = (view: number) =>
      (h.sink.delivered.get(view) ?? []).map((event) => event.args[0]);
    await waitFor(() => history(VIEW_A).includes("sentinel"));
    await waitFor(() => history(VIEW_B).includes("sentinel"));
    expect(history(VIEW_A)).toEqual(["term-all", "sentinel"]);
    expect(history(VIEW_B)).toEqual(["term-all", "sentinel"]);
    expect(h.sink.delivered.has(VIEW_C)).toBe(false);
  });

  it("resolves HOST_DISCONNECTED immediately while the host is down", async () => {
    await startHarness();
    await connect();
    await h.manager.disconnect(HOST_ID);

    const started = Date.now();
    const envelope = await invoke(HOST_CHANNEL, VIEW_A, {});
    expect(Date.now() - started).toBeLessThan(500);
    expect(envelope.ok).toBe(false);
    if (!envelope.ok) expect(envelope.error.code).toBe("HOST_DISCONNECTED");
    expect(hostContexts).toHaveLength(0);
  });

  it("keeps endpoints through a dropped link and closes them after the grace window", async () => {
    await startHarness();
    await connect();
    await invoke(HOST_CHANNEL, VIEW_A, {});
    expect(getEndpointRegistry().getRemote()).toHaveLength(1);

    h.allowConnect.value = false;
    for (const socket of h.sockets) socket.destroy();
    await waitFor(() => h.frontendCounts.at(-1) === 0);
    // Inside the grace window the endpoint survives, so a resume keeps its state.
    expect(getEndpointRegistry().getRemote()).toHaveLength(1);
    const down = await invoke(HOST_CHANNEL, VIEW_A, {});
    expect(down.ok ? null : down.error.code).toBe("HOST_DISCONNECTED");

    await waitFor(() => getEndpointRegistry().getRemote().length === 0, 2_000);
  });

  it("resumes a dropped link with its endpoints and tells the view it missed events", async () => {
    await startHarness();
    await connect();
    await invoke(HOST_CHANNEL, VIEW_A, {});
    const endpoint = getEndpointRegistry().getRemote()[0]!;

    for (const socket of h.sockets) socket.destroy();
    await waitFor(() => h.frontendCounts.at(-1) === 0);
    broadcastToProjectRenderers("proj-1", EVENT_CHANNEL, "lost", "x");
    await waitFor(() => h.manager.get(HOST_ID)?.unavailableEnvelope() === null);
    await waitFor(() => h.sink.resyncs.length === 1);

    expect(h.sink.resyncs).toEqual([{ webContentsId: VIEW_A, reason: "reattached" }]);
    expect(getEndpointRegistry().getRemote()).toEqual([endpoint]);
    const envelope = await invoke(HOST_CHANNEL, VIEW_A, {});
    expect(envelope.ok).toBe(true);
    expect(hostContexts.at(-1)!.endpoint).toBe(endpoint);
    // The resume's own reconcile, answered by now, repaired nothing and repainted nothing more.
    expect(h.sink.resyncs).toHaveLength(1);
  });

  it("tells endpoint listeners when a view's endpoint opens and again on a resumed session", async () => {
    await startHarness();
    const opened: Array<{
      hostId: string;
      webContentsId: number;
      endpointId: string;
      session: unknown;
    }> = [];
    cleanups.push(h.manager.onEndpointOpened((hostId, info) => opened.push({ hostId, ...info })));
    await connect();
    expect(opened).toEqual([]);

    await invoke(HOST_CHANNEL, VIEW_A, {});
    await invoke(HOST_CHANNEL, VIEW_A, {});
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({
      hostId: HOST_ID,
      webContentsId: VIEW_A,
      endpointId: "view-11",
    });
    const first = opened[0]!.session;

    for (const socket of h.sockets) socket.destroy();
    await waitFor(() => h.frontendCounts.at(-1) === 0);
    await waitFor(() => opened.length === 2);

    expect(opened[1]).toMatchObject({
      hostId: HOST_ID,
      webContentsId: VIEW_A,
      endpointId: "view-11",
    });
    expect(opened[1]!.session).not.toBe(first);
  });

  it("drops a Shell whose event lane overflows to a snapshot resync instead of queueing", async () => {
    await startHarness({ eventsLimits: { high: 4 * 1024, cap: 16 * 1024 } });
    await connect();
    await invoke(HOST_CHANNEL, VIEW_A, {});

    const chunk = "x".repeat(1024);
    for (let i = 0; i < 200; i++)
      broadcastToProjectRenderers("proj-1", EVENT_CHANNEL, `t${i}`, chunk);

    await waitFor(() => h.sink.resyncs.length === 1);
    expect(h.sink.resyncs[0]).toEqual({ webContentsId: VIEW_A, reason: "overflow" });
    const delivered = h.sink.delivered.get(VIEW_A)?.length ?? 0;
    expect(delivered).toBeGreaterThan(0);
    expect(delivered).toBeLessThan(200);

    // Delivery resumes after the resync.
    broadcastToProjectRenderers("proj-1", EVENT_CHANNEL, "after", "y");
    await waitFor(() =>
      (h.sink.delivered.get(VIEW_A) ?? []).some((event) => event.args[0] === "after")
    );
  });

  it("routes nothing to a host on a different link protocol", async () => {
    await startHarness();
    const registry = new HostRegistry(memoryStore());
    registry.add({ name: HOST_ID, connection: { kind: "ssh", target: "studio.example" } });
    const mismatched = new RemoteHostManager({
      registry,
      createTransport: () =>
        createDirectTransport({ socketPath: h.server.socketPath, token: h.server.token }),
      handshake: () => ({ ...TEST_HANDSHAKE, protocolVersion: TEST_HANDSHAKE.protocolVersion + 1 }),
      client: { clientId: "client-2", clientName: "other", platform: "darwin" },
      views: recordingSink().sink,
      session: { pingIntervalMs: 0, idleTimeoutMs: 0 },
    });
    cleanups.push(() => mismatched.disposeAll());
    getIpcDispatcher().setRemoteRouter(
      new RemoteRouterImpl(mismatched, new WindowHostBinding(), {
        projectKeyFor: (id) => projectKeys.get(id) ?? null,
        windowIdFor: () => null,
      })
    );

    mismatched.connect(HOST_ID);
    await waitFor(() => mismatched.connectionState(HOST_ID).status === "version-mismatch");
    const state = mismatched.connectionState(HOST_ID);
    expect(state).toMatchObject({ status: "version-mismatch", remote: { version: "1.2.3" } });

    const envelope = await invoke(HOST_CHANNEL, VIEW_A, {});
    expect(envelope.ok ? null : envelope.error.code).toBe("HOST_VERSION_MISMATCH");
    expect(hostContexts).toHaveLength(0);
    expect(getEndpointRegistry().getRemote()).toHaveLength(0);
    expect(registry.get(HOST_ID)?.lastHandshake?.version).toBe("1.2.3");
  });

  it("routes to a host on a different version, best effort, carrying the difference", async () => {
    await startHarness();
    const registry = new HostRegistry(memoryStore());
    registry.add({ name: HOST_ID, connection: { kind: "ssh", target: "studio.example" } });
    const differing = new RemoteHostManager({
      registry,
      createTransport: () =>
        createDirectTransport({ socketPath: h.server.socketPath, token: h.server.token }),
      handshake: () => ({ ...TEST_HANDSHAKE, version: "9.9.9" }),
      client: { clientId: "client-2", clientName: "other", platform: "darwin" },
      views: recordingSink().sink,
      session: { pingIntervalMs: 0, idleTimeoutMs: 0 },
    });
    cleanups.push(() => differing.disposeAll());
    getIpcDispatcher().setRemoteRouter(
      new RemoteRouterImpl(differing, new WindowHostBinding(), {
        projectKeyFor: (id) => projectKeys.get(id) ?? null,
        windowIdFor: () => null,
      })
    );

    differing.connect(HOST_ID);
    await waitFor(() => differing.connectionState(HOST_ID).status === "connected");
    expect(differing.connectionState(HOST_ID)).toMatchObject({
      status: "connected",
      buildMismatch: { kind: "version", local: "9.9.9", remote: "1.2.3" },
    });

    const envelope = await invoke(HOST_CHANNEL, VIEW_A, {});
    expect(envelope.ok).toBe(true);
    expect(hostContexts).toHaveLength(1);
  });

  /** A second Shell, on an older build than the harness host, routing this test's views. */
  async function connectOlderShell() {
    const registry = new HostRegistry(memoryStore());
    registry.add({ name: HOST_ID, connection: { kind: "ssh", target: "studio.example" } });
    const sink = recordingSink();
    const older = new RemoteHostManager({
      registry,
      createTransport: () =>
        createDirectTransport({ socketPath: h.server.socketPath, token: h.server.token }),
      handshake: () => ({ ...TEST_HANDSHAKE, version: "0.9.0" }),
      client: { clientId: "client-2", clientName: "other", platform: "darwin" },
      views: sink.sink,
      session: { pingIntervalMs: 0, idleTimeoutMs: 0 },
    });
    cleanups.push(() => older.disposeAll());
    getIpcDispatcher().setRemoteRouter(
      new RemoteRouterImpl(older, new WindowHostBinding(), {
        projectKeyFor: (id) => projectKeys.get(id) ?? null,
        windowIdFor: () => null,
      })
    );
    older.connect(HOST_ID);
    await waitFor(() => older.connectionState(HOST_ID).status === "connected");
    return sink;
  }

  it("names the host and both builds when a host on another build doesn't have a channel (#13918)", async () => {
    await startHarness();
    // This Shell's build has the channel; the host's never registered it.
    ipcMainMock.handle(MISSING_ON_HOST, () => "answered here");
    await connectOlderShell();

    const envelope = await invoke(MISSING_ON_HOST, VIEW_A);
    expect(envelope.ok).toBe(false);
    if (envelope.ok) return;
    expect(envelope.error.code).toBe("HOST_BUILD_SKEW");
    for (const text of [envelope.error.message, envelope.error.userMessage]) {
      expect(text).toContain(HOST_ID);
      expect(text).toContain("1.2.3");
      expect(text).toContain("0.9.0");
    }
  });

  it("logs once, with both builds, an event a host on another build sends that this build doesn't know", async () => {
    await startHarness();
    const sink = await connectOlderShell();
    await invoke(HOST_CHANNEL, VIEW_A, {});
    logBuffer.clear();

    broadcastToRenderer(CHANNELS.EVENTS_PUSH, { name: "made:up", payload: {} });
    broadcastToRenderer(CHANNELS.EVENTS_PUSH, { name: "made:up", payload: {} });
    // Shell-owned: dropped on purpose, not for want of knowing it.
    broadcastToRenderer(CHANNELS.EVENTS_PUSH, { name: "system:wake", payload: {} });
    broadcastToRenderer(EVENT_CHANNEL, "term-all", "hi");
    await waitFor(() => (sink.delivered.get(VIEW_A)?.length ?? 0) === 1);

    const drops = logBuffer
      .getFiltered({ sources: ["main:RemoteHostManager"] })
      .filter((entry) => entry.message.startsWith("Dropped a push"))
      .map((entry) => entry.context);
    expect(drops).toEqual([
      expect.objectContaining({
        hostId: HOST_ID,
        name: "made:up",
        buildMismatch: { kind: "version", local: "0.9.0", remote: "1.2.3" },
      }),
    ]);
  });

  it("keeps the plain refusal when the builds match", async () => {
    await startHarness();
    ipcMainMock.handle(MISSING_ON_HOST, () => "answered here");
    await connect();

    const envelope = await invoke(MISSING_ON_HOST, VIEW_A);
    expect(envelope.ok).toBe(false);
    if (envelope.ok) return;
    expect(envelope.error).toMatchObject({
      code: "CHANNEL_NOT_REMOTABLE",
      message: `Channel ${MISSING_ON_HOST} has no context handler on this host`,
    });
    expect(envelope.error.userMessage).toBeUndefined();
  });

  it("records when the host was last seen and its handshake", async () => {
    await startHarness();
    await connect();
    const connection = h.manager.get(HOST_ID)!;
    expect(connection.state()).toMatchObject({ status: "connected" });
    await waitFor(() => connection.hostInfo !== null);
    expect(connection.hostInfo!.platform).toMatch(/darwin|linux/);
    await expect(connection.describeProject("proj-1")).resolves.toEqual({
      projectId: "proj-1",
      path: "/srv/proj-1",
      name: "one",
    });
    await expect(connection.describeProject("nope")).resolves.toBeNull();
  });

  it("refuses to describe a project while the link is down rather than calling it missing", async () => {
    await startHarness();
    const disconnected = h.manager.connect(HOST_ID);
    expect(disconnected.currentSession).toBeNull();
    await expect(disconnected.describeProject("proj-1")).rejects.toMatchObject({
      code: "HOST_DISCONNECTED",
    });
  });

  it("lists the host's projects without binding a view, and refuses while disconnected", async () => {
    await startHarness();
    const disconnected = h.manager.connect(HOST_ID);
    if (disconnected.unavailableEnvelope() !== null) {
      await expect(disconnected.listProjects()).rejects.toMatchObject({
        code: "HOST_DISCONNECTED",
      });
    }
    await connect();
    const connection = h.manager.get(HOST_ID)!;
    // Readiness crosses as the host said it, and a host that didn't say (#14122) still lists.
    await expect(connection.listProjects()).resolves.toEqual([
      { id: "proj-1", name: "one", path: "/srv/proj-1", emoji: "🌲", frontendAttached: false },
      { id: "proj-2", name: "two", path: "/srv/proj-2" },
    ]);
    expect(getEndpointRegistry().getRemote()).toHaveLength(0);
  });

  it("gives a listing its own short deadline rather than the link's 60 s one", async () => {
    await startHarness();
    await connect();
    const connection = h.manager.get(HOST_ID)!;
    const call = vi.spyOn(connection.currentSession!, "call");
    await connection.listProjects();
    const options = call.mock.calls[0]![2] as { timeoutMs?: number } | undefined;
    expect(options?.timeoutMs).toBeLessThan(60_000);
  });

  it("fails a switch's lookups on a host that doesn't answer well before the link's 60 s", async () => {
    await startHarness();
    await connect();
    const connection = h.manager.get(HOST_ID)!;
    // The host's answers stop being read: the link stays up, nothing comes back.
    for (const socket of h.sockets) socket.pause();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const settled = (work: Promise<unknown>) => {
        const state = { done: false, error: undefined as unknown };
        work.then(
          () => (state.done = true),
          (error: unknown) => {
            state.done = true;
            state.error = error;
          }
        );
        return state;
      };
      const described = settled(connection.describeProject("proj-1"));
      const last = settled(connection.lastActiveProject());
      await vi.advanceTimersByTimeAsync(HOST_PROJECT_LOOKUP_TIMEOUT_MS - 1);
      expect([described.done, last.done]).toEqual([false, false]);
      await vi.advanceTimersByTimeAsync(1);
      expect(described.error).toMatchObject({ code: "OUTCOME_UNKNOWN" });
      expect(last.error).toMatchObject({ code: "OUTCOME_UNKNOWN" });
      expect(HOST_PROJECT_LOOKUP_TIMEOUT_MS).toBeLessThan(60_000);
    } finally {
      vi.useRealTimers();
      for (const socket of h.sockets) socket.resume();
    }
  });

  it("exposes the host's open session with no view bound, and none while the link is down", async () => {
    await startHarness();
    const connection = h.manager.connect(HOST_ID);
    await connect();
    const session = connection.currentSession;
    expect(session?.isOpen).toBe(true);
    expect(getEndpointRegistry().getRemote()).toHaveLength(0);

    h.allowConnect.value = false;
    for (const socket of h.sockets) socket.destroy();
    await waitFor(() => connection.currentSession === null);

    h.allowConnect.value = true;
    await waitFor(() => connection.currentSession !== null, 2_000);
    expect(connection.currentSession).not.toBe(session);

    await h.manager.disconnect(HOST_ID);
    expect(connection.currentSession).toBeNull();
  });

  it("closes endpoints of views that went away while the link was down once it resumes", async () => {
    await startHarness({ maxEndpoints: 2 });
    await connect();
    for (let cycle = 0; cycle < 5; cycle++) {
      const view = 100 + cycle;
      projectKeys.set(view, `${HOST_ID}:proj-1`);
      const envelope = await invoke(HOST_CHANNEL, view, {});
      expect(envelope.ok).toBe(true);

      h.allowConnect.value = false;
      for (const socket of h.sockets.splice(0)) socket.destroy();
      await waitFor(() => h.frontendCounts.at(-1) === 0);
      h.sink.gone(view);
      h.allowConnect.value = true;
      await waitFor(() => h.manager.get(HOST_ID)?.unavailableEnvelope() === null);
      // Resumed, not replaced: the close owed from the outage reaches the host.
      await waitFor(() => getEndpointRegistry().getRemote().length === 0);
    }
  });

  describe("endpoint changes still queued when the link drops (#13917)", () => {
    /** A grace long enough that a busy worker still resumes rather than starting over. */
    const RESUMABLE = { resumeGraceMs: 10_000 };

    /** Run `act`, then drop the link in the same tick so what it queued is never written. */
    async function dropWith(act: (connection: HostConnection) => void): Promise<void> {
      const connection = h.manager.get(HOST_ID)!;
      const session = connection.currentSession!;
      const sessionId = connection.lastSessionId;
      act(connection);
      expect(session.queuedBytes(Lane.CONTROL)).toBeGreaterThan(0);
      for (const socket of h.sockets.splice(0)) socket.destroy();
      await waitFor(
        () => connection.currentSession !== null && connection.currentSession !== session
      );
      // Resumed, not replaced: the host kept what it had, lost frames and all.
      expect(connection.lastSessionId).toBe(sessionId);
    }

    it("opens the endpoint on resume and tells the view it missed events", async () => {
      await startHarness(RESUMABLE);
      await connect();

      await dropWith((connection) => connection.send(VIEW_B, "proj-2", HOST_CHANNEL, [{}]));

      const envelope = await invoke(HOST_CHANNEL, VIEW_B, {});
      expect(envelope).toEqual(wrapSuccess({ answeredFor: "proj-2", remote: true }));
      await waitFor(() => h.sink.resyncs.length === 1);
      expect(h.sink.resyncs).toEqual([{ webContentsId: VIEW_B, reason: "reattached" }]);
    });

    it("moves the endpoint to the view's project on resume", async () => {
      await startHarness(RESUMABLE);
      await connect();
      await invoke(HOST_CHANNEL, VIEW_A, {});
      const endpoint = getEndpointRegistry().getRemote()[0]!;

      await dropWith((connection) => connection.send(VIEW_A, "proj-2", HOST_CHANNEL, [{}]));

      await waitFor(() => endpoint.projectId === "proj-2");
      expect(getEndpointRegistry().getRemote()).toEqual([endpoint]);
    });

    it("closes the endpoint of a view closed just before the drop, and keeps the rest", async () => {
      await startHarness(RESUMABLE);
      await connect();
      await invoke(HOST_CHANNEL, VIEW_A, {});
      await invoke(HOST_CHANNEL, VIEW_B, {});
      const kept = getEndpointRegistry()
        .getRemote()
        .find((endpoint) => endpoint.projectId === "proj-1")!;
      const ghost = getEndpointRegistry()
        .getRemote()
        .find((endpoint) => endpoint.projectId === "proj-2")!;

      await dropWith(() => h.sink.gone(VIEW_B));

      await waitFor(() => ghost.isClosed());
      expect(ghost.closeCause).toBe("client-closed");
      expect(getEndpointRegistry().getRemote()).toEqual([kept]);
      const envelope = await invoke(HOST_CHANNEL, VIEW_A, {});
      expect(envelope.ok).toBe(true);
      expect(hostContexts.at(-1)!.endpoint).toBe(kept);
    });

    it("ends with the reopened view when a close and reopen under one id were both lost", async () => {
      await startHarness(RESUMABLE);
      await connect();
      await invoke(HOST_CHANNEL, VIEW_A, {});
      const closed = getEndpointRegistry().getRemote()[0]!;

      await dropWith((connection) => {
        connection.retireView(VIEW_A);
        connection.send(VIEW_A, "proj-1", HOST_CHANNEL, [{}]);
      });

      await waitFor(() => closed.isClosed());
      expect(closed.closeCause).toBe("client-closed");
      const envelope = await invoke(HOST_CHANNEL, VIEW_A, {});
      expect(envelope.ok).toBe(true);
      const reopened = hostContexts.at(-1)!.endpoint;
      expect(reopened).not.toBe(closed);
      expect(getEndpointRegistry().getRemote()).toEqual([reopened]);
    });

    it("opens a view whose repeated open the lost closes crowded out once they are gone", async () => {
      await startHarness({ ...RESUMABLE, maxEndpoints: 2 });
      await connect();
      await invoke(HOST_CHANNEL, VIEW_A, {});
      await invoke(HOST_CHANNEL, VIEW_B, {});
      const viewC = 14;
      projectKeys.set(viewC, `${HOST_ID}:proj-1`);

      await dropWith((connection) => {
        h.sink.gone(VIEW_B);
        connection.send(viewC, "proj-1", HOST_CHANNEL, [{}]);
      });

      await waitFor(() => h.sink.resyncs.some((resync) => resync.webContentsId === viewC));
      expect(h.sink.resyncs).toContainEqual({ webContentsId: viewC, reason: "reattached" });
      const envelope = await invoke(HOST_CHANNEL, viewC, {});
      expect(envelope).toEqual(wrapSuccess({ answeredFor: "proj-1", remote: true }));
      expect(getEndpointRegistry().getRemote()).toHaveLength(2);
    });

    it("asks for the reconcile before the views' streams move to the resumed session", async () => {
      await startHarness(RESUMABLE);
      await connect();
      await invoke(HOST_CHANNEL, VIEW_A, {});
      const connection = h.manager.get(HOST_ID)!;
      const askedBeforeStreams: boolean[] = [];
      let call: { mock: { calls: unknown[][] } } | null = null;
      cleanups.push(
        connection.onSessionOpened((session) => {
          call = vi.spyOn(session, "call");
        }),
        connection.onEndpointOpened(() => {
          const asked = call?.mock.calls.some(
            ([method]) => method === LinkMethod.ENDPOINT_RECONCILE
          );
          askedBeforeStreams.push(asked ?? false);
        })
      );

      for (const socket of h.sockets.splice(0)) socket.destroy();

      await waitFor(() => askedBeforeStreams.length === 1);
      expect(askedBeforeStreams).toEqual([true]);
    });

    it("still opens what was lost on a host too old to reconcile", async () => {
      await startHarness(RESUMABLE);
      // A host from before the reconcile call has no handler for it.
      cleanups.push(
        h.server.onSession(({ session }) => {
          session.registerCallHandler(LinkMethod.ENDPOINT_RECONCILE, z.unknown(), () => {
            throw new AppError({ code: "UNSUPPORTED", message: "Unknown method" });
          });
        })
      );
      await connect();
      await invoke(HOST_CHANNEL, VIEW_A, {});

      await dropWith((connection) => connection.send(VIEW_B, "proj-2", HOST_CHANNEL, [{}]));

      const envelope = await invoke(HOST_CHANNEL, VIEW_B, {});
      expect(envelope).toEqual(wrapSuccess({ answeredFor: "proj-2", remote: true }));
      expect((await invoke(HOST_CHANNEL, VIEW_A, {})).ok).toBe(true);
    });
  });

  it("delivers nothing to a view that now belongs to another host", async () => {
    await startHarness();
    await connect();
    await invoke(HOST_CHANNEL, VIEW_A, {});
    await invoke(HOST_CHANNEL, VIEW_B, {});
    h.sink.hosts.set(VIEW_A, "studio-02");

    broadcastToRenderer(EVENT_CHANNEL, "term-all", "hi");
    await waitFor(() => (h.sink.delivered.get(VIEW_B)?.length ?? 0) === 1);
    expect(h.sink.delivered.has(VIEW_A)).toBe(false);
  });

  it("reports discarded endpoints and reopens bound views' endpoints on a fresh session", async () => {
    await startHarness();
    const closed: Array<{ hostId: string; webContentsId: number; endpointId: string }> = [];
    const opened: number[] = [];
    cleanups.push(h.manager.onEndpointClosed((hostId, info) => closed.push({ hostId, ...info })));
    cleanups.push(h.manager.onEndpointOpened((_hostId, info) => opened.push(info.webContentsId)));
    await connect();
    await invoke(HOST_CHANNEL, VIEW_A, {});
    await invoke(HOST_CHANNEL, VIEW_B, {});
    opened.length = 0;
    const firstSessionId = h.manager.get(HOST_ID)!.lastSessionId;
    logBuffer.clear();

    // Past the resume grace, so the next session is a fresh one; VIEW_B moved away meanwhile.
    h.allowConnect.value = false;
    for (const socket of h.sockets.splice(0)) socket.destroy();
    await waitFor(() => getEndpointRegistry().getRemote().length === 0, 2_000);
    h.sink.hosts.set(VIEW_B, null);
    h.allowConnect.value = true;
    await waitFor(() => opened.length === 1);

    expect(opened).toEqual([VIEW_A]);
    expect(closed).toEqual([{ hostId: HOST_ID, webContentsId: VIEW_B, endpointId: "view-12" }]);
    await waitFor(() => getEndpointRegistry().getRemote().length === 1);
    // The host starts over on a fresh session and can't say what the view
    // missed, so the Shell tells the reopened view itself, once.
    expect(h.sink.resyncs).toEqual([{ webContentsId: VIEW_A, reason: "reconnected" }]);

    const secondSessionId = h.manager.get(HOST_ID)!.lastSessionId;
    expect(secondSessionId).not.toBe(firstSessionId);
    h.sink.gone(VIEW_A);
    expect(closed.at(-1)).toEqual({
      hostId: HOST_ID,
      webContentsId: VIEW_A,
      endpointId: "view-11",
    });
    await h.manager.disconnect(HOST_ID);
    expect(closed).toHaveLength(2);

    // Each close is logged under the session the endpoint lived on, with why.
    const closes = logBuffer
      .getFiltered({ sources: ["main:RemoteHostManager"] })
      .filter((entry) => entry.message === "Remote host view endpoint closed")
      .map((entry) => entry.context);
    expect(closes).toEqual([
      expect.objectContaining({
        hostId: HOST_ID,
        sessionId: firstSessionId,
        webContentsId: VIEW_B,
        endpointId: "view-12",
        cause: "view-moved",
      }),
      expect.objectContaining({
        sessionId: secondSessionId,
        webContentsId: VIEW_A,
        endpointId: "view-11",
        cause: "view-closed",
      }),
    ]);
  });

  describe("assistant liveness (#13349)", () => {
    /** Endpoint handle → the project its live assistant was launched for. */
    const live = new Map<number, string>();
    const startWithAssistants = (options: { resumeGraceMs?: number } = {}) =>
      startHarness({
        ...options,
        assistantLive: (endpoint) => live.get(endpoint.handle) === endpoint.projectId,
      });
    const handleOf = (projectId: string) =>
      getEndpointRegistry().getForProject(projectId)[0]!.handle;

    /** The host's side of each link, to say things its SessionHost wouldn't. */
    function captureHostSessions(): LinkSession[] {
      const sessions: LinkSession[] = [];
      cleanups.push(h.server.onSession((ctx) => sessions.push(ctx.session)));
      return sessions;
    }

    beforeEach(() => live.clear());

    it("tells the Shell which view has a live assistant on the host, through a dropped link", async () => {
      // A grace long enough that the reconnect below is always a resume.
      await startWithAssistants({ resumeGraceMs: 10_000 });
      await connect();
      await invoke(HOST_CHANNEL, VIEW_A, {});
      await invoke(HOST_CHANNEL, VIEW_B, {});
      const connection = h.manager.get(HOST_ID)!;
      const endpoint = getEndpointRegistry().getForProject("proj-1")[0]!;
      expect(connection.hasLiveAssistant(VIEW_A)).toBe(false);

      live.set(endpoint.handle, "proj-1");
      h.sessionHost.refreshAssistants();
      await waitFor(() => connection.hasLiveAssistant(VIEW_A));
      expect(connection.hasLiveAssistant(VIEW_B)).toBe(false);

      // Down but resumable: the host keeps the endpoint, and would still revoke
      // the assistant on the close an eviction sends once the link is back.
      h.allowConnect.value = false;
      for (const socket of h.sockets.splice(0)) socket.destroy();
      await waitFor(() => h.frontendCounts.at(-1) === 0);
      await waitFor(() => connection.unavailableEnvelope() !== null);
      expect(connection.hasLiveAssistant(VIEW_A)).toBe(true);

      // It quits while nobody is attached to hear; the resumed session says so.
      live.clear();
      h.sessionHost.refreshAssistants();
      h.allowConnect.value = true;
      await waitFor(() => connection.unavailableEnvelope() === null);
      await waitFor(() => !connection.hasLiveAssistant(VIEW_A));
      expect(getEndpointRegistry().getForProject("proj-1")).toEqual([endpoint]);
    });

    it("forgets a view's assistant when the view goes, so a reopened endpoint starts clear", async () => {
      await startWithAssistants();
      await connect();
      await invoke(HOST_CHANNEL, VIEW_A, {});
      const connection = h.manager.get(HOST_ID)!;
      const first = handleOf("proj-1");
      live.set(first, "proj-1");
      h.sessionHost.refreshAssistants();
      await waitFor(() => connection.hasLiveAssistant(VIEW_A));

      h.sink.gone(VIEW_A);
      const envelope = await invoke(HOST_CHANNEL, VIEW_A, {});
      expect(envelope.ok).toBe(true);
      expect(connection.boundViews()).toEqual([VIEW_A]);
      await waitFor(() => getEndpointRegistry().getRemote().length === 1);
      expect(handleOf("proj-1")).not.toBe(first);
      expect(connection.hasLiveAssistant(VIEW_A)).toBe(false);
    });

    it("takes the host's word only for the project the view is on now, and only well-formed", async () => {
      // No reader: the host's SessionHost says nothing, so every answer here is
      // one this test sends, and what the Shell does with it is its own doing.
      await startHarness();
      const hostSessions = captureHostSessions();
      await connect();
      await invoke(HOST_CHANNEL, VIEW_B, {});
      const connection = h.manager.get(HOST_ID)!;
      const say = (projectId: string, live: unknown) =>
        hostSessions.at(-1)!.call(LinkMethod.ENDPOINT_ASSISTANT, {
          endpoints: [{ endpointId: "view-12", projectId, live }],
        });

      await say("proj-2", true);
      expect(connection.hasLiveAssistant(VIEW_B)).toBe(true);

      // The host revokes the assistant of a view that moves project, and the
      // Shell doesn't wait to be told.
      projectKeys.set(VIEW_B, `${HOST_ID}:proj-1`);
      await invoke(HOST_CHANNEL, VIEW_B, {});
      expect(connection.hasLiveAssistant(VIEW_B)).toBe(false);

      // Said about the project it left, either way: ignored.
      await say("proj-2", true);
      expect(connection.hasLiveAssistant(VIEW_B)).toBe(false);
      await say("proj-1", true);
      expect(connection.hasLiveAssistant(VIEW_B)).toBe(true);
      await say("proj-2", false);
      expect(connection.hasLiveAssistant(VIEW_B)).toBe(true);

      await expect(say("proj-1", "no")).rejects.toMatchObject({ code: "VALIDATION" });
      expect(connection.hasLiveAssistant(VIEW_B)).toBe(true);
    });

    it("starts over with no assistants on a fresh session", async () => {
      await startWithAssistants();
      await connect();
      await invoke(HOST_CHANNEL, VIEW_A, {});
      const connection = h.manager.get(HOST_ID)!;
      live.set(handleOf("proj-1"), "proj-1");
      h.sessionHost.refreshAssistants();
      await waitFor(() => connection.hasLiveAssistant(VIEW_A));

      // Past the resume grace: the host closed the endpoint, and its assistant with it.
      h.allowConnect.value = false;
      for (const socket of h.sockets.splice(0)) socket.destroy();
      await waitFor(() => getEndpointRegistry().getRemote().length === 0, 2_000);
      h.allowConnect.value = true;
      await waitFor(() => getEndpointRegistry().getRemote().length === 1);

      expect(connection.hasLiveAssistant(VIEW_A)).toBe(false);
    });
  });

  describe("agent activity (#13359)", () => {
    /** Projects with an agent working, waiting or directing on the host. */
    const active = new Set<string>();
    const startWithAgents = (options: { resumeGraceMs?: number } = {}) =>
      startHarness({
        ...options,
        agentActive: (endpoint) => active.has(endpoint.projectId ?? ""),
      });

    beforeEach(() => active.clear());

    it("tells the Shell which views have active agents on the host, through a dropped link", async () => {
      active.add("proj-1");
      await startWithAgents({ resumeGraceMs: 10_000 });
      await connect();
      await invoke(HOST_CHANNEL, VIEW_A, {});
      await invoke(HOST_CHANNEL, VIEW_B, {});
      const connection = h.manager.get(HOST_ID)!;
      // Already working when the view opened: no change needed to hear it.
      await waitFor(() => connection.hasActiveAgent(VIEW_A));
      expect(connection.hasActiveAgent(VIEW_B)).toBe(false);

      active.add("proj-2");
      h.sessionHost.refreshAgentActivity();
      await waitFor(() => connection.hasActiveAgent(VIEW_B));

      // The agents run on while the link is down, and the Shell keeps ranking them.
      h.allowConnect.value = false;
      for (const socket of h.sockets.splice(0)) socket.destroy();
      await waitFor(() => connection.unavailableEnvelope() !== null);
      expect(connection.hasActiveAgent(VIEW_A)).toBe(true);

      // They stop while nobody is attached to hear; the resumed session says so.
      active.clear();
      h.sessionHost.refreshAgentActivity();
      h.allowConnect.value = true;
      await waitFor(() => connection.unavailableEnvelope() === null);
      await waitFor(() => !connection.hasActiveAgent(VIEW_A) && !connection.hasActiveAgent(VIEW_B));
      expect(h.sink.activated).toEqual([VIEW_A, VIEW_B]);
    });

    it("forgets a view's answer when it closes", async () => {
      active.add("proj-1");
      await startWithAgents();
      await connect();
      await invoke(HOST_CHANNEL, VIEW_A, {});
      const connection = h.manager.get(HOST_ID)!;
      await waitFor(() => connection.hasActiveAgent(VIEW_A));

      h.sink.gone(VIEW_A);
      expect(connection.hasActiveAgent(VIEW_A)).toBe(false);
    });

    it("takes the host's word only for the project the view is on now, and only well-formed", async () => {
      // No reader: every answer here is one this test sends.
      await startHarness();
      const hostSessions: LinkSession[] = [];
      cleanups.push(h.server.onSession((ctx) => hostSessions.push(ctx.session)));
      await connect();
      await invoke(HOST_CHANNEL, VIEW_B, {});
      const connection = h.manager.get(HOST_ID)!;
      const say = (projectId: string, active: unknown) =>
        hostSessions.at(-1)!.call(LinkMethod.ENDPOINT_AGENT_ACTIVITY, {
          endpoints: [{ endpointId: "view-12", projectId, active }],
        });

      await say("proj-2", true);
      expect(connection.hasActiveAgent(VIEW_B)).toBe(true);

      // The old project's agents say nothing about the new one's.
      projectKeys.set(VIEW_B, `${HOST_ID}:proj-1`);
      await invoke(HOST_CHANNEL, VIEW_B, {});
      expect(connection.hasActiveAgent(VIEW_B)).toBe(false);

      // Said about the project it left, either way: ignored.
      await say("proj-2", true);
      expect(connection.hasActiveAgent(VIEW_B)).toBe(false);
      await say("proj-1", true);
      expect(connection.hasActiveAgent(VIEW_B)).toBe(true);
      await say("proj-2", false);
      expect(connection.hasActiveAgent(VIEW_B)).toBe(true);

      await expect(say("proj-1", "no")).rejects.toMatchObject({ code: "VALIDATION" });
      expect(connection.hasActiveAgent(VIEW_B)).toBe(true);
    });

    it("tells the view sink when a view's agents go active, and only then (#15879)", async () => {
      await startHarness();
      const hostSessions: LinkSession[] = [];
      cleanups.push(h.server.onSession((ctx) => hostSessions.push(ctx.session)));
      await connect();
      await invoke(HOST_CHANNEL, VIEW_B, {});
      const say = (projectId: string, active: boolean) =>
        hostSessions.at(-1)!.call(LinkMethod.ENDPOINT_AGENT_ACTIVITY, {
          endpoints: [{ endpointId: "view-12", projectId, active }],
        });

      await say("proj-2", true);
      expect(h.sink.activated).toEqual([VIEW_B]);

      // A repeat says nothing new, and a stop needs no wake.
      await say("proj-2", true);
      await say("proj-2", false);
      expect(h.sink.activated).toEqual([VIEW_B]);

      // Said about a project the view isn't on: no wake.
      await say("proj-1", true);
      expect(h.sink.activated).toEqual([VIEW_B]);

      await say("proj-2", true);
      expect(h.sink.activated).toEqual([VIEW_B, VIEW_B]);
    });

    it("wakes a view whose agent started during a resumed gap, and only that one", async () => {
      active.add("proj-1");
      await startWithAgents({ resumeGraceMs: 10_000 });
      await connect();
      await invoke(HOST_CHANNEL, VIEW_A, {});
      await invoke(HOST_CHANNEL, VIEW_B, {});
      const connection = h.manager.get(HOST_ID)!;
      await waitFor(() => connection.hasActiveAgent(VIEW_A));
      const resumed: boolean[] = [];
      cleanups.push(h.manager.onSessionAttached((_hostId, info) => resumed.push(info.resumed)));

      h.allowConnect.value = false;
      for (const socket of h.sockets.splice(0)) socket.destroy();
      await waitFor(() => connection.unavailableEnvelope() !== null);
      // proj-2's agent starts while nobody is attached to hear; proj-1's runs on.
      active.add("proj-2");
      h.sessionHost.refreshAgentActivity();
      h.allowConnect.value = true;
      await waitFor(() => connection.hasActiveAgent(VIEW_B));

      expect(resumed).toEqual([true]);
      expect(connection.hasActiveAgent(VIEW_A)).toBe(true);
      expect(h.sink.activated).toEqual([VIEW_A, VIEW_B]);
    });

    it("hears agents that outlived the session on a fresh one", async () => {
      active.add("proj-1");
      await startWithAgents();
      await connect();
      await invoke(HOST_CHANNEL, VIEW_A, {});
      const connection = h.manager.get(HOST_ID)!;
      await waitFor(() => connection.hasActiveAgent(VIEW_A));

      // Past the resume grace: the endpoint is gone, the agents are not.
      h.allowConnect.value = false;
      for (const socket of h.sockets.splice(0)) socket.destroy();
      await waitFor(() => getEndpointRegistry().getRemote().length === 0, 2_000);
      h.allowConnect.value = true;
      await waitFor(() => getEndpointRegistry().getRemote().length === 1);
      await waitFor(() => connection.hasActiveAgent(VIEW_A));
      // A fresh session forgot every answer, so hearing it again is a new activation.
      expect(h.sink.activated).toEqual([VIEW_A, VIEW_A]);
    });
  });

  describe("MCP bindings (#14228)", () => {
    /** Projects an external MCP session on the host is bound to, live. */
    const bound = new Set<string>();
    const startWithBindings = (options: { resumeGraceMs?: number } = {}) =>
      startHarness({
        ...options,
        mcpBindingLive: (endpoint) => bound.has(endpoint.projectId ?? ""),
      });

    beforeEach(() => bound.clear());

    it("tells the Shell which views a session on the host is bound to, through a dropped link", async () => {
      bound.add("proj-1");
      await startWithBindings({ resumeGraceMs: 10_000 });
      await connect();
      await invoke(HOST_CHANNEL, VIEW_A, {});
      await invoke(HOST_CHANNEL, VIEW_B, {});
      const connection = h.manager.get(HOST_ID)!;
      // Already bound when the view opened: no change needed to hear it.
      await waitFor(() => connection.hasLiveMcpBinding(VIEW_A));
      expect(connection.hasLiveMcpBinding(VIEW_B)).toBe(false);

      bound.add("proj-2");
      h.sessionHost.refreshMcpBindings();
      await waitFor(() => connection.hasLiveMcpBinding(VIEW_B));

      // The session lives on the host while the link is down.
      h.allowConnect.value = false;
      for (const socket of h.sockets.splice(0)) socket.destroy();
      await waitFor(() => connection.unavailableEnvelope() !== null);
      expect(connection.hasLiveMcpBinding(VIEW_A)).toBe(true);

      // It drops while nobody is attached to hear; the resumed session says so.
      bound.clear();
      h.sessionHost.refreshMcpBindings();
      h.allowConnect.value = true;
      await waitFor(() => connection.unavailableEnvelope() === null);
      await waitFor(
        () => !connection.hasLiveMcpBinding(VIEW_A) && !connection.hasLiveMcpBinding(VIEW_B)
      );
    });

    it("forgets a view's answer when it closes", async () => {
      bound.add("proj-1");
      await startWithBindings();
      await connect();
      await invoke(HOST_CHANNEL, VIEW_A, {});
      const connection = h.manager.get(HOST_ID)!;
      await waitFor(() => connection.hasLiveMcpBinding(VIEW_A));

      h.sink.gone(VIEW_A);
      expect(connection.hasLiveMcpBinding(VIEW_A)).toBe(false);
    });

    it("takes the host's word only for the project the view is on now, and only well-formed", async () => {
      // No reader: every answer here is one this test sends.
      await startHarness();
      const hostSessions: LinkSession[] = [];
      cleanups.push(h.server.onSession((ctx) => hostSessions.push(ctx.session)));
      await connect();
      await invoke(HOST_CHANNEL, VIEW_B, {});
      const connection = h.manager.get(HOST_ID)!;
      const say = (projectId: string, liveBinding: unknown) =>
        hostSessions.at(-1)!.call(LinkMethod.ENDPOINT_MCP_BINDING, {
          endpoints: [{ endpointId: "view-12", projectId, liveBinding }],
        });

      await say("proj-2", true);
      expect(connection.hasLiveMcpBinding(VIEW_B)).toBe(true);

      // A session bound to the old project says nothing about the new one.
      projectKeys.set(VIEW_B, `${HOST_ID}:proj-1`);
      await invoke(HOST_CHANNEL, VIEW_B, {});
      expect(connection.hasLiveMcpBinding(VIEW_B)).toBe(false);

      // Said about the project it left, either way: ignored.
      await say("proj-2", true);
      expect(connection.hasLiveMcpBinding(VIEW_B)).toBe(false);
      await say("proj-1", true);
      expect(connection.hasLiveMcpBinding(VIEW_B)).toBe(true);
      await say("proj-2", false);
      expect(connection.hasLiveMcpBinding(VIEW_B)).toBe(true);

      await expect(say("proj-1", "no")).rejects.toMatchObject({ code: "VALIDATION" });
      expect(connection.hasLiveMcpBinding(VIEW_B)).toBe(true);
    });
  });

  it("carries host summaries and session calls on a link no view is bound to", async () => {
    await startHarness();
    const summary = {
      hostId: "local",
      sampledAt: 7,
      platform: "linux" as const,
      cpuPercent: 12,
      memoryPressure: "normal" as const,
      memoryUsedBytes: null,
      memoryTotalBytes: null,
      swapUsedBytes: null,
      swapTotalBytes: null,
      thermal: null,
      cpuPressure: null,
      agentsObserved: { working: 1, waiting: 0, idle: 2 },
      projectCount: 1,
      worktreeCount: 2,
      driver: null,
      agentClis: [],
    };
    const disposeHost = installHostMetricsHostWith(h.server, {
      loop: { subscribe: () => () => {}, latest: () => summary },
      listFleetTargets: async () => ({ targets: [], complete: true }),
      submitFleet: async () => {},
      listWorktrees: async () => [],
      onWorktreesMaybeChanged: () => () => {},
      restartTerminals: async () => ({
        projects: [],
        complete: true,
        operations: 0,
        terminalIds: [],
      }),
      onAgentWaiting: () => () => {},
      notificationSettings: () => ({
        enabled: true,
        waitingEnabled: true,
        quietHoursEnabled: false,
        quietHoursStartMin: 0,
        quietHoursEndMin: 0,
        quietHoursWeekdays: [],
      }),
      shellDecides: () => false,
      now: Date.now,
    });
    cleanups.push(disposeHost);
    const seen: number[] = [];
    h.manager.onSessionOpened((hostId, session) => {
      if (hostId !== HOST_ID) return;
      session.on(Lane.CONTROL, ControlKind.HOST_SUMMARY, (body) => seen.push(body.sampledAt));
    });
    await connect();
    await waitFor(() => seen.length === 1);
    expect(h.manager.get(HOST_ID)!.boundViews()).toEqual([]);
    await expect(
      h.manager.get(HOST_ID)!.callHost(MetricsLinkMethod.LIST_WORKTREES, null)
    ).resolves.toEqual([]);
  });

  it("settles whenReady at once when the host answers but isn't in Host mode", async () => {
    await startHarness();
    h.allowConnect.hostModeOff = true;
    const connection = h.manager.connect(HOST_ID);
    const started = Date.now();
    await expect(connection.whenReady(5_000)).resolves.toBe("host-mode-off");
    expect(Date.now() - started).toBeLessThan(2_000);
    h.allowConnect.hostModeOff = false;
  });

  it("keeps waiting through a host restart rather than settling on Host mode being off (#13392)", async () => {
    await startHarness();
    const connection = h.manager.connect(HOST_ID);
    await expect(connection.whenReady(5_000)).resolves.toBe("ready");

    // The host restarting: host.json is gone on the way down.
    h.allowConnect.hostModeOff = true;
    for (const socket of h.sockets) socket.destroy();
    await waitFor(() => connection.currentSession === null);
    await expect(connection.whenReady(300)).resolves.toBe("timeout");

    const waiting = connection.whenReady(5_000);
    h.allowConnect.hostModeOff = false;
    await expect(waiting).resolves.toBe("ready");
  });

  it("settles whenReady on connect, stop and timeout", async () => {
    await startHarness();
    h.allowConnect.value = false;
    const connection = h.manager.connect(HOST_ID);
    await expect(connection.whenReady(30)).resolves.toBe("timeout");
    const waiting = connection.whenReady(5_000);
    h.allowConnect.value = true;
    await expect(waiting).resolves.toBe("ready");
    const stopped = h.manager.get(HOST_ID)!;
    await h.manager.disconnect(HOST_ID);
    await expect(stopped.whenReady(5_000)).resolves.toBe("stopped");
  });
});

describe("a closing view's last calls (#15881)", () => {
  const viewAOnHost = () => getEndpointRegistry().getForProject("proj-1")[0];

  /** What reached the host's send handler, and whether its endpoint was still open then. */
  function recordHostSends() {
    const received: Array<{ channel: string; endpointOpen: boolean }> = [];
    const spy = vi
      .spyOn(getIpcDispatcher(), "sendForEndpoint")
      .mockImplementation((invocation, channel) => {
        received.push({ channel, endpointOpen: !invocation.endpoint.isClosed() });
      });
    cleanups.push(() => spy.mockRestore());
    return received;
  }

  async function openViewA() {
    await startHarness();
    await connect();
    await invoke(HOST_CHANNEL, VIEW_A, {});
    expect(viewAOnHost()).toBeDefined();
    return h.manager.get(HOST_ID)!;
  }

  it("delivers a send queued behind a backpressured socket before the view's close", async () => {
    const connection = await openViewA();
    const received = recordHostSends();
    const socket = h.sockets.at(-1)!;
    // Held writes past the high-water mark: the session waits for a drain,
    // and everything posted after stays in its scheduler.
    socket.cork();
    connection.send(VIEW_A, "proj-1", "filler", ["x".repeat(socket.writableHighWaterMark)]);
    await waitFor(() => socket.writableNeedDrain);
    connection.send(VIEW_A, "proj-1", "commit", [{ panelIds: ["t1"] }]);
    h.sink.gone(VIEW_A);
    // A flush later, both still wait in the scheduler and nothing has arrived.
    await new Promise((resolve) => setImmediate(resolve));
    const session = connection.currentSession!;
    expect(session.queuedBytes(Lane.RPC)).toBeGreaterThan(0);
    expect(session.queuedBytes(Lane.CONTROL)).toBeGreaterThan(0);
    expect(received).toEqual([]);
    socket.uncork();

    await waitFor(() => viewAOnHost() === undefined);
    expect(received).toEqual([
      { channel: "filler", endpointOpen: true },
      { channel: "commit", endpointOpen: true },
    ]);
  });

  it("delivers a send posted in the same tick as the view's close before it", async () => {
    const connection = await openViewA();
    const received = recordHostSends();
    connection.send(VIEW_A, "proj-1", "commit", [{ panelIds: ["t1"] }]);
    h.sink.gone(VIEW_A);

    await waitFor(() => viewAOnHost() === undefined);
    expect(received).toEqual([{ channel: "commit", endpointOpen: true }]);
  });
});
