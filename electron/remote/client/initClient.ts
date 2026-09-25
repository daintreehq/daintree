import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { app, type WebContents } from "electron";
import type { RemoteHostsEvent } from "../../../shared/types/ipc/remoteHosts.js";
import type { HostId } from "../../../shared/types/remoteHosts.js";
import { CHANNELS } from "../../ipc/channels.js";
import { getIpcDispatcher } from "../../ipc/dispatcher.js";
import { store } from "../../store.js";
import { projectStore } from "../../services/ProjectStore.js";
import { AppError } from "../../utils/errorTypes.js";
import {
  getAllAppWebContents,
  getProjectForWebContents,
  getWindowForWebContents,
  resolveLiveWebContents,
} from "../../window/webContentsRegistry.js";
import { getWindowRegistry } from "../../window/windowRef.js";
import { getLocalHandshakeInfo } from "../handshakeInfo.js";
import type { LinkSession } from "../link/session.js";
import { registerRemoteService } from "../runtime.js";
import { HostRegistry, type RemoteHostsStore } from "./HostRegistry.js";
import {
  RemoteHostManager,
  type EndpointClosedInfo,
  type HostReadiness,
  type EndpointSessionInfo,
  type ViewSink,
} from "./RemoteHostManager.js";
import { RemoteHostsClient, type WindowControl } from "./RemoteHostsClient.js";
import { RemoteRouterImpl, type SenderLookup } from "./RemoteRouter.js";
import { answerReverseRequest } from "./reverseRequests.js";
import { SshTransport } from "./sshTransport.js";
import { WindowHostBinding } from "./WindowHostBinding.js";
import { defaultCommandRunner } from "./commandRunner.js";
import { detectClientBundle, downloadArtifact } from "./clientBuild.js";
import { HostSetupService, RELEASE_FEED_PREFIXES } from "./HostSetupService.js";

declare module "../runtime.js" {
  interface RemoteServices {
    remoteHostsClient: RemoteHostsClient;
    hostSetup: HostSetupService;
  }
}

type WorkingAgentsSource = (hostId: HostId) => number | null;

let workingAgentsSource: WorkingAgentsSource | null = null;

/**
 * Where "agents working on this host" comes from for the update gate. Until a
 * source is set the host list's summary frame is read; with no summary the
 * count is unknown, and an update then needs the user's confirmation.
 */
export function setHostWorkingAgentsSource(source: WorkingAgentsSource | null): void {
  workingAgentsSource = source;
}

type WindowOpener = () => Promise<number>;

let windowOpener: WindowOpener | null = null;

/**
 * How a Cmd/Ctrl-click on a host opens a fresh window. Window creation lives
 * in the composition root, which sets this once windows can be made.
 */
export function setRemoteHostsWindowOpener(opener: WindowOpener | null): void {
  windowOpener = opener;
}

function broadcastLocal(event: RemoteHostsEvent): void {
  for (const wc of getAllAppWebContents()) {
    if (wc.isDestroyed()) continue;
    try {
      wc.send(CHANNELS.REMOTE_HOSTS_EVENT, event);
    } catch {
      // A view mid-teardown.
    }
  }
}

function createViewSink(hostOf: (webContentsId: number) => HostId | null): ViewSink {
  const sink: ViewSink = {
    send(webContentsId, channel, args) {
      const wc = resolveLiveWebContents(webContentsId);
      if (!wc) return false;
      try {
        wc.send(channel, ...args);
        return true;
      } catch {
        return false;
      }
    },
    watch(webContentsId, onGone) {
      const wc = resolveLiveWebContents(webContentsId);
      if (!wc) {
        queueMicrotask(onGone);
        return () => {};
      }
      wc.once("destroyed", onGone);
      return () => {
        try {
          wc.removeListener("destroyed", onGone);
        } catch {
          // Already torn down.
        }
      };
    },
    resync(webContentsId, hostId, reason) {
      const event: RemoteHostsEvent = { type: "resync-required", hostId, reason };
      sink.send(webContentsId, CHANNELS.REMOTE_HOSTS_EVENT, [event]);
    },
    hostOf,
  };
  return sink;
}

const senders: SenderLookup = {
  projectKeyFor: (webContentsId) => getProjectForWebContents(webContentsId),
  windowIdFor(webContentsId) {
    const wc = resolveLiveWebContents(webContentsId);
    const win = wc ? getWindowForWebContents(wc) : null;
    return win && !win.isDestroyed() ? win.id : null;
  },
};

function managerFor(windowId: number) {
  const pvm = getWindowRegistry()?.getByWindowId(windowId)?.services.projectViewManager;
  if (!pvm) {
    throw new AppError({ code: "INTERNAL", message: `Window ${windowId} has no project views` });
  }
  return pvm;
}

export interface RemoteHostsClientHooks {
  /** The first time a host is actually used (see RemoteHostsClientOptions.onFirstUse). */
  onFirstUse?: () => void;
  /** A window now shows a remote project view: newly created, or a cached one reactivated. */
  onRemoteViewActivated?: (windowId: number, webContents: WebContents, isNew: boolean) => void;
}

