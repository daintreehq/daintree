import type { WindowStateTracking } from "../windowState.js";
import {
  isLiveScratchSync,
  readProjectPathSync,
} from "../services/persistence/readLastProjectId.js";
import { isScratchWorkspaceId } from "../../shared/utils/workspaceIds.js";
import { folderlessBoundsKey } from "./windowBoundsKeys.js";
import { getPendingRemoteRestore } from "./openWindowsTracker.js";
import { onProjectPresenceChanged } from "./projectPresenceChanges.js";
import { getWindowRegistry } from "./windowRef.js";

/**
 * The key a new window takes its saved bounds from: the folder it was opened
 * for, or the workspace it was restored on. A restored window arrives with its
 * workspace's id alone: without a key it fell back to the last bounds any
 * window saved, so every restored window opened exactly on top of whichever
 * window moved last.
 *
 * A local project is keyed on its folder, a scratch and a host's project on
 * their ids (windowBoundsKeys.ts). A project whose row is gone and a scratch
 * that was deleted have no key, so a window still showing one saves nothing
 * that would outlive it.
 */
export function resolveBoundsKey(
  projectPath: string | null | undefined,
  workspaceId: string | undefined
): string | null {
  if (projectPath) return projectPath;
  if (!workspaceId) return null;
  const folderless = folderlessBoundsKey(workspaceId);
  if (folderless) {
    return isScratchWorkspaceId(workspaceId) && !isLiveScratchSync(workspaceId)
      ? null
      : folderless;
  }
  return readProjectPathSync(workspaceId);
}

/**
 * Bounds tracking for an app window: saved under the workspace the open-window
 * manifest reopens it on, and placed clear of the app's other windows.
 */
export const appWindowStateTracking: WindowStateTracking = {
  getShownBoundsKey: (win) => {
    const ctx = getWindowRegistry()?.getByWindowId(win.id);
    if (!ctx) return null;
    // A window restored onto the picker for a host's project is still that
    // project's window until it shows something, as the manifest has it.
    const workspaceId =
      ctx.services.projectViewManager?.getActiveProjectId() ??
      getPendingRemoteRestore(ctx.windowId);
    return workspaceId ? resolveBoundsKey(null, workspaceId) : null;
  },
  onShownProjectChange: onProjectPresenceChanged,
  getOccupiedBounds: () =>
    (getWindowRegistry()?.all() ?? []).flatMap(({ browserWindow }) =>
      browserWindow.isDestroyed() ? [] : [browserWindow.getNormalBounds()]
    ),
};
