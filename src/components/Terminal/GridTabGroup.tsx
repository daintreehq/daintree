import React, { useCallback, useMemo, useEffect, useRef } from "react";
import { usePanelStore, type TerminalInstance } from "@/store";
import { GridPanel } from "./GridPanel";
import type { TabGroup } from "@/types";
import type { TabInfo } from "@/components/Panel/TabButton";
import { buildPanelDuplicateOptions } from "@/services/terminal/panelDuplicationService";
import { focusPanelInput } from "./terminalFocusRegistry";
import { getGroupAmbientAgentState } from "@/components/Layout/useDockBlockedState";

export interface GridTabGroupProps {
  group: TabGroup;
  panels: TerminalInstance[];
  focusedId: string | null;
  gridPanelCount?: number;
  gridCols?: number;
  isMaximized?: boolean;
}

/**
 * Custom comparator for GridTabGroup's React.memo wrapper.
 *
 * Compares panel rendering fields used by the tabs useMemo, isGroupFocused,
 * and getGroupAmbientAgentState. Skips callback props (none on this component).
 * The group.activeTabId is NOT compared because the component subscribes to it
 * via Zustand store selector instead.
 */
export function gridTabGroupPropsAreEqual(
  prev: GridTabGroupProps,
  next: GridTabGroupProps
): boolean {
  // Scalar props
  if (
    prev.focusedId !== next.focusedId ||
    prev.gridPanelCount !== next.gridPanelCount ||
    prev.gridCols !== next.gridCols ||
    prev.isMaximized !== next.isMaximized
  ) {
    return false;
  }

  // Group: fast-path reference check, then field-level
  if (prev.group !== next.group) {
    const a = prev.group;
    const b = next.group;
    if (a.id !== b.id || a.location !== b.location || a.worktreeId !== b.worktreeId) {
      return false;
    }
    // Compare panelIds (ordered)
    if (a.panelIds.length !== b.panelIds.length) return false;
    for (let i = 0; i < a.panelIds.length; i++) {
      if (a.panelIds[i] !== b.panelIds[i]) return false;
    }
  }

  // Panels: compare length, then element-by-element on all render-relevant fields.
  // Must include the full set that GridPanel/buildPanelProps uses, not just tab-label
  // fields, because the active panel is passed as `terminal` to GridPanel.
  const prevPanels = prev.panels;
  const nextPanels = next.panels;
  if (prevPanels !== nextPanels) {
    if (prevPanels.length !== nextPanels.length) return false;
    for (let i = 0; i < prevPanels.length; i++) {
      const a = prevPanels[i];
      const b = nextPanels[i];
      if (a !== b) {
        if (
          a.id !== b.id ||
          a.title !== b.title ||
          a.worktreeId !== b.worktreeId ||
          a.kind !== b.kind ||
          a.type !== b.type ||
          a.agentId !== b.agentId ||
          a.cwd !== b.cwd ||
          a.agentState !== b.agentState ||
          a.activityHeadline !== b.activityHeadline ||
          a.activityStatus !== b.activityStatus ||
          a.activityType !== b.activityType ||
          a.lastCommand !== b.lastCommand ||
          a.flowStatus !== b.flowStatus ||
          a.restartKey !== b.restartKey ||
          a.restartError !== b.restartError ||
          a.reconnectError !== b.reconnectError ||
          a.spawnError !== b.spawnError ||
          a.detectedProcessId !== b.detectedProcessId ||
          a.browserUrl !== b.browserUrl ||
          a.notePath !== b.notePath ||
          a.noteId !== b.noteId ||
          a.scope !== b.scope ||
          a.createdAt !== b.createdAt ||
          a.isRestarting !== b.isRestarting ||
          a.runtimeStatus !== b.runtimeStatus ||
          a.isInputLocked !== b.isInputLocked
        ) {
          return false;
        }
      }
    }
  }

  return true;
}

export const GridTabGroup = React.memo(function GridTabGroup({
  group,
  panels,
  focusedId,
  gridPanelCount,
  gridCols,
  isMaximized = false,
}: GridTabGroupProps) {
  const setFocused = usePanelStore((state) => state.setFocused);
  const setActiveTab = usePanelStore((state) => state.setActiveTab);
  const setMaximizedId = usePanelStore((state) => state.setMaximizedId);
  const trashPanel = usePanelStore((state) => state.trashPanel);
  const addPanel = usePanelStore((state) => state.addPanel);
  const addPanelToGroup = usePanelStore((state) => state.addPanelToGroup);
  const reorderPanelsInGroup = usePanelStore((state) => state.reorderPanelsInGroup);
  const updateTitle = usePanelStore((state) => state.updateTitle);

  // Subscribe to registry's active tab for reactive updates
  const storedActiveTabId = usePanelStore(
    (state) => state.tabGroups.get(group.id)?.activeTabId ?? null
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
  const isGroupFocused = useMemo(() => panels.some((p) => p.id === focusedId), [panels, focusedId]);

  // Compute highest-urgency agent state across all tabs so the group container
  // reflects blocked/working state even when the blocking tab is not active.
  const groupAmbientState = useMemo(() => getGroupAmbientAgentState(panels), [panels]);

  // Restore focus to the hybrid input bar when switching tabs within a focused group.
  // The existing TerminalPane focus effect uses double-rAF which races with
  // HybridInputBar's CodeMirror editor reinitialization on terminalId change.
  const prevActiveTabIdRef = useRef(activeTabId);
  const panelIdsRef = useRef<Set<string>>(new Set(panels.map((p) => p.id)));
  useEffect(() => {
    panelIdsRef.current = new Set(panels.map((p) => p.id));
  }, [panels]);

  useEffect(() => {
    if (prevActiveTabIdRef.current === activeTabId) return;
    prevActiveTabIdRef.current = activeTabId;
    if (!activeTabId || !isGroupFocused) return;
    const rafId = requestAnimationFrame(() => {
      const currentFocusedId = usePanelStore.getState().focusedId;
      if (!currentFocusedId || !panelIdsRef.current.has(currentFocusedId)) return;
      focusPanelInput(activeTabId);
    });
    return () => cancelAnimationFrame(rafId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTabId]);

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
      trashPanel(tabId);
    },
    [activeTabId, panels, group.id, setActiveTab, setFocused, trashPanel]
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
      const newPanelId = await addPanel(options);
      if (!newPanelId) return;

      addPanelToGroup(group.id, newPanelId);
      setActiveTab(group.id, newPanelId);
      setFocused(newPanelId);
    } catch (error) {
      console.error("Failed to add tab:", error);
    }
  }, [activePanel, group.id, addPanel, addPanelToGroup, setActiveTab, setFocused]);

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
      ambientAgentState={groupAmbientState}
      tabs={tabs}
      groupId={group.id}
      onTabClick={handleTabClick}
      onTabClose={handleTabClose}
      onTabRename={handleTabRename}
      onAddTab={handleAddTab}
      onTabReorder={handleTabReorder}
    />
  );
}, gridTabGroupPropsAreEqual);
