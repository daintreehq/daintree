import { CHANNELS } from "../channels.js";
import { broadcastToRenderer } from "../utils.js";
import { projectStore } from "../../services/ProjectStore.js";
import { collectActiveProjectIds, projectViewManagersFrom } from "../../window/activeProjectIds.js";
import { getHibernationService } from "../../services/HibernationService.js";
import { writeHibernatedMarker } from "../../services/pty/terminalSessionPersistence.js";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";
import { AppError } from "../../utils/errorTypes.js";
import { defineIpcNamespace, op } from "../define.js";
import type { HandlerDependencies } from "../types.js";
import type { ProjectFreeMemoryResult } from "../../../shared/types/ipc/project.js";

/**
 * `project:free-memory` — reclaim a background project's resident memory while
 * keeping it in the list as `closed` for a non-destructive reopen. Tears down
 * all three reclaimable tiers: graceful (session-preserving) PTY kill, cached
 * renderer WebContentsView, and the workspace-host process. Deliberately does
 * NOT call `clearProjectState` (layout survives), `killByProject` (destructive),
 * or route through `HibernationService.hibernateProject` (experiment-gated).
 *
 * Lives in its own `defineIpcNamespace` block rather than the hand-written
 * `project` namespace so its `IpcInvokeMap` entry is codegen-generated — new
 * channels must not grow the hand-written ratchet (`check:ipc-handwritten`).
 */
export function registerProjectFreeMemoryHandlers(deps: HandlerDependencies): () => void {
  const namespace = defineIpcNamespace({
    name: "projectFreeMemory",
    ops: {
      freeMemory: op(
        CHANNELS.PROJECT_FREE_MEMORY,
        async (projectId: string): Promise<ProjectFreeMemoryResult> => {
          if (typeof projectId !== "string" || !projectId) {
            throw new Error("Invalid project ID");
          }

          // A visible project owns its window's renderer and live workspace host
          // — tearing them down would blank that window and sever the worktree
          // feed. Check EVERY window, not just the DB current-project pointer:
          // that only tracks the last-focused window, so a project on-screen in
          // a second window would otherwise look like a background one (#11102).
          const activeIds = collectActiveProjectIds(
            projectViewManagersFrom(deps.windowRegistry),
            projectStore.getCurrentProjectId(),
            "project-free-memory"
          );
          if (activeIds.has(projectId)) {
            throw new Error(
              "Cannot free memory for a project that's open in a window. " +
                "Switch that window to another project first."
            );
          }

          const project = projectStore.getProjectById(projectId);
          if (!project) {
            throw new Error(`Project not found: ${projectId}`);
          }

          // Already reclaimed — nothing resident to free. Idempotent so repeated
          // menu clicks (or a re-broadcast) don't double-kill or throw.
          if (project.status === "closed") {
            return { terminalsKilled: 0, rendererEvicted: false, workspaceEvicted: false };
          }

          try {
            // Graceful, session-preserving kill — NOT killByProject. The shell
            // scrollback survives via the hibernation markers below so a later
            // reopen restores the panels instead of starting cold.
            const results = await deps.ptyClient!.gracefulKillByProject(projectId, {
              preserveSession: true,
            });
            for (const result of results) {
              writeHibernatedMarker(result.id);
            }

            // Tear down the cached WebContentsView across every window (no-ops
            // where the project is on-screen — guarded inside the service).
            const evictedViewCount = getHibernationService().evictProjectRenderer(projectId);

            // Drop the workspace-host utility process. Skips when another window
            // still holds the project (refCount > 0).
            const workspaceEvicted = deps.worktreeService?.evictProject(project.path) ?? false;

            // Keep the project in the list as `closed` WITHOUT clearProjectState,
            // so its panel/terminal layout survives for a non-destructive reopen.
            projectStore.updateProjectStatus(projectId, "closed");
            const updated = projectStore.getProjectById(projectId);
            if (updated) {
              broadcastToRenderer(CHANNELS.PROJECT_UPDATED, updated);
            }

            console.log(
              `[IPC] project:free-memory: ${projectId} — killed ${results.length} terminal(s), ` +
                `evicted ${evictedViewCount} renderer view(s), workspace host ${
                  workspaceEvicted ? "evicted" : "retained"
                }`
            );

            return {
              terminalsKilled: results.length,
              rendererEvicted: evictedViewCount > 0,
              workspaceEvicted,
            };
          } catch (error) {
            console.error(`[IPC] project:free-memory: Failed for ${projectId}:`, error);
            throw new AppError({
              code: "INTERNAL",
              message: formatErrorMessage(error, "Failed to free memory"),
              context: { projectId },
              cause: error instanceof Error ? error : undefined,
            });
          }
        }
      ),
    },
  });

  return namespace.register();
}
