import { CHANNELS } from "../channels.js";
import { broadcastToRenderer } from "../utils.js";
import { projectStore } from "../../services/ProjectStore.js";
import { projectViewManagersFrom } from "../../window/activeProjectIds.js";
import { getHibernationService } from "../../services/HibernationService.js";
import { logError } from "../../utils/logger.js";
import { writeHibernatedMarker } from "../../services/pty/terminalSessionPersistence.js";
import { gracefulTeardownAndJournalProject } from "../../services/pty/projectSessionJournal.js";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";
import { AppError } from "../../utils/errorTypes.js";
import { defineIpcNamespace, op } from "../define.js";
import type { HandlerDependencies } from "../types.js";
import type { ProjectSleepResult } from "../../../shared/types/ipc/project.js";

/** Thrown when the PTY host can't confirm the kills — see the handler below. */
const UNCONFIRMED_TEARDOWN_MESSAGE =
  "Couldn't confirm the project's terminals stopped. The project was left open.";

/**
 * `project:sleep` — put ONE project to sleep the way quitting puts them all to
 * sleep: a graceful, session-preserving kill of its terminals, each captured
 * `agentSessionId` written back into the saved panel snapshots, a resume record
 * journaled per agent, hibernation markers written, the cached renderer view and
 * the workspace host reclaimed, and the row left `closed` so a reopen restores
 * the layout and resumes the agents. Deliberately does NOT call
 * `clearProjectState` (that is Close's job — it destroys the layout) or
 * `killByProject` (destructive — it discards the sessions this exists to keep).
 *
 * Unlike the `project:free-memory` handler it replaces, this one accepts the
 * project that is on screen. It does NOT tear down that window's view: the
 * window's React renderer IS the project's `WebContentsView`, and the unbound
 * first-run welcome view is closed for good once a project paints, so destroying
 * it leaves a blank window rather than the picker. Instead the renderer drops to
 * the no-project state itself — the same transition `closeActiveProject` already
 * performs — and the `closed` row is what tells the menus the project is shut.
 * `evictProjectRenderer` still reclaims the project's CACHED views in every
 * other window; its skip-the-active-window guard is correct and stays.
 *
 * Lives in its own `defineIpcNamespace` block rather than the hand-written
 * `project` namespace so its `IpcInvokeMap` entry is codegen-generated — new
 * channels must not grow the hand-written ratchet (`check:ipc-handwritten`).
 */
