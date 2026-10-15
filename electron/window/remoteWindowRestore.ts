/**
 * Windows that were showing another machine's project when the app last quit.
 *
 * The restore opens such a window on this machine's picker (nothing remote
 * exists that early) and records where it belongs. Once Remote Hosts is up,
 * each one is switched back to its host's project through the same switch the
 * host menu uses: those already set up at once, and any that finish setting up
 * later (a crash recovery brings its fleet back after the start) as they do. A
 * window the person has meanwhile put to use is left alone. One whose host
 * can't be reached stays on this machine's picker with a Retry, keeps its
 * place on the host for the next launch until it shows something else, and
 * moves back by itself once the host is reachable: tried again whenever the
 * host connects, and the host re-dialled now and then while it waits, since a
 * host that quit cleanly parks its link and nothing else would dial it.
 *
 * Core code: reaches the client through the remote runtime, never by import.
 */

import { parseHostScopedKey, type HostConnectionState } from "../../shared/types/remoteHosts.js";
import type { WebContents } from "electron";
import type { MainProcessToastPayload } from "../../shared/types/ipc/maps.js";
import { CHANNELS } from "../ipc/channels.js";
import { getRemoteService } from "../remote/runtime.js";
import { getUserMessage, isAppError } from "../utils/errorTypes.js";
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
/** Windows whose restore failed to reach their host, by window id, with that host's id. */
const awaitingHost = new Map<number, string>();
/** The first wait between dials of a host a window is waiting for, doubling to a cap. */
export const REMOTE_RESTORE_REDIAL_MS = 30_000;
export const REMOTE_RESTORE_REDIAL_MAX_MS = 5 * 60_000;
/**
 * What is known about each awaited host. `redial` is false while what was
 * last seen there won't change by dialling again (ssh refused the login, the
 * builds can't talk): the window still moves back if the host connects.
 */
const hostWait = new Map<
  string,
  { lastStatus: string | null; redial: boolean; delayMs: number; nextDialAt: number }
>();
let redialTimer: ReturnType<typeof setInterval> | null = null;
let offConnection: (() => void) | null = null;
/** Switch failures a later dial can't change: the person has to act first. */
const NOT_REDIALLED = new Set(["HOST_SSH_ACCESS_DENIED", "HOST_VERSION_MISMATCH"]);

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
  stopAwaiting(windowId);
  clearPendingRemoteRestore(windowId);
}

function waitFor(hostId: string) {
  let wait = hostWait.get(hostId);
  if (!wait) {
    // Seeded from the link as it is now, so a host already connected doesn't
    // read its next ping as a reconnect.
    const current = getRemoteService("remoteHostsClient")
      ?.list()
      .find((entry) => entry.descriptor.id === hostId)?.connection?.status;
    wait = {
      lastStatus: current ?? null,
      redial: true,
      delayMs: REMOTE_RESTORE_REDIAL_MS,
      nextDialAt: 0,
    };
    hostWait.set(hostId, wait);
  }
  return wait;
}

/**
 * The window waits no more. What was seen of its host is kept (it is one
 * entry per host, gone with the host), so a window that goes straight back
 * to waiting after a failed retry doesn't read the next ping as a reconnect.
 */
function stopAwaiting(windowId: number): void {
  awaitingHost.delete(windowId);
  if (awaitingHost.size > 0) return;
  if (redialTimer) clearInterval(redialTimer);
  redialTimer = null;
}

/**
 * Whether a window still waits for `hostId`: still on its picker, still
 * meant for that host, and with no switch of the person's on its way. Gives
 * the window up when not.
 */
function stillAwaiting(deps: RemoteWindowRestoreDeps, windowId: number, hostId: string): boolean {
  const key = getPendingRemoteRestore(windowId);
  const client = getRemoteService("remoteHostsClient");
  const ok =
    key !== null &&
    parseHostScopedKey(key).hostId === hostId &&
    deps.isWindowWaiting(windowId) &&
    client?.hasPendingSwitch?.(windowId) !== true &&
    client?.list().some((entry) => entry.descriptor.id === hostId) === true;
  if (!ok) stopAwaiting(windowId);
  return ok;
}

/** Try again every window waiting for `hostId`, quietly: each was told once already. */
function retryAwaiting(deps: RemoteWindowRestoreDeps, hostId: string): void {
  for (const [windowId, awaited] of [...awaitingHost]) {
    if (awaited !== hostId || !stillAwaiting(deps, windowId, hostId)) continue;
    stopAwaiting(windowId);
    void restoreOne(deps, windowId, { quiet: true });
  }
}

/**
 * A host's connection changed. Only a move into `connected` retries: a
 * connected link reports every ping too, and a restore that failed on a
 * connected host would otherwise be tried again each time.
 */
function onHostConnection(hostId: string, state: HostConnectionState): void {
  const wait = hostWait.get(hostId);
  if (!wait) return;
  const was = wait.lastStatus;
  wait.lastStatus = state.status;
  if (state.status === "connected") {
    // Whatever stopped the dialling (ssh refused, a build it couldn't talk
    // to) has been dealt with, and the backoff starts over.
    wait.redial = true;
    wait.delayMs = REMOTE_RESTORE_REDIAL_MS;
    wait.nextDialAt = 0;
    if (was !== "connected" && armed) retryAwaiting(armed, hostId);
    return;
  }
  if (state.status === "version-mismatch") wait.redial = false;
  if (state.status === "unreachable" && state.stoppedRetrying && !state.hostModeOff) {
    wait.redial = false;
  }
  if (state.status === "unreachable" && state.hostModeOff) wait.redial = true;
}

