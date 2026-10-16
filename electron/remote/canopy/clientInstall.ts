import { webContents } from "electron";
import type { CanopyHostEvent } from "../../../shared/types/ipc/canopyHost.js";
import { CHANNELS } from "../../ipc/channels.js";
import { getLocalClientRef } from "../../ipc/localEndpoint.js";
import { onWebContentsDestroyed } from "../../window/webContentsDestroyed.js";
import { registerRemoteService } from "../runtime.js";
import { CanopyHostsClient, type CanopyHostsClientOptions } from "./client.js";
import { createLocalCanopyViewers } from "./localViewers.js";

declare module "../runtime.js" {
  interface RemoteServices {
    canopyHosts: CanopyHostsClient;
  }
}

function send(webContentsId: number, event: CanopyHostEvent): boolean {
  const wc = webContents.fromId(webContentsId);
  if (!wc || wc.isDestroyed()) return false;
  try {
    wc.send(CHANNELS.CANOPY_HOST_EVENT, event);
    return true;
  } catch {
    return false;
  }
}

/** A reload starts the view with no panel open, as does its going away. */
function watchView(webContentsId: number, onGone: () => void): () => void {
  const wc = webContents.fromId(webContentsId);
  if (!wc || wc.isDestroyed()) {
    queueMicrotask(onGone);
    return () => {};
  }
  let gone = false;
  const once = () => {
    if (gone) return;
    gone = true;
    onGone();
  };
  const onNavigate = (details: { isMainFrame: boolean; isSameDocument: boolean }) => {
    if (details.isMainFrame && !details.isSameDocument) once();
  };
  wc.on("did-start-navigation", onNavigate);
  wc.on("render-process-gone", once);
  const unwatchDestroyed = onWebContentsDestroyed(wc, once);
  return () => {
    wc.removeListener("did-start-navigation", onNavigate);
    wc.removeListener("render-process-gone", once);
    unwatchDestroyed();
  };
}

export interface InstallCanopyHostsClientOptions {
  manager: CanopyHostsClientOptions["manager"];
  registry: CanopyHostsClientOptions["registry"];
  hostForView: CanopyHostsClientOptions["hostForView"];
}

/** Start the Shell side of Canopy reading hosts views aren't bound to. */
export function installCanopyHostsClient(options: InstallCanopyHostsClientOptions): () => void {
  const client = new CanopyHostsClient({
    ...options,
    local: createLocalCanopyViewers(),
    localClient: getLocalClientRef(),
    send,
    watchView,
  });
  client.start();
  const unregister = registerRemoteService("canopyHosts", client);
  return () => {
    unregister();
    client.dispose();
  };
}
