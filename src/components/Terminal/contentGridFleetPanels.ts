import type { TerminalInstance } from "@/store";

// Single source of truth for the ordered, grid-renderable fleet panel set.
// Keeping this pure and shared prevents the navigation model in
// useGridNavigation from drifting from ContentGrid's render output — that
// drift is the root cause of #5989 (focus model built from a different
// source than the cells on screen).
export function buildFleetPanels(
  armOrder: readonly string[],
  armedIds: ReadonlySet<string>,
  panelsById: Record<string, TerminalInstance>
): TerminalInstance[] {
  const result: TerminalInstance[] = [];
  for (const id of armOrder) {
    if (!armedIds.has(id)) continue;
    const t = panelsById[id];
    if (!t) continue;
    if (t.location === "trash" || t.location === "background" || t.location === "dock") continue;
    result.push(t);
  }
  return result;
}
