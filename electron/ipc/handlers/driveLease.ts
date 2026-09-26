import { defineIpcNamespace, op } from "../define.js";
import type { IpcContext } from "../types.js";
import type { ClientEndpoint } from "../endpoint.js";
import { DRIVE_LEASE_METHOD_CHANNELS } from "./driveLease.preload.js";
import { getDriveLeaseService } from "../../services/DriveLeaseService.js";
import { AppError } from "../../utils/errorTypes.js";
import type {
  DriveLeaseProjectPayload,
  DriveLeaseView,
} from "../../../shared/types/ipc/driveLease.js";

function endpointOf(ctx: IpcContext): ClientEndpoint | null {
  return (ctx.endpoint as ClientEndpoint | undefined) ?? null;
}

function readProjectId(payload: DriveLeaseProjectPayload | undefined): string {
  const projectId = payload?.projectId;
  if (typeof projectId !== "string" || projectId.length === 0 || projectId.length > 512) {
    throw new AppError({ code: "VALIDATION", message: "A project id is required" });
  }
  return projectId;
}

/**
 * A remote client is bound to one project and may ask only about that one.
 * Local views are this machine's own UI and may ask about any.
 */
function assertVisible(endpoint: ClientEndpoint | null, projectId: string): void {
  if (endpoint?.kind === "remote-view" && endpoint.projectId !== projectId) {
    throw new AppError({
      code: "VALIDATION",
      message: "A remote view can only see the lease of its own project",
    });
  }
}

export const driveLeaseNamespace = defineIpcNamespace({
  name: "driveLease",
  ops: {
    get: op(
      DRIVE_LEASE_METHOD_CHANNELS.get,
      async (ctx: IpcContext, payload: DriveLeaseProjectPayload): Promise<DriveLeaseView> => {
        const projectId = readProjectId(payload);
        const endpoint = endpointOf(ctx);
        assertVisible(endpoint, projectId);
        return getDriveLeaseService().viewFor(projectId, endpoint);
      },
      { withContext: true }
    ),
    takeOver: op(
      DRIVE_LEASE_METHOD_CHANNELS.takeOver,
      async (ctx: IpcContext, payload: DriveLeaseProjectPayload): Promise<DriveLeaseView> => {
        const projectId = readProjectId(payload);
        const endpoint = endpointOf(ctx);
        if (!endpoint) {
          throw new AppError({ code: "VALIDATION", message: "No view to hand the lease to" });
        }
        const service = getDriveLeaseService();
        service.takeOver(projectId, endpoint);
        return service.viewFor(projectId, endpoint);
      },
      { withContext: true }
    ),
  },
});

export function registerDriveLeaseHandlers(): () => void {
  return driveLeaseNamespace.register();
}
