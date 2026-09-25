import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { app } from "electron";
import type { RemoteHostsEvent } from "../../../shared/types/ipc/remoteHosts.js";
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
import { registerRemoteService } from "../runtime.js";
import { HostRegistry, type RemoteHostsStore } from "./HostRegistry.js";
import { RemoteHostManager, type ViewSink } from "./RemoteHostManager.js";
import { RemoteHostsClient, type WindowControl } from "./RemoteHostsClient.js";
import { RemoteRouterImpl, type SenderLookup } from "./RemoteRouter.js";
import { SshTransport } from "./sshTransport.js";
import { WindowHostBinding } from "./WindowHostBinding.js";

declare module "../runtime.js" {
  interface RemoteServices {
    remoteHostsClient: RemoteHostsClient;
  }
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

const viewSink: ViewSink = {
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
    viewSink.send(webContentsId, CHANNELS.REMOTE_HOSTS_EVENT, [event]);
  },
};

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

const windowControl: WindowControl = {
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
    await managerFor(windowId).switchToHostProject(hostId, projectId, projectPath);
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

/**
 * Start the Shell side of Remote Hosts: the host list, per-host connections
 * (dialled only when a window or the user asks), window bindings and the
 * dispatcher's router (installed on first use, so a user with no hosts runs
 * every call exactly as before).
 */
export function initRemoteHostsClient(): { client: RemoteHostsClient; dispose(): Promise<void> } {
  const registry = new HostRegistry(store as unknown as RemoteHostsStore);
  const clientDir = path.join(app.getPath("userData"), "rh");
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
    views: viewSink,
  });
  const bindings = new WindowHostBinding();
  const router = new RemoteRouterImpl(manager, bindings, senders);
  const client = new RemoteHostsClient({
    registry,
    manager,
    bindings,
    router,
    senders,
    windows: windowControl,
    installRouter: (next) => getIpcDispatcher().setRemoteRouter(next),
    emit: broadcastLocal,
  });
  const unregister = registerRemoteService("remoteHostsClient", client);
  return {
    client,
    async dispose() {
      unregister();
      await client.dispose();
    },
  };
}
