import React, { useCallback, useMemo, useEffect, useEffectEvent, useRef } from "react";
import { useShallow } from "zustand/react/shallow";
import { usePanelStore, type TerminalInstance } from "@/store";
import { logError } from "@/utils/logger";
import { useAgentSettingsStore } from "@/store/agentSettingsStore";
import { useCcrPresetsStore } from "@/store/ccrPresetsStore";
import { useProjectPresetsStore } from "@/store/projectPresetsStore";
import { getMergedPresets } from "@/config/agents";
import { GridPanel } from "./GridPanel";
import type { TabGroup } from "@/types";
import type { TabInfo } from "@/components/Panel/TabButton";
import { buildPanelDuplicateOptions } from "@/services/terminal/panelDuplicationService";
import { focusPanelInput } from "./terminalFocusRegistry";
import { getGroupAmbientAgentState } from "@/components/Layout/useDockBlockedState";
import { deriveTerminalChrome } from "@/utils/terminalChrome";

export interface GridTabGroupProps {
  group: TabGroup;
  focusedId: string | null;
  gridPanelCount?: number;
  gridCols?: number;
  isMaximized?: boolean;
}

export const GridTabGroup = React.memo(function GridTabGroup({
  group,
  focusedId,
  gridPanelCount,
  gridCols,
  isMaximized = false,
}: GridTabGroupProps) {
  // Subscribe to this group's panels keyed by `group.panelIds`. `useShallow`
  // does element-by-element identity comparison on the resolved array, so
  // updates to unrelated panels don't trigger a re-render here.
  const panels = usePanelStore(
    useShallow((state) =>
      group.panelIds
        .map((id) => state.panelsById[id])
        .filter((p): p is TerminalInstance => p !== undefined)
    )
  );

  const setFocused = usePanelStore((state) => state.setFocused);
  const setActiveTab = usePanelStore((state) => state.setActiveTab);
  const stampLastActive = usePanelStore((state) => state.stampLastActive);
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

  const agentSettings = useAgentSettingsStore((s) => s.settings);
  const ccrPresetsByAgent = useCcrPresetsStore((s) => s.ccrPresetsByAgent);
  const projectPresetsByAgent = useProjectPresetsStore((s) => s.presetsByAgent);

  // Build tabs array for PanelHeader
  const tabs: TabInfo[] = useMemo(() => {
    const dangerousFlags = new Set([
      "--dangerously-skip-permissions",
      "--yolo",
      "--dangerously-bypass-approvals-and-sandbox",
      "--force",
    ]);

    return panels.map((p) => {
      let presetColor = p.agentPresetColor;
      let fallbackTooltip: string | undefined;
      if (p.launchAgentId && p.agentPresetId) {
        const presets = getMergedPresets(
          p.launchAgentId,
          agentSettings?.agents?.[p.launchAgentId]?.customPresets,
          ccrPresetsByAgent[p.launchAgentId],
          projectPresetsByAgent[p.launchAgentId]
        );
        const live = presets.find((f) => f.id === p.agentPresetId);
        if (live) presetColor = live.color ?? presetColor;
        if (p.isUsingFallback && p.originalPresetId) {
          const original = presets.find((f) => f.id === p.originalPresetId);
          const originalName = original?.name ?? p.originalPresetId;
          const activeName = live?.name ?? p.agentPresetId;
          fallbackTooltip = `Using fallback "${activeName}" — "${originalName}" unavailable`;
        }
      }

      const hasDangerousFlags =
        p.agentLaunchFlags?.some((flag) => dangerousFlags.has(flag)) ?? false;

      return {
        id: p.id,
        title: p.title,
        chrome: deriveTerminalChrome({
          kind: p.kind,
          launchAgentId: p.launchAgentId,
          runtimeIdentity: p.runtimeIdentity,
          detectedAgentId: p.detectedAgentId,
          detectedProcessId: p.detectedProcessId,
          agentState: p.agentState,
          runtimeStatus: p.runtimeStatus,
          exitCode: p.exitCode,
          presetColor,
        }),
        kind: p.kind ?? "terminal",
        agentState: p.agentState,
        isActive: p.id === activeTabId,
        presetColor,
        isUsingFallback: p.isUsingFallback,
        fallbackTooltip,
        hasDangerousFlags,
      };
    });
  }, [panels, activeTabId, agentSettings, ccrPresetsByAgent, projectPresetsByAgent]);

  // Check if this group is currently focused
  const isGroupFocused = useMemo(() => panels.some((p) => p.id === focusedId), [panels, focusedId]);

  // Compute highest-urgency agent state across all tabs so the group container
  // reflects blocked/working state even when the blocking tab is not active.
  const groupAmbientState = useMemo(() => getGroupAmbientAgentState(panels), [panels]);

  // Restore focus to the destination tab when switching tabs within a focused
  // group. The registry handler routes to either xterm or the hybrid input
  // depending on the user's current `preferredTerminalFocusTarget`, so tab
  // switching no longer forces input focus when the user has chosen xterm.
  // The existing TerminalPane focus effect uses double-rAF which races with
  // HybridInputBar's CodeMirror editor reinitialization on terminalId change.
  const prevActiveTabIdRef = useRef(activeTabId);
  const panelIdsRef = useRef<Set<string>>(new Set(panels.map((p) => p.id)));
  useEffect(() => {
    panelIdsRef.current = new Set(panels.map((p) => p.id));
  }, [panels]);

  // isGroupFocused is read non-reactively — we only want to re-run when
  // activeTabId changes, not when focus flickers.
  const maybeScheduleFocus = useEffectEvent(() => {
    if (prevActiveTabIdRef.current === activeTabId) return null;
    prevActiveTabIdRef.current = activeTabId;
    if (!activeTabId || !isGroupFocused) return null;
    return requestAnimationFrame(() => {
      const currentFocusedId = usePanelStore.getState().focusedId;
      if (!currentFocusedId || !panelIdsRef.current.has(currentFocusedId)) return;
      focusPanelInput(activeTabId);
    });
  });
  useEffect(() => {
    void activeTabId;
    const rafId = maybeScheduleFocus();
    if (rafId == null) return;
    return () => cancelAnimationFrame(rafId);
  }, [activeTabId]);

  // Handle tab click - switch to that tab, only focus if group already focused
  const handleTabClick = useCallback(
    (tabId: string) => {
      setActiveTab(group.id, tabId);
      // Only set focus if the group is already focused
      // This prevents single-click from activating focus/maximize mode
      if (isGroupFocused) {
        setFocused(tabId);
      } else {
        // The focus path stamps lastActiveAt via setFocused. When the group is
        // unfocused, tab-switching is still user intent to view this panel —
        // stamp explicitly so the restore predicate (issue #8703) sees the
        // last-clicked tab as the worktree's recent panel even if the user
        // quits before clicking the body to claim focus.
        stampLastActive(tabId);
      }
      // If this group is maximized, update maximizedId to the new tab
      // so "Restore" (maximize toggle) works correctly
      if (isMaximized) {
        setMaximizedId(tabId);
      }
    },
    [
      group.id,
      setActiveTab,
      setFocused,
      stampLastActive,
      isGroupFocused,
      isMaximized,
      setMaximizedId,
    ]
  );

  // Handle tab rename
  const handleTabRename = useCallback(
    (tabId: string, newTitle: string) => {
      updateTitle(tabId, newTitle);
    },
    [updateTitle]
  );

  const handleTabClose = useCallback(
    (tabId: string) => {
      if (tabId === activeTabId) {
        const currentIndex = panels.findIndex((p) => p.id === tabId);
        const nextPanel = panels[currentIndex + 1] ?? panels[currentIndex - 1];
        if (nextPanel) {
          setActiveTab(group.id, nextPanel.id);
          setFocused(nextPanel.id);
        }
      }
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
      logError("Failed to add tab", error);
    }
  }, [activePanel, group.id, addPanel, addPanelToGroup, setActiveTab, setFocused]);

  if (!activePanel) {
    return null;
  }

  const isFocused = activePanel.id === focusedId;

  return (
    <GridPanel
      terminalId={activePanel.id}
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
});
