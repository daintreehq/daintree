import { getNarrowPanel } from "@/store/slices/panelRegistry/selectors";
import type { MaximizeTarget } from "@/store/slices/terminalFocusSlice";

type CarrierPanel = Parameters<typeof getNarrowPanel>[0][string];

/** The group a panel belongs to, and which of its tabs is currently on screen. */
export interface PanelGroupInfo {
  groupId: string;
  activeTabId: string | null;
}

export type GetPanelGroupInfo = (panelId: string) => PanelGroupInfo | undefined;

/**
 * Whether a panel is laid out in the grid of the active worktree. Legacy rows
 * carry no `location` and are grid panels by omission.
 *
 * Docked panels are excluded even while their popover is open: the popover is a
 * transient surface, and handing focus back to one that is closing is the bug
 * this guards against (#11133).
 */
export function isVisibleGridPanel(panel: CarrierPanel, activeWorktreeId: string | null): boolean {
  if (panel.location && panel.location !== "grid") return false;
  return (panel.worktreeId ?? undefined) === (activeWorktreeId ?? undefined);
}

/**
 * Whether the user can actually see this panel right now — grid membership is
 * necessary but not sufficient. A background tab of a grid tab group and a pane
 * sitting behind a maximized one both still read as `location: "grid"`, so a
 * fallback that stopped at `isVisibleGridPanel` could hand the keyboard to a
 * pane nothing renders, which is the same divergence from the other end.
 */
export function isRenderedGridPanel(
  panel: CarrierPanel,
  options: {
    activeWorktreeId: string | null;
    maximizedId: string | null;
    maximizeTarget: MaximizeTarget;
    getPanelGroupInfo: GetPanelGroupInfo;
  }
): boolean {
  if (!isVisibleGridPanel(panel, options.activeWorktreeId)) return false;

  const group = options.getPanelGroupInfo(panel.id);
  if (group && group.activeTabId !== null && group.activeTabId !== panel.id) return false;

  // Mirror ContentGrid's own branching rather than paraphrasing it. It maximizes
  // only when BOTH halves are set, and for a panel target it renders the pane
  // named by `maximizedId` — not by `maximizeTarget.id`. The two can drift
  // (layout undo restores `maximizedId` alone), and a predicate that trusted the
  // target would then reject the very pane on screen and elect a hidden one.
  const { maximizedId, maximizeTarget } = options;
  if (!maximizedId || !maximizeTarget) return true;
  if (maximizeTarget.type === "group") return group?.groupId === maximizeTarget.id;
  return maximizedId === panel.id;
}

/**
 * Where focus goes when the open dock panel is dismissed while holding it.
 *
 * `previousFocusedId` is preferred because `openDockTerminal` records the pane
 * the user came from, so the round trip is exact. It is still checked against
 * the rendered set rather than trusted: a dock-to-dock switch overwrites it with
 * the other dock pane, and the pane it named can be trashed or maximized away
 * while the popover is open.
 */
export function pickDockCloseFocusId(options: {
  panels: CarrierPanel[];
  activeWorktreeId: string | null;
  previousFocusedId: string | null;
  maximizedId: string | null;
  maximizeTarget: MaximizeTarget;
  getPanelGroupInfo: GetPanelGroupInfo;
}): string | null {
  const rendered = options.panels.filter((panel) => isRenderedGridPanel(panel, options));
  const previous = rendered.find((panel) => panel.id === options.previousFocusedId);
  return previous?.id ?? rendered[0]?.id ?? null;
}

function firstFocusablePanelInGroup(
  panelIds: string[],
  activeTabId: string | undefined,
  closing: Pick<ReadonlySet<string>, "has">
): string | null {
  if (activeTabId && panelIds.includes(activeTabId) && !closing.has(activeTabId)) {
    return activeTabId;
  }
  return panelIds.find((id) => !closing.has(id)) ?? null;
}

/**
 * Where focus goes when the panels in `hideIds` leave their worktree's grid,
 * closed or moved to another worktree (#14974): the next tab group in visual
 * order, else the nearest one before it, landing on that group's visible tab. A
 * leaver outside the grid's groups (a docked pane) walks the flat panel order
 * the same way. `isUnavailable` names panels already on their way out, such as
 * a close still pending, which can't take focus either.
 *
 * Read it before the leavers are refiled: a moved group is gone from this
 * worktree's order afterwards, leaving no position to step on from.
 */
export function pickGridSuccessorFocusId(
  state: {
    panelIds: string[];
    panelsById: Record<string, CarrierPanel>;
    getTabGroups?: (
      location: "grid",
      worktreeId?: string
    ) => ReadonlyArray<{ panelIds: string[]; activeTabId: string }>;
  },
  hideIds: readonly string[],
  isUnavailable: (id: string) => boolean = () => false
): string | null {
  const closing = { has: (id: string) => hideIds.includes(id) || isUnavailable(id) };
  const closingWorktreeId = state.panelsById[hideIds[0] ?? ""]?.worktreeId;
  const groups = state.getTabGroups?.("grid", closingWorktreeId);

  if (groups && groups.length > 0) {
    const closedGroupIndex = groups.findIndex((group) =>
      group.panelIds.some((id) => hideIds.includes(id))
    );

    if (closedGroupIndex >= 0) {
      for (let i = closedGroupIndex + 1; i < groups.length; i++) {
        const group = groups[i]!;
        const candidate = firstFocusablePanelInGroup(group.panelIds, group.activeTabId, closing);
        if (candidate) return candidate;
      }
      for (let i = closedGroupIndex - 1; i >= 0; i--) {
        const group = groups[i]!;
        const candidate = firstFocusablePanelInGroup(group.panelIds, group.activeTabId, closing);
        if (candidate) return candidate;
      }
      return null;
    }
  }

  const closedIndexes = hideIds
    .map((id) => state.panelIds.indexOf(id))
    .filter((index) => index >= 0);
  const startIndex = closedIndexes.length > 0 ? Math.max(...closedIndexes) + 1 : 0;

  const isGridSurvivor = (id: string): boolean => {
    if (closing.has(id)) return false;
    const terminal = state.panelsById[id];
    if (!terminal) return false;
    if (terminal.location !== "grid" && terminal.location !== undefined) return false;
    return terminal.worktreeId === closingWorktreeId;
  };

  for (let i = startIndex; i < state.panelIds.length; i++) {
    const id = state.panelIds[i]!;
    if (isGridSurvivor(id)) return id;
  }
  for (let i = startIndex - 2; i >= 0; i--) {
    const id = state.panelIds[i]!;
    if (isGridSurvivor(id)) return id;
  }
  return null;
}
