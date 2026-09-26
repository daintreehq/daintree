import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type net from "node:net";
import type { IpcEnvelope } from "../../../../shared/types/ipc/errors.js";
import { toHostScopedKey } from "../../../../shared/types/remoteHosts.js";
import { CHANNELS } from "../../../ipc/channels.js";
import { _resetEndpointRegistryForTesting } from "../../../ipc/endpointRegistry.js";
import { registerDriveLeaseHandlers } from "../../../ipc/handlers/driveLease.js";
import { registerFileTransferHandlers } from "../../../ipc/handlers/fileTransfer.js";
import { registerOperationsHandlers } from "../../../ipc/handlers/operations.js";
import { _resetIpcGuardForTesting } from "../../../ipc/ipcGuard.js";
import { _resetLocalEndpointsForTesting } from "../../../ipc/localEndpoint.js";
import type { PtyClient } from "../../../services/PtyClient.js";
import { _resetDriveLeaseServiceForTesting } from "../../../services/DriveLeaseService.js";
import { _resetOperationRegistryForTest } from "../../../services/operations/index.js";
import { enforceIpcSenderValidation } from "../../../setup/security.js";
import type { WorkspaceClient } from "../../../services/WorkspaceClient.js";
import { WorktreePortBroker } from "../../../services/WorktreePortBroker.js";
import {
  setPtyClientRef,
  setWorkspaceClientRef,
  setWorktreePortBrokerRef,
} from "../../../window/serviceRefs.js";
import { startRemoteHosts, stopRemoteHosts } from "../../boot.js";
import type { RemoteHostManager } from "../../client/RemoteHostManager.js";
import { createDirectTransport, type LinkTransport } from "../../client/transport.js";
import type { HostServer } from "../../host/HostServer.js";
import { hostSocketLocation, type HostSocketLocation } from "../../host/hostSocketPath.js";
import type { SessionHost } from "../../host/SessionHost.js";
import type { LinkSession } from "../../link/session.js";
import { _resetRemoteServicesForTest, requireRemoteService } from "../../runtime.js";
import type { ClientTerminalRelay } from "../../terminal/ClientTerminalRelay.js";
import { getClientTerminalRelay } from "../../terminal/clientAttach.js";
import type { TerminalStreamBridge } from "../../terminal/TerminalStreamBridge.js";
import { closeAllFakePorts, invokeHandlers, resetIpcMain, sendListeners } from "./fakeElectron.js";
import { FakePtyHost } from "./fakePtyHost.js";
import { FakeView, liveViews, projectKeys } from "./fakeView.js";
import { createFakeWorkspaceClient, FakeWorkspaceHost } from "./fakeWorkspaceHost.js";
import { harnessState, resetHarnessState, type HarnessProject } from "./harnessState.js";
import { waitUntil } from "./poll.js";

export const HOST_ID = "studio-01";
export const PROJECT_IDS = ["proj-1", "proj-2"] as const;

/**
 * Host and Shell in one process, joined by a real Unix socket, started by the
 * real `startRemoteHosts` with Host mode on: the Shell dials this process's
 * own Host-mode listener through a direct socket transport instead of ssh.
 * Only Electron, the pty-host, the persistent stores and the OS-facing
 * helpers (mDNS) are fakes; see `harnessState` and the test file's mocks.
 */
export interface RemoteHarness {
  dir: string;
  /** The host's `os.tmpdir()` for this run, which holds its upload inbox. */
  hostTmpDir: string;
  pty: FakePtyHost;
  /** The host's project records (real directories under `dir`). */
  projects: Map<string, HarnessProject>;
  /** Each project's workspace host, by project id. */
  workspaceHosts: Map<string, FakeWorkspaceHost>;
  /** Host mode's server and session host, as boot registered them. */
  server(): HostServer;
  sessionHost(): SessionHost;
  manager: RemoteHostManager;
  /** Host-side bridges by the Shell's endpoint id. */
  bridges: Map<string, TerminalStreamBridge>;
  addView(webContentsId: number, projectId: string): FakeView;
  invoke(channel: string, view: FakeView, ...args: unknown[]): Promise<IpcEnvelope>;
  /** What the view's `ipcRenderer.send` does: every `ipcMain.on` listener for the channel. */
  send(channel: string, view: FakeView, ...args: unknown[]): void;
  connect(): Promise<void>;
  isConnected(): boolean;
  /** Open the view's endpoint and wait until its terminal stream is flowing. */
  openStreams(
    view: FakeView
  ): Promise<{ relay: ClientTerminalRelay; bridge: TerminalStreamBridge }>;
  streamsFlowing(view: FakeView): boolean;
  /** Kill the client's socket and keep it from redialling; resolves once both sides noticed. */
  dropLink(): Promise<void>;
  /** Let the client redial; resolves once the session is back and streams have resumed. */
  restoreLink(): Promise<void>;
  /** The Shell's current link session. */
  clientSession(): LinkSession;
  dispose(): Promise<void>;
}

