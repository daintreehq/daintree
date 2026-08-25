import { projectStore } from "../../services/ProjectStore.js";
import { scratchStore } from "../../services/ScratchStore.js";
import { getProjectHistory } from "../../services/ProjectHistoryService.js";
import { isScratchWorkspaceId } from "../../../shared/utils/workspaceIds.js";
import type { HandlerDependencies, IpcContext } from "../types.js";
import type { ProjectHistoryTarget } from "../../../shared/types/ipc/project.js";
import { defineIpcNamespace, op } from "../define.js";
import { resolveScopedProjectForIpcContext } from "../projectContext.js";
import { PROJECT_HISTORY_METHOD_CHANNELS } from "./projectHistory.preload.js";

/**
 * Whether a remembered workspace is still there to go back to.
 *
 * Routed on the id's shape rather than by asking both stores in turn: the two
 * id spaces are disjoint, and shape is the repo's authority on which kind an id
 * is (`shared/utils/workspaceIds.ts`). Only the scratch side is gated on shape,
 * though — a scratch lookup on a project id would hit the database for an
 * answer it can never find, while an unrecognised id falling through to the
 * project store simply comes back missing and is pruned, which is what should
 * happen to an id no store can account for.
 */
const workspaceExists = (workspaceId: string): boolean =>
  isScratchWorkspaceId(workspaceId)
    ? Boolean(scratchStore.getScratchById(workspaceId))
    : Boolean(projectStore.getProjectById(workspaceId));

/**
 * `workspaceExists` memoised for the length of one request.
 *
 * `prune` tests every entry twice — once to decide whether anything is missing,
 * again to filter — and both `current` and `peekLast` prune, so a single press
 * would otherwise repeat the same scratch row lookup up to four times. Sharing
 * one map across the whole resolution also makes it internally consistent: a
 * workspace deleted midway cannot be present for the seed and absent for the
 * peek.
 */
function memoizedWorkspaceExists(): (workspaceId: string) => boolean {
  const cache = new Map<string, boolean>();
  return (workspaceId: string): boolean => {
    const cached = cache.get(workspaceId);
    if (cached !== undefined) return cached;
    const result = workspaceExists(workspaceId);
    cache.set(workspaceId, result);
    return result;
  };
}

export function createProjectHistoryNamespace(deps: HandlerDependencies) {
  /**
   * The workspace bound to the view that sent the request — not the global
   * current-project pointer, which only tracks the last-focused window and in a
   * second window names someone else's project. Falls back to the pointer only
   * when there is no view scoping to consult at all.
   *
   * `workspaceId`, not `project?.id`: a scratch is a workspace with no project
   * row, so reading the project would answer null for a window that is very
   * much somewhere (#11936). That null was what forced the toggle to guess.
   *
   * The raw binding backs it up because the scoped resolver also blanks a
   * *closed* project — the right answer for state hydration, which must not
   * resurrect a workspace the user closed, and the wrong one here: the view is
   * still on screen, and calling it nowhere hands the toggle back the very
   * workspace it is standing in.
   */
  const resolveCurrentWorkspaceId = (ctx: IpcContext): string | null => {
    const scoped = resolveScopedProjectForIpcContext(ctx, deps);
    if (scoped) return scoped.workspaceId ?? ctx.projectId;
    return ctx.projectId ?? projectStore.getCurrentProjectId();
  };

  /**
   * Resolve the toggle target without performing the switch.
   *
   * The switch is left to the renderer, which routes it through the same
   * `project:switch` / `scratch:switch` IPC the palette uses. That path owns the
   * view swap, the per-window serialisation and the outgoing-state persist.
   * Driving `ProjectSwitchService` from here instead moved the current-project
   * pointer without moving the `WebContentsView` that is actually on screen, and
   * resolved to whichever window happened to own the globally-registered
   * handler dependencies rather than the one that pressed the key.
   */
  const resolveLastWorkspace = (ctx: IpcContext): ProjectHistoryTarget | null => {
    const windowId = ctx.senderWindow?.id ?? deps.mainWindow?.id;
    if (windowId === undefined) return null;

    const history = getProjectHistory(windowId);
    const exists = memoizedWorkspaceExists();
    const currentWorkspaceId = resolveCurrentWorkspaceId(ctx);

    // Seed from where the window actually is, then step behind it. A window
    // that hasn't switched since launch has an empty list, and without this the
    // head would name whatever another route recorded rather than the workspace
    // on screen. Idempotent once seeded.
    //
    // The head is only the target when there is no live workspace to seed —
    // a sender with no binding to resolve, or one whose workspace was deleted
    // out from under it. Both leave the head as the most recent place the
    // window is known to have been, and stepping behind it there would skip
    // over the very entry being asked for.
    let targetId: string | null;
    if (currentWorkspaceId && exists(currentWorkspaceId)) {
      history.record(currentWorkspaceId);
      targetId = history.peekLast(exists);
    } else {
      targetId = history.current(exists);
    }

    if (!targetId) return null;
    return { workspaceId: targetId };
  };

  return defineIpcNamespace({
    name: "projectHistory",
    ops: {
      peek: op(PROJECT_HISTORY_METHOD_CHANNELS.peek, async (ctx) => resolveLastWorkspace(ctx), {
        withContext: true,
      }),
    },
  });
}

export function registerProjectHistoryHandlers(deps: HandlerDependencies): () => void {
  return createProjectHistoryNamespace(deps).register();
}