export function registerProjectSleepHandlers(deps: HandlerDependencies): () => void {
  const namespace = defineIpcNamespace({
    name: "projectSleep",
    ops: {
      sleepProject: op(
        CHANNELS.PROJECT_SLEEP,
        async (projectId: string): Promise<ProjectSleepResult> => {
          // An absent/blank id must fail as invalid, never quietly resolve to
          // "whatever project is current" — a silent fallback on a teardown is
          // how the wrong project gets torn down (#7880).
          if (typeof projectId !== "string" || !projectId) {
            throw new Error("Invalid project ID");
          }

          const project = projectStore.getProjectById(projectId);
          if (!project) {
            throw new Error(`Project not found: ${projectId}`);
          }

          // Already asleep — nothing resident to reclaim, and re-killing would
          // walk an empty scope. Idempotent so a re-broadcast or a double click
          // can't double-journal.
          if (project.status === "closed") {
            return { terminalsKilled: 0, rendererViewsEvicted: 0, workspaceEvicted: false };
          }

          try {
            // Graceful, session-preserving kill + snapshot writeback + journal, in
            // that order — the same three steps a quit performs per project, via
            // the shared helper rather than a fourth copy of them.
            const { confirmed, terminalsKilled, sessions } =
              await gracefulTeardownAndJournalProject(
                projectId,
                deps.ptyClient!,
                deps.worktreeService,
                { preserveSession: true, writeBackSessionIds: true }
              );

            // Fail closed: an unconfirmed kill means a live host never
            // acknowledged, so its agents may still be running. Marking the row
            // `closed` now would hide still-running work behind a "reopen to
            // resume" affordance that has nothing to resume (#11340).
            if (!confirmed) {
              throw new AppError({
                code: "INTERNAL",
                message: UNCONFIRMED_TEARDOWN_MESSAGE,
                context: { projectId },
              });
            }

            // Past this point the terminals are gone and the kill is confirmed,
            // so the operation is COMMITTED: every remaining step is reclamation
            // or bookkeeping, and letting one of them throw would strand the row
            // as "open" with dead terminals behind it. Each is isolated, and the
            // status write + broadcast below always run.
            for (const session of sessions) {
              try {
                writeHibernatedMarker(session.id);
              } catch (markerError) {
                // Costs this terminal its restore banner, nothing else.
                console.warn(`[IPC] project:sleep: marker failed for ${session.id}:`, markerError);
              }
            }

            let rendererViewsEvicted = 0;
            try {
              // Reclaim the project's cached WebContentsViews. No-ops for a
              // window where the project is on screen (guarded inside the
              // service) — that window's renderer transitions itself, see the
              // docblock above.
              rendererViewsEvicted = getHibernationService().evictProjectRenderer(projectId);
            } catch (evictError) {
              console.warn(`[IPC] project:sleep: renderer eviction failed:`, evictError);
            }

            let workspaceEvicted = false;
            try {
              // `evictProject` refuses while any window still holds the project
              // (refCount > 0), and a window showing it holds one — so release
              // those references first. Safe even though the view stays alive:
              // it is about to render the welcome screen, which needs no
              // worktree feed. Without this, sleeping the project on screen
              // would leave its workspace host resident and report
              // `workspaceEvicted: false`, defeating half the reclaim.
              releaseWorkspaceRefsForProject(deps, projectId);
              workspaceEvicted = deps.worktreeService?.evictProject(project.path) ?? false;
            } catch (workspaceError) {
              console.warn(`[IPC] project:sleep: workspace eviction failed:`, workspaceError);
            }

            // Keep the project in the list as `closed` WITHOUT clearProjectState,
            // so its panel/terminal layout survives for a non-destructive reopen.
            projectStore.updateProjectStatus(projectId, "closed");

            // Read the pointer fresh rather than from a snapshot taken before the
            // awaits above: another window can switch projects while the kill is
            // in flight, and clearing on a stale read would wipe a DIFFERENT
            // project's pointer. Pointer bookkeeping, not a visibility check — it
            // must stay keyed on the DB pointer.
            if (projectId === projectStore.getCurrentProjectId()) {
              projectStore.clearCurrentProject();
            }

            const updated = projectStore.getProjectById(projectId);
            if (updated) {
              broadcastToRenderer(CHANNELS.PROJECT_UPDATED, updated);
            }

            // Its OWN event, not an inference from the `closed` status above:
            // relocation, project adoption and the idle sweep all reach `closed`
            // too, and a window blanking itself on any of those would be wrong.
            // This is what tells a SECOND window showing the project to drop to
            // the no-project state — main deliberately leaves its view alive.
            broadcastToRenderer(CHANNELS.PROJECT_SLEPT, projectId);

            console.log(
              `[IPC] project:sleep: ${projectId} — killed ${terminalsKilled} terminal(s), ` +
                `evicted ${rendererViewsEvicted} renderer view(s), workspace host ${
                  workspaceEvicted ? "evicted" : "retained"
                }`
            );

            return { terminalsKilled, rendererViewsEvicted, workspaceEvicted };
          } catch (error) {
            console.error(`[IPC] project:sleep: Failed for ${projectId}:`, error);
            // Rethrow an AppError as-is so a guard rejection (the unconfirmed
            // teardown above) isn't relabelled as an INTERNAL failure.
            if (error instanceof AppError) throw error;
            throw new AppError({
              code: "INTERNAL",
              message: formatErrorMessage(error, "Failed to sleep project"),
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

/**
 * Drop every window's workspace-host reference to `projectId`, so the host can
 * actually be evicted.
 *
 * `WorkspaceHostPool.evictProject` refuses a host any window still holds, and a
 * window with the project on screen holds one. Sleep leaves that window's view
 * alive on purpose — destroying it would blank the window — so nothing else
 * releases the reference, and the host would survive a sleep of the only
 * project using it. Releasing is safe here: the view is about to render the
 * welcome screen, and a later reopen re-registers through `loadProject`.
 *
 * Per-window and best-effort: a disposing window can throw, and one failure
 * must not skip the rest.
 */
function releaseWorkspaceRefsForProject(deps: HandlerDependencies, projectId: string): void {
  const worktreeService = deps.worktreeService;
  if (!worktreeService) return;

  let managers;
  try {
    managers = projectViewManagersFrom(deps.windowRegistry)();
  } catch (error) {
    logError("project-sleep-window-provider-failed", error, { projectId });
    return;
  }

  for (const manager of managers) {
    try {
      // Only the windows actually bound to this project — releasing another
      // window's mapping would sever a worktree feed still in use.
      if (manager.getActiveProjectId() !== projectId) continue;
      if (manager.win.isDestroyed()) continue;
      worktreeService.unregisterWindow(manager.win.id);
    } catch (error) {
      logError("project-sleep-window-release-failed", error, { projectId });
    }
  }
}
