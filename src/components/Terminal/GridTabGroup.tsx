import { useCallback, useMemo, useEffect } from "react";
import { useTerminalStore, type TerminalInstance } from "@/store";
import { GridPanel } from "./GridPanel";
import type { TabGroup } from "@/types";
import type { TabInfo } from "@/components/Panel/TabButton";
import { generateAgentCommand } from "@shared/types";
import { getAgentConfig, isRegisteredAgent } from "@/config/agents";
import { agentSettingsClient } from "@/clients";

export interface GridTabGroupProps {
  group: TabGroup;
  panels: TerminalInstance[];
  focusedId: string | null;
  gridPanelCount?: number;
  gridCols?: number;
}

export function GridTabGroup({
  group,
  panels,
  focusedId,
  gridPanelCount,
  gridCols,
}: GridTabGroupProps) {
  const setFocused = useTerminalStore((state) => state.setFocused);
  const setActiveTab = useTerminalStore((state) => state.setActiveTab);
  const trashTerminal = useTerminalStore((state) => state.trashTerminal);
  const removePanelFromGroup = useTerminalStore((state) => state.removePanelFromGroup);
  const addTerminal = useTerminalStore((state) => state.addTerminal);
  const addPanelToGroup = useTerminalStore((state) => state.addPanelToGroup);
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
    },
    [group.id, setActiveTab, setFocused, isGroupFocused]
  );

  // Handle tab rename
  const handleTabRename = useCallback(
    (tabId: string, newTitle: string) => {
      updateTitle(tabId, newTitle);
    },
    [updateTitle]
  );

  // Handle tab close - move to trash and remove from group
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
      // Remove from group (this will auto-delete group if ≤1 panels remain)
      removePanelFromGroup(tabId);
      // Then trash the terminal
      trashTerminal(tabId);
    },
    [activeTabId, panels, group.id, setActiveTab, setFocused, removePanelFromGroup, trashTerminal]
  );

  // Handle add tab - duplicate the current panel as a new tab
  const handleAddTab = useCallback(async () => {
    if (!activePanel) return;

    const kind = activePanel.kind ?? "terminal";

    try {
      // For agents, generate the command
      let command: string | undefined;
      if (activePanel.agentId && isRegisteredAgent(activePanel.agentId)) {
        const agentConfig = getAgentConfig(activePanel.agentId);
        if (agentConfig) {
          try {
            const agentSettings = await agentSettingsClient.get();
            const entry = agentSettings?.agents?.[activePanel.agentId] ?? {};
            command = generateAgentCommand(agentConfig.command, entry, activePanel.agentId, {
              interactive: true,
            });
          } catch (error) {
            console.warn("Failed to get agent settings, using existing command:", error);
            command = activePanel.command;
          }
        } else {
          command = activePanel.command;
        }
      } else {
        command = activePanel.command;
      }

      // Create new panel without tab group info (will be added to group separately)
      const baseOptions = {
        kind,
        type: activePanel.type,
        agentId: activePanel.agentId,
        cwd: activePanel.cwd || "",
        worktreeId: activePanel.worktreeId,
        location: activePanel.location ?? "grid",
        exitBehavior: activePanel.exitBehavior,
        isInputLocked: activePanel.isInputLocked,
        command,
      };

      let kindSpecificOptions = {};
      if (kind === "browser") {
        kindSpecificOptions = { browserUrl: activePanel.browserUrl };
      } else if (kind === "notes") {
        kindSpecificOptions = {
          notePath: (activePanel as any).notePath,
          noteId: (activePanel as any).noteId,
          scope: (activePanel as any).scope,
          createdAt: Date.now(),
        };
      } else if (kind === "dev-preview") {
        kindSpecificOptions = {
          devCommand: (activePanel as any).devCommand,
          browserUrl: activePanel.browserUrl,
        };
      }

      const newPanelId = await addTerminal({
        ...baseOptions,
        ...kindSpecificOptions,
      });

      // Add the new panel to this group
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
      gridPanelCount={gridPanelCount}
      gridCols={gridCols}
      tabs={tabs}
      onTabClick={handleTabClick}
      onTabClose={handleTabClose}
      onTabRename={handleTabRename}
      onAddTab={handleAddTab}
    />
  );
}
