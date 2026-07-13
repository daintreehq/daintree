import type { Project } from "../types/index.js";
import { projectStore } from "../services/ProjectStore.js";
import { getWindowForWebContents } from "../window/webContentsRegistry.js";
import type { HandlerDependencies, IpcContext } from "./types.js";

export interface ScopedProjectResolution {
  project: Project | null;
}

function getOpenProjectById(projectId: string): Project | null {
  const project = projectStore.getProjectById(projectId);
  if (project?.status === "closed") return null;
  return project ?? null;
}

/**
 * Project id carried on a view's document URL. Only the initial (startup-restore)
 * renderer gets a `?projectId=` query string; ProjectViewManager's cold switch
 * views load a static URL. So this is the sole per-sender identity during the
 * startup window where the restored view is already live but `registerInitialView`
 * has not bound it in the project maps yet.
 */
export function getProjectIdFromSenderUrl(sender: Electron.WebContents): string | null {
  const senderWithUrl = sender as Electron.WebContents & { getURL?: () => string };
  if (typeof senderWithUrl.getURL !== "function") return null;

  try {
    return new URL(senderWithUrl.getURL()).searchParams.get("projectId");
  } catch {
    return null;
  }
}

/**
 * Resolve project-scoped IPC requests without leaking the global current project
 * into an unbound or newly-loading ProjectViewManager view.
 */
export function resolveScopedProjectForIpcContext(
  ctx: IpcContext,
  deps?: HandlerDependencies
): ScopedProjectResolution | null {
  const senderWindow = ctx.senderWindow ?? getWindowForWebContents(ctx.event.sender);
  const pvm =
    (senderWindow &&
      deps?.windowRegistry?.getByWindowId(senderWindow.id)?.services?.projectViewManager) ??
    deps?.projectViewManager;

  if (pvm) {
    const viewProjectId = pvm.getProjectIdForWebContents(ctx.webContentsId);
    if (viewProjectId) {
      return { project: getOpenProjectById(viewProjectId) };
    }

    const urlProjectId = getProjectIdFromSenderUrl(ctx.event.sender);
    if (urlProjectId) {
      return { project: getOpenProjectById(urlProjectId) };
    }

    return { project: null };
  }

  if (ctx.projectId) {
    return { project: getOpenProjectById(ctx.projectId) };
  }

  return null;
}
