import { LOCAL_HOST_ID, isLocalHostId, type HostId } from "../../shared/types/remoteHosts.js";
import type { SwitchWindowHostResult } from "../../shared/types/ipc/remoteHosts.js";
import { getRemoteService, requireRemoteService } from "../remote/runtime.js";

/**
 * What main's window code needs from Remote Hosts: which host a window is on,
 * and the moves that keep a window's binding and its view together. The
 * Remote Hosts client registers itself under this key at boot.
 */
export interface WindowHostService {
  windowHost(windowId: number): HostId;
  viewHost(webContentsId: number): HostId;
  /** The name the user knows a host by, or null for one this machine doesn't list. */
  hostName?(hostId: HostId): string | null;
  switchWindowToLocal(windowId: number, projectId: string): Promise<SwitchWindowHostResult>;
  openHostProjectInNewWindow(hostId: HostId, projectPath: string): Promise<SwitchWindowHostResult>;
  /** A navigation in the window that didn't go through Remote Hosts: a host switch waiting there gives way. */
  supersedePendingSwitch?(windowId: number): void;
}

declare module "../remote/runtime.js" {
  interface RemoteServices {
    windowHosts: WindowHostService;
  }
}

/**
 * The host a window is attached to. Every window is on this machine until a
 * Remote Hosts switch puts it on a host, and a build without Remote Hosts has
 * none to put it on.
 */
export function getWindowHostId(windowId: number): HostId {
  return getRemoteService("windowHosts")?.windowHost(windowId) ?? LOCAL_HOST_ID;
}

/**
 * Whether a window shows a remote host's work. Its renderer's calls go to that
 * host, so a folder on this machine can't open in it as it stands.
 */
export function isWindowOnRemoteHost(windowId: number): boolean {
  return !isLocalHostId(getWindowHostId(windowId));
}

/**
 * The newest navigation in a window wins: a switch to another host still
 * waiting on that host when the person picks something here (a local project
 * or scratch, File › Open Recent) must not pull the window there once the host
 * answers.
 */
export function supersedePendingHostSwitch(windowId: number | null | undefined): void {
  if (windowId == null) return;
  getRemoteService("windowHosts")?.supersedePendingSwitch?.(windowId);
}

/** Bring a window that is on a host back to this machine, showing one of its workspaces. */
export function switchWindowToLocal(
  windowId: number,
  projectId: string
): Promise<SwitchWindowHostResult> {
  return requireRemoteService("windowHosts").switchWindowToLocal(windowId, projectId);
}

/**
 * Where a view's request for a new window goes. A view on a remote host lists
 * the host's projects, so a path it names is the host's and the new window
 * opens that project there; everything else is this machine's. The asking
 * view's own host decides, not its window's: the window may have moved on
 * while the view was choosing.
 */
export async function routeNewWindowRequest(
  senderWebContentsId: number,
  windowId: number | null,
  projectPath: string | undefined,
  openOnThisMachine: (projectPath?: string, initiatingWindowId?: number | null) => Promise<void>
): Promise<void> {
  const hostId = getRemoteService("windowHosts")?.viewHost(senderWebContentsId) ?? LOCAL_HOST_ID;
  if (projectPath && !isLocalHostId(hostId)) {
    await requireRemoteService("windowHosts").openHostProjectInNewWindow(hostId, projectPath);
    return;
  }
  await openOnThisMachine(projectPath, windowId);
}
