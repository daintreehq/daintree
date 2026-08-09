import { projectStore } from "../../services/ProjectStore.js";
import { defineIpcNamespace, op } from "../define.js";
import type { HandlerDependencies } from "../types.js";
import type { CopyTreeHistoryRecord } from "../../../shared/types/ipc/copyTreeHistory.js";
import { resolveCopyTreeProjectId } from "./copyTree.js";
import { COPY_TREE_HISTORY_METHOD_CHANNELS } from "./copyTreeHistory.preload.js";

/**
 * Read side of the per-project copy-tree run history (#11732).
 *
 * Read-only by design: the main process is the single writer, and it records a
 * run at the point the run actually completes rather than trusting a renderer
 * to report one. There is deliberately no `append` op here — a writable channel
 * would let any window forge entries for the project it happens to be bound to.
 *
 * Scoping reuses the *same* resolver the generate handlers write through, so a
 * view can never read a history it would not have written to.
 */
export function buildCopyTreeHistoryNamespace(deps: HandlerDependencies) {
  return defineIpcNamespace({
    name: "copyTreeHistory",
    ops: {
      getRecords: op(
        COPY_TREE_HISTORY_METHOD_CHANNELS.getRecords,
        async (ctx): Promise<CopyTreeHistoryRecord[]> => {
          const projectId = resolveCopyTreeProjectId(ctx, deps);
          if (!projectId) return [];
          try {
            return await projectStore.getCopyTreeHistory(projectId);
          } catch (error) {
            // A quarantine that could not be renamed leaves the file unreadable.
            // An empty list is the honest answer for a reader; the write path
            // still refuses to overwrite it.
            console.warn(
              `[CopyTreeHistory] Failed to read history for project ${projectId}:`,
              error
            );
            return [];
          }
        },
        { withContext: true }
      ),
    },
  });
}

export function registerCopyTreeHistoryHandlers(deps: HandlerDependencies): () => void {
  return buildCopyTreeHistoryNamespace(deps).register();
}
