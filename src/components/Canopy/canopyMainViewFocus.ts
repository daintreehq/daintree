import { usePanelStore } from "@/store/panelStore";
import { isAgentTerminal } from "@/utils/terminalType";

/**
 * The agent terminal the main view has focused. `focusedId` is trusted as the
 * pane the main view shows: keeping it there is the panel store's job across
 * every way the grid renders (maximized, tab groups, fleet scope, the dock),
 * and Canopy only selects the row, never moving focus, so re-deriving what is
 * on screen here would only drift from it.
 */
export function mainViewFocusedAgentId(): string | null {
  const { focusedId, panelsById } = usePanelStore.getState();
  const panel = focusedId === null ? undefined : panelsById[focusedId];
  if (!panel || panel.location === "trash" || panel.location === "background") return null;
  return isAgentTerminal(panel) ? panel.id : null;
}
