import { useCallback, useMemo, useEffect } from "react";
import { useTerminalStore, type TerminalInstance } from "@/store";
import { GridPanel } from "./GridPanel";
import type { TabGroup } from "@/types";
import type { TabInfo } from "@/components/Panel/TabButton";
import { buildPanelDuplicateOptions } from "@/services/terminal/panelDuplicationService";

export interface GridTabGroupProps {
  group: TabGroup;
  panels: TerminalInstance[];
  focusedId: string | null;
  gridPanelCount?: number;
  gridCols?: number;
  isMaximized?: boolean;
}

export function GridTabGroup({
  group,
  panels,
  focusedId,
  gridPanelCount,
  gridCols,
  isMaximized = false,
}: GridTabGroupProps) {
  const setFocused = useTerminalStore((state) => state.setFocused);
  const setActiveTab = useTerminalStore((state) => state.setActiveTab);
  const setMaximizedId = useTerminalStore((state) => state.setMaximizedId);
  const trashTerminal = useTerminalStore((state) => state.trashTerminal);
  const addTerminal = useTerminalStore((state) => state.addTerminal);
  const addPanelToGroup = useTerminalStore((state) => state.addPanelToGroup);
  const reorderPanelsInGroup = useTerminalStore((state) => state.reorderPanelsInGroup);
  const updateTitle = useTerminalStore((state) => state.updateTitle);

  // Subscribe to activeTabByGroup for reactive updates
  const storedActiveTabId = useTerminalStore(
    (state) => state.activeTabByGroup.get(group.id) ?? null
  );

  // Reconcile active tab - ensure it's valid and in this group
  const activeTabId = useMemo(() => {
    // If stored ID is valid and in this group, use it
    if (storedActiveTabId && panels.some((p) => p.id === storedActiveTabId)) {
      return storedActiveTabId;
    }
    // If focused panel is in this group, prefer it
    if (focusedId && panels.some((p) => p.id === focusedId)) {
      return focusedId;
    }
    // Default to first panel
    return panels[0]?.id ?? "";
  }, [storedActiveTabId, focusedId, panels]);

  // Sync active tab when it changes
  useEffect(() => {
    if (activeTabId && activeTabId !== storedActiveTabId) {
      setActiveTab(group.id, activeTabId);
    }
  }, [activeTabId, storedActiveTabId, group.id, setActiveTab]);

  // Find the active panel to render
  const activePanel = useMemo(() => {
    return panels.find((p) => p.id === activeTabId) ?? panels[0];
  }, [panels, activeTabId]);

  // Build tabs array for PanelHeader
  const tabs: TabInfo[] = useMemo(() => {
    return panels.map((p) => ({
      id: p.id,
      title: p.title,
      type: p.type,
      agentId: p.agentId,
      detectedProcessId: p.detectedProcessId,
      kind: p.kind ?? "terminal",
      agentState: p.agentState,
      isActive: p.id === activeTabId,
    }));
  }, [panels, activeTabId]);

  // Check if this group is currently focused
  const isGroupFocused = panels.some((p) => p.id === focusedId);

  // Handle tab click - switch to that tab, only focus if group already focused
  const handleTabClick = useCallback(
    (tabId: string) => {
      setActiveTab(group.id, tabId);
      // Only set focus if the group is already focused
      // This prevents single-click from activating focus/maximize mode
      if (isGroupFocused) {
        setFocused(tabId);
      }
      // If this group is maximized, update maximizedId to the new tab
      // so "Exit Focus" works correctly
      if (isMaximized) {
        setMaximizedId(tabId);
      }
    },
    [group.id, setActiveTab, setFocused, isGroupFocused, isMaximized, setMaximizedId]
  );

  // Handle tab rename
  const handleTabRename = useCallback(
    (tabId: string, newTitle: string) => {
      updateTitle(tabId, newTitle);
    },
    [updateTitle]
  );

  // Handle tab close - move to trash (store handles group cleanup)
  const handleTabClose = useCallback(
    (tabId: string) => {
      // If closing the active tab, switch to another tab first
      if (tabId === activeTabId) {
        const currentIndex = panels.findIndex((p) => p.id === tabId);
        const nextPanel = panels[currentIndex + 1] ?? panels[currentIndex - 1];
        if (nextPanel) {
          setActiveTab(group.id, nextPanel.id);
          setFocused(nextPanel.id);
        }
      }
      // Trash the terminal (store auto-removes from group)
      trashTerminal(tabId);
    },
    [activeTabId, panels, group.id, setActiveTab, setFocused, trashTerminal]
  );

  // Handle tab reorder - update group panel order
  const handleTabReorder = useCallback(
    (newOrder: string[]) => {
      reorderPanelsInGroup(group.id, newOrder);
    },
    [group.id, reorderPanelsInGroup]
  );

  // Handle add tab - duplicate the current panel as a new tab
  const handleAddTab = useCallback(async () => {
    if (!activePanel) return;

    try {
      const options = await buildPanelDuplicateOptions(activePanel, "grid");
      const newPanelId = await addTerminal(options);

      addPanelToGroup(group.id, newPanelId);
      setActiveTab(group.id, newPanelId);
      setFocused(newPanelId);
    } catch (error) {
      console.error("Failed to add tab:", error);
    }
  }, [activePanel, group.id, addTerminal, addPanelToGroup, setActiveTab, setFocused]);

  if (!activePanel) {
    return null;
  }

  const isFocused = activePanel.id === focusedId;

  return (
    <GridPanel
      terminal={activePanel}
      isFocused={isFocused}
      isMaximized={isMaximized}
      gridPanelCount={gridPanelCount}
      gridCols={gridCols}
      tabs={tabs}
      groupId={group.id}
      onTabClick={handleTabClick}
      onTabClose={handleTabClose}
      onTabRename={handleTabRename}
      onAddTab={handleAddTab}
      onTabReorder={handleTabReorder}
    />
  );
}
