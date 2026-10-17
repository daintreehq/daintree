import { randomUUID } from "crypto";
import type { BrowserWindow, WebContents } from "electron";
import { CHANNELS } from "../../channels.js";
import { broadcastToRenderer } from "../../utils.js";
import { distributePortsToView } from "../../../window/portDistribution.js";
import { scheduleOpenWindowsSave } from "../../../window/openWindowsTracker.js";
import { scratchStore } from "../../../services/ScratchStore.js";
import { projectStore } from "../../../services/ProjectStore.js";
import { refreshProjectMenuState } from "../../../projectMenuState.js";
import { notificationService } from "../../../services/NotificationService.js";
import type { PtyClient } from "../../../services/PtyClient.js";
import type { WindowRegistry } from "../../../window/WindowRegistry.js";
import type { Scratch } from "../../../../shared/types/scratch.js";

/**
 * What makes a scratch the workspace a window works in, once its view has
 * been swapped in: the canonical pointers, the saved window manifest, the
 * menu and titles, the PTY host's active workspace, and a fresh terminal port
 * for the view. Shared by `scratch:switch` and a window coming back to a
 * scratch from a remote host, which otherwise left its terminals unreachable.
 */
export function activateScratchInWindow(options: {
  scratch: Scratch;
  windowId: number | undefined;
  window: BrowserWindow | null | undefined;
  view: WebContents | null | undefined;
  windowRegistry: WindowRegistry | null | undefined;
  ptyClient: PtyClient | null | undefined;
}): Scratch {
  const { scratch, windowId, window, view, windowRegistry, ptyClient } = options;
  // Mutually exclusive with project: clear the project pointer so the
  // renderer's `getCurrentProject` does not race-restore the previous project.
  const updated = scratchStore.setCurrentScratch(scratch.id);
  projectStore.clearCurrentProject();

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

  broadcastToRenderer(CHANNELS.SCRATCH_ON_SWITCH, { scratch: updated, switchId: randomUUID() });
  return updated;
}
