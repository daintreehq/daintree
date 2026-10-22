import {
  WORKTREES_SIDEBAR_VIEW_PRIORITY,
  pluginManifestIdFromInstanceKey,
  projectIdFromPluginInstanceKey,
  type PluginHostedViewDescriptor,
  type PluginSidebarHostedViewDescriptor,
} from "@shared/types/plugin";
import { evaluateWhenClause, type WhenClauseContext } from "@shared/utils/whenClause";
import { WORKTREES_SIDEBAR_VIEW_ID } from "@/store/sidebarViewStore";

/** One entry in the sidebar view switcher. */
export interface SidebarViewOption {
  /** The public id, as `activeSidebarView` publishes it and the choice is remembered. */
  id: string;
  priority: number;
  /** `null` for the built-in worktree list, whose title depends on the sidebar showing it. */
  view: PluginSidebarHostedViewDescriptor | null;
}

const PROJECT_SIDEBAR_VIEW_PREFIX = "project:";

/** Dispatched on `window` by `ui.sidebar.switchView` with no view: the mounted switcher opens. */
export const OPEN_SIDEBAR_VIEW_SWITCHER_EVENT = "daintree:open-sidebar-view-switcher";

/**
 * The public id of a plugin's sidebar view: `<manifest name>.<view id>`, with a
 * `project:` prefix for a project plugin's. An installed plugin and a project
 * plugin may share a manifest name and both load (§7.1), so the bare form
 * would name two views at once; the project id itself stays out, so an author
 * can write the id in a `when` clause.
 */
export function sidebarViewPublicId(view: Pick<PluginHostedViewDescriptor, "pluginId" | "viewId">) {
  const id = `${pluginManifestIdFromInstanceKey(view.pluginId)}.${view.viewId}`;
  return projectIdFromPluginInstanceKey(view.pluginId) === null
    ? id
    : `${PROJECT_SIDEBAR_VIEW_PREFIX}${id}`;
}

const BUILT_IN_OPTION: SidebarViewOption = Object.freeze({
  id: WORKTREES_SIDEBAR_VIEW_ID,
  priority: WORKTREES_SIDEBAR_VIEW_PRIORITY,
  view: null,
});

/**
 * Every sidebar view on offer, highest priority first: the built-in worktree
 * list, always, plus each plugin sidebar view whose `when` holds. The worktree
 * list wins a tie, and plugin views that tie sort by id, so the order never
 * depends on which plugin happened to load first.
 *
 * `hosted` is already narrowed by main to the plugins this project may see;
 * `null` (no snapshot yet) offers the worktree list alone.
 *
 * A sidebar view's `when` is evaluated without `activeSidebarView`: which view
 * shows is decided from this list, so a view whose availability read that
 * answer would never settle. The manifest gate rejects such a clause; leaving
 * the key out keeps a manifest that slipped past it from looping.
 */
export function resolveSidebarViewOptions(
  hosted: readonly PluginHostedViewDescriptor[] | null,
  context: WhenClauseContext
): SidebarViewOption[] {
  const { activeSidebarView: _decidedFromThisList, ...whenContext } = context;
  const seen = new Set<string>([WORKTREES_SIDEBAR_VIEW_ID]);
  const plugin: SidebarViewOption[] = [];
  for (const view of hosted ?? []) {
    if (view.location !== "sidebar") continue;
    const id = sidebarViewPublicId(view);
    if (seen.has(id) || !evaluateWhenClause(view.when, whenContext)) continue;
    seen.add(id);
    plugin.push({ id, priority: view.priority, view });
  }
  if (plugin.length === 0) return [BUILT_IN_OPTION];
  return [BUILT_IN_OPTION, ...plugin].sort((a, b) => {
    if (a.priority !== b.priority) return b.priority - a.priority;
    if (a.view === null) return -1;
    if (b.view === null) return 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/** The view to show: the chosen one while it is on offer, otherwise the worktree list. */
export function resolveActiveSidebarView(
  options: readonly SidebarViewOption[],
  chosen: string
): SidebarViewOption {
  return options.find((option) => option.id === chosen) ?? BUILT_IN_OPTION;
}
