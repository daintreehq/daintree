import { randomUUID } from "crypto";
import type { BrowserWindow, WebContents } from "electron";
import { CHANNELS } from "../../channels.js";
import { broadcastToRenderer } from "../../utils.js";
import { distributePortsToView } from "../../../window/portDistribution.js";
import { scheduleOpenWindowsSave } from "../../../window/openWindowsTracker.js";
import {
  collectActiveProjectIds,
  projectViewManagersFrom,
} from "../../../window/activeProjectIds.js";
import { beginWindowSwitch, isCurrentWindowSwitch } from "../../../window/windowSwitchEpochs.js";
import { scratchStore } from "../../../services/ScratchStore.js";
import { projectStore } from "../../../services/ProjectStore.js";
import { refreshProjectMenuState } from "../../../projectMenuState.js";
import { notificationService } from "../../../services/NotificationService.js";
import { logError } from "../../../utils/logger.js";
import type { PtyClient } from "../../../services/PtyClient.js";
import type { WorkspaceClient } from "../../../services/WorkspaceClient.js";
import type { WindowRegistry } from "../../../window/WindowRegistry.js";
import type { Scratch } from "../../../../shared/types/scratch.js";

/**
 * What makes a scratch the workspace a window works in, once its view has
 * been swapped in: the canonical pointers, the saved window manifest, the
 * menu and titles, the PTY host's active workspace, and a fresh terminal port
 * for the view. Shared by `scratch:switch` and a window coming back to a
 * scratch from a remote host, which otherwise left its terminals unreachable.
 *
 * The window also lets go of the project it left (#17186): its workspace host
 * stops counting the window as a holder, so a project no window shows any more
 * stops foreground polling and can be reclaimed, and the project's row goes to
 * the background unless another window still shows it.
 */
export function activateScratchInWindow(options: {
  scratch: Scratch;
  windowId: number | undefined;
  window: BrowserWindow | null | undefined;
  view: WebContents | null | undefined;
  windowRegistry: WindowRegistry | null | undefined;
  ptyClient: PtyClient | null | undefined;
  workspaceClient: WorkspaceClient | null | undefined;
  /**
   * The workspace the window showed before the scratch, read from the
   * sender's own binding before the swap, never from the global pointer,
   * which names whichever window switched last. Null when it showed none.
   */
  outgoingWorkspaceId: string | null;
  /**
   * The window's switch epoch (`currentWindowSwitch`) when the scratch was
   * asked for, read before the swap was queued.
   */
  switchEpoch: number;
}): Scratch {
  const { scratch, windowId, window, view, windowRegistry, ptyClient, workspaceClient } = options;

  // A project switch asked for in this window while the scratch's swap waited
  // has already moved the window to that project's host, at the time it was
  // asked for, and its own view lands next: releasing the window now would
  // detach the project it is about to show. Otherwise a scratch has no
  // workspace host, so the pool drops the window as a holder of whatever it
  // was attached to, and backgrounds that host once nothing else holds it.
  // The new epoch outdates the deferred tail of any earlier project switch
  // here (a failed swap's restore, a cloned project's load), which would
  // otherwise attach the window to that project again behind the scratch.
  if (windowId !== undefined && isCurrentWindowSwitch(windowId, options.switchEpoch)) {
    beginWindowSwitch(windowId);
    workspaceClient?.unregisterWindow(windowId);
  }

  // Mutually exclusive with project: clear the project pointer so the
  // renderer's `getCurrentProject` does not race-restore the previous project.
  const updated = scratchStore.setCurrentScratch(scratch.id);
  projectStore.clearCurrentProject();
  // Bookkeeping: the window has already moved, so a failed write must not stop
  // its terminals and its view from being brought to the scratch below.
  try {
    backgroundDepartedProject(options.outgoingWorkspaceId, windowRegistry);
  } catch (error) {
    logError("[ScratchSwitch] Failed to background the project the window left", error);
  }

  // Re-persist which workspace each window is showing (#11492). Built from
  // `getActiveProjectId()` across every window, so it runs after the swap.
  scheduleOpenWindowsSave();

  // A scratch is not a project: the File-menu project gates must drop.
  refreshProjectMenuState();
  notificationService.refreshTitles();

  // PtyClient treats the id as an opaque string and the path as a working
  // directory, so a scratch UUID and folder are supported as they are.
  if (windowId !== undefined && ptyClient) {
    ptyClient.onProjectSwitch(windowId, scratch.id, scratch.path);
  }

  // Without a fresh PTY port, terminals in the scratch can't reach the PTY host.
  if (window && windowRegistry) {
    const wctx = windowRegistry.getByWindowId(window.id);
    if (wctx && view && !view.isDestroyed()) {
      distributePortsToView(window, wctx, view, ptyClient ?? null);
    }
  }

  // Only the scratch's own view: a broadcast would also make the scratch the
  // current one in every other window's views, whatever they show.
  if (view && !view.isDestroyed()) {
    view.send(CHANNELS.SCRATCH_ON_SWITCH, { scratch: updated, switchId: randomUUID() });
  }
  return updated;
}

/**
 * The project the window left goes to the background, as a project switch
 * backgrounds the one it leaves, unless another window, or a remote Shell,
 * still shows it. A row that is not active (closed, missing, already in the
 * background) is left as it is.
 */
function backgroundDepartedProject(
  outgoingWorkspaceId: string | null,
  windowRegistry: WindowRegistry | null | undefined
): void {
  if (!outgoingWorkspaceId) return;
  const departed = projectStore.getProjectById(outgoingWorkspaceId);
  if (departed?.status !== "active") return;
  const shown = collectActiveProjectIds(
    projectViewManagersFrom(windowRegistry ?? undefined),
    null,
    "scratch-switch"
  );
  if (shown.has(departed.id)) return;
  broadcastToRenderer(
    CHANNELS.PROJECT_UPDATED,
    projectStore.updateProjectStatus(departed.id, "background")
  );
}
