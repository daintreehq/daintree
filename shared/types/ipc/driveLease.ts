import type { DriveLeaseState } from "../remoteHosts.js";

export interface DriveLeaseProjectPayload {
  projectId: string;
}

export interface DriveLeaseTakeOverPayload extends DriveLeaseProjectPayload {
  /**
   * Take it only if the lease is still the one this view read: that holder's
   * `leaseId`, or null for nobody holding it. Absent, the take-over is
   * unconditional, as the Take over button's is. A claim made on opening a
   * project passes it, so two Shells opening at once can't take it from each
   * other on the same stale read.
   */
  ifLeaseId?: number | null;
}

/**
 * Where the driver is in the project, as it last reported it: what a watching
 * screen moves to so it shows what the driver shows. Screen-owned state (sizes,
 * widths, scroll, zoom, overlays) is never part of it.
 */
export interface DriveLeaseNavigation {
  activeWorktreeId: string | null;
  /** The focused grid or dock panel; null when nothing is focused. */
  focusedPanelId: string | null;
  /** The maximized panel and what it maximizes: itself, or its tab group. */
  maximize: { panelId: string; target: { type: "panel" | "group"; id: string } } | null;
  /** The worktree sidebar hidden by focus mode, as the project saves it. */
  focusMode: boolean;
}

export interface DriveLeaseReportNavigationPayload extends DriveLeaseProjectPayload {
  /**
   * The lease the reporter drove under when it read its navigation, or null
   * for nobody holding it. A report from a lease that has since changed hands
   * is dropped, so a displaced driver's late report can't move anyone.
   */
  leaseId: number | null;
  navigation: DriveLeaseNavigation;
}

/** A project's drive lease as one renderer sees it. */
export interface DriveLeaseView extends DriveLeaseState {
  /**
   * This renderer's client drives the project (or nobody does), so it may type
   * and resize. Enforced per client: every window of the driving machine drives.
   */
  drivingHere: boolean;
  /** This renderer is the holder itself: MCP dispatch and plugin prompts land here. */
  isHolderEndpoint: boolean;
  /** This renderer is a window on the Host machine's own screen (offers "Take back"). */
  viewerIsHostLocal: boolean;
  /**
   * The holder is a window of this renderer's own machine (any of its windows),
   * so opening the project here moves it between this machine's windows rather
   * than from another machine. Absent from hosts before this field.
   */
  heldByThisClient?: boolean;
  /**
   * A window on the Host's own screen shows the project as the active view of
   * a focused window, and someone there has used the Host in the last few
   * minutes. Opening the project elsewhere then leaves it with them. Absent
   * from hosts before this field.
   */
  hostScreenInUse?: boolean;
  /**
   * The driver's navigation as it last reported it, kept across a change of
   * holder so a view taking over starts from it. Absent until a driver reports,
   * and from hosts before this field.
   */
  driverNavigation?: DriveLeaseNavigation;
}

export type DriveLeaseEvent =
  | { type: "changed"; state: DriveLeaseView }
  /**
   * The driver saved a different panel set or layout for the project. Sent
   * only to the views that watch it, which read the host's panels back.
   */
  | { type: "panels-changed"; projectId: string }
  /**
   * The driver saved different composer drafts for the project. Sent only to
   * the views that watch it, which read the drafts back. Carries no text.
   */
  | { type: "drafts-changed"; projectId: string }
  /** The driver moved: sent only to the views that watch the project. */
  | { type: "navigation-changed"; projectId: string; navigation: DriveLeaseNavigation };
