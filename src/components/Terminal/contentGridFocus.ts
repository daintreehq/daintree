import type { PanelInstance } from "@shared/types/panel";

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
