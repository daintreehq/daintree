import type { TerminalLocation } from "../../shared/types/ipc/terminal.js";
import { getWebContentsForProject } from "../window/webContentsRegistry.js";
import type { PtyClient } from "./PtyClient.js";

/**
 * The one main-side answer to "where does this terminal live?" (#13120).
 *
 * Liveness comes from the pty-host record, not `getTerminalProjectId`'s spawn
 * map: a trashed terminal can still be running, and an owner entry can outlive
 * its process. A trashed-but-running record counts as found, since the panel
 * still exists in its project's trash. Residency is read after the host round
 * trip so an eviction that lands mid-query is reflected.
 *
 * Diagnostic only — nothing here grants authority to act on the terminal.
 */
export async function locateTerminal(
  ptyClient: Pick<PtyClient, "getTerminalAsync">,
  terminalId: string
): Promise<TerminalLocation> {
  const record = await ptyClient.getTerminalAsync(terminalId);
  if (!record || record.hasPty !== true) return { found: false };
  const projectId = record.projectId;
  if (typeof projectId !== "string" || projectId.length === 0) return { found: false };
  return {
    found: true,
    projectId,
    viewResident: getWebContentsForProject(projectId).length > 0,
  };
}