function createWindowControl(hooks: RemoteHostsClientHooks): WindowControl {
  return {
    async openWindow() {
      if (!windowOpener) {
        throw new AppError({
          code: "UNSUPPORTED",
          message: "Opening a host in a new window is not wired",
          userMessage: "Couldn't open a new window for this host.",
        });
      }
      return windowOpener();
    },
    async openRemoteProject(windowId, hostId, projectId, projectPath) {
      const { view, isNew } = await managerFor(windowId).switchToHostProject(
        hostId,
        projectId,
        projectPath
      );
      const wc = view.webContents;
      if (wc && !wc.isDestroyed()) hooks.onRemoteViewActivated?.(windowId, wc, isNew);
    },
    async openLocalProject(windowId, projectId) {
      const project = projectStore.getProjectById(projectId);
      if (!project) {
        throw new AppError({ code: "NOT_FOUND", message: `No local project ${projectId}` });
      }
      await managerFor(windowId).switchTo(project.id, project.path);
    },
    watchWindow(windowId, onClosed) {
      const win = getWindowRegistry()?.getByWindowId(windowId)?.browserWindow;
      if (!win || win.isDestroyed()) {
        queueMicrotask(onClosed);
        return;
      }
      win.once("closed", onClosed);
    },
  };
}

/**
 * Start the Shell side of Remote Hosts: the host list, per-host connections
 * (dialled only when a window or the user asks), window bindings and the
 * dispatcher's router (installed on first use, so a user with no hosts runs
 * every call exactly as before).
 */
export function initRemoteHostsClient(hooks: RemoteHostsClientHooks = {}): {
  client: RemoteHostsClient;
  /** Every time a local view's endpoint is live on a host session (opened, or carried by a resume). */
  onEndpointOpened(listener: (hostId: string, info: EndpointSessionInfo) => void): () => void;
  /** A view's endpoint on a host was discarded (view gone, moved host, connection stopped). */
  onEndpointClosed(listener: (hostId: string, info: EndpointClosedInfo) => void): () => void;
  /** The view's authoritative host, or null when it runs on this machine. */
  hostForView(webContentsId: number): HostId | null;
  /** The dispatcher's router, for Shell-side relays that forward on a view's behalf. */
  router: RemoteRouterImpl;
  /** The host's open session, whether or not a local view has an endpoint on it. */
  sessionFor(hostId: HostId): LinkSession | null;
  /** Per-host links and the host list, for session-level services such as host summaries. */
  manager: RemoteHostManager;
  registry: HostRegistry;
  dispose(): Promise<void>;
} {
  const registry = new HostRegistry(store as unknown as RemoteHostsStore);
  const clientDir = path.join(app.getPath("userData"), "rh");
  // Bound below: the sink needs the router's answer, the router needs the manager.
  let router: RemoteRouterImpl | null = null;
  const hostForView = (webContentsId: number) => router?.hostForSender(webContentsId) ?? null;
  const manager = new RemoteHostManager({
    registry,
    createTransport: (descriptor) => new SshTransport({ target: descriptor.sshTarget, clientDir }),
    handshake: getLocalHandshakeInfo,
    client: {
      // Per launch: a session only resumes within one run of this app.
      clientId: crypto.randomUUID(),
      clientName: os.hostname(),
      platform:
        process.platform === "win32" ? "win32" : process.platform === "darwin" ? "darwin" : "linux",
    },
    views: createViewSink(hostForView),
    reverseRequests: answerReverseRequest,
  });
  const bindings = new WindowHostBinding();
  const remoteRouter = new RemoteRouterImpl(manager, bindings, senders);
  router = remoteRouter;
  const client: RemoteHostsClient = new RemoteHostsClient({
    registry,
    manager,
    bindings,
    router: remoteRouter,
    senders,
    windows: createWindowControl(hooks),
    installRouter: (next) => getIpcDispatcher().setRemoteRouter(next),
    emit: broadcastLocal,
    onFirstUse: hooks.onFirstUse,
    onForget: (descriptor): Promise<void> => setup.forgetArtifacts(descriptor),
  });
  const setup: HostSetupService = new HostSetupService({
    run: defaultCommandRunner,
    clientDir,
    platform: process.platform,
    knownTargets: () => registry.list().map((host) => host.sshTarget),
    clientBuild: () => {
      const handshake = getLocalHandshakeInfo();
      return {
        platform: handshake.platform,
        arch: handshake.arch,
        version: handshake.version,
        commit: handshake.commit,
        channel: store.get("updateChannel") === "nightly" ? "nightly" : "stable",
        bundle: detectClientBundle({
          isPackaged: app.isPackaged,
          exePath: app.getPath("exe"),
          platform: process.platform,
          env: process.env,
        }),
      };
    },
    async workingAgents(hostId) {
      if (!hostId) return null;
      if (workingAgentsSource) return workingAgentsSource(hostId);
      const entry = client.list().find((host) => host.descriptor.id === hostId);
      return entry?.summary?.agentsObserved.working ?? null;
    },
    async reconnect(hostId) {
      const existing = manager.get(hostId);
      if (!existing) return null;
      const readiness: HostReadiness = await client.connectAndWait(hostId, 30_000);
      return readiness === "ready" ? true : readiness === "version-mismatch" ? false : null;
    },
    download: (url, destination, signal) =>
      downloadArtifact({ url, destination, signal, allowedPrefixes: RELEASE_FEED_PREFIXES }),
    emit: broadcastLocal,
  });
  const unregister = registerRemoteService("remoteHostsClient", client);
  const unregisterSetup = registerRemoteService("hostSetup", setup);
  return {
    client,
    onEndpointOpened: (listener) => manager.onEndpointOpened(listener),
    onEndpointClosed: (listener) => manager.onEndpointClosed(listener),
    hostForView,
    router: remoteRouter,
    sessionFor: (hostId) => manager.get(hostId)?.currentSession ?? null,
    manager,
    registry,
    async dispose() {
      unregister();
      unregisterSetup();
      await client.dispose();
    },
  };
}
