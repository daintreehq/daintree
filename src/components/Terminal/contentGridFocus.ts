import type { PanelInstance } from "@shared/types/panel";

interface MaximizedGroupFocusArgs {
  focusedId: string | null;
  groupId: string;
  groupPanels: PanelInstance[];
  getActiveTabId: (groupId: string) => string | null;
}

export function getMaximizedGroupFocusTarget({
  focusedId,
  groupId,
  groupPanels,
  getActiveTabId,
}: MaximizedGroupFocusArgs): string | null {
  if (groupPanels.length === 0) {
    return null;
  }

  if (focusedId && groupPanels.some((panel) => panel.id === focusedId)) {
    return focusedId;
  }

  const activeTabId = getActiveTabId(groupId);
  return groupPanels.find((panel) => panel.id === activeTabId)?.id ?? groupPanels[0]!.id;
}
