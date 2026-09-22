import type { ProjectOpenOutcome } from "../../shared/types/windowOpen.js";

/**
 * Open a folder in a new window because the user asked for exactly that
 * (#12594). The router in `openDirHandler.ts` registers itself here once the
 * first window has set up open routing. It lives apart from the router so the
 * menu and the window IPC can reach it without pulling the router's boot-time
 * environment module into their import graphs.
 */
export type NewWindowOpener = (
  dirPath: string,
  initiatingWindowId: number | null
) => Promise<ProjectOpenOutcome>;

let opener: NewWindowOpener | null = null;

export function setNewWindowOpener(next: NewWindowOpener | null): void {
  opener = next;
}

/** Rejects when no window has finished setting up yet: until then there is nothing to route with. */
export function openFolderInNewWindow(
  dirPath: string,
  initiatingWindowId: number | null
): Promise<ProjectOpenOutcome> {
  if (!opener) return Promise.reject(new Error("Window opening isn't ready yet"));
  return opener(dirPath, initiatingWindowId);
}
