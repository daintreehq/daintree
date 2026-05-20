import { CHANNELS } from "./channels.js";
import { broadcastToRenderer } from "./utils.js";
import { projectStore } from "../services/ProjectStore.js";

/**
 * Broadcast `project:updated` for both the departing and newly-active project
 * after `ProjectStore.setCurrentProject` commits.
 *
 * Why: `setCurrentProject` writes both rows inside a single SQLite transaction
 * but does not emit IPC. Without this broadcast, cached WebContentsView
 * renderer stores keep stale MRU timestamps and the next `Cmd+Alt+=` /
 * project switcher pick targets the wrong project. See #8561.
 *
 * Reads each row back via `getProjectById` so the payload reflects the
 * actual persisted state — under write suppression, `lastOpened` may be
 * unchanged while `status` still flipped, and the broadcast must reflect that.
 */
export function broadcastProjectSwitchUpdates(
  previousProjectId: string | null,
  activeProjectId: string
): void {
  if (previousProjectId && previousProjectId !== activeProjectId) {
    const prevRow = projectStore.getProjectById(previousProjectId);
    if (prevRow) broadcastToRenderer(CHANNELS.PROJECT_UPDATED, prevRow);
  }
  const activeRow = projectStore.getProjectById(activeProjectId);
  if (activeRow) broadcastToRenderer(CHANNELS.PROJECT_UPDATED, activeRow);
}
