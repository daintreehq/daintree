import type { BrowserWindow } from "electron";
import type { OpenFoldersInNewWindow } from "../../shared/types/windowOpen.js";
import type { WindowRegistry } from "./WindowRegistry.js";
import type { OpenWorld, OpenWorldWindow, WindowOpenReservation } from "./windowOpenPolicy.js";
import { logError } from "../utils/logger.js";

/**
 * Process-wide world state behind `decideProjectOpenTarget` (#12593): which
 * windows have finished booting, and which have an open in flight. Both keep a
 * window out of the empty set while `getActiveProjectId()` still reads null —
 * a window mid-boot is about to bind the workspace it was created or restored
 * for, and a window mid-open is about to show the project it was claimed for.
 */

const readyWindows = new WeakSet<BrowserWindow>();
const reservations = new Map<number, Set<WindowOpenReservation>>();

/** Called once a window has finished setting up and may be picked as an empty window. */
export function markWindowReadyForOpens(win: BrowserWindow): void {
  readyWindows.add(win);
}

/**
 * Claim `windowId` for an open that is about to start. Must be taken
 * synchronously with the decision that chose the window, before any await.
 * Returns an idempotent release, to be called when the open settles either way.
 */
export function reserveWindowForOpen(
  windowId: number,
  reservation: WindowOpenReservation
): () => void {
  const token: WindowOpenReservation = { ...reservation };
  let held = reservations.get(windowId);
  if (!held) {
    held = new Set();
    reservations.set(windowId, held);
  }
  held.add(token);
  return () => {
    const current = reservations.get(windowId);
    if (!current) return;
    current.delete(token);
    if (current.size === 0) reservations.delete(windowId);
  };
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
  for (const ctx of registry?.focusOrder() ?? []) {
    const win = ctx.browserWindow;
    if (win.isDestroyed()) continue;
    const held = [...(reservations.get(ctx.windowId) ?? [])];
    const pvm = ctx.services.projectViewManager;
    try {
      windows.push({
        windowId: ctx.windowId,
        activeProjectId: pvm?.getActiveProjectId() ?? null,
        bridgeProjectId: pvm?.getOutgoingBridgeProjectId() ?? null,
        viewProjectIds:
          pvm
            ?.getAllViews()
            .filter((entry) => !entry.view.webContents.isDestroyed())
            .map((entry) => entry.projectId) ?? [],
        ready: pvm !== undefined && readyWindows.has(win),
        reservations: held,
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
      });
    }
  }
  return { preference, windows };
}

/** Test-only: drop every reservation between cases. */
export function _resetWindowOpenStateForTest(): void {
  reservations.clear();
}
