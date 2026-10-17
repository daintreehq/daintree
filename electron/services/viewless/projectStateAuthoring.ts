import type { PanelSnapshot, ProjectState } from "../../../shared/types/project.js";

/**
 * The slice of `ProjectStore` main-authored state writes need. Injected so the
 * viewless executor can be exercised without the real store's disk layout.
 */
export interface ProjectStateWriter {
  enqueueProjectStateUpdate(
    projectId: string,
    updater: (existing: ProjectState | null) => ProjectState | null | Promise<ProjectState | null>
  ): Promise<void>;
}

/**
 * The state a project has before any renderer ever saved one. Mirrors the
 * renderer's own first save closely enough for hydration, which only reads the
 * fields a panel restore needs; the sidebar width is the layout default.
 */
function emptyProjectState(projectId: string): ProjectState {
  return { projectId, sidebarWidth: 350, terminals: [] };
}

/**
 * Record a terminal a viewless action spawned, so the next frontend to attach
 * hydrates a panel for it instead of finding a PTY no layout mentions.
 *
 * Queued behind any other write to the project's state rather than read and
 * saved separately: a concurrent write (another viewless spawn, a relocation
 * rewrite) must not lose this one. Appended, never inserted, and a snapshot for
 * an id already present is left alone — a renderer that recorded the panel
 * first knows more about it than this does.
 */
export async function recordViewlessTerminal(
  writer: ProjectStateWriter,
  projectId: string,
  snapshot: PanelSnapshot
): Promise<void> {
  await writer.enqueueProjectStateUpdate(projectId, (existing) => {
    const state = existing ?? emptyProjectState(projectId);
    const terminals = Array.isArray(state.terminals) ? state.terminals : [];
    if (terminals.some((terminal) => terminal.id === snapshot.id)) return null;
    return { ...state, terminals: [...terminals, snapshot] };
  });
}
