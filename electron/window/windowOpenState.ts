import type { BrowserWindow } from "electron";
import type { OpenFoldersInNewWindow } from "../../shared/types/windowOpen.js";
import type { WindowRegistry } from "./WindowRegistry.js";
import type { OpenWorld, OpenWorldWindow, WindowOpenReservation } from "./windowOpenPolicy.js";
import { logError } from "../utils/logger.js";

/**
 * Process-wide world state behind `decideProjectOpenTarget` (#12593): which
 * windows have finished booting, which have an open in flight, and which are
 * holding a folder whose open settled without binding a workspace. All three
 * keep a window out of the empty set while `getActiveProjectId()` reads null —
 * a window mid-boot is about to bind the workspace it was created or restored
 * for, a window mid-open is about to show the project it was claimed for, and a
 * window left on the picker by a git-init prompt is still answering it.
 */

const readyWindows = new WeakSet<BrowserWindow>();
const reservations = new Map<number, Set<WindowOpenReservation>>();
const unboundOpens = new Map<number, WindowOpenReservation[]>();

/** Called once a window has finished setting up and may be picked as an empty window. */
export function markWindowReadyForOpens(win: BrowserWindow): void {
  readyWindows.add(win);
}

/**
 * Claim `windowId` for an open that is about to start. Must be taken
 * synchronously with the decision that chose the window, before any await.
 *
 * Returns an idempotent release for when the open settles. `bound` says whether
 * the window ended up with a workspace: when it didn't — the folder is waiting
 * on the git-init prompt, or its failure is on screen — the claim stays as an
 * unbound open until the window binds one, so the next queued folder can't take
 * the window out from under the prompt.
 */
export function reserveWindowForOpen(
  windowId: number,
  reservation: WindowOpenReservation
): (bound: boolean) => void {
  const token: WindowOpenReservation = { ...reservation };
  let held = reservations.get(windowId);
  if (!held) {
    held = new Set();
    reservations.set(windowId, held);
  }
  held.add(token);
  let released = false;
  return (bound) => {
    if (released) return;
    released = true;
    const current = reservations.get(windowId);
    if (current) {
      current.delete(token);
      if (current.size === 0) reservations.delete(windowId);
    }
    if (bound) {
      unboundOpens.delete(windowId);
    } else {
      unboundOpens.set(windowId, [...(unboundOpens.get(windowId) ?? []), token]);
    }
  };
}

/**
 * Whether the window now has a workspace in front. Unknown reads as unbound —
 * the direction that can cost an extra window but never an occupied one.
 */
export function isWindowBound(
  registry: WindowRegistry | null | undefined,
  windowId: number
): boolean {
  try {
    return (
      registry?.getByWindowId(windowId)?.services.projectViewManager?.getActiveProjectId() != null
    );
  } catch {
    return false;
  }
}

/**
 * Read every live window into the policy's snapshot shape, most recently
 * focused first. Each window is read from its own view manager — never the
 * process-global one, which only knows the last-created window (#11131) — and a
 * manager that throws is isolated: that window is reported as not ready, so it
 * can never be mistaken for an empty window it might not be.
 */
export function snapshotOpenWorld(
  registry: WindowRegistry | null | undefined,
  preference: OpenFoldersInNewWindow
): OpenWorld {
  const windows: OpenWorldWindow[] = [];
  const live = new Set<number>();
  for (const ctx of registry?.focusOrder() ?? []) {
    const win = ctx.browserWindow;
    if (win.isDestroyed()) continue;
    live.add(ctx.windowId);
    const held = [...(reservations.get(ctx.windowId) ?? [])];
    const pvm = ctx.services.projectViewManager;
    try {
      const activeProjectId = pvm?.getActiveProjectId() ?? null;
      const bridgeProjectId = pvm?.getOutgoingBridgeProjectId() ?? null;
      // A window that has since bound a workspace (a project picked from its
      // own picker, say) has moved on from the folder it was waiting on.
      if (activeProjectId !== null || bridgeProjectId !== null) unboundOpens.delete(ctx.windowId);
      windows.push({
        windowId: ctx.windowId,
        activeProjectId,
        bridgeProjectId,
        viewProjectIds:
          pvm
            ?.getAllViews()
            .filter((entry) => !entry.view.webContents.isDestroyed())
            .map((entry) => entry.projectId) ?? [],
        ready: pvm !== undefined && readyWindows.has(win),
        reservations: held,
        unboundOpens: [...(unboundOpens.get(ctx.windowId) ?? [])],
      });
    } catch (error) {
      logError("window-open-snapshot-manager-failed", error, { windowId: ctx.windowId });
      windows.push({
        windowId: ctx.windowId,
        activeProjectId: null,
        bridgeProjectId: null,
        viewProjectIds: [],
        ready: false,
        reservations: held,
        unboundOpens: [...(unboundOpens.get(ctx.windowId) ?? [])],
      });
    }
  }
  for (const windowId of unboundOpens.keys()) {
    if (!live.has(windowId)) unboundOpens.delete(windowId);
  }
  return { preference, windows };
}

/** Test-only: drop every reservation between cases. */
export function _resetWindowOpenStateForTest(): void {
  reservations.clear();
  unboundOpens.clear();
}
