import type { DriveLeaseState } from "../remoteHosts.js";

export interface DriveLeaseProjectPayload {
  projectId: string;
}

export type DriveLeaseEvent = { type: "changed"; state: DriveLeaseState };
