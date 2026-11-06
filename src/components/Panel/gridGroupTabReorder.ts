import { createContext, useContext } from "react";

/**
 * How a grid tab group's strip reorders its tabs. A context rather than a prop
 * so the shown pane's strip is sortable whatever its kind: a pane that renders
 * `ContentPanel` with its own prop list never has to remember to forward it.
 */
export interface GridGroupTabReorder {
  /** The tab the group shows, whose `ContentPanel` draws the strip. */
  panelId: string;
  groupId: string;
  onTabReorder: (newOrder: string[]) => void;
}

export const GridGroupTabReorderContext = createContext<GridGroupTabReorder | null>(null);

/**
 * The group reorder for this panel's own strip: only the shown tab's grid
 * panel takes it, so a nested or portalled panel never inherits it.
 */
export function useGridGroupTabReorder(
  panelId: string,
  location: "grid" | "dock" | "dialog"
): GridGroupTabReorder | null {
  const reorder = useContext(GridGroupTabReorderContext);
  if (location !== "grid" || reorder?.panelId !== panelId) return null;
  return reorder;
}
