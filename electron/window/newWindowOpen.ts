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

interface QueuedOpen {
  dirPath: string;
  initiatingWindowId: number | null;
  resolve: (outcome: ProjectOpenOutcome) => void;
  reject: (reason: unknown) => void;
}

let opener: NewWindowOpener | null = null;
let queued: QueuedOpen[] = [];

export function setNewWindowOpener(next: NewWindowOpener | null): void {
  opener = next;
  const waiting = queued;
  queued = [];
  for (const open of waiting) {
    if (next) next(open.dirPath, open.initiatingWindowId).then(open.resolve, open.reject);
    else open.reject(new Error("Window opening was shut down"));
  }
}

/**
 * The menu and renderer are usable before the first window finishes setting up,
 * so a request that arrives before the router does waits for it rather than
 * failing or skipping the routing rules.
 */
export function openFolderInNewWindow(
  dirPath: string,
  initiatingWindowId: number | null
): Promise<ProjectOpenOutcome> {
  if (opener) return opener(dirPath, initiatingWindowId);
  return new Promise((resolve, reject) => {
    queued.push({ dirPath, initiatingWindowId, resolve, reject });
  });
}
