import type { PanelInstance } from "@shared/types/panel";

interface MaximizedGroupFocusArgs {
  focusedId: string | null;
  groupId: string;
  groupPanels: PanelInstance[];
  getActiveTabId: (groupId: string) => string | null;
  activeDockTerminalId: string | null;
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
  activeDockTerminalId,
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
  // `setFocused` and slam the popover shut (#11065). The truthy `focusedId`
  // guard matters: both ids are `null` when focus is nowhere and no popover is
  // open, and that case must still fall through to the rescue below.
  if (focusedId && focusedId === activeDockTerminalId) {
    return null;
  }

  const activeTabId = getActiveTabId(groupId);
  return groupPanels.find((panel) => panel.id === activeTabId)?.id ?? groupPanels[0]!.id;
}
