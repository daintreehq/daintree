import type { PanelInstance } from "@shared/types/panel";
import { focusPanelInput } from "@/components/Panel/panelFocusRegistry";
import { useMacroFocusStore } from "@/store/macroFocusStore";

/**
 * Hand the grid's macro focus down into the focused panel, whatever its kind.
 *
 * The macro region is released only once a live target has actually taken
 * focus. A panel whose focus target is not mounted (lazy view still loading,
 * terminal with no opened xterm) declines the handoff, and keeping the region
 * armed is what stops Enter from stranding the user: DOM focus would still sit
 * on the grid region, but with `focusedRegion` cleared the arrow keys would no
 * longer be handled and the grid would go dead.
 */
export function enterFocusedPanel(focusedId: string | null): boolean {
  if (!focusedId) return false;
  if (!focusPanelInput(focusedId)) return false;
  useMacroFocusStore.getState().clearFocus();
  return true;
}

interface MaximizedGroupFocusArgs {
  focusedId: string | null;
  groupId: string;
  groupPanels: PanelInstance[];
  getActiveTabId: (groupId: string) => string | null;
  /**
   * The dock terminal whose popover is genuinely on screen, or `null`. This is
   * NOT the raw `activeDockTerminalId` — that pointer outlives the popover it
   * names (see `isDockPanelRendered`), and trusting it here would strand focus
   * on a panel the dock no longer renders.
   */
  openDockPopoverId: string | null;
}

/**
 * Resolves which group panel should hold focus while the group is maximized, or
 * `null` when no enforcement is warranted. Callers treat `null` as "leave focus
 * alone".
 */
export function getMaximizedGroupFocusTarget({
  focusedId,
  groupId,
  groupPanels,
  getActiveTabId,
  openDockPopoverId,
}: MaximizedGroupFocusArgs): string | null {
  if (groupPanels.length === 0) {
    return null;
  }

  if (focusedId && groupPanels.some((panel) => panel.id === focusedId)) {
    return focusedId;
  }

  // Focus sits on the terminal whose dock popover is open, so it is live and
  // deliberate — not the stale persisted focus this fallback exists to rescue.
  // Enforcing a group panel here would clear `activeDockTerminalId` via
  // `setFocused` and slam the popover shut (#11065). Compare against `null`
  // rather than truthiness: both ids are `null` when focus is nowhere and no
  // popover is open, and that case must still fall through to the rescue below.
  if (focusedId !== null && focusedId === openDockPopoverId) {
    return null;
  }

  const activeTabId = getActiveTabId(groupId);
  return groupPanels.find((panel) => panel.id === activeTabId)?.id ?? groupPanels[0]!.id;
}
