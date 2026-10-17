import { defineIpcNamespace, op } from "../define.js";
import type { IpcContext } from "../types.js";
import type { ClientEndpoint } from "../endpoint.js";
import { DRIVE_LEASE_METHOD_CHANNELS } from "./driveLease.preload.js";
import { getDriveLeaseService } from "../../services/DriveLeaseService.js";
import { AppError } from "../../utils/errorTypes.js";
import type {
  DriveLeaseNavigation,
  DriveLeaseProjectPayload,
  DriveLeaseReportNavigationPayload,
  DriveLeaseTakeOverPayload,
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

function readIfLeaseId(payload: DriveLeaseTakeOverPayload | undefined): number | null | undefined {
  const value = payload?.ifLeaseId;
  if (value === undefined || value === null) return value;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new AppError({ code: "VALIDATION", message: "ifLeaseId must be a lease id or null" });
  }
  return value;
}

const MAX_ID_LENGTH = 512;

function readOptionalId(value: unknown, field: string): string | null {
  if (value === null) return null;
  if (typeof value === "string" && value.length > 0 && value.length <= MAX_ID_LENGTH) return value;
  throw new AppError({ code: "VALIDATION", message: `${field} must be an id or null` });
}

function readId(value: unknown, field: string): string {
  const id = readOptionalId(value, field);
  if (id === null) throw new AppError({ code: "VALIDATION", message: `${field} is required` });
  return id;
}

function readNavigation(value: unknown): DriveLeaseNavigation {
  if (value === null || typeof value !== "object") {
    throw new AppError({ code: "VALIDATION", message: "A navigation report is required" });
  }
  const raw = value as Record<string, unknown>;
  if (typeof raw.focusMode !== "boolean") {
    throw new AppError({ code: "VALIDATION", message: "focusMode must be a boolean" });
  }
  let maximize: DriveLeaseNavigation["maximize"] = null;
  if (raw.maximize !== null) {
    const m = raw.maximize as { panelId?: unknown; target?: { type?: unknown; id?: unknown } };
    const type = m?.target?.type;
    if (typeof m !== "object" || (type !== "panel" && type !== "group")) {
      throw new AppError({ code: "VALIDATION", message: "maximize must name a panel or a group" });
    }
    maximize = {
      panelId: readId(m.panelId, "maximize.panelId"),
      target: { type, id: readId(m.target?.id, "maximize.target.id") },
    };
  }
  return {
    activeWorktreeId: readOptionalId(raw.activeWorktreeId, "activeWorktreeId"),
    focusedPanelId: readOptionalId(raw.focusedPanelId, "focusedPanelId"),
    maximize,
    focusMode: raw.focusMode,
  };
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
      async (ctx: IpcContext, payload: DriveLeaseTakeOverPayload): Promise<DriveLeaseView> => {
        const projectId = readProjectId(payload);
        const ifLeaseId = readIfLeaseId(payload);
        const endpoint = endpointOf(ctx);
        if (!endpoint) {
          throw new AppError({ code: "VALIDATION", message: "No view to hand the lease to" });
        }
        const service = getDriveLeaseService();
        service.takeOver(projectId, endpoint, ifLeaseId === undefined ? {} : { ifLeaseId });
        return service.viewFor(projectId, endpoint);
      },
      { withContext: true }
    ),
    reportNavigation: op(
      DRIVE_LEASE_METHOD_CHANNELS.reportNavigation,
      async (ctx: IpcContext, payload: DriveLeaseReportNavigationPayload): Promise<void> => {
        const projectId = readProjectId(payload);
        const leaseId = payload.leaseId;
        if (leaseId !== null && (!Number.isSafeInteger(leaseId) || leaseId < 0)) {
          throw new AppError({ code: "VALIDATION", message: "leaseId must be a lease id or null" });
        }
        const navigation = readNavigation(payload.navigation);
        const endpoint = endpointOf(ctx);
        assertVisible(endpoint, projectId);
        if (!endpoint) return;
        getDriveLeaseService().reportNavigation(projectId, endpoint, leaseId, navigation);
      },
      { withContext: true }
    ),
  },
});

export function registerDriveLeaseHandlers(): () => void {
  return driveLeaseNamespace.register();
}
