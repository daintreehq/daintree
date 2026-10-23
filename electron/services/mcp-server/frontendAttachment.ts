import { getWebContentsForProject } from "../../window/webContentsRegistry.js";
import { isMcpFrontendAttached } from "./driveTarget.js";

/**
 * Whether a frontend is attached to `projectId` on this machine now (#14122):
 * what a project listing reports, so an assistant knows before it calls rather
 * than from a `NO_FRONTEND_ATTACHED` answer.
 */
export function isProjectFrontendAttached(projectId: string): boolean {
  return isMcpFrontendAttached(projectId, getWebContentsForProject(projectId).length > 0);
}
