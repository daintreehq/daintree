import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type net from "node:net";
import type { WebContents } from "electron";
import type { IpcEnvelope } from "../../../../shared/types/ipc/errors.js";
import { toHostScopedKey, type HostDescriptor } from "../../../../shared/types/remoteHosts.js";
import { CHANNELS } from "../../../ipc/channels.js";
import { getIpcDispatcher } from "../../../ipc/dispatcher.js";
import {
  _resetEndpointRegistryForTesting,
  getEndpointRegistry,
} from "../../../ipc/endpointRegistry.js";
import { registerOperationsHandlers } from "../../../ipc/handlers/operations.js";
import { _resetIpcGuardForTesting } from "../../../ipc/ipcGuard.js";
import { _resetLocalEndpointsForTesting } from "../../../ipc/localEndpoint.js";
import type { PtyClient } from "../../../services/PtyClient.js";
import { _resetOperationRegistryForTest } from "../../../services/operations/index.js";
import { enforceIpcSenderValidation } from "../../../setup/security.js";
import { setPtyClientRef } from "../../../window/serviceRefs.js";
import { HostRegistry, type RemoteHostsStore } from "../../client/HostRegistry.js";
import { RemoteHostManager, type ViewSink } from "../../client/RemoteHostManager.js";
import { RemoteRouterImpl } from "../../client/RemoteRouter.js";
import { createDirectTransport, type LinkTransport } from "../../client/transport.js";
import { WindowHostBinding } from "../../client/WindowHostBinding.js";
import { HostServer } from "../../host/HostServer.js";
import { hostSocketLocation } from "../../host/hostSocketPath.js";
import type { RemoteViewEndpoint } from "../../host/RemoteViewEndpoint.js";
import { SessionHost } from "../../host/SessionHost.js";
import { TEST_HANDSHAKE } from "../../link/__tests__/linkTestUtils.js";
import type { LinkSession } from "../../link/session.js";
import type { TransferSink } from "../../link/transfer.js";
import type { ClientTerminalRelay } from "../../terminal/ClientTerminalRelay.js";
import {
  attachClientTerminalRelay,
  detachClientTerminalRelayFor,
  disposeAllClientTerminalRelays,
  getClientTerminalRelay,
} from "../../terminal/clientAttach.js";
import {
  attachTerminalBridge,
  detachTerminalBridge,
  disposeAllTerminalBridges,
} from "../../terminal/hostAttach.js";
import type { TerminalStreamBridge } from "../../terminal/TerminalStreamBridge.js";
import { closeAllFakePorts, invokeHandlers, resetIpcMain } from "./fakeElectron.js";
import { FakePtyHost } from "./fakePtyHost.js";
import { FakeView, liveViews, projectKeys } from "./fakeView.js";
import { waitUntil } from "./poll.js";

export const HOST_ID = "studio-01";

/**
 * Host and Shell in one process, joined by a real Unix socket: a HostServer +
 * SessionHost + per-endpoint TerminalStreamBridge on one side, a
 * RemoteHostManager (LinkClient over the direct transport) + RemoteRouter +
 * per-view ClientTerminalRelay on the other, both on this process's
 * dispatcher and endpoint registry. The stream wiring mirrors `boot.ts`.
 * Only Electron and the pty-host are fakes.
 */
export interface RemoteHarness {
  dir: string;
  pty: FakePtyHost;
  server: HostServer;
  sessionHost: SessionHost;
  manager: RemoteHostManager;
  /** Host-side bridges by the Shell's endpoint id. */
  bridges: Map<string, TerminalStreamBridge>;
  addView(webContentsId: number, projectId: string): FakeView;
  invoke(channel: string, view: FakeView, ...args: unknown[]): Promise<IpcEnvelope>;
  connect(): Promise<void>;
  /** Open the view's endpoint and wait until its terminal stream is flowing. */
  openStreams(
    view: FakeView
  ): Promise<{ relay: ClientTerminalRelay; bridge: TerminalStreamBridge }>;
  /** Kill the client's socket and keep it from redialling; resolves once both sides noticed. */
  dropLink(): Promise<void>;
  /** Let the client redial; resolves once the session is back and streams have resumed. */
  restoreLink(): Promise<void>;
  /** The Shell's current link session. */
  clientSession(): LinkSession;
  dispose(): Promise<void>;
}

function memoryStore(): RemoteHostsStore {
  let value: { hosts: HostDescriptor[] } | undefined;
  return {
    get: () => value,
    set: (_key, next) => {
      value = next;
    },
  };
}

