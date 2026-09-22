import type { BrowserWindow, WebContents } from "electron";
import { CHANNELS } from "../ipc/channels.js";
import { getAppWebContents } from "./webContentsRegistry.js";
import type { ProjectViewManager } from "./ProjectViewManager.js";
import type { WindowContext, WindowRegistry } from "./WindowRegistry.js";
import type {
  ProjectFocusOnActivateIntent,
  ProjectSwitchResult,
} from "../../shared/types/ipc/project.js";
import type { Project } from "../../shared/types/project.js";
import { hasPendingActivation } from "./projectActivationClaims.js";

export { claimProjectActivation } from "./projectActivationClaims.js";

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
  /**
   * `foreground`: the window is showing the project. `activating`: it has
   * committed to showing it but its manager has no view yet. `cached`: it holds
   * a view it isn't showing.
   */
  state: "foreground" | "activating" | "cached";
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
 * showing it. Preference runs foreground, then activating, then cached: with the
 * rule enforced there is at most one owner, but a fleet built before it could
 * hold two, and the window closest to showing the project is the one to bring
 * forward. The manager's own inventory outranks a claim, since a window can
 * finish activating the project and switch on before its claim is released.
 */
export function findOtherProjectOwner(
  registry: WindowRegistry | undefined,
  projectId: string,
  requester: { windowId?: number; projectViewManager?: ProjectViewManager | null }
): ProjectOwner | null {
  if (!registry) return null;

  let activatingOwner: ProjectOwner | null = null;
  let cachedOwner: ProjectOwner | null = null;
  for (const context of registry.all()) {
    if (context.windowId === requester.windowId) continue;
    try {
      if (context.browserWindow.isDestroyed()) continue;
      const projectViewManager = context.services.projectViewManager;
      if (!projectViewManager || projectViewManager === requester.projectViewManager) continue;
      if (projectViewManager.getActiveProjectId() === projectId) {
        return { context, projectViewManager, state: "foreground" };
      }
      if (hasLiveProjectView(projectViewManager, projectId)) {
        cachedOwner ??= { context, projectViewManager, state: "cached" };
      } else if (hasPendingActivation(projectId, context.windowId)) {
        activatingOwner ??= { context, projectViewManager, state: "activating" };
      }
    } catch {
      // A window tearing down can throw from any of these reads. It can't be
      // shown or switched either, so it owns nothing worth redirecting to.
    }
  }
  return activatingOwner ?? cachedOwner;
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
 * The focus intent goes straight to that view — unless the window is still in a
 * cold switch to it, where `activeProjectId` has flipped before the view can
 * listen, and the intent is parked for that switch to deliver instead.
 *
 * Still activating there: the window comes forward, but its active view may
 * still be the project it is leaving, so nothing is focused or told anything.
 * The focus intent is parked for the activation already under way to consume.
 *
 * Cached there: the owning window's own renderer runs the switch, exactly as if
 * the user had picked the project in that window. The switch has to start in a
 * renderer, because the renderer holds the layout of whatever it is showing, and
 * a switch driven from main alone would drop that layout on the floor. The focus
 * intent is parked on the owner's manager first, where the switch it triggers
 * consumes it — and where any other switch discards it, so it can't fire later
 * against an unrelated activation.
 */
export function redirectToProjectOwner(
  owner: ProjectOwner,
  project: Project,
  focusIntent?: ProjectFocusOnActivateIntent
): ProjectSwitchResult {
  const { context, projectViewManager, state } = owner;
  const browserWindow = context.browserWindow;
  const targetWindowId = context.windowId;

  if (state === "foreground") {
    revealWindow(browserWindow);
    const stillArriving = projectViewManager.getOutgoingBridgeProjectId() !== null;
    const webContents = projectViewManager.getActiveView()?.webContents;
    if (webContents && !webContents.isDestroyed()) {
      webContents.focus();
      if (focusIntent && !stillArriving) {
        webContents.send(CHANNELS.PROJECT_FOCUS_ON_ACTIVATE, focusIntent);
      }
    }
    if (focusIntent && stillArriving) {
      projectViewManager.setPendingFocusIntent(project.id, focusIntent);
    }
    return { outcome: "focused-elsewhere", project, targetWindowId };
  }

  if (focusIntent) {
    projectViewManager.setPendingFocusIntent(project.id, focusIntent);
  }
  if (state === "activating") {
    revealWindow(browserWindow);
    return { outcome: "focused-elsewhere", project, targetWindowId };
  }

  requestOwnerSwitch(ownerSwitchRenderer(projectViewManager, browserWindow), project.id);
  revealWindow(browserWindow);
  return { outcome: "activated-elsewhere", project, targetWindowId };
}

/**
 * The renderer to hand the owner's switch to. Normally the window's app view.
 * Mid cold switch, though, the app view is already the incoming project's fresh
 * view, which has no menu-action listener until React is up and may yet fail to
 * load. The outgoing view is still attached and fully booted, so it runs the
 * switch instead: it saves its own layout as any switch would, and the manager
 * queues the new activation behind the one in flight — or, if that one rolls
 * back, lands it from the view the rollback restored.
 */
function ownerSwitchRenderer(
  projectViewManager: ProjectViewManager,
  browserWindow: BrowserWindow
): WebContents {
  const bridgeProjectId = projectViewManager.getOutgoingBridgeProjectId();
  if (bridgeProjectId !== null) {
    const bridge = projectViewManager
      .getAllViews()
      .find((entry) => entry.projectId === bridgeProjectId)?.view.webContents;
    if (bridge && !bridge.isDestroyed()) return bridge;
  }
  return getAppWebContents(browserWindow);
}

/**
 * Ask the chosen renderer to switch. A view still loading — a window whose only
 * view is still booting — has no listener yet, and a send before
 * `did-finish-load` is dropped with no queue, so it waits for the load
 * (`isLoadingMainFrame`, not `isLoading`, which a loading subframe would hold
 * open indefinitely).
 */
function requestOwnerSwitch(appWebContents: WebContents, projectId: string): void {
  const send = (): void => {
    if (appWebContents.isDestroyed()) return;
    appWebContents.send(CHANNELS.MENU_ACTION, {
      actionId: "project.switch",
      args: { projectId },
    });
  };
  if (appWebContents.isDestroyed()) return;
  if (appWebContents.isLoadingMainFrame()) {
    appWebContents.once("did-finish-load", send);
  } else {
    send();
  }
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
