import type { BrowserWindow } from "electron";
import { CHANNELS } from "../ipc/channels.js";
import { getAppWebContents } from "./webContentsRegistry.js";
import type { ProjectViewManager } from "./ProjectViewManager.js";
import type { WindowContext, WindowRegistry } from "./WindowRegistry.js";
import type {
  ProjectFocusOnActivateIntent,
  ProjectSwitchResult,
} from "../../shared/types/ipc/project.js";
import type { Project } from "../../shared/types/project.js";

/**
 * A window holding a live view of a project — on screen or cached (#12596).
 *
 * A project has one live view across the whole app. A second view would attach
 * to the same PTYs, with two xterms of different sizes resizing and pausing one
 * shell, and would leave the MCP workspace binding ambiguous.
 */
export interface ProjectOwner {
  context: WindowContext;
  projectViewManager: ProjectViewManager;
  /** True when the window is showing the project, false when it only has it cached. */
  isForeground: boolean;
}

/**
 * Projects a window has committed to activating whose view the window's manager
 * hasn't registered yet — the guard passed, but repository checks, the pending
 * persist and the manager's switch queue still lie between that and the
 * manager's inventory showing it. Without this, two windows asking for the same
 * project in that gap would both find no owner and both build a view.
 */
const pendingActivations = new Map<string, { windowId: number; token: object }>();

/**
 * Claim `projectId` for `windowId` until the returned release runs. Taken
 * synchronously with the owner check, and released in a `finally`: a claim that
 * outlived its activation would send every later request for the project to a
 * window that never got it.
 */
export function claimProjectActivation(
  projectId: string,
  windowId: number | undefined
): () => void {
  if (windowId === undefined) return () => {};
  const token = {};
  pendingActivations.set(projectId, { windowId, token });
  return () => {
    if (pendingActivations.get(projectId)?.token === token) pendingActivations.delete(projectId);
  };
}

export function hasLiveProjectView(
  pvm: ProjectViewManager | null | undefined,
  projectId: string
): boolean {
  try {
    return Boolean(
      pvm?.getAllViews().some((v) => v.projectId === projectId && !v.view.webContents.isDestroyed())
    );
  } catch {
    return false;
  }
}

/**
 * The window, other than the one making the request, that holds a live view of
 * `projectId`. Walks every registered window's own manager — never the
 * process-global one, which only reaches the last-created window (#8607).
 *
 * The requester is excluded by window id and by manager: the switch handler can
 * fall back to a manager that belongs to a different window than the sender,
 * and a manager the request is about to act on is never someone else's owner.
 *
 * A window whose manager has flipped `activeProjectId` to the project counts as
 * showing it, and so does one that has claimed it but not yet registered a view.
 * A foreground owner wins over a cached one: with the rule enforced there is at
 * most one owner, but a fleet built before it could hold two, and the window
 * already showing the project is the one to bring forward.
 */
export function findOtherProjectOwner(
  registry: WindowRegistry | undefined,
  projectId: string,
  requester: { windowId?: number; projectViewManager?: ProjectViewManager | null }
): ProjectOwner | null {
  if (!registry) return null;

  const pendingWindowId = pendingActivations.get(projectId)?.windowId;
  let pendingOwner: ProjectOwner | null = null;
  let cachedOwner: ProjectOwner | null = null;
  for (const context of registry.all()) {
    if (context.windowId === requester.windowId) continue;
    try {
      if (context.browserWindow.isDestroyed()) continue;
      const projectViewManager = context.services.projectViewManager;
      if (!projectViewManager || projectViewManager === requester.projectViewManager) continue;
      if (projectViewManager.getActiveProjectId() === projectId) {
        return { context, projectViewManager, isForeground: true };
      }
      // The manager's own inventory outranks the claim: a window can finish
      // activating the project and switch on before its handler settles.
      if (hasLiveProjectView(projectViewManager, projectId)) {
        cachedOwner ??= { context, projectViewManager, isForeground: false };
      } else if (context.windowId === pendingWindowId) {
        pendingOwner = { context, projectViewManager, isForeground: true };
      }
    } catch {
      // A window tearing down can throw from any of these reads. It can't be
      // shown or switched either, so it owns nothing worth redirecting to.
    }
  }
  return pendingOwner ?? cachedOwner;
}

/** Bring a window to the front, restoring it first if it was minimized. */
export function revealWindow(browserWindow: BrowserWindow): void {
  if (browserWindow.isDestroyed()) return;
  if (browserWindow.isMinimized()) {
    browserWindow.restore();
  }
  browserWindow.show();
  browserWindow.focus();
}

/**
 * Send a request for a project to the window that owns it instead of opening
 * a second view, and report where it went. The requesting window is left alone.
 *
 * On screen there: the window comes forward, and the project view itself takes
 * keyboard focus, which focusing the window doesn't hand to a WebContentsView.
 *
 * Cached there: the owning window's own renderer runs the switch, exactly as if
 * the user had picked the project in that window. The switch has to start in
 * that renderer, because it is the one holding the layout of whatever it is
 * showing now, and a switch driven from main alone would drop that layout on
 * the floor. The focus intent is parked on the owner's manager first, where the
 * switch it triggers consumes it — and where any other switch discards it, so it
 * can't fire later against an unrelated activation.
 */
export function redirectToProjectOwner(
  owner: ProjectOwner,
  project: Project,
  focusIntent?: ProjectFocusOnActivateIntent
): ProjectSwitchResult {
  const { context, projectViewManager, isForeground } = owner;
  const browserWindow = context.browserWindow;
  const targetWindowId = context.windowId;

  if (isForeground) {
    revealWindow(browserWindow);
    const webContents = projectViewManager.getActiveView()?.webContents;
    if (webContents && !webContents.isDestroyed()) {
      webContents.focus();
      if (focusIntent) {
        webContents.send(CHANNELS.PROJECT_FOCUS_ON_ACTIVATE, focusIntent);
      }
    }
    return { outcome: "focused-elsewhere", project, targetWindowId };
  }

  if (focusIntent) {
    projectViewManager.setPendingFocusIntent(project.id, focusIntent);
  }
  const appWebContents = getAppWebContents(browserWindow);
  if (!appWebContents.isDestroyed()) {
    appWebContents.send(CHANNELS.MENU_ACTION, {
      actionId: "project.switch",
      args: { projectId: project.id },
    });
  }
  revealWindow(browserWindow);
  return { outcome: "activated-elsewhere", project, targetWindowId };
}

/**
 * Send a request to open `projectPath` in a new window to the window that
 * already owns that project, if one does (#12596). Runs before any window is
 * created, so the redirect doesn't leave an empty picker window behind. Every
 * window counts as a possible owner here, the one the request came from
 * included: asking for a new window never opens a second view of a project.
 *
 * Only a folder already registered as a project can have an owner. Anything
 * else — or a lookup that fails — opens its window as before, and the redirect
 * in `handleDirectoryOpen` still stands behind it.
 */
export async function redirectNewWindowToOwner(
  registry: WindowRegistry | undefined,
  projectPath: string,
  getProjectByPath: (projectPath: string) => Promise<Project | null>
): Promise<boolean> {
  let project: Project | null;
  try {
    project = await getProjectByPath(projectPath);
  } catch {
    return false;
  }
  if (!project) return false;
  const owner = findOtherProjectOwner(registry, project.id, {});
  if (!owner) return false;
  redirectToProjectOwner(owner, project);
  return true;
}
