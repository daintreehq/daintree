import type { Project } from "../types/index.js";
import { projectStore } from "../services/ProjectStore.js";
import { getWindowForWebContents } from "../window/webContentsRegistry.js";
import type { HandlerDependencies, IpcContext } from "./types.js";

export interface ScopedProjectResolution {
  project: Project | null;
  /**
   * The sender view's workspace id, whether or not it names a Project row. A
   * scratch is a workspace with no row (#11484), so `project` is null while
   * this still identifies the sender — anything keyed on durable per-workspace
   * storage must use this, and anything that genuinely needs a git repository
   * (in-repo presets, recipes) must keep using `project`.
   */
  workspaceId: string | null;
}

/**
 * Resolve one candidate id into a project and the workspace that owns its
 * durable state.
 *
 * The two can diverge in both directions, and the distinction is load-bearing:
 * an id with no project row at all is a scratch, whose state must still be
 * served (#11484), whereas a *closed* project keeps its row and must not be
 * served — hydrating it would resurrect a workspace the user closed.
 */
function resolveWorkspaceById(workspaceId: string): ScopedProjectResolution {
  const project = projectStore.getProjectById(workspaceId);
  if (project?.status === "closed") return { project: null, workspaceId: null };
  return { project: project ?? null, workspaceId };
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
      return resolveWorkspaceById(viewProjectId);
    }

    const urlProjectId = getProjectIdFromSenderUrl(ctx.event.sender);
    if (urlProjectId) {
      return resolveWorkspaceById(urlProjectId);
    }

    return { project: null, workspaceId: null };
  }

  if (ctx.projectId) {
    return resolveWorkspaceById(ctx.projectId);
  }

  return null;
}
