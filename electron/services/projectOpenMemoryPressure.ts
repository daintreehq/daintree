import { BrowserWindow, dialog, type MessageBoxOptions } from "electron";
import { checkKernelPressureCritical } from "./SystemMemoryPressureMonitor.js";
import { logInfo } from "../utils/logger.js";

/**
 * `open`: pressure isn't critical, so nothing was asked. `open-anyway`: the
 * user chose to open at critical pressure. `cancel`: the user declined.
 */
export type ColdOpenAnswer = "open" | "open-anyway" | "cancel";

export interface ColdOpenConfirmation {
  /** What the dialog names: a project name, or the folder's when it has none. */
  projectName: string;
  /** Logged with the hold; null for a folder that resolved to no project. */
  projectId: string | null;
  /** The window that asked, when there is one still open to sit the dialog on. */
  parent?: BrowserWindow | null;
  /** Closes the dialog as a Cancel once the request it answers is abandoned. */
  signal?: AbortSignal;
}

/**
 * Asks before an open that starts a new renderer while the kernel reports
 * critical memory pressure (#13638), for the opens main makes on its own: a new
 * window, an external open, a switch between hosts. None has a view on screen
 * that could hold it with the "Open anyway" toast the switch handler's refusal
 * gets (#13530), so the question is a native dialog. Cancel ends the request;
 * nothing is retried once pressure eases.
 */
export async function confirmColdOpenAtMemoryPressure({
  projectName,
  projectId,
  parent,
  signal,
}: ColdOpenConfirmation): Promise<ColdOpenAnswer> {
  if (!(await checkKernelPressureCritical())) return "open";
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
    ...(signal ? { signal } : {}),
  };
  // On macOS a message box with no window runs synchronously and stalls main
  // until it is answered, so one with no window that asked (an external open)
  // still sits on a window if there is any.
  const live = [parent, BrowserWindow.getFocusedWindow(), ...BrowserWindow.getAllWindows()].find(
    (win): win is BrowserWindow => win != null && !win.isDestroyed() && win.isVisible()
  );
  const { response } = live
    ? await dialog.showMessageBox(live, options)
    : await dialog.showMessageBox(options);
  if (response !== 0 || signal?.aborted === true) return "cancel";
  logInfo("project-open-memory-pressure-overridden", { projectId });
  return "open-anyway";
}
