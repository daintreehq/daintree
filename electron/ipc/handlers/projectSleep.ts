import { CHANNELS } from "../channels.js";
import { broadcastToRenderer } from "../utils.js";
import { projectStore } from "../../services/ProjectStore.js";
import { getHibernationService } from "../../services/HibernationService.js";
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

            for (const session of sessions) {
              writeHibernatedMarker(session.id);
            }

            // Reclaim the project's cached WebContentsViews. No-ops for a window
            // where the project is on screen (guarded inside the service) — that
            // window's renderer transitions itself, see the docblock above.
            const rendererViewsEvicted = getHibernationService().evictProjectRenderer(projectId);

            // Drop the workspace-host utility process. Returns false while any
            // window still holds the project (refCount > 0), which is exactly the
            // on-screen case: that window keeps its live worktree feed until the
            // user moves it elsewhere.
            const workspaceEvicted = deps.worktreeService?.evictProject(project.path) ?? false;

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
              // Every window listens: one showing this project drops to the
              // no-project state off this broadcast, so a second window can't be
              // left painting a project whose terminals are gone.
              broadcastToRenderer(CHANNELS.PROJECT_UPDATED, updated);
            }

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
