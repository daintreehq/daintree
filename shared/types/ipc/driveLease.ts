import type { DriveLeaseState } from "../remoteHosts.js";

export interface DriveLeaseProjectPayload {
  projectId: string;
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
}

export type DriveLeaseEvent = { type: "changed"; state: DriveLeaseView };
