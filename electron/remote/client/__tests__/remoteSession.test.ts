import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type net from "node:net";

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
import { getIpcDispatcher } from "../../../ipc/dispatcher.js";
import {
  getEndpointRegistry,
  _resetEndpointRegistryForTesting,
} from "../../../ipc/endpointRegistry.js";
import { _resetLocalEndpointsForTesting } from "../../../ipc/localEndpoint.js";
import type { IpcContext } from "../../../ipc/types.js";
import { AppError } from "../../../utils/errorTypes.js";
import { wrapSuccess } from "../../../../shared/utils/ipcErrorSerialization.js";
import type { IpcEnvelope } from "../../../../shared/types/ipc/errors.js";
import type { HostDescriptor } from "../../../../shared/types/remoteHosts.js";
import { HostServer } from "../../host/HostServer.js";
import { hostSocketLocation } from "../../host/hostSocketPath.js";
import { SessionHost } from "../../host/SessionHost.js";
import { Lane } from "../../link/frames.js";
import { DEFAULT_LANE_LIMITS } from "../../link/scheduler.js";
import {
  TEST_HANDSHAKE,
  makeTempDir,
  removeTempDir,
  waitFor,
} from "../../link/__tests__/linkTestUtils.js";
import { HostRegistry, type RemoteHostsStore } from "../HostRegistry.js";
import { RemoteHostManager, type ViewSink } from "../RemoteHostManager.js";
import { RemoteRouterImpl } from "../RemoteRouter.js";
import { createDirectTransport, type LinkTransport } from "../transport.js";
import { WindowHostBinding } from "../WindowHostBinding.js";

const HOST_CHANNEL = "git:get-file-diff";
const SHELL_CHANNEL = "window:new";
const EVENT_CHANNEL = "terminal:data";
const HOST_ID = "studio-01";

const VIEW_A = 11; // studio-01:proj-1
const VIEW_B = 12; // studio-01:proj-2
const VIEW_LOCAL = 13; // proj-1 on this machine

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
  };
  /** The view was destroyed. */
  const gone = (webContentsId: number) => goneListeners.get(webContentsId)?.();
  return { sink, delivered, resyncs, gone, hosts };
}

interface Harness {
  dir: string;
  server: HostServer;
  sessionHost: SessionHost;
  frontendCounts: number[];
  manager: RemoteHostManager;
  sink: ReturnType<typeof recordingSink>;
  sockets: net.Socket[];
  allowConnect: { value: boolean };
}

const cleanups: Array<() => unknown> = [];
let h: Harness;

async function startHarness(
  options: { eventsLimits?: { high: number; cap: number }; maxEndpoints?: number } = {}
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
    resumeGraceMs: 150,
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
    eventsHighWaterBytes: options.eventsLimits?.high,
    maxEndpointsPerSession: options.maxEndpoints,
  });

  const registry = new HostRegistry(memoryStore());
  registry.add({ name: HOST_ID, sshTarget: "studio.example" });
  const sink = recordingSink();
  const sockets: net.Socket[] = [];
  const allowConnect = { value: true };
  const direct = createDirectTransport({ socketPath: location.socketPath, token: server.token });
  const transport: LinkTransport = {
    async open(signal) {
      if (!allowConnect.value) throw new Error("host unreachable");
      const connection = await direct.open(signal);
      sockets.push(connection.socket);
      return connection;
    },
  };
  const manager = new RemoteHostManager({
    registry,
    createTransport: () => transport,
    handshake: () => TEST_HANDSHAKE,
    client: { clientId: "client-1", clientName: "greg-mbp", platform: "darwin" },
    views: sink.sink,
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

  it("routes nothing to a host running a different build", async () => {
    await startHarness();
    const registry = new HostRegistry(memoryStore());
    registry.add({ name: HOST_ID, sshTarget: "studio.example" });
    const mismatched = new RemoteHostManager({
      registry,
      createTransport: () =>
        createDirectTransport({ socketPath: h.server.socketPath, token: h.server.token }),
      handshake: () => ({ ...TEST_HANDSHAKE, version: "9.9.9" }),
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

    h.sink.gone(VIEW_A);
    expect(closed.at(-1)).toEqual({
      hostId: HOST_ID,
      webContentsId: VIEW_A,
      endpointId: "view-11",
    });
    await h.manager.disconnect(HOST_ID);
    expect(closed).toHaveLength(2);
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
