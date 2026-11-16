import { useMemo, useState } from "react";
import { usePanelStore } from "@/store";
import type { PanelInstance } from "@shared/types/panel";
import { getRenderablePanel } from "@/store/slices/panelRegistry/selectors";

/**
 * Panel fields the store keeps for its own bookkeeping, which nothing the grid
 * renders reads off the panel object. A backpressure pause and resume landing
 * in one frame moves only `flowStatusTimestamp`, the held-duration gauge ticks
 * every 2s while paused, and a host confirming a state already on screen moves
 * only `lastAgentObservation`; each replaces the panel object, and without this
 * each re-rendered the grid cell and the pane inside it (#17052).
 *
 * A panel the grid holds may carry stale values for these fields, so a grid
 * render must never read them. Anything that needs one subscribes to it on its
 * own, as `TerminalStatusSlot` does for `heldDurationMs`.
 */
const BOOKKEEPING_FIELDS: ReadonlySet<string> = new Set([
  "flowStatusTimestamp",
  "heldDurationMs",
  "lastAgentObservation",
]);

/**
 * Whether `a` and `b` draw the same: every own field but the bookkeeping ones
 * is present in both and `Object.is`-equal. A field added to panels later
 * counts by default, so this costs renders, never staleness.
 */
export function isSameRenderedPanel<T extends object>(a: T, b: T): boolean {
  if (a === b) return true;
  let aCount = 0;
  for (const key in a) {
    if (!Object.hasOwn(a, key) || BOOKKEEPING_FIELDS.has(key)) continue;
    if (!Object.hasOwn(b, key) || !Object.is(a[key], b[key])) return false;
    aCount++;
  }
  let bCount = 0;
  for (const key in b) {
    if (Object.hasOwn(b, key) && !BOOKKEEPING_FIELDS.has(key)) bCount++;
  }
  return aCount === bCount;
}

type PanelSelector<T> = (state: { panelsById: Record<string, PanelInstance> }) => T;

/**
 * A selector for one panel that keeps returning the panel it last returned
 * while only bookkeeping fields change. Each subscription needs its own: the
 * cache is the previous result.
 */
export function createGridPanelSelector(id: string): PanelSelector<PanelInstance | undefined> {
  let previous: PanelInstance | undefined;
  return (state) => {
    const next = state.panelsById[id];
    if (previous !== undefined && next !== undefined && isSameRenderedPanel(previous, next)) {
      return previous;
    }
    previous = next;
    return next;
  };
}

/**
 * A selector for a tab group's render-eligible panels, in group order, that
 * keeps returning the array it last returned while only bookkeeping fields
 * change, and reuses each unchanged panel when something else does.
 */
export function createGridGroupPanelsSelector(
  panelIds: readonly string[]
): PanelSelector<PanelInstance[]> {
  let previous: PanelInstance[] | undefined;
  return (state) => {
    const previousById = previous ? new Map(previous.map((p) => [p.id, p])) : undefined;
    let unchanged = previous !== undefined;
    const next: PanelInstance[] = [];
    for (const id of panelIds) {
      // Render-eligibility, not type-narrowing: a tab group may hold a
      // plugin-contributed panel, which must stay in the rendered set (#10512).
      const panel = getRenderablePanel(state.panelsById, id);
      if (!panel) continue;
      const prior = previousById?.get(id);
      const kept = prior !== undefined && isSameRenderedPanel(prior, panel) ? prior : panel;
      if (kept !== previous?.[next.length]) unchanged = false;
      next.push(kept);
    }
    if (unchanged && previous !== undefined && previous.length === next.length) return previous;
    previous = next;
    return next;
  };
}

/** The panel a grid cell renders, steady through bookkeeping-only writes. */
export function useGridPanel(id: string): PanelInstance | undefined {
  const selector = useMemo(() => createGridPanelSelector(id), [id]);
  return usePanelStore(selector);
}

function isSameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

/** A tab group's panels, steady through bookkeeping-only writes. */
export function useGridGroupPanels(panelIds: readonly string[]): PanelInstance[] {
  // Keyed on the ids, not the array: the group object, and with it the array,
  // is rebuilt on every active-tab switch, and a new selector starts with no
  // previous result to hold on to. Adjusted during render, as `useStableGridTabs`
  // does, so React owns the kept ids.
  const [ids, setIds] = useState(panelIds);
  if (ids !== panelIds && !isSameIds(ids, panelIds)) setIds(panelIds);
  const selector = useMemo(() => createGridGroupPanelsSelector(ids), [ids]);
  return usePanelStore(selector);
}
