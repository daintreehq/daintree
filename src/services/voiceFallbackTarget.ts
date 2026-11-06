import type { TabGroup } from "@shared/types/panel";
import {
  selectOpenDockPopoverId,
  type DockPopoverPointerState,
} from "@/components/Layout/dockPanelVisibility";
import { isRenderedGridPanel, type PanelGroupInfo } from "@/store/panelFocusFallback";
import type { MaximizeTarget } from "@/store/slices/terminalFocusSlice";

const MRU_TERMINAL_PREFIX = "terminal:";

export interface VisiblePaneState extends DockPopoverPointerState {
  activeWorktreeId: string | null;
  maximizedId: string | null;
  maximizeTarget: MaximizeTarget;
  /** The active worktree's grid groups, as `getTabGroups` hands them to the grid. */
  gridGroups: readonly Pick<TabGroup, "id" | "panelIds" | "activeTabId">[];
  helpTerminalIds: ReadonlySet<string>;
  /** Something else fills the main area in place of the worktree's grid: Home alone, a fleet scope. */
  gridHidden: boolean;
  /** A close the grid has already hidden but the store hasn't committed. */
  isClosing: (id: string) => boolean;
}

/**
 * The panes the person can see right now: the active worktree's grid cells
 * that are drawn (the shown tab of each group, only the maximized cell while
 * one is), and the open dock popover. Read the way the grid and dock render
 * them, so a pane nothing draws is never the answer.
 */
export function listVisiblePaneIds(state: VisiblePaneState): string[] {
  const visible: string[] = [];

  if (!state.gridHidden) {
    const groupByPanel = new Map<string, PanelGroupInfo>();
    for (const group of state.gridGroups) {
      // The grid drops a closing pane before its trash commit lands, and its
      // group shows the next tab meanwhile.
      const kept = group.panelIds.filter((id) => !state.isClosing(id));
      if (kept.length === 0) continue;
      const activeTabId = kept.includes(group.activeTabId) ? group.activeTabId : kept[0]!;
      for (const id of kept) groupByPanel.set(id, { groupId: group.id, activeTabId });
    }
    const options = {
      activeWorktreeId: state.activeWorktreeId,
      // As the grid reads it: a closing maximized pane no longer covers the rest.
      maximizedId:
        state.maximizedId !== null && state.isClosing(state.maximizedId) ? null : state.maximizedId,
      maximizeTarget: state.maximizeTarget,
      getPanelGroupInfo: (id: string) => groupByPanel.get(id),
    };
    for (const id of groupByPanel.keys()) {
      const panel = state.panelsById[id];
      if (panel && !state.trashedTerminals.has(id) && isRenderedGridPanel(panel, options)) {
        visible.push(id);
      }
    }
  }

  const dockId = selectOpenDockPopoverId(state, {
    helpTerminalIds: state.helpTerminalIds,
    activeWorktreeId: state.activeWorktreeId,
  });
  if (dockId !== null && !state.isClosing(dockId)) {
    visible.push(dockId);
  }

  return visible;
}

/**
 * Of the visible panes that can take dictation, the one the person was last in:
 * the newest panel MRU entry among them, else the only one there is. Null when
 * several are on screen and none was focused, since any pick would be a guess.
 */
export function pickRecentVisibleTarget<T>(
  candidates: ReadonlyMap<string, T>,
  mruList: readonly string[]
): T | null {
  for (const entry of mruList) {
    if (!entry.startsWith(MRU_TERMINAL_PREFIX)) continue;
    const candidate = candidates.get(entry.slice(MRU_TERMINAL_PREFIX.length));
    if (candidate !== undefined) return candidate;
  }
  if (candidates.size !== 1) return null;
  return candidates.values().next().value ?? null;
}
