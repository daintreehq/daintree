import { defineIpcNamespace, op } from "../define.js";
import type { IpcContext } from "../types.js";
import { pendingRemoteHostsHandler } from "../../remote/pendingHandler.js";
import { DRIVE_LEASE_METHOD_CHANNELS } from "./driveLease.preload.js";
import type { DriveLeaseState } from "../../../shared/types/remoteHosts.js";
import type { DriveLeaseProjectPayload } from "../../../shared/types/ipc/driveLease.js";

export const driveLeaseNamespace = defineIpcNamespace({
  name: "driveLease",
  ops: {
    get: op(
      DRIVE_LEASE_METHOD_CHANNELS.get,
      async (_ctx: IpcContext, _payload: DriveLeaseProjectPayload): Promise<DriveLeaseState> =>
        pendingRemoteHostsHandler(DRIVE_LEASE_METHOD_CHANNELS.get),
      { withContext: true }
    ),
    takeOver: op(
      DRIVE_LEASE_METHOD_CHANNELS.takeOver,
      async (_ctx: IpcContext, _payload: DriveLeaseProjectPayload): Promise<DriveLeaseState> =>
        pendingRemoteHostsHandler(DRIVE_LEASE_METHOD_CHANNELS.takeOver),
      { withContext: true }
    ),
  },
});

export function registerDriveLeaseHandlers(): () => void {
  return driveLeaseNamespace.register();
}
