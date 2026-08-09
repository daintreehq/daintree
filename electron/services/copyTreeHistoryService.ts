// eager-import-allow: reaches the project file store only from copy-tree IPC handlers, never at boot
import { CHANNELS } from "../ipc/channels.js";
import { getWebContentsForProject } from "../window/webContentsRegistry.js";
import { projectStore } from "./ProjectStore.js";
import type {
  CopyTreeHistoryAppendInput,
  CopyTreeHistoryRecord,
} from "../../shared/types/ipc/copyTreeHistory.js";

/**
 * Push a copy-tree history snapshot to the views that own the project.
 *
 * Deliberately not `broadcastToProjectRenderers`: that helper falls back to a
 * global broadcast when no project views are registered, which for per-project
 * data would hand one project's history to whatever window happened to be open
 * — the failure mode #11125 already hit CopyTree with. No exact binding means
 * nothing to push.
 */
function pushCopyTreeHistory(projectId: string, records: CopyTreeHistoryRecord[]): void {
  for (const wc of getWebContentsForProject(projectId)) {
    try {
      wc.send(CHANNELS.EVENTS_PUSH, {
        name: "copy-tree-history:update",
        payload: { projectId, records },
      });
    } catch {
      // Silently ignore send failures during window initialization/disposal.
    }
  }
}

/**
 * Record a completed copy-tree run and push the new snapshot.
 *
 * Never throws and never rejects: recording is bookkeeping alongside a run that
 * has already delivered its bundle, so a corrupt history file, a failed
 * quarantine or a dead renderer must not turn a successful copy into a failed
 * one. Callers `await` it so the write and its push stay ordered behind the
 * per-project queue, and get back `undefined` either way.
 */
export async function recordCopyTreeRun(
  projectId: string | null,
  input: CopyTreeHistoryAppendInput
): Promise<void> {
  if (!projectId) return;

  try {
    const records = await projectStore.appendCopyTreeRun(projectId, input);
    pushCopyTreeHistory(projectId, records);
  } catch (error) {
    console.warn(`[CopyTreeHistory] Failed to record run for project ${projectId}:`, error);
  }
}
