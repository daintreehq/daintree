import {
  isDockPanel,
  isPtyPanel,
  type DockPanelData,
  type PanelInstance,
  type PtyPanelData,
} from "@shared/types/panel";
import { getRenderablePanel } from "@/store/slices/panelRegistry/selectors";
import {
  collectUngroupedCandidateIds,
  panelMatchesWorktreeScope,
} from "@/store/slices/panelRegistry/worktreeIndex";
import type { TabGroup } from "@/types";

export interface DockRenderItem {
  group: TabGroup;
  panels: DockPanelData[];
}

/** The panel-store fields that decide which panels are docked. */
export interface DockMembershipState {
  panelIds: string[];
  panelIdsByWorktreeId: Record<string, string[]>;
  panelsById: Record<string, PanelInstance>;
  trashedTerminals: ReadonlyMap<string, unknown>;
}

/**
 * Every docked panel the rail can show, in canonical order, before the filters
 * that read other stores (`filterRailDockPanels`). The rail subscribes to this
 * half alone (#10908); the keyboard chip move (#14972) composes both so it
 * orders chips exactly as the rail paints them.
 *
 * Membership is `isDockPanel` — every registered kind that hasn't opted out
 * with `dockable: false`, PTY and non-PTY alike, including plugin kinds
 * (#11332). Panels are read through `getRenderablePanel`, not `getNarrowPanel`,
 * which drops plugin kinds. This is NOT the #10512 grid render-eligibility
 * predicate, which deliberately does not apply to the dock.
 *
 * Candidate ids come from `collectUngroupedCandidateIds`, the same helper
 * `getTabGroups` uses, so a panel committed mid-spawn-batch — eagerly in the
 * worktree index while `panelIds` only appends at flush — still paints on first
 * mount (#9649). The scoped call orders pending ids active-bucket-then-global,
 * while the unscoped one follows `panelIdsByWorktreeId`'s insertion order. Only
 * the pending tail differs, and only while a batch is open, but the worktree
 * filter can't restore the order — so it is scoped here to stay identical to
 * `getTabGroups`. Committed `panelIds` order is unaffected either way.
 */
export function collectDockPanels(
  state: DockMembershipState,
  activeWorktreeId: string | null | undefined
): DockPanelData[] {
  const result: DockPanelData[] = [];
  for (const id of collectUngroupedCandidateIds(
    state.panelIds,
    state.panelIdsByWorktreeId,
    activeWorktreeId ?? undefined
  )) {
    const terminal = getRenderablePanel(state.panelsById, id);
    if (
      terminal &&
      isDockPanel(terminal) &&
      terminal.location === "dock" &&
      !state.trashedTerminals.has(terminal.id)
    ) {
      result.push(terminal);
    }
  }
  return result;
}

/**
 * Narrow `collectDockPanels` to what the active worktree's rail shows: its own
 * and global panels, minus `excludedIds` — every assistant lane's terminal
 * renders inside HelpPanel, never in the dock (#12108).
 */
export function filterRailDockPanels(
  panels: readonly DockPanelData[],
  activeWorktreeId: string | null | undefined,
  excludedIds: readonly string[]
): DockPanelData[] {
  return panels.filter(
    (panel) =>
      !excludedIds.includes(panel.id) &&
      panelMatchesWorktreeScope(panel.worktreeId, activeWorktreeId, "dock")
  );
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

/**
 * The full `panelIds` order that moves the chip holding `panelId` one place
 * along the rail, or `null` when nothing would move: no chip holds the panel,
 * the chip is already at that end, or a rail member is still pending in a spawn
 * batch (painted, but not yet in `panelIds` or a layout snapshot).
 *
 * A one-index `reorderTerminals` step isn't chip-aware. A group paints at its
 * earliest member, so stepping a single chip past one member of a group can
 * leave the rail as it was. Swapping whole chips and writing the flattened rail
 * back into the slots its panels already hold changes the rail by exactly that
 * swap, and every panel the rail doesn't show keeps its place.
 */
export function planDockChipMove(
  panelIds: readonly string[],
  items: readonly DockRenderItem[],
  panelId: string,
  direction: -1 | 1
): string[] | null {
  const from = items.findIndex((item) => item.panels.some((panel) => panel.id === panelId));
  const to = from + direction;
  if (from === -1 || to < 0 || to >= items.length) return null;

  const reordered = [...items];
  reordered.splice(to, 0, ...reordered.splice(from, 1));
  const railIds = reordered.flatMap((item) => item.panels.map((panel) => panel.id));

  const railIdSet = new Set(railIds);
  const slots: number[] = [];
  panelIds.forEach((id, index) => {
    if (railIdSet.has(id)) slots.push(index);
  });
  if (slots.length !== railIds.length) return null;

  const next = [...panelIds];
  slots.forEach((slot, index) => {
    next[slot] = railIds[index]!;
  });
  return next.some((id, index) => id !== panelIds[index]) ? next : null;
}