/** Dial each awaited host whose wait is up, backing off while it stays away. */
function redialAwaitedHosts(deps: RemoteWindowRestoreDeps): void {
  for (const [windowId, hostId] of [...awaitingHost]) stillAwaiting(deps, windowId, hostId);
  const client = getRemoteService("remoteHostsClient");
  const now = Date.now();
  for (const hostId of new Set(awaitingHost.values())) {
    const wait = waitFor(hostId);
    if (!wait.redial || wait.lastStatus === "connected" || now < wait.nextDialAt) continue;
    wait.delayMs = Math.min(wait.delayMs * 2, REMOTE_RESTORE_REDIAL_MAX_MS);
    wait.nextDialAt = now + wait.delayMs;
    try {
      client?.connect({ hostId });
    } catch (error) {
      console.warn(`[RemoteHosts] Couldn't dial ${hostId} for a waiting window:`, error);
    }
  }
}

/**
 * Keep after the host a window is waiting for: retry it once the host
 * connects, and dial the host again now and then meanwhile.
 */
function awaitHost(
  deps: RemoteWindowRestoreDeps,
  windowId: number,
  hostId: string,
  code: string | null
): void {
  awaitingHost.set(windowId, hostId);
  const wait = waitFor(hostId);
  if (code !== null && NOT_REDIALLED.has(code)) wait.redial = false;
  if (wait.nextDialAt === 0) wait.nextDialAt = Date.now() + wait.delayMs;
  const client = getRemoteService("remoteHostsClient");
  if (!client) return;
  offConnection ??= client.onConnectionChange?.(onHostConnection) ?? null;
  if (redialTimer) return;
  redialTimer = setInterval(() => redialAwaitedHosts(deps), REMOTE_RESTORE_REDIAL_MS);
  redialTimer.unref?.();
}

/** A host was removed or re-pointed: no window waits for it any more. */
export function forgetRemoteRestoresForHost(hostId: string): void {
  for (const [windowId, awaited] of [...awaitingHost]) {
    if (awaited === hostId) stopAwaiting(windowId);
  }
  hostWait.delete(hostId);
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

async function restoreOne(
  deps: RemoteWindowRestoreDeps,
  windowId: number,
  options: { quiet?: boolean } = {}
): Promise<void> {
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
  // A switch the person started in the window wins: the restore lets go of it.
  if (client.hasPendingSwitch?.(windowId) === true) {
    stopAwaiting(windowId);
    clearPendingRemoteRestore(windowId);
    return;
  }
  // Asked before the window moves: a project the person opened there while
  // the host was connecting is never replaced.
  const stillWanted = () => deps.isWindowWaiting(windowId);
  try {
    const result = await client.switchWindowToHostProject(windowId, hostId, projectId, stillWanted);
    if (result.outcome === "switched") deps.onRestored();
    if (result.outcome === "focused-elsewhere") {
      // Another window has that project now: this one stays on this machine's
      // picker, and the manifest stops saying it belongs on the host.
      clearPendingRemoteRestore(windowId);
      deps.onRestored();
    }
  } catch (error) {
    if (!stillWanted()) return;
    // Removed from this device while it was being reached: nothing to retry.
    if (!client.list().some((entry) => entry.descriptor.id === hostId)) {
      clearPendingRemoteRestore(windowId);
      return;
    }
    // A save taken while the view was loading may have spent the intent; the
    // window is back on the picker, so it still belongs on the host.
    setPendingRemoteRestore(windowId, key);
    const code = isAppError(error) ? error.code : null;
    // The project is gone from the host: nothing will bring the window back there.
    const projectGone = code === "NOT_FOUND";
    if (projectGone) {
      clearPendingRemoteRestore(windowId);
    } else {
      awaitHost(deps, windowId, hostId, code);
    }
    if (options.quiet) return;
    console.warn(`[RemoteHosts] Couldn't reopen a window on ${hostId}:`, error);
    const view = deps.viewOf(windowId);
    if (!view || view.isDestroyed()) return;
    const toast: MainProcessToastPayload = {
      type: "error",
      title: `Couldn't reopen this window on ${hostName}`,
      message: projectGone
        ? `${getUserMessage(error)} The window opened on this machine instead.`
        : `${getUserMessage(error)} It's on this machine for now and moves back once ${hostName} is reachable.`,
      action: {
        label: "Retry",
        ipcChannel: REMOTE_RESTORE_RETRY_CHANNEL,
        data: JSON.stringify({ hostId, projectId }),
      },
      // Read by the host-switch failure presenter, which offers what gets this
      // host back (Set up…, Settings…) where Retry alone would fail the same way.
      hostSwitchFailure: { hostId, projectId, code },
    };
    view.send(CHANNELS.NOTIFICATION_SHOW_TOAST, toast);
  }
}

/** Test-only. */
export function resetRemoteWindowRestoreForTests(): void {
  waiting.clear();
  setUp.clear();
  awaitingHost.clear();
  hostWait.clear();
  if (redialTimer) clearInterval(redialTimer);
  redialTimer = null;
  offConnection?.();
  offConnection = null;
  armed = null;
}
