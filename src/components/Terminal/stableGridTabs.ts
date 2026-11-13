import { useMemo, useState } from "react";
import { shallow } from "zustand/shallow";
import type { TabInfo } from "@/components/Panel/TabButton";

function isSameTab(a: TabInfo, b: TabInfo): boolean {
  const { chrome: aChrome, ...aRest } = a;
  const { chrome: bChrome, ...bRest } = b;
  return shallow(aChrome, bChrome) && shallow(aRest, bRest);
}

/**
 * `next` with every tab that draws the same as one in `previous` swapped for
 * that earlier object, and `previous` itself when nothing a tab draws changed.
 * It compares the built tabs, not the panel fields behind them, so a field a
 * tab starts drawing can never be missed; a nested field added to `TabInfo`
 * compares by identity, which costs renders, never staleness.
 */
export function reconcileGridTabs(previous: TabInfo[], next: TabInfo[]): TabInfo[] {
  if (previous === next) return previous;
  const previousById = new Map(previous.map((tab) => [tab.id, tab]));
  let unchanged = previous.length === next.length;
  const reconciled = next.map((tab, index) => {
    const prior = previousById.get(tab.id);
    const kept = prior !== undefined && isSameTab(prior, tab) ? prior : tab;
    if (kept !== previous[index]) unchanged = false;
    return kept;
  });
  return unchanged ? previous : reconciled;
}

/**
 * The group's tabs, keeping their identity until something a tab draws
 * changes. A background tab rewrites its panel every frame it streams status
 * no tab shows; without this, each write rebuilds the strip and re-renders the
 * pane in front of it (#16801). The last tabs live in state, adjusted during
 * render, so React rather than a ref owns them and a render it throws away
 * leaves them untouched.
 */
export function useStableGridTabs(built: TabInfo[]): TabInfo[] {
  const [previous, setPrevious] = useState(built);
  const tabs = useMemo(() => reconcileGridTabs(previous, built), [previous, built]);
  if (tabs !== previous) setPrevious(tabs);
  return tabs;
}
