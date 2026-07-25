import { projectStore } from "../../services/ProjectStore.js";
import { getProjectHistory } from "../../services/ProjectHistoryService.js";
import type { HandlerDependencies, IpcContext } from "../types.js";
import type {
  ProjectHistoryDirection,
  ProjectHistoryTarget,
} from "../../../shared/types/ipc/project.js";
import { defineIpcNamespace, op, ValidationError } from "../define.js";
import { resolveScopedProjectForIpcContext } from "../projectContext.js";
import { PROJECT_HISTORY_METHOD_CHANNELS } from "./projectHistory.preload.js";

/**
 * Reject rather than coerce. TypeScript does not police what a renderer puts on
 * the wire, and quietly mapping a malformed value onto "back" would turn a bug
 * into a silent, state-changing navigation.
 */
function parseDirection(value: unknown): ProjectHistoryDirection {
  if (value === "back" || value === "forward") return value;
  throw new ValidationError(`Invalid history direction: ${String(value)}`);
}

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
   * Resolve a step without performing it.
   *
   * The switch is left to the renderer, which routes it through the same
   * `project:switch` IPC the palette uses. That path owns the view swap, the
   * per-window serialisation and the outgoing-state persist. Driving
   * `ProjectSwitchService` from here instead moved the current-project pointer
   * without moving the `WebContentsView` that is actually on screen, and
   * resolved to whichever window happened to own the globally-registered
   * handler dependencies rather than the one that pressed the key.
   */
  const resolveStep = (
    ctx: IpcContext,
    direction: ProjectHistoryDirection
  ): ProjectHistoryTarget | null => {
    const windowId = ctx.senderWindow?.id ?? deps.mainWindow?.id;
    if (windowId === undefined) return null;

    const history = getProjectHistory(windowId);
    const currentProjectId = resolveCurrentProjectId(ctx);

    // Seed from where the window actually is. A window that hasn't switched
    // since launch has an empty stack, and without this Back would do nothing
    // until the user had already switched twice. Idempotent once seeded.
    if (currentProjectId) history.record(currentProjectId);

    // From a scratch there is no current project on the stack, so Back means
    // "return to the project I left" — the cursor itself, not one behind it.
    if (!currentProjectId && direction === "back") {
      const target = history.current();
      return target && projectExists(target) ? describe(target) : null;
    }

    const targetId = history.peek(direction, projectExists);
    if (!targetId) return null;

    return describe(targetId);
  };

  return defineIpcNamespace({
    name: "projectHistory",
    ops: {
      peek: op(
        PROJECT_HISTORY_METHOD_CHANNELS.peek,
        async (ctx, direction: ProjectHistoryDirection) =>
          resolveStep(ctx, parseDirection(direction)),
        { withContext: true }
      ),
    },
  });
}

export function registerProjectHistoryHandlers(deps: HandlerDependencies): () => void {
  return createProjectHistoryNamespace(deps).register();
}
