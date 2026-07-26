import { projectStore } from "../../services/ProjectStore.js";
import { getProjectHistory } from "../../services/ProjectHistoryService.js";
import type { HandlerDependencies, IpcContext } from "../types.js";
import type { ProjectHistoryTarget } from "../../../shared/types/ipc/project.js";
import { defineIpcNamespace, op } from "../define.js";
import { resolveScopedProjectForIpcContext } from "../projectContext.js";
import { PROJECT_HISTORY_METHOD_CHANNELS } from "./projectHistory.preload.js";

const projectExists = (projectId: string): boolean =>
  Boolean(projectStore.getProjectById(projectId));

export function createProjectHistoryNamespace(deps: HandlerDependencies) {
  /**
   * The project bound to the view that sent the request — not the global
   * current-project pointer, which only tracks the last-focused window and in a
   * second window names someone else's project. Falls back to the pointer only
   * when there is no view scoping to consult at all.
   */
  const resolveCurrentProjectId = (ctx: IpcContext): string | null => {
    const scoped = resolveScopedProjectForIpcContext(ctx, deps);
    if (scoped) return scoped.project?.id ?? null;
    return ctx.projectId ?? projectStore.getCurrentProjectId();
  };

  const describe = (projectId: string): ProjectHistoryTarget | null =>
    projectExists(projectId) ? { projectId } : null;

  /**
   * Resolve the toggle target without performing the switch.
   *
   * The switch is left to the renderer, which routes it through the same
   * `project:switch` IPC the palette uses. That path owns the view swap, the
   * per-window serialisation and the outgoing-state persist. Driving
   * `ProjectSwitchService` from here instead moved the current-project pointer
   * without moving the `WebContentsView` that is actually on screen, and
   * resolved to whichever window happened to own the globally-registered
   * handler dependencies rather than the one that pressed the key.
   */
  const resolveLastProject = (ctx: IpcContext): ProjectHistoryTarget | null => {
    const windowId = ctx.senderWindow?.id ?? deps.mainWindow?.id;
    if (windowId === undefined) return null;

    const history = getProjectHistory(windowId);
    const currentProjectId = resolveCurrentProjectId(ctx);

    // Seed from where the window actually is. A window that hasn't switched
    // since launch has an empty list, and without this the head would name
    // whatever another route recorded rather than the project on screen.
    // Idempotent once seeded.
    if (currentProjectId) history.record(currentProjectId);

    // From a scratch there is no current project to occupy the head, so the
    // project to return to is the head itself, not the entry behind it. Pruned
    // either way: an unpruned head deleted since the last switch would answer
    // every press with a project that no longer exists, stranding the toggle on
    // a survivor sitting right behind it.
    const targetId = currentProjectId
      ? history.peekLast(projectExists)
      : history.current(projectExists);
    if (!targetId) return null;

    return describe(targetId);
  };

  return defineIpcNamespace({
    name: "projectHistory",
    ops: {
      peek: op(PROJECT_HISTORY_METHOD_CHANNELS.peek, async (ctx) => resolveLastProject(ctx), {
        withContext: true,
      }),
    },
  });
}

export function registerProjectHistoryHandlers(deps: HandlerDependencies): () => void {
  return createProjectHistoryNamespace(deps).register();
}
