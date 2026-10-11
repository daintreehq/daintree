/**
 * Windows that were showing another machine's project when the app last quit.
 *
 * The restore opens such a window on this machine's picker (nothing remote
 * exists that early) and records where it belongs. Once Remote Hosts is up,
 * each one is switched back to its host's project through the same switch the
 * host menu uses: those already set up at once, and any that finish setting up
 * later (a crash recovery brings its fleet back after the start) as they do. A
 * window the person has meanwhile put to use is left alone; one whose host
 * can't be reached stays on this machine with a Retry, and its place on the
 * host is kept for the next launch until it shows something else.
 *
 * Core code: reaches the client through the remote runtime, never by import.
 */

import { parseHostScopedKey } from "../../shared/types/remoteHosts.js";
import type { WebContents } from "electron";
import type { MainProcessToastPayload } from "../../shared/types/ipc/maps.js";
import { CHANNELS } from "../ipc/channels.js";
import { getRemoteService } from "../remote/runtime.js";
import { getUserMessage } from "../utils/errorTypes.js";
import {
  clearPendingRemoteRestore,
  getPendingRemoteRestore,
  setPendingRemoteRestore,
} from "./openWindowsTracker.js";

/** The IPC channel a failed restore's Retry runs, from the window it failed in. */
export const REMOTE_RESTORE_RETRY_CHANNEL = "remote-hosts:switch-window-host";

export interface RemoteWindowRestoreDeps {
  /**
   * Open, still on the picker its restore opened, and with no open of the
   * person's in flight or waiting on them: nothing of theirs to replace.
   */
  isWindowWaiting(windowId: number): boolean;
  /** The view a toast for that window goes to. */
  viewOf(windowId: number): WebContents | null;
  /** A window moved to its host: the manifest describes it now. */
  onRestored(): void;
}

/** Noted for a host and not yet attempted. */
const waiting = new Set<number>();
/** Finished setting up, so its view can be switched. */
const setUp = new Set<number>();
/** Set once Remote Hosts is up; from then on a window is restored as soon as it is set up. */
let armed: RemoteWindowRestoreDeps | null = null;

/** A restored window belongs on `workspaceKey` (`<hostId>:<projectId>`). */
export function noteRemoteWindowRestore(windowId: number, workspaceKey: string): void {
  setPendingRemoteRestore(windowId, workspaceKey);
  waiting.add(windowId);
}

/** The window finished setting up. Once Remote Hosts is up, its restore starts now. */
export function remoteWindowReady(windowId: number): void {
  setUp.add(windowId);
  if (!armed || !waiting.has(windowId)) return;
  waiting.delete(windowId);
  void restoreOne(armed, windowId);
}

/** The window closed: nothing to bring back, nothing to keep. */
export function forgetRemoteWindowRestore(windowId: number): void {
  waiting.delete(windowId);
  setUp.delete(windowId);
  clearPendingRemoteRestore(windowId);
}

/**
 * Remote Hosts is up: switch every waiting window that is set up to its host's
 * project, and do the same for each one that finishes setting up from now on.
 * Settles once those already set up have.
 */
export async function restoreRemoteWindows(deps: RemoteWindowRestoreDeps): Promise<void> {
  armed = deps;
  const ready = [...waiting].filter((windowId) => setUp.has(windowId));
  for (const windowId of ready) waiting.delete(windowId);
  await Promise.allSettled(ready.map((windowId) => restoreOne(deps, windowId)));
}

async function restoreOne(deps: RemoteWindowRestoreDeps, windowId: number): Promise<void> {
  const key = getPendingRemoteRestore(windowId);
  if (key === null || !deps.isWindowWaiting(windowId)) return;
  const client = getRemoteService("remoteHostsClient");
  if (!client) return;
  const { hostId, projectId } = parseHostScopedKey(key);
  const hostName = client.list().find((entry) => entry.descriptor.id === hostId)?.descriptor.name;
  if (hostName === undefined) {
    // The host was removed from this device: there is nothing to go back to.
    clearPendingRemoteRestore(windowId);
    return;
  }
  // Asked before the window moves: a project the person opened there while
  // the host was connecting is never replaced.
  const stillWanted = () => deps.isWindowWaiting(windowId);
  try {
    const result = await client.switchWindowToHostProject(windowId, hostId, projectId, stillWanted);
    if (result.outcome === "switched") deps.onRestored();
  } catch (error) {
    if (!stillWanted()) return;
    // A save taken while the view was loading may have spent the intent; the
    // window is back on the picker, so it still belongs on the host.
    setPendingRemoteRestore(windowId, key);
    console.warn(`[RemoteHosts] Couldn't reopen a window on ${hostId}:`, error);
    const view = deps.viewOf(windowId);
    if (!view || view.isDestroyed()) return;
    const toast: MainProcessToastPayload = {
      type: "error",
      title: `Couldn't reopen this window on ${hostName}`,
      message: `${getUserMessage(error)} The window opened on this machine instead.`,
      action: {
        label: "Retry",
        ipcChannel: REMOTE_RESTORE_RETRY_CHANNEL,
        data: JSON.stringify({ hostId, projectId }),
      },
    };
    view.send(CHANNELS.NOTIFICATION_SHOW_TOAST, toast);
  }
}

/** Test-only. */
export function resetRemoteWindowRestoreForTests(): void {
  waiting.clear();
  setUp.clear();
  armed = null;
}
