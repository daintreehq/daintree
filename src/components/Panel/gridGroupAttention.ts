import { createContext, useContext } from "react";
import type { AgentState } from "@shared/types/agent";

/**
 * What a grid tab group's hidden tabs say about the group, for the edge of the
 * tab it shows. A context rather than a prop so the shown pane draws it
 * whatever its kind: a pane that renders `ContentPanel` with its own prop list
 * never has to remember to forward it.
 */
export interface GridGroupAttention {
  /** The tab the group shows, whose `ContentPanel` draws the edge. */
  panelId: string;
  /** Waiting for a hidden tab's unseen ask, working for any tab at work. */
  ambientAgentState: AgentState | undefined;
  /** A hidden tab shows a failure the user hasn't had in front of them. */
  hiddenTabFailed: boolean;
}

export const GridGroupAttentionContext = createContext<GridGroupAttention | null>(null);

/**
 * The group attention for this panel's own edge: only the shown tab's grid
 * panel takes it, so a nested or portalled panel never inherits it.
 */
export function useGridGroupAttention(
  panelId: string,
  location: "grid" | "dock" | "dialog"
): GridGroupAttention | null {
  const attention = useContext(GridGroupAttentionContext);
  if (location !== "grid" || attention?.panelId !== panelId) return null;
  return attention;
}
