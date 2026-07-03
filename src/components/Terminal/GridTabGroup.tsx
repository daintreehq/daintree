import React, { useCallback, useMemo, useEffect, useEffectEvent, useRef } from "react";
import { useShallow } from "zustand/react/shallow";
import { usePanelStore } from "@/store";
import { getRenderablePanel } from "@/store/slices/panelRegistry/selectors";
import { isBuiltInPanelKind, isPtyPanel, type PanelInstance } from "@shared/types/panel";
import { useAgentSettingsStore } from "@/store/agentSettingsStore";
import { useCcrPresetsStore } from "@/store/ccrPresetsStore";
import { useProjectPresetsStore } from "@/store/projectPresetsStore";
import { getMergedPresets } from "@/config/agents";
import { GridPanel } from "./GridPanel";
import type { TabGroup } from "@/types";
import type { TabInfo } from "@/components/Panel/TabButton";
import { addTabForPanel } from "./useContentGridContext";
import { requestPanelClose } from "@/services/terminal/optimisticPanelClose";
import { focusPanelInput } from "./terminalFocusRegistry";
import { getGroupAmbientAgentState } from "@/components/Layout/useDockBlockedState";
import { deriveTerminalChrome } from "@/utils/terminalChrome";
import { getTerminalDisplayTitle } from "@/utils/terminalTitleDisplay";
import { usePreferencesStore } from "@/store/preferencesStore";

export interface GridTabGroupProps {
  group: TabGroup;
  focusedId: string | null;
  isMultiPanelGrid?: boolean;
  isMaximized?: boolean;
}

export const GridTabGroup = React.memo(function GridTabGroup({
  group,
  focusedId,
  isMultiPanelGrid,
  isMaximized = false,
}: GridTabGroupProps) {
  // Subscribe to this group's panels keyed by `group.panelIds`. `useShallow`
  // does element-by-element identity comparison on the resolved array, so
  // updates to unrelated panels don't trigger a re-render here.
  const panels = usePanelStore(
    useShallow((state) =>
      group.panelIds
        // Render-eligibility, not type-narrowing: a tab group may hold a
        // plugin-contributed panel, which must stay in the rendered set (#10512).
        .map((id) => getRenderablePanel(state.panelsById, id))
        .filter((p): p is PanelInstance => p !== undefined)
    )
  );

  const setFocused = usePanelStore((state) => state.setFocused);
  const setActiveTab = usePanelStore((state) => state.setActiveTab);
  const stampLastActive = usePanelStore((state) => state.stampLastActive);
  const setMaximizedId = usePanelStore((state) => state.setMaximizedId);
  const trashPanel = usePanelStore((state) => state.trashPanel);
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
  const showAgentTaskTitles = usePreferencesStore((s) => s.showAgentTaskTitles);

  // Build tabs array for PanelHeader
  const tabs: TabInfo[] = useMemo(() => {
    const dangerousFlags = new Set([
      "--dangerously-skip-permissions",
      "--yolo",
      "--dangerously-bypass-approvals-and-sandbox",
      "--force",
    ]);

    return panels.map((p) => {
      const pty = isPtyPanel(p) ? p : null;
      let presetColor = pty?.agentPresetColor;
      let fallbackTooltip: string | undefined;
      if (pty?.launchAgentId && pty.agentPresetId) {
        const presets = getMergedPresets(
          pty.launchAgentId,
          agentSettings?.agents?.[pty.launchAgentId]?.customPresets,
          ccrPresetsByAgent[pty.launchAgentId],
          projectPresetsByAgent[pty.launchAgentId]
        );
        const live = presets.find((f) => f.id === pty.agentPresetId);
        if (live) presetColor = live.color ?? presetColor;
        if (pty.isUsingFallback && pty.originalPresetId) {
          const original = presets.find((f) => f.id === pty.originalPresetId);
          const originalName = original?.name ?? pty.originalPresetId;
          const activeName = live?.name ?? pty.agentPresetId;
          fallbackTooltip = `Using fallback "${activeName}" — "${originalName}" unavailable`;
        }
      }

      const hasDangerousFlags =
        pty?.agentLaunchFlags?.some((flag) => dangerousFlags.has(flag)) ?? false;

      return {
        id: p.id,
        // Compact slot (~100px): the agent's task alone — the tab icon already
        // carries identity. Falls back to the identity title when no task.
        title: getTerminalDisplayTitle(p, "compact", { showTask: showAgentTaskTitles }),
        fullTitle: getTerminalDisplayTitle(p, "full", { showTask: showAgentTaskTitles }),
        chrome: deriveTerminalChrome({
          kind: p.kind,
          launchAgentId: pty?.launchAgentId,
          runtimeIdentity: pty?.runtimeIdentity,
          detectedAgentId: pty?.detectedAgentId,
          detectedProcessId: pty?.detectedProcessId,
          agentState: pty?.agentState,
          runtimeStatus: pty?.runtimeStatus,
          exitCode: pty?.exitCode,
          presetColor,
        }),
        kind: p.kind ?? "terminal",
        agentState: pty?.agentState,
        isActive: p.id === activeTabId,
        presetColor,
        isUsingFallback: pty?.isUsingFallback,
        fallbackTooltip,
        hasDangerousFlags,
      };
    });
  }, [
    panels,
    activeTabId,
    agentSettings,
    ccrPresetsByAgent,
    projectPresetsByAgent,
    showAgentTaskTitles,
  ]);

  // Check if this group is currently focused
  const isGroupFocused = useMemo(() => panels.some((p) => p.id === focusedId), [panels, focusedId]);

  // Compute highest-urgency agent state across all tabs so the group container
  // reflects blocked/working state even when the blocking tab is not active.
  // Filter to PTY panels because getGroupAmbientAgentState expects agent-state
  // fields only present on PtyPanelData; browser/dev-preview panels contribute
  // nothing to ambient state anyway.
  const groupAmbientState = useMemo(
    () => getGroupAmbientAgentState(panels.filter(isPtyPanel)),
    [panels]
  );

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
      requestPanelClose({
        hideIds: [tabId],
        commit: () => {
          trashPanel(tabId);
        },
      });
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

  // Handle add tab - duplicate the current panel as a new tab. Delegates to the
  // shared module-level helper so the create → add-to-group → activate sequence
  // (and its orphan-cleanup on a failed add) lives in one place (#10441).
  const handleAddTab = useCallback(async () => {
    if (!activePanel) return;
    await addTabForPanel(activePanel);
  }, [activePanel]);

  if (!activePanel) {
    return null;
  }

  // Only built-in kinds can be duplicated (panelDuplicationService throws for
  // plugin kinds). Now that plugin panels render in tab groups (#10512), hide
  // the add-tab affordance for them instead of surfacing a button that throws —
  // mirrors GridPanel's single-panel add-tab gate.
  const canAddTab = isBuiltInPanelKind(activePanel.kind);

  const isFocused = activePanel.id === focusedId;

  return (
    <GridPanel
      terminalId={activePanel.id}
      isFocused={isFocused}
      isMaximized={isMaximized}
      isMultiPanelGrid={isMultiPanelGrid}
      ambientAgentState={groupAmbientState}
      tabs={tabs}
      groupId={group.id}
      onTabClick={handleTabClick}
      onTabClose={handleTabClose}
      onTabRename={handleTabRename}
      onAddTab={canAddTab ? handleAddTab : undefined}
      onTabReorder={handleTabReorder}
    />
  );
});
