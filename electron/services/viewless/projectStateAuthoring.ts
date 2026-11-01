import type { PanelSnapshot, ProjectState } from "../../../shared/types/project.js";
import {
  forgetHostStartedTerminals,
  noteHostStartedTerminal,
  noteHostStartedTerminalBackgrounded,
} from "./hostStartedTerminals.js";

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
 *
 * Noted as host-started before the write, which can fail while the PTY runs:
 * a window already showing the project never adopts it either way (#14473).
 */
export async function recordViewlessTerminal(
  writer: ProjectStateWriter,
  projectId: string,
  snapshot: PanelSnapshot
): Promise<void> {
  noteHostStartedTerminal(projectId, snapshot.id, snapshot);
  await writer.enqueueProjectStateUpdate(projectId, (existing) => {
    const state = existing ?? emptyProjectState(projectId);
    const terminals = Array.isArray(state.terminals) ? state.terminals : [];
    if (terminals.some((terminal) => terminal.id === snapshot.id)) return null;
    return { ...state, terminals: [...terminals, snapshot] };
  });
}

function withoutPanelReferences(
  layout: NonNullable<ProjectState["terminalLayout"]>,
  terminalId: string
): NonNullable<ProjectState["terminalLayout"]> {
  const { focusedTerminalId, maximizedTerminalId, ...rest } = layout;
  return {
    ...rest,
    ...(focusedTerminalId !== undefined && focusedTerminalId !== terminalId
      ? { focusedTerminalId }
      : {}),
    ...(maximizedTerminalId !== undefined && maximizedTerminalId !== terminalId
      ? { maximizedTerminalId }
      : {}),
  };
}

function withoutKey<T>(
  record: Record<string, T> | undefined,
  key: string
): Record<string, T> | undefined {
  if (!record || !Object.hasOwn(record, key)) return record;
  const { [key]: _removed, ...rest } = record;
  return rest;
}

/** The layout's tab groups without `terminalId`, a group left empty dropped. */
function withoutGroupMember(
  tabGroups: ProjectState["tabGroups"],
  terminalId: string
): ProjectState["tabGroups"] {
  return tabGroups
    ?.map((group) => {
      const panelIds = group.panelIds.filter((id) => id !== terminalId);
      return {
        ...group,
        panelIds,
        activeTabId:
          group.activeTabId === terminalId ? (panelIds[0] ?? group.activeTabId) : group.activeTabId,
      };
    })
    .filter((group) => group.panelIds.length > 0);
}

/**
 * Park a terminal no view holds in the background of the saved layout, as a
 * view's own "move to background" parks it: out of its grid or dock and its
 * tab group, coming back where it was. A scheduled run's done policy (#15982)
 * is the only caller. Queued like the writes above; a panel the layout never
 * held, or one already parked or in the trash, is left alone.
 */
export async function backgroundViewlessTerminal(
  writer: ProjectStateWriter,
  projectId: string,
  terminalId: string
): Promise<void> {
  noteHostStartedTerminalBackgrounded(projectId, terminalId);
  await writer.enqueueProjectStateUpdate(projectId, (existing) => {
    if (!existing || !Array.isArray(existing.terminals)) return null;
    const panel = existing.terminals.find((terminal) => terminal.id === terminalId);
    if (!panel || (panel.location !== "grid" && panel.location !== "dock")) return null;
    const tabGroups = withoutGroupMember(existing.tabGroups, terminalId);
    return {
      ...existing,
      terminals: existing.terminals.map((terminal) =>
        terminal.id === terminalId
          ? { ...terminal, location: "background", backgroundRestoreLocation: panel.location }
          : terminal
      ),
      ...(tabGroups !== undefined ? { tabGroups } : {}),
      ...(existing.terminalLayout !== undefined
        ? { terminalLayout: withoutPanelReferences(existing.terminalLayout, terminalId) }
        : {}),
    };
  });
}

/**
 * Take a panel a viewless action closed out of the saved layout, the way a
 * view's own save drops a trashed panel: the next frontend to attach should
 * not hydrate a panel the agent already closed. The process keeps its trash
 * grace in the pty-host either way; this only changes what the layout says.
 *
 * Queued like the record above, and a no-op for a panel the layout never
 * held, so a close racing a view's save can't resurrect or lose anything else.
 */
export async function forgetViewlessTerminal(
  writer: ProjectStateWriter,
  projectId: string,
  terminalId: string
): Promise<void> {
  forgetHostStartedTerminals(projectId, [terminalId]);
  await writer.enqueueProjectStateUpdate(projectId, (existing) => {
    if (!existing || !Array.isArray(existing.terminals)) return null;
    if (!existing.terminals.some((terminal) => terminal.id === terminalId)) return null;
    const tabGroups = withoutGroupMember(existing.tabGroups, terminalId);
    return {
      ...existing,
      terminals: existing.terminals.filter((terminal) => terminal.id !== terminalId),
      ...(tabGroups !== undefined ? { tabGroups } : {}),
      // MRU entries are keyed `terminal:<id>`; a bare id is dropped too.
      ...(existing.mruList !== undefined
        ? {
            mruList: existing.mruList.filter(
              (key) => key !== terminalId && key !== `terminal:${terminalId}`
            ),
          }
        : {}),
      ...(existing.terminalLayout !== undefined
        ? { terminalLayout: withoutPanelReferences(existing.terminalLayout, terminalId) }
        : {}),
      ...(existing.terminalSizes !== undefined
        ? { terminalSizes: withoutKey(existing.terminalSizes, terminalId) }
        : {}),
      ...(existing.draftInputs !== undefined
        ? { draftInputs: withoutKey(existing.draftInputs, terminalId) }
        : {}),
    };
  });
}
