import type { DockPanelData, PtyPanelData } from "@shared/types/panel";
import type { TabGroup } from "@/types";

export interface DockRenderItem {
  group: TabGroup;
  panels: DockPanelData[];
}

export function buildDockRenderItems(
  tabGroups: TabGroup[],
  // Tab groups stay PTY-only — every dockable non-PTY kind (file, browser and
  // plugin view panels — #11332) docks as a standalone chip.
  resolvePanels: (groupId: string) => PtyPanelData[],
  excludedPanelId?: string | null,
  dockTerminals: DockPanelData[] = []
): DockRenderItem[] {
  const renderedPanelIds = new Set<string>();
  const items: DockRenderItem[] = tabGroups.flatMap((group) => {
    const panels = resolvePanels(group.id).filter((panel) => panel.id !== excludedPanelId);
    if (panels.length === 0) return [];

    const panelIdSet = new Set(panels.map((panel) => panel.id));
    const panelIds = group.panelIds.filter((id) => panelIdSet.has(id));
    if (panelIds.length === 0) return [];
    panelIds.forEach((id) => renderedPanelIds.add(id));

    return [
      {
        group: {
          ...group,
          panelIds,
          activeTabId: panelIds.includes(group.activeTabId)
            ? group.activeTabId
            : (panelIds[0] ?? ""),
        },
        panels,
      },
    ];
  });

  for (const panel of dockTerminals) {
    if (panel.id === excludedPanelId) continue;
    if (renderedPanelIds.has(panel.id)) continue;
    items.push({
      group: {
        id: panel.id,
        location: "dock",
        worktreeId: panel.worktreeId,
        activeTabId: panel.id,
        panelIds: [panel.id],
      },
      panels: [panel],
    });
  }

  return items;
}
