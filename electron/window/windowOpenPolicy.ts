import type {
  OpenFoldersInNewWindow,
  ProjectOpenDisposition,
} from "../../shared/types/windowOpen.js";

/**
 * The one decision point for which window a project open lands in (#12593).
 *
 * Pure: every input is in the request and the world snapshot, so the whole
 * precedence matrix is testable without Electron. The snapshot is taken and the
 * target claimed synchronously by the caller (see `windowOpenState.ts`) — each
 * window's view manager only serializes its own switches, so two opens that
 * both read "no owner" across an `await` would each create a view.
 */

/** Where the request came from. */
export type ProjectOpenSource = "external" | "in-app" | "restore";

/** Opening a folder, or navigating to a project the window already knows. */
export type ProjectOpenIntent = "open" | "switch";

export interface ProjectOpenRequest {
  /** The registered project, or null when the folder resolved to none (e.g. not a repository yet). */
  projectId: string | null;
  /** Canonical project path, matched against in-flight opens that haven't resolved an id. */
  projectPath: string | null;
  source: ProjectOpenSource;
  intent: ProjectOpenIntent;
  disposition: ProjectOpenDisposition;
  /** The window that asked. Null for opens from outside the app. */
  initiatingWindowId: number | null;
}

/** An open in flight into a window, claimed before its first await. */
export interface WindowOpenReservation {
  projectId: string | null;
  projectPath: string | null;
}

export interface OpenWorldWindow {
  windowId: number;
  /** The workspace in the foreground (project or scratch), or null on the project picker. */
  activeProjectId: string | null;
  /** A workspace still painted behind a cold switch's anti-flash bridge. */
  bridgeProjectId: string | null;
  /** Every workspace with a live view in this window, foreground and cached. */
  viewProjectIds: readonly string[];
  /**
   * False until the window has finished setting up. A booting window may still
   * be about to bind the workspace it was created or restored for, so it is
   * never treated as empty.
   */
  ready: boolean;
  reservations: readonly WindowOpenReservation[];
}

export interface OpenWorld {
  preference: OpenFoldersInNewWindow;
  /** Live windows, most recently focused first. */
  windows: readonly OpenWorldWindow[];
}

export type ProjectOpenDecision =
  /** The project is already in front in this window (or on its way there): bring the window forward. */
  | { kind: "focus"; windowId: number }
  /** Open or switch the project inside this existing window. */
  | { kind: "activate"; windowId: number; reason: "owner" | "empty" | "current" }
  /** No existing window qualifies: make one. */
  | { kind: "create" };

function reservationMatches(
  reservation: WindowOpenReservation,
  request: ProjectOpenRequest
): boolean {
  if (request.projectId !== null && reservation.projectId === request.projectId) return true;
  return request.projectPath !== null && reservation.projectPath === request.projectPath;
}

// The asking window first, then focus order, so a tie between windows that
// both qualify goes to the one the user is in.
function candidateOrder(request: ProjectOpenRequest, world: OpenWorld): OpenWorldWindow[] {
  const initiating = world.windows.find((w) => w.windowId === request.initiatingWindowId);
  if (!initiating) return [...world.windows];
  return [initiating, ...world.windows.filter((w) => w !== initiating)];
}

/** Precedence rule 1: a window that already owns the project wins over everything. */
function findOwner(request: ProjectOpenRequest, world: OpenWorld): ProjectOpenDecision | null {
  const { projectId } = request;
  const windows = candidateOrder(request, world);

  if (projectId !== null) {
    const foreground = windows.find((w) => w.activeProjectId === projectId);
    if (foreground) return { kind: "focus", windowId: foreground.windowId };
  }

  const inFlight = windows.find((w) => w.reservations.some((r) => reservationMatches(r, request)));
  if (inFlight) return { kind: "focus", windowId: inFlight.windowId };

  if (projectId !== null) {
    const cached = windows.find((w) => w.viewProjectIds.includes(projectId));
    if (cached) return { kind: "activate", windowId: cached.windowId, reason: "owner" };
  }

  return null;
}

function isEmptyWindow(w: OpenWorldWindow): boolean {
  return (
    w.ready && w.activeProjectId === null && w.bridgeProjectId === null && w.reservations.length === 0
  );
}

/** "New window": an empty window if there is one, otherwise a fresh one. */
function newWindowTarget(request: ProjectOpenRequest, world: OpenWorld): ProjectOpenDecision {
  const empty = candidateOrder(request, world).find(isEmptyWindow);
  if (empty) return { kind: "activate", windowId: empty.windowId, reason: "empty" };
  return { kind: "create" };
}

/**
 * "This window": the asking window, or for a request with none (an external
 * open under `off`) the most recently focused window that has finished booting.
 */
function currentWindowTarget(request: ProjectOpenRequest, world: OpenWorld): ProjectOpenDecision {
  const target =
    world.windows.find((w) => w.windowId === request.initiatingWindowId) ??
    world.windows.find((w) => w.ready);
  if (target) return { kind: "activate", windowId: target.windowId, reason: "current" };
  return newWindowTarget(request, world);
}

export function decideProjectOpenTarget(
  request: ProjectOpenRequest,
  world: OpenWorld
): ProjectOpenDecision {
  const owner = findOwner(request, world);
  if (owner) return owner;

  // Rule 2: an explicit disposition beats the preference.
  if (request.disposition === "new") return newWindowTarget(request, world);
  if (request.disposition === "current") return currentWindowTarget(request, world);

  // Rule 3: navigation and restore keep their window whatever the preference says.
  if (request.intent === "switch" || request.source === "restore") {
    return currentWindowTarget(request, world);
  }

  // Rule 4: the preference, and under `default` the origin, decides a plain open.
  if (world.preference === "on") return newWindowTarget(request, world);
  if (world.preference === "off") return currentWindowTarget(request, world);
  return request.source === "external"
    ? newWindowTarget(request, world)
    : currentWindowTarget(request, world);
}
