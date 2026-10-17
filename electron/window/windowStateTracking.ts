import type { WindowStateTracking } from "../windowState.js";
import { readProjectPathSync } from "../services/persistence/readLastProjectId.js";
import { onProjectPresenceChanged } from "./projectPresenceChanges.js";
import { getWindowRegistry } from "./windowRef.js";

/**
 * The project folder a new window takes its saved bounds from. Bounds are saved
 * per folder, and a restored window arrives with its project's id alone: without
 * the folder it fell back to the last bounds any window saved, so every
 * restored window opened exactly on top of whichever window moved last.
 */
export function resolveBoundsProjectPath(
  projectPath: string | null | undefined,
  projectId: string | undefined
): string | null {
  if (projectPath) return projectPath;
  return projectId ? readProjectPathSync(projectId) : null;
}

/**
 * Bounds tracking for an app window: saved under the project the window's own
 * view manager shows (the one the open-window manifest reopens it on), and
 * placed clear of the app's other windows.
 */
export const appWindowStateTracking: WindowStateTracking = {
  getShownProjectPath: (win) => {
    const projectId = getWindowRegistry()
      ?.getByWindowId(win.id)
      ?.services.projectViewManager?.getActiveProjectId();
    return projectId ? readProjectPathSync(projectId) : null;
  },
  onShownProjectChange: onProjectPresenceChanged,
  getOccupiedBounds: () =>
    (getWindowRegistry()?.all() ?? []).flatMap(({ browserWindow }) =>
      browserWindow.isDestroyed() ? [] : [browserWindow.getNormalBounds()]
    ),
};
