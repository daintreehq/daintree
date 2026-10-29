import type { Project } from "../../shared/types/project.js";
import type { ProjectFocusOnActivateIntent } from "../../shared/types/ipc/project.js";
import type { WindowRegistry } from "./WindowRegistry.js";
import {
  findOtherProjectOwner,
  redirectToProjectOwner,
  requestProjectSwitchInWindow,
} from "./projectOwnership.js";
import { isWindowOnRemoteHost } from "./windowHost.js";

/** Where a notification's panel lived: its window, and the key that window's manager held its view under. */
export interface NotificationPlace {
  windowId: number;
  workspaceKey: string;
}

/**
 * Bring a notification's project on screen and land on its panel. False when
 * there is no local project to open, so the caller keeps its own fallback.
 */
export type NotificationProjectOpener = (place: NotificationPlace, panelId: string) => boolean;

/**
 * A click on a banner for a project the window isn't showing goes through the
 * renderer-owned project switch (#15233), the way the plugin pager's clicks
 * do, rather than focusing the panel in a renderer nobody can see:
 *
 * - A window holds a view of it (cached, or the one on screen): that window
 *   switches to it, or just comes forward.
 * - No window does, because the view was evicted: the window it was in opens
 *   it again, as picking it there would. A project closed or missing since
 *   opens nothing, and nor does a scratch workspace or a host's project.
 */
export function createNotificationProjectOpener(
  registry: WindowRegistry,
  getProject: (projectId: string) => Project | null | undefined
): NotificationProjectOpener {
  return (place, panelId) => {
    const project = getProject(place.workspaceKey);
    if (!project || project.status === "closed" || project.status === "missing") return false;
    const intent: ProjectFocusOnActivateIntent = { intent: "focus-panel", panelId };

    const owner = findOtherProjectOwner(registry, project.id, {});
    if (owner) {
      redirectToProjectOwner(owner, project, intent);
      return true;
    }

    const context = registry.getByWindowId(place.windowId);
    const projectViewManager = context?.services.projectViewManager;
    if (!context || !projectViewManager || context.browserWindow.isDestroyed()) return false;
    if (isWindowOnRemoteHost(context.windowId)) return false;
    requestProjectSwitchInWindow(context, projectViewManager, project, intent);
    return true;
  };
}