function senderEvent(id: number) {
  return {
    sender: { id, isDestroyed: () => false, send: () => undefined, once: () => undefined },
    senderFrame: { url: "app://daintree/index.html" },
  };
}

export interface RemoteHarnessOptions {
  /** Parent of the run's directory; the OS temp dir unless given (ssh socket paths need a short one). */
  rootDir?: string;
  /** Where Host mode listens; under the run's directory unless given. */
  hostLocation?: HostSocketLocation;
  /**
   * How the Shell reaches the host, given the client's own directory (the one
   * the port forwards take their ControlMaster from). A direct socket to the
   * host's discovery file unless given; `dropLink`/`restoreLink` need that one.
   */
  createTransport?: (clientDir: string) => LinkTransport;
  sshTarget?: string;
}

export async function startRemoteHarness(
  options: RemoteHarnessOptions = {}
): Promise<RemoteHarness> {
  const teardowns: Array<() => unknown> = [];
  try {
    return await buildHarness(teardowns, options);
  } catch (error) {
    // A failed start must not leave its socket, env or services behind for the next test.
    for (const teardown of teardowns.splice(0).reverse()) {
      try {
        await teardown();
      } catch {
        // Keep undoing the rest.
      }
    }
    throw error;
  }
}

async function buildHarness(
  teardowns: Array<() => unknown>,
  options: RemoteHarnessOptions
): Promise<RemoteHarness> {
  resetIpcMain();
  _resetIpcGuardForTesting();
  _resetEndpointRegistryForTesting();
  _resetLocalEndpointsForTesting();
  _resetOperationRegistryForTest();
  _resetRemoteServicesForTest();
  // The lease service binds the endpoint registry it was made with, and names
  // endpoints of the session it last saw: each harness needs its own.
  _resetDriveLeaseServiceForTesting(null);
  enforceIpcSenderValidation();

  // Real paths throughout: host containment compares canonical paths.
  const dir = await fs.realpath(
    await fs.mkdtemp(path.join(options.rootDir ?? os.tmpdir(), "drh-"))
  );
  teardowns.push(() => fs.rm(dir, { recursive: true, force: true }));
  resetHarnessState(path.join(dir, "shell"));
  await fs.mkdir(harnessState.userDataDir, { recursive: true });
  for (const id of PROJECT_IDS) {
    const projectPath = path.join(dir, "projects", id);
    await fs.mkdir(projectPath, { recursive: true });
    harnessState.projects.set(id, { id, name: id, path: projectPath });
  }
  teardowns.push(() => {
    closeAllFakePorts();
    liveViews.clear();
    projectKeys.clear();
    _resetOperationRegistryForTest();
    _resetDriveLeaseServiceForTesting(null);
    _resetRemoteServicesForTest();
  });

  const pty = new FakePtyHost();
  setPtyClientRef(pty.client as unknown as PtyClient);
  teardowns.push(() => setPtyClientRef(null));
  // The broker is real; only the workspace hosts behind it are fakes.
  const workspaceHosts = new Map<string, FakeWorkspaceHost>();
  const hostsByPath = new Map<string, FakeWorkspaceHost>();
  for (const project of harnessState.projects.values()) {
    const host = new FakeWorkspaceHost(project.path);
    workspaceHosts.set(project.id, host);
    hostsByPath.set(project.path, host);
  }
  setWorktreePortBrokerRef(new WorktreePortBroker());
  setWorkspaceClientRef(createFakeWorkspaceClient(hostsByPath) as unknown as WorkspaceClient);
  teardowns.push(() => {
    setWorkspaceClientRef(null);
    setWorktreePortBrokerRef(null);
  });
  teardowns.push(registerOperationsHandlers());
  teardowns.push(registerDriveLeaseHandlers());
  teardowns.push(registerFileTransferHandlers());
  // The host's temp dir (its upload inbox) lives in this run's directory.
  const previousTmpDir = process.env.TMPDIR;
  const hostTmpDir = path.join(dir, "host-tmp");
  await fs.mkdir(hostTmpDir, { recursive: true });
  process.env.TMPDIR = hostTmpDir;
  teardowns.push(() => {
    if (previousTmpDir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previousTmpDir;
  });

  // The Shell reaches the host over a direct socket; closing it (and
  // refusing to redial) stands in for the network going away.
  const location: HostSocketLocation =
    options.hostLocation ??
    hostSocketLocation({ platform: "darwin", userDataDir: path.join(dir, "host") });
  const sockets: net.Socket[] = [];
  let allowConnect = true;
  const direct = createDirectTransport({ discoveryPath: location.discoveryPath });
  const clientDir = path.join(harnessState.userDataDir, "rh");
  const transport: LinkTransport = options.createTransport?.(clientDir) ?? {
    async open(signal) {
      if (!allowConnect) throw new Error("host unreachable");
      const connection = await direct.open(signal);
      sockets.push(connection.socket as net.Socket);
      return connection;
    },
  };

  teardowns.push(() => stopRemoteHosts());
  await startRemoteHosts({
    hostMode: true,
    hostLocation: location,
    createTransport: () => transport,
  });
  const booted = harnessState.client;
  if (!booted) throw new Error("boot did not start the Remote Hosts client");
  const added = booted.client.add({
    name: HOST_ID,
    connection: { kind: "ssh", target: options.sshTarget ?? "studio.example" },
  });
  if (added.id !== HOST_ID) throw new Error(`unexpected host id ${added.id}`);

  const manager = booted.manager;
  const connection = () => manager.get(HOST_ID);
  const isConnected = () => connection()?.unavailableEnvelope() === null;
  const bridges = harnessState.bridges;

  const streamsFlowing = (view: FakeView) => {
    const relay = getClientTerminalRelay(view.id);
    const bridge = relay ? bridges.get(relay.endpointId) : undefined;
    return Boolean(relay?.isAttached && !relay.resumeInFlight && bridge?.isResumed && view.hasPort);
  };

  const harness: RemoteHarness = {
    dir,
    hostTmpDir,
    pty,
    projects: harnessState.projects,
    workspaceHosts,
    server: () => requireRemoteService("hostServer"),
    sessionHost: () => requireRemoteService("sessionHost"),
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
    send(channel, view, ...args) {
      for (const listener of [...(sendListeners.get(channel) ?? [])]) {
        listener(senderEvent(view.id), ...args);
      }
    },
    async connect() {
      const readiness = await booted.client.connectAndWait(HOST_ID, 10_000);
      if (readiness !== "ready") throw new Error(`host not ready: ${String(readiness)}`);
      await waitUntil(isConnected, "the Shell to connect");
    },
    isConnected,
    async openStreams(view) {
      // Any host call opens the view's endpoint; operations:list is a real host handler.
      const envelope = await harness.invoke(CHANNELS.OPERATIONS_LIST, view, {});
      if (!envelope.ok) throw new Error(`opening the endpoint failed: ${envelope.error.message}`);
      await waitUntil(() => streamsFlowing(view), `view ${view.id}'s terminal stream`);
      const relay = getClientTerminalRelay(view.id)!;
      return { relay, bridge: bridges.get(relay.endpointId)! };
    },
    streamsFlowing,
    async dropLink() {
      allowConnect = false;
      for (const socket of sockets.splice(0)) socket.destroy();
      await waitUntil(
        () =>
          harness.server().sessions.length === 0 &&
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
      const session = connection()?.currentSession;
      if (!session || !session.isOpen) throw new Error("no open client session");
      return session;
    },
    async dispose() {
      for (const teardown of teardowns.splice(0).reverse()) await teardown();
    },
  };
  return harness;
}
