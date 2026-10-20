import { dialog, type BrowserWindow, type MessageBoxOptions } from "electron";
import { checkKernelPressureCritical } from "./SystemMemoryPressureMonitor.js";
import { logInfo } from "../utils/logger.js";

export interface ColdOpenConfirmation {
  /** What the dialog names: a project name, or the folder's when it has none. */
  projectName: string;
  /** Logged with the hold; null for a folder that resolved to no project. */
  projectId: string | null;
  /** The window that asked, when there is one still open to sit the dialog on. */
  parent?: BrowserWindow | null;
}

/**
 * Asks before an open that starts a new renderer while the kernel reports
 * critical memory pressure (#13638), for the opens main makes on its own: a new
 * window, an external open, a switch between hosts. None has a view on screen
 * that could hold it with the "Open anyway" toast the switch handler's refusal
 * gets (#13530), so the question is a native dialog. Resolves true when the
 * open may go ahead: pressure isn't critical, or the user chose to open anyway.
 * Cancel ends the request; nothing is retried once pressure eases.
 */
export async function confirmColdOpenAtMemoryPressure({
  projectName,
  projectId,
  parent,
}: ColdOpenConfirmation): Promise<boolean> {
  if (!(await checkKernelPressureCritical())) return true;
  logInfo("project-open-held-memory-pressure", { projectId });
  const options: MessageBoxOptions = {
    type: "warning",
    title: `Open "${projectName}" anyway?`,
    message: `Open "${projectName}" anyway?`,
    detail:
      "macOS reports memory pressure at its critical level. Opening the project loads it from scratch, which takes memory the system is short of.",
    buttons: ["Open anyway", "Cancel"],
    defaultId: 1,
    cancelId: 1,
  };
  const live = parent && !parent.isDestroyed() ? parent : null;
  const { response } = live
    ? await dialog.showMessageBox(live, options)
    : await dialog.showMessageBox(options);
  const admitted = response === 0;
  if (admitted) logInfo("project-open-memory-pressure-overridden", { projectId });
  return admitted;
}
