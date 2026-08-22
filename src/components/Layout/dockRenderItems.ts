import { isPtyPanel, type DockPanelData, type PtyPanelData } from "@shared/types/panel";
import { panelMatchesWorktreeScope } from "@/store/slices/panelRegistry/worktreeIndex";
import type { TabGroup } from "@/types";

export interface DockRenderItem {
  group: TabGroup;
  panels: DockPanelData[];
}

/**
 * Project the dock rail from two reactive snapshots: the ordered dock panels
 * and the tab-group map.
 *
 * `orderedPanels` is the sole authority for chip order. It arrives in canonical
 * `panelIds` order, so a pure `reorderTerminals` — which rewrites only
 * `panelIds`/`panelIdsByWorktreeId` — repaints the rail. Order used to come
 * from the `getTabGroups` store action behind a `useMemo` whose deps were read
 * for invalidation only; React Compiler drops deps a callback never consumes,
 * so that memo held the pre-drag order and every reorder snapped back (#11873).
 *
 * Explicit dock tab groups stay PTY-only by design — every dockable non-PTY
 * kind (file, browser and plugin view panels — #11332) docks as a standalone
 * chip. Those chips are emitted in place, at their canonical position, rather
 * than appended after every terminal: resolving each group through a PTY-only
 * filter used to leave a non-PTY panel's group empty, dropping it out of the
 * rail and re-appending it at the end, so `[a1, browser, a2]` rendered as
 * `a1, a2, browser` (#11873).
 *
 * A group is emitted once, at its earliest surviving member's position, so
 * explicit and virtual groups interleave exactly as `getTabGroups` orders them
 * — a panel must not jump to position 0 the moment it gains a second tab
 * (#10435).
 */
export function buildDockRenderItems(
  orderedPanels: readonly DockPanelData[],
  tabGroups: ReadonlyMap<string, TabGroup>,
  activeWorktreeId: string | null | undefined
): DockRenderItem[] {
  const panelsById = new Map<string, DockPanelData>();
  for (const panel of orderedPanels) panelsById.set(panel.id, panel);

  // Resolve each in-scope dock group to its surviving PTY members, in the
  // group's own tab order. A non-PTY member is dropped here — it never joins a
  // group — and falls through to a standalone chip below. Groups are scoped by
  // their own worktree as well as their members' so a group pinned to another
  // worktree can't surface through a global member.
  //
  // A panel belongs to at most one chip: claiming ids as they resolve means the
  // first group wins and a later group can't re-list an id already taken. The
  // store guards against overlapping membership, but a corrupt or hand-edited
  // group would otherwise render the same panel under two chips — with two
  // sortables sharing one dnd-kit id.
  const resolvedGroups = new Map<string, { group: TabGroup; panels: PtyPanelData[] }>();
  const groupIdByPanelId = new Map<string, string>();
  for (const group of tabGroups.values()) {
    if (group.location !== "dock") continue;
    if (!panelMatchesWorktreeScope(group.worktreeId, activeWorktreeId, "dock")) continue;

    const panels: PtyPanelData[] = [];
    for (const id of group.panelIds) {
      if (groupIdByPanelId.has(id)) continue;
      const panel = panelsById.get(id);
      if (!panel || !isPtyPanel(panel)) continue;
      panels.push(panel);
      groupIdByPanelId.set(id, group.id);
    }
    if (panels.length === 0) continue;

    resolvedGroups.set(group.id, { group, panels });
  }

  const items: DockRenderItem[] = [];
  const emittedGroupIds = new Set<string>();
  const emittedPanelIds = new Set<string>();
  for (const panel of orderedPanels) {
    if (emittedPanelIds.has(panel.id)) continue;
    emittedPanelIds.add(panel.id);

    const groupId = groupIdByPanelId.get(panel.id);

    if (groupId === undefined) {
      items.push({
        group: {
          id: panel.id,
          location: "dock",
          worktreeId: panel.worktreeId,
          activeTabId: panel.id,
          panelIds: [panel.id],
        },
        panels: [panel],
      });
      continue;
    }

    if (emittedGroupIds.has(groupId)) continue;
    emittedGroupIds.add(groupId);

    const resolved = resolvedGroups.get(groupId)!;
    const panelIds = resolved.panels.map((member) => member.id);
    items.push({
      group: {
        ...resolved.group,
        panelIds,
        activeTabId: panelIds.includes(resolved.group.activeTabId)
          ? resolved.group.activeTabId
          : (panelIds[0] ?? ""),
      },
      panels: resolved.panels,
    });
  }

  return items;
}
