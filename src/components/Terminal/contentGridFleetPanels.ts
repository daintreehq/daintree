import { getNarrowPanel } from "@/store/slices/panelRegistry/selectors";
import type { PanelInstance } from "@shared/types/panel";

type CarrierPanel = Parameters<typeof getNarrowPanel>[0][string];

// Single source of truth for the ordered, grid-renderable fleet panel set.
// Keeping this pure and shared prevents the navigation model in
// useGridNavigation from drifting from ContentGrid's render output — that
// drift is the root cause of #5989 (focus model built from a different
// source than the cells on screen).
export function buildFleetPanels(
  armOrder: readonly string[],
  armedIds: ReadonlySet<string>,
  panelsById: Record<string, CarrierPanel>
): PanelInstance[] {
  const result: PanelInstance[] = [];
  for (const id of armOrder) {
    if (!armedIds.has(id)) continue;
    const t = panelsById[id];
    if (!t) continue;
    if (t.location === "trash" || t.location === "background" || t.location === "dock") continue;
    const narrowed = getNarrowPanel(panelsById, id);
    if (!narrowed) continue;
    result.push(narrowed);
  }
  return result;
}
