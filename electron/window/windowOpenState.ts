import type { BrowserWindow } from "electron";
import type { OpenFoldersInNewWindow } from "../../shared/types/windowOpen.js";
import type { WindowRegistry } from "./WindowRegistry.js";
import type { OpenWorld, OpenWorldWindow, WindowOpenReservation } from "./windowOpenPolicy.js";
import { getProjectHistory } from "../services/ProjectHistoryService.js";
import { logError } from "../utils/logger.js";
import { getPendingActivationProjectIds } from "./projectActivationClaims.js";

/**
 * Process-wide world state behind `decideProjectOpenTarget` (#12593): which
 * windows have finished booting, which have an open in flight, and which are
 * holding a folder whose open settled without binding a workspace. All three
 * keep a window out of the empty set while it reads as the picker — a window
 * mid-boot is about to bind the workspace it was created or restored for, a
 * window mid-open is about to show the project it was claimed for, and a window
 * left on the picker by a git-init prompt is still answering it.
 */

/**
 * True for a workspace id whose project row is closed. Closing the project a
 * window shows keeps its view (and the view manager's binding) alive to paint
 * the picker, so the id outlives the open project — the same rule the menu's
 * project gate applies (`projectMenuState.ts`). Scratch ids have no project row
 * and are never closed.
 */
export type IsClosedWorkspace = (workspaceId: string) => boolean;

const neverClosed: IsClosedWorkspace = () => false;

interface UnboundOpens {
  claims: WindowOpenReservation[];
  /** The window's history head when the claims were parked. */
  historyHead: string | null;
}

const readyWindows = new WeakSet<BrowserWindow>();
const reservations = new Map<number, Set<WindowOpenReservation>>();
const unboundOpens = new Map<number, UnboundOpens>();

/** Called once a window has finished setting up and may be picked as an empty window. */
export function markWindowReadyForOpens(win: BrowserWindow): void {
  readyWindows.add(win);
}

export function isWindowReadyForOpens(win: BrowserWindow): boolean {
  return readyWindows.has(win);
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
      return;
    }
    // Every completed switch records into the window's history, so a head that
    // has moved since earlier claims were parked means the window bound a
    // workspace in between: those claims are stale.
    const historyHead = getProjectHistory(windowId).current();
    const parked = unboundOpens.get(windowId);
    const claims = parked?.historyHead === historyHead ? parked.claims : [];
    unboundOpens.set(windowId, { claims: [...claims, token], historyHead });
  };
}

/**
 * Whether the window now has a workspace in front. Unknown reads as unbound —
 * the direction that can cost an extra window but never an occupied one.
 */
export function isWindowBound(
  registry: WindowRegistry | null | undefined,
  windowId: number,
  isClosedWorkspace: IsClosedWorkspace = neverClosed
): boolean {
  try {
    const activeId = registry
      ?.getByWindowId(windowId)
      ?.services.projectViewManager?.getActiveProjectId();
    return activeId != null && !isClosedWorkspace(activeId);
  } catch {
    return false;
  }
}

/**
 * Run `open` with `windowId` claimed for it: reserved before `open` starts, and
 * released when it settles, bound or not as `isBound` then reports. Rejections
 * propagate after the release.
 */
export async function holdWindowForOpen(
  windowId: number,
  reservation: WindowOpenReservation,
  open: () => Promise<void>,
  isBound: () => boolean
): Promise<void> {
  const release = reserveWindowForOpen(windowId, reservation);
  try {
    await open();
  } finally {
    let bound = false;
    try {
      bound = isBound();
    } catch {
      // Unknown reads as unbound, as in isWindowBound.
    }
    release(bound);
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
  preference: OpenFoldersInNewWindow,
  isClosedWorkspace: IsClosedWorkspace = neverClosed
): OpenWorld {
  const shown = (id: string | null | undefined): string | null =>
    id != null && !isClosedWorkspace(id) ? id : null;
  const windows: OpenWorldWindow[] = [];
  const live = new Set<number>();
  for (const ctx of registry?.focusOrder() ?? []) {
    const win = ctx.browserWindow;
    if (win.isDestroyed()) continue;
    live.add(ctx.windowId);
    // An in-app switch or menu open that has committed to a project but whose
    // view isn't registered yet (#12596) is an open in flight too, so an
    // external open of that project focuses this window rather than building a
    // second view, and the window never reads as empty mid-switch.
    const held: WindowOpenReservation[] = [
      ...(reservations.get(ctx.windowId) ?? []),
      ...getPendingActivationProjectIds(ctx.windowId).map((projectId) => ({
        projectId,
        projectPath: null,
      })),
    ];
    const pvm = ctx.services.projectViewManager;
    try {
      const activeProjectId = shown(pvm?.getActiveProjectId());
      const bridgeProjectId = shown(pvm?.getOutgoingBridgeProjectId());
      // A window that has bound a workspace since — on screen now, or one it
      // has already left again — has moved on from the folder it was holding.
      const parked = unboundOpens.get(ctx.windowId);
      if (
        parked &&
        (activeProjectId !== null ||
          bridgeProjectId !== null ||
          getProjectHistory(ctx.windowId).current() !== parked.historyHead)
      ) {
        unboundOpens.delete(ctx.windowId);
      }
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
        unboundOpens: [...(unboundOpens.get(ctx.windowId)?.claims ?? [])],
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
        unboundOpens: [...(unboundOpens.get(ctx.windowId)?.claims ?? [])],
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
