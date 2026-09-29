import type { WebContentsView } from "electron";
import type { SystemMemoryPressurePayload } from "../../shared/types/ipc/system.js";
import { notifyError } from "../ipc/errorHandlers.js";
import { projectStore } from "../services/ProjectStore.js";
import { AppError } from "../utils/errorTypes.js";
import { getOpenSystemMemoryPressure } from "./systemMemoryPressureDelivery.js";

/**
 * Switches the paint gate rolled back (#13035). Their `message` stays technical
 * for logs and diagnostics; the `userMessage` is what the requesting renderer
 * shows.
 */
const cancelledSwitchErrors = new WeakSet<Error>();

/**
 * The pressure sentence is an observation only — an open episode says memory
 * readings were over threshold, not that they stopped the view drawing.
 */
export function formatCancelledSwitchMessage(
  previousProjectName: string | null,
  pressure: SystemMemoryPressurePayload | null
): string {
  const outcome = previousProjectName
    ? `The project didn't finish displaying, so the switch was cancelled and you're still in ${previousProjectName}.`
    : "The project didn't finish displaying, so the switch was cancelled.";
  return pressure ? `${outcome} Daintree is also reporting high system memory use.` : outcome;
}

function lookUpProjectName(projectId: string | null): string | null {
  if (!projectId) return null;
  try {
    return projectStore.getProjectById(projectId)?.name?.trim() || null;
  } catch {
    return null;
  }
}

export function createCancelledSwitchError(opts: {
  message: string;
  context: Record<string, unknown>;
  previousProjectId: string | null;
}): AppError {
  const error = new AppError({
    code: "INTERNAL",
    message: opts.message,
    userMessage: formatCancelledSwitchMessage(
      lookUpProjectName(opts.previousProjectId),
      getOpenSystemMemoryPressure()
    ),
    context: opts.context,
  });
  cancelledSwitchErrors.add(error);
  return error;
}

/**
 * A cancelled switch is reported by the renderer that asked for it, which the
 * rollback has put back on screen — the main-side notification would be a
 * second, generic toast for the same failure. Every other failure, and any
 * switch whose requester is not the restored view (menu and Dock opens, a
 * request that reached a cached view), keeps the main-side report.
 */
export function reportSwitchFailure(
  error: unknown,
  requesterWebContentsId: number | undefined,
  restoredView: WebContentsView | null
): void {
  const reportedByRequester =
    error instanceof Error &&
    cancelledSwitchErrors.has(error) &&
    requesterWebContentsId !== undefined &&
    restoredView !== null &&
    !restoredView.webContents.isDestroyed() &&
    restoredView.webContents.id === requesterWebContentsId;
  if (reportedByRequester) return;
  notifyError(error, { source: "project-switch" });
}