function senderEvent(id: number) {
  return {
    sender: { id, isDestroyed: () => false, send: () => undefined, once: () => undefined },
    senderFrame: { url: "app://daintree/index.html" },
  };
}

/** Receives bulk transfers on the host and throws the bytes away. */
function discardSink(): TransferSink {
  return {
    write: () => undefined,
    commit: async () => "/dev/null",
    abort: () => undefined,
  };
}

export async function startRemoteHarness(
  options: { resumeGraceMs?: number } = {}
): Promise<RemoteHarness> {
  resetIpcMain();
  _resetIpcGuardForTesting();
  _resetEndpointRegistryForTesting();
  _resetLocalEndpointsForTesting();
  _resetOperationRegistryForTest();
  enforceIpcSenderValidation();

  const teardowns: Array<() => unknown> = [];
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "drh-"));
  teardowns.push(() => fs.rm(dir, { recursive: true, force: true }));
  teardowns.push(() => {
    closeAllFakePorts();
    liveViews.clear();
    projectKeys.clear();
    _resetOperationRegistryForTest();
  });

  const pty = new FakePtyHost();
  setPtyClientRef(pty.client as unknown as PtyClient);
  teardowns.push(() => setPtyClientRef(null));
  teardowns.push(registerOperationsHandlers());

  // ---- Host ----
  const location = hostSocketLocation({ platform: "darwin", userDataDir: dir });
  const server = new HostServer({
    location,
    handshake: TEST_HANDSHAKE,
    hostName: "studio",
    resumeGraceMs: options.resumeGraceMs ?? 60_000,
    session: { pingIntervalMs: 0, idleTimeoutMs: 0 },
  });
  const sessionHost = new SessionHost(server, {
    dispatcher: getIpcDispatcher(),
    registry: getEndpointRegistry(),
    describeProject: (projectId) => ({ projectId, path: `/srv/${projectId}`, name: projectId }),
  });
  teardowns.push(() => server.close());
  teardowns.push(() => sessionHost.dispose());
  teardowns.push(() => disposeAllTerminalBridges());

  const bridges = new Map<string, TerminalStreamBridge>();
  const endpointsBySession = new Map<string, Map<string, RemoteViewEndpoint>>();
  const attachHostStreams = (session: LinkSession, endpoint: RemoteViewEndpoint) => {
    bridges.set(endpoint.clientEndpointId, attachTerminalBridge(session, endpoint));
  };
  teardowns.push(
    sessionHost.onEndpointOpened((endpoint, handle) => {
      let endpoints = endpointsBySession.get(handle.sessionId);
      if (!endpoints) {
        endpoints = new Map();
        endpointsBySession.set(handle.sessionId, endpoints);
      }
      endpoints.set(endpoint.endpointId, endpoint);
      endpoint.onClose(() => endpointsBySession.get(handle.sessionId)?.delete(endpoint.endpointId));
      const link = handle.link();
      if (link) attachHostStreams(link, endpoint);
    })
  );
  teardowns.push(
    server.onSession((ctx) => {
      ctx.session.transfers.setSinkFactory(discardSink);
      if (!ctx.resumed) return;
      for (const endpoint of endpointsBySession.get(ctx.sessionId)?.values() ?? []) {
        if (!endpoint.isClosed()) attachHostStreams(ctx.session, endpoint);
      }
    })
  );
  teardowns.push(
    server.onSessionExpired(({ sessionId }) => {
      const endpoints = endpointsBySession.get(sessionId);
      endpointsBySession.delete(sessionId);
      for (const endpointId of endpoints?.keys() ?? []) detachTerminalBridge(endpointId);
    })
  );
  await server.listen();

  // ---- Shell ----
  const registry = new HostRegistry(memoryStore());
  registry.add({ name: HOST_ID, sshTarget: "studio.example" });
  const sockets: net.Socket[] = [];
  let allowConnect = true;
  const direct = createDirectTransport({ discoveryPath: location.discoveryPath });
  const transport: LinkTransport = {
    async open(signal) {
      if (!allowConnect) throw new Error("host unreachable");
      const connection = await direct.open(signal);
      sockets.push(connection.socket);
      return connection;
    },
  };
  const hostOf = (webContentsId: number) =>
    projectKeys.get(webContentsId)?.startsWith(`${HOST_ID}:`) ? HOST_ID : null;
  const sink: ViewSink = {
    send(webContentsId, channel, args) {
      const view = liveViews.get(webContentsId);
      if (!view || view.webContents.isDestroyed()) return false;
      view.webContents.send(channel, ...args);
      return true;
    },
    watch(webContentsId, onGone) {
      const wc = liveViews.get(webContentsId)?.webContents;
      if (!wc) {
        queueMicrotask(onGone);
        return () => undefined;
      }
      wc.once("destroyed", onGone);
      return () => wc.removeListener("destroyed", onGone);
    },
    resync(webContentsId, _hostId, reason) {
      liveViews.get(webContentsId)?.resyncs.push(reason);
    },
    hostOf,
  };
  const manager = new RemoteHostManager({
    registry,
    createTransport: () => transport,
    handshake: () => TEST_HANDSHAKE,
    client: { clientId: "client-1", clientName: "greg-mbp", platform: "darwin" },
    views: sink,
    session: { pingIntervalMs: 0, idleTimeoutMs: 0 },
    backoff: { initialMs: 10, maxMs: 40, jitter: 0 },
  });
  const router = new RemoteRouterImpl(manager, new WindowHostBinding(), {
    projectKeyFor: (id) => projectKeys.get(id) ?? null,
    windowIdFor: () => null,
  });
  getIpcDispatcher().setRemoteRouter(router);
  teardowns.push(() => manager.disposeAll());
  teardowns.push(() => getIpcDispatcher().setRemoteRouter(null));

  let currentSession: LinkSession | null = null;
  teardowns.push(
    manager.onEndpointOpened((hostId, { session, webContentsId, endpointId }) => {
      currentSession = session;
      if (hostOf(webContentsId) !== hostId) return;
      const view = liveViews.get(webContentsId);
      if (!view || view.webContents.isDestroyed()) return;
      attachClientTerminalRelay(
        session,
        view.webContents as unknown as WebContents,
        endpointId,
        hostId
      );
    })
  );
  teardowns.push(
    manager.onEndpointClosed((hostId, { webContentsId, endpointId }) => {
      detachClientTerminalRelayFor(webContentsId, hostId, endpointId);
    })
  );
  teardowns.push(() => disposeAllClientTerminalRelays());

  const connection = () => manager.get(HOST_ID);
  const isConnected = () => connection()?.unavailableEnvelope() === null;

  const streamsFlowing = (view: FakeView) => {
    const relay = getClientTerminalRelay(view.id);
    const bridge = relay ? bridges.get(relay.endpointId) : undefined;
    return Boolean(relay?.isAttached && !relay.resumeInFlight && bridge?.isResumed && view.hasPort);
  };

  const harness: RemoteHarness = {
    dir,
    pty,
    server,
    sessionHost,
    manager,
    bridges,
    addView(webContentsId, projectId) {
      const view = new FakeView(webContentsId);
      liveViews.set(webContentsId, view);
      projectKeys.set(webContentsId, toHostScopedKey(HOST_ID, projectId));
      return view;
    },
    invoke(channel, view, ...args) {
      const listener = invokeHandlers.get(channel);
      if (!listener) throw new Error(`no handler for ${channel}`);
      return listener(senderEvent(view.id), ...args) as Promise<IpcEnvelope>;
    },
    async connect() {
      manager.connect(HOST_ID);
      await waitUntil(isConnected, "the Shell to connect");
    },
    async openStreams(view) {
      // Any host call opens the view's endpoint; operations:list is a real host handler.
      const envelope = await harness.invoke(CHANNELS.OPERATIONS_LIST, view, {});
      if (!envelope.ok) throw new Error(`opening the endpoint failed: ${envelope.error.message}`);
      await waitUntil(() => streamsFlowing(view), `view ${view.id}'s terminal stream`);
      const relay = getClientTerminalRelay(view.id)!;
      return { relay, bridge: bridges.get(relay.endpointId)! };
    },
    async dropLink() {
      allowConnect = false;
      for (const socket of sockets.splice(0)) socket.destroy();
      await waitUntil(
        () =>
          server.sessions.length === 0 &&
          !isConnected() &&
          [...liveViews.keys()].every((id) => !getClientTerminalRelay(id)?.isAttached),
        "both sides to see the link drop"
      );
    },
    async restoreLink() {
      allowConnect = true;
      connection()?.retryNow();
      await waitUntil(isConnected, "the Shell to reconnect");
      await waitUntil(
        () =>
          [...liveViews.values()].every(
            (view) => !getClientTerminalRelay(view.id) || streamsFlowing(view)
          ),
        "terminal streams to resume"
      );
    },
    clientSession() {
      if (!currentSession || !currentSession.isOpen) throw new Error("no open client session");
      return currentSession;
    },
    async dispose() {
      for (const teardown of teardowns.splice(0).reverse()) await teardown();
    },
  };
  return harness;
}
