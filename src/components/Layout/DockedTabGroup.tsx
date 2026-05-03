import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import {
  DndContext,
  useDndMonitor,
  closestCenter,
  useSensor,
  useSensors,
  PointerSensor,
  TouchSensor,
  type DragEndEvent,
} from "@dnd-kit/core";
import { SortableContext, horizontalListSortingStrategy, arrayMove } from "@dnd-kit/sortable";
import { restrictToHorizontalAxis, restrictToParentElement } from "@dnd-kit/modifiers";
import { LayoutGroup } from "framer-motion";
import { ChevronDown, Plus } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn, getBaseTitle } from "@/lib/utils";
import { logError } from "@/utils/logger";
import { useTabOverflow } from "@/hooks";
import {
  useTerminalInputStore,
  usePanelStore,
  usePortalStore,
  useFocusStore,
  type TerminalInstance,
} from "@/store";
import { useAgentSettingsStore } from "@/store/agentSettingsStore";
import { useCcrPresetsStore } from "@/store/ccrPresetsStore";
import { useProjectPresetsStore } from "@/store/projectPresetsStore";
import { getMergedPresets } from "@/config/agents";
import { TerminalContextMenu } from "@/components/Terminal/TerminalContextMenu";
import { TerminalIcon } from "@/components/Terminal/TerminalIcon";
import { getTerminalFocusTarget } from "@/components/Terminal/terminalFocus";
import { deriveTerminalChrome } from "@/utils/terminalChrome";
import {
  getEffectiveStateIcon,
  getEffectiveStateColor,
} from "@/components/Worktree/terminalStateConfig";
import { TerminalRefreshTier } from "@/types";
import { terminalInstanceService } from "@/services/TerminalInstanceService";
import { useDockPanelPortal } from "./DockPanelOffscreenContainer";
import {
  useDockBlockedState,
  getDockDisplayAgentState,
  getGroupBlockedAgentState,
  isGroupDeprioritized,
} from "./useDockBlockedState";
import { SortableTabButton } from "@/components/Panel/SortableTabButton";
import type { TabGroup } from "@/types";
import { buildPanelDuplicateOptions } from "@/services/terminal/panelDuplicationService";
import { handleDockInteractOutside, handleDockEscapeKeyDown } from "./dockPopoverGuard";
import { usePreferencesStore } from "@/store";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { CLOSE_CONFIRM_AGENT_STATES } from "@shared/types/agent";

interface DockedTabGroupProps {
  group: TabGroup;
  panels: TerminalInstance[];
}

export function DockedTabGroup({ group, panels }: DockedTabGroupProps) {
  const activeDockTerminalId = usePanelStore((s) => s.activeDockTerminalId);
  const openDockTerminal = usePanelStore((s) => s.openDockTerminal);
  const closeDockTerminal = usePanelStore((s) => s.closeDockTerminal);
  const moveTerminalToGrid = usePanelStore((s) => s.moveTerminalToGrid);
  const backendStatus = usePanelStore((s) => s.backendStatus);
  const setActiveTab = usePanelStore((s) => s.setActiveTab);
  const setFocused = usePanelStore((s) => s.setFocused);
  const trashPanel = usePanelStore((s) => s.trashPanel);
  const updateTitle = usePanelStore((s) => s.updateTitle);
  const skipWorkingCloseConfirm = usePreferencesStore((s) => s.skipWorkingCloseConfirm);
  const hybridInputEnabled = useTerminalInputStore((s) => s.hybridInputEnabled);
  const hybridInputAutoFocus = useTerminalInputStore((s) => s.hybridInputAutoFocus);
  const reorderPanelsInGroup = usePanelStore((s) => s.reorderPanelsInGroup);
  const addPanel = usePanelStore((s) => s.addPanel);
  const addPanelToGroup = usePanelStore((s) => s.addPanelToGroup);

  // Subscribe to registry's active tab for this group
  const storedActiveTabId = usePanelStore(
    (state) => state.tabGroups.get(group.id)?.activeTabId ?? null
  );

  // Reconcile active tab
  const activeTabId = useMemo(() => {
    if (storedActiveTabId && panels.some((p) => p.id === storedActiveTabId)) {
      return storedActiveTabId;
    }
    return panels[0]?.id ?? "";
  }, [storedActiveTabId, panels]);

  // Get active panel
  const activePanel = useMemo(() => {
    return panels.find((p) => p.id === activeTabId) ?? panels[0];
  }, [panels, activeTabId]);

  // Derive isOpen from store state - open if ANY panel in this group is active
  const isOpen = panels.some((p) => p.id === activeDockTerminalId);

  // Track when popover was just programmatically opened. Initialized to `isOpen` so a group
  // that mounts already-open is armed before Radix's DismissableLayer can fire a spurious
  // mount-time onOpenChange(false).
  const wasJustOpenedRef = useRef(isOpen);
  const [tabListEl, setTabListEl] = useState<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!isOpen) return;

    wasJustOpenedRef.current = true;
    const timer = setTimeout(() => {
      wasJustOpenedRef.current = false;
    }, 100);
    return () => clearTimeout(timer);
  }, [isOpen]);

  const { isOpen: portalOpen, width: portalWidth } = usePortalStore(
    useShallow((s) => ({ isOpen: s.isOpen, width: s.width }))
  );

  const isFocusMode = useFocusStore((s) => s.isFocusMode);

  const collisionPadding = useMemo(() => {
    const basePadding = 32;
    return {
      top: basePadding,
      left: isFocusMode ? 8 : basePadding,
      bottom: basePadding,
      right: portalOpen ? portalWidth + basePadding : basePadding,
    };
  }, [isFocusMode, portalOpen, portalWidth]);

  // Toggle buffering based on popover open state
  useEffect(() => {
    let cancelled = false;

    const applyBufferingState = async () => {
      try {
        if (isOpen && activePanel) {
          if (!cancelled) {
            const MAX_RETRIES = 10;
            const RETRY_DELAY_MS = 16;

            let dims: { cols: number; rows: number } | null = null;
            for (let attempt = 0; attempt < MAX_RETRIES && !cancelled; attempt++) {
              await new Promise((resolve) => requestAnimationFrame(resolve));
              if (cancelled) return;

              dims = terminalInstanceService.fit(activePanel.id);
              if (dims) break;

              if (attempt < MAX_RETRIES - 1) {
                await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
              }
            }

            if (cancelled || !dims) return;

            terminalInstanceService.applyRendererPolicy(
              activePanel.id,
              TerminalRefreshTier.VISIBLE
            );
          }
        } else if (activePanel) {
          if (!cancelled) {
            terminalInstanceService.applyRendererPolicy(
              activePanel.id,
              TerminalRefreshTier.BACKGROUND
            );
          }
        }
      } catch (error) {
        console.warn(`Failed to apply dock state for panel ${activePanel?.id}:`, error);
      }
    };

    applyBufferingState();

    return () => {
      cancelled = true;
    };
  }, [isOpen, activePanel]);

  // Auto-close popover when drag starts for any panel in this group
  useDndMonitor({
    onDragStart: ({ active }) => {
      if (panels.some((p) => p.id === active.id) && isOpen) {
        closeDockTerminal();
      }
    },
  });

  const portalTarget = useDockPanelPortal();
  const [portalContainer, setPortalContainer] = useState<HTMLDivElement | null>(null);

  const portalContainerRef = useCallback((node: HTMLDivElement | null) => {
    setPortalContainer(node);
  }, []);

  // Register/unregister portal target for active panel
  useEffect(() => {
    if (isOpen && portalContainer && activePanel) {
      portalTarget(activePanel.id, portalContainer);
    } else if (activePanel) {
      portalTarget(activePanel.id, null);
    }

    return () => {
      if (activePanel) {
        portalTarget(activePanel.id, null);
      }
    };
  }, [isOpen, portalContainer, activePanel, portalTarget]);

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (open) {
        openDockTerminal(activeTabId);
      } else {
        if (wasJustOpenedRef.current) {
          return;
        }
        closeDockTerminal();
      }
    },
    [activeTabId, openDockTerminal, closeDockTerminal]
  );

  const handleTabClick = useCallback(
    (tabId: string) => {
      setActiveTab(group.id, tabId);
      setFocused(tabId);
      openDockTerminal(tabId);
    },
    [group.id, setActiveTab, setFocused, openDockTerminal]
  );

  const [pendingCloseTabId, setPendingCloseTabId] = useState<string | null>(null);

  const doCloseTab = useCallback(
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

  // Confirm before closing a tab whose agent is mid-task. The dock popover
  // collapses when the body-portalled ConfirmDialog appears (via Radix's
  // onInteractOutside), so close it explicitly first to keep state transitions
  // clean — otherwise cancel would leave the user with no popover to return to.
  const handleTabClose = useCallback(
    (tabId: string) => {
      const panel = panels.find((p) => p.id === tabId);
      if (
        !skipWorkingCloseConfirm &&
        panel?.agentState &&
        CLOSE_CONFIRM_AGENT_STATES.has(panel.agentState)
      ) {
        closeDockTerminal();
        setPendingCloseTabId(tabId);
        return;
      }
      doCloseTab(tabId);
    },
    [panels, closeDockTerminal, doCloseTab, skipWorkingCloseConfirm]
  );

  const handleConfirmClose = useCallback(() => {
    const tabId = pendingCloseTabId;
    setPendingCloseTabId(null);
    if (tabId) doCloseTab(tabId);
  }, [pendingCloseTabId, doCloseTab]);

  const handleCancelClose = useCallback(() => {
    const tabId = pendingCloseTabId;
    setPendingCloseTabId(null);
    // The popover was closed before the dialog opened so the Radix
    // outside-click guard wouldn't collapse it behind the modal. Restore it
    // on cancel so the user lands back where they started.
    if (tabId) openDockTerminal(tabId);
  }, [pendingCloseTabId, openDockTerminal]);

  // Sensors for tab drag-and-drop (require small distance to differentiate from clicks)
  const tabSensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 5 },
    }),
    useSensor(TouchSensor, {
      activationConstraint: { delay: 150, tolerance: 5 },
    })
  );

  // Tab IDs for sortable context
  const tabIds = useMemo(() => panels.map((p) => p.id), [panels]);

  const hiddenTabIds = useTabOverflow(tabListEl, tabIds);

  // Handle tab reorder drag end
  const handleTabDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;

      const oldIndex = panels.findIndex((p) => p.id === active.id);
      const newIndex = panels.findIndex((p) => p.id === over.id);

      if (oldIndex !== -1 && newIndex !== -1 && oldIndex !== newIndex) {
        const newOrder = arrayMove(
          panels.map((p) => p.id),
          oldIndex,
          newIndex
        );
        reorderPanelsInGroup(group.id, newOrder);
      }
    },
    [panels, group.id, reorderPanelsInGroup]
  );

  const handleTabRename = useCallback(
    (tabId: string, newTitle: string) => {
      updateTitle(tabId, newTitle);
    },
    [updateTitle]
  );

  // Arrow key navigation for tabs (standard tablist behavior)
  const handleTabListKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (panels.length < 2) return;

      const currentIndex = panels.findIndex((p) => p.id === activeTabId);
      let nextIndex: number | undefined;

      switch (e.key) {
        case "ArrowLeft":
          nextIndex = currentIndex > 0 ? currentIndex - 1 : panels.length - 1;
          break;
        case "ArrowRight":
          nextIndex = currentIndex < panels.length - 1 ? currentIndex + 1 : 0;
          break;
        case "Home":
          nextIndex = 0;
          break;
        case "End":
          nextIndex = panels.length - 1;
          break;
        default:
          return;
      }

      e.preventDefault();
      const nextPanel = panels[nextIndex];
      if (nextPanel) {
        handleTabClick(nextPanel.id);
        // Focus the new tab button
        const tabButton = tabListEl?.querySelector(
          `[data-tab-id="${nextPanel.id}"]`
        ) as HTMLElement | null;
        tabButton?.focus();
      }
    },
    [panels, activeTabId, handleTabClick, tabListEl]
  );

  // Handle add tab - duplicate the current panel as a new tab
  const handleAddTab = useCallback(async () => {
    if (!activePanel) return;

    try {
      const options = await buildPanelDuplicateOptions(activePanel, "dock");
      // `activateDockOnCreate` folds dock activation into the panel commit so
      // the watchdog effect cannot collapse the just-created tab. See #6590.
      const newPanelId = await addPanel({ ...options, activateDockOnCreate: true });
      if (!newPanelId) return;

      addPanelToGroup(group.id, newPanelId);
      setActiveTab(group.id, newPanelId);
    } catch (error) {
      logError("Failed to add tab", error);
    }
  }, [activePanel, group.id, addPanel, addPanelToGroup, setActiveTab]);

  const groupBlockedState = getGroupBlockedAgentState(panels);
  const blockedState = useDockBlockedState(groupBlockedState);
  const isDeprioritized = !isOpen && isGroupDeprioritized(panels);
  const showDockAgentHighlights = usePreferencesStore((s) => s.showDockAgentHighlights);

  const agentSettingsAll = useAgentSettingsStore((s) => s.settings);
  const ccrPresetsByAgent = useCcrPresetsStore((s) => s.ccrPresetsByAgent);
  const projectPresetsByAgent = useProjectPresetsStore((s) => s.presetsByAgent);

  // Per-panel preset colors for tab bar
  const panelPresetColors = useMemo(() => {
    return new Map(
      panels.map((p) => {
        const fallbackColor = deriveTerminalChrome(p).color;
        if (!p.agentPresetId || !p.launchAgentId) return [p.id, fallbackColor] as const;
        const presets = getMergedPresets(
          p.launchAgentId,
          agentSettingsAll?.agents?.[p.launchAgentId]?.customPresets,
          ccrPresetsByAgent[p.launchAgentId],
          projectPresetsByAgent[p.launchAgentId]
        );
        const preset = presets.find((f) => f.id === p.agentPresetId);
        return [p.id, preset?.color ?? p.agentPresetColor ?? fallbackColor] as const;
      })
    );
  }, [panels, agentSettingsAll, ccrPresetsByAgent, projectPresetsByAgent]);

  if (!activePanel || panels.length === 0) {
    return null;
  }

  const brandColor =
    panelPresetColors.get(activePanel.id) ?? deriveTerminalChrome(activePanel).color;
  const activeChrome = deriveTerminalChrome({
    kind: activePanel.kind,
    launchAgentId: activePanel.launchAgentId,
    runtimeIdentity: activePanel.runtimeIdentity,
    detectedAgentId: activePanel.detectedAgentId,
    detectedProcessId: activePanel.detectedProcessId,
    agentState: activePanel.agentState,
    runtimeStatus: activePanel.runtimeStatus,
    exitCode: activePanel.exitCode,
    presetColor: brandColor,
  });
  const agentState = getDockDisplayAgentState(activePanel);
  const isWorking = agentState === "working";
  const isWaiting = agentState === "waiting";
  const isActive = isWorking || isWaiting;
  const commandText = activePanel.activityHeadline || activePanel.lastCommand;
  const displayTitle = getBaseTitle(activePanel.title);
  const showStateIcon =
    agentState && agentState !== "idle" && agentState !== "completed" && agentState !== "exited";
  const StateIcon = showStateIcon
    ? getEffectiveStateIcon(agentState, activePanel.waitingReason)
    : null;

  return (
    <>
      <Popover open={isOpen} onOpenChange={handleOpenChange}>
        <TerminalContextMenu terminalId={activePanel.id} forceLocation="dock">
          <PopoverTrigger asChild>
            <button
              className={cn(
                "flex items-center gap-1.5 px-3 h-[var(--dock-item-height)] rounded-[var(--radius-md)] text-xs border transition duration-150 max-w-[280px]",
                "bg-[var(--dock-item-bg)] border-[var(--dock-item-border)] text-daintree-text/70",
                "hover:text-daintree-text hover:bg-[var(--dock-item-bg-hover)]",
                "focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent focus-visible:outline-offset-2",
                "cursor-grab active:cursor-grabbing",
                isOpen &&
                  "bg-[var(--dock-item-bg-active)] text-daintree-text border-[var(--dock-item-border-active)] ring-1 ring-inset ring-daintree-accent/30",
                !isOpen &&
                  showDockAgentHighlights &&
                  blockedState === "waiting" &&
                  "bg-[var(--dock-item-bg-waiting)] border-[var(--dock-item-border-waiting)]",
                isDeprioritized && "opacity-50"
              )}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                if (e.detail >= 2) return;
                if (isOpen) {
                  closeDockTerminal();
                } else {
                  openDockTerminal(activeTabId);
                }
              }}
              onDoubleClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                const moved = moveTerminalToGrid(activePanel.id);
                if (moved) closeDockTerminal();
              }}
              aria-label={`${activePanel.title} (${panels.length} tabs) - Click to preview, double-click to move to grid, drag to reorder`}
            >
              <div className="flex items-center justify-center shrink-0">
                <TerminalIcon
                  kind={activePanel.kind}
                  chrome={activeChrome}
                  className="w-3.5 h-3.5"
                />
              </div>
              <span className="truncate min-w-[48px] max-w-[140px] font-sans font-medium">
                {displayTitle}
              </span>

              {/* Tab count indicator */}
              <span className="text-[10px] text-daintree-text/40 tabular-nums shrink-0">
                ({panels.length})
              </span>

              {isActive && commandText && (
                <>
                  <div className="h-3 w-px bg-border-subtle shrink-0" aria-hidden="true" />
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="truncate flex-1 min-w-0 text-[11px] text-daintree-text/50 font-mono">
                        {commandText}
                      </span>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">{commandText}</TooltipContent>
                  </Tooltip>
                </>
              )}

              {showStateIcon && StateIcon && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <div
                      className={cn(
                        "flex items-center shrink-0",
                        getEffectiveStateColor(agentState, activePanel.waitingReason)
                      )}
                    >
                      <StateIcon
                        className={cn(
                          "w-3.5 h-3.5",
                          agentState === "working" && "animate-spin-slow",
                          "motion-reduce:animate-none"
                        )}
                        aria-hidden="true"
                      />
                    </div>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">{`Agent ${agentState}`}</TooltipContent>
                </Tooltip>
              )}
            </button>
          </PopoverTrigger>
        </TerminalContextMenu>

        <PopoverContent
          className="w-[700px] max-w-[90vw] h-[500px] max-h-[80vh] p-0 bg-daintree-bg/95 backdrop-blur-sm border border-[var(--border-dock-popup)] shadow-[var(--shadow-dock-panel-popover)] rounded-[var(--radius-lg)] overflow-hidden"
          side="top"
          align="start"
          sideOffset={10}
          collisionPadding={collisionPadding}
          onInteractOutside={(e) => handleDockInteractOutside(e, portalContainer)}
          onEscapeKeyDown={(e) => handleDockEscapeKeyDown(e, portalContainer)}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            const focusTarget = getTerminalFocusTarget({
              hasHybridInputSurface: activeChrome.isAgent,
              isInputDisabled: backendStatus === "disconnected" || backendStatus === "recovering",
              hybridInputEnabled,
              hybridInputAutoFocus,
            });

            if (focusTarget === "hybridInput") {
              return;
            }

            setTimeout(() => terminalInstanceService.focus(activePanel.id), 50);
          }}
        >
          {/* Tab bar at top of popover */}
          <DndContext
            sensors={tabSensors}
            collisionDetection={closestCenter}
            onDragEnd={handleTabDragEnd}
            modifiers={[restrictToHorizontalAxis, restrictToParentElement]}
          >
            <SortableContext items={tabIds} strategy={horizontalListSortingStrategy}>
              <LayoutGroup id={`dock-tabs-${group.id}`}>
                <div className="flex items-stretch border-b border-divider bg-daintree-sidebar shrink-0">
                  <div
                    ref={setTabListEl}
                    className="flex items-center min-w-0 flex-1 overflow-x-auto scrollbar-none"
                    role="tablist"
                    aria-label="Dock panel tabs"
                    onKeyDown={handleTabListKeyDown}
                  >
                    {panels.map((panel) => {
                      const tabChrome = deriveTerminalChrome({
                        kind: panel.kind,
                        launchAgentId: panel.launchAgentId,
                        runtimeIdentity: panel.runtimeIdentity,
                        detectedAgentId: panel.detectedAgentId,
                        detectedProcessId: panel.detectedProcessId,
                        agentState: panel.agentState,
                        runtimeStatus: panel.runtimeStatus,
                        exitCode: panel.exitCode,
                        presetColor: panelPresetColors.get(panel.id),
                      });
                      return (
                        <SortableTabButton
                          key={panel.id}
                          id={panel.id}
                          title={getBaseTitle(panel.title)}
                          chrome={tabChrome}
                          kind={panel.kind ?? "terminal"}
                          agentState={getDockDisplayAgentState(panel)}
                          isActive={panel.id === activeTabId}
                          presetColor={panelPresetColors.get(panel.id)}
                          isUsingFallback={panel.isUsingFallback}
                          onClick={() => handleTabClick(panel.id)}
                          onClose={() => handleTabClose(panel.id)}
                          onRename={(newTitle) => handleTabRename(panel.id, newTitle)}
                        />
                      );
                    })}
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleAddTab();
                          }}
                          onPointerDown={(e) => e.stopPropagation()}
                          className="shrink-0 p-1.5 hover:bg-daintree-text/10 text-daintree-text/40 hover:text-daintree-text transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent focus-visible:outline-offset-1"
                          aria-label="Duplicate panel as new tab"
                          type="button"
                        >
                          <Plus className="w-3 h-3" aria-hidden="true" />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="bottom">Duplicate panel as new tab</TooltipContent>
                    </Tooltip>
                  </div>
                  {hiddenTabIds.size > 0 && (
                    <DropdownMenu>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <DropdownMenuTrigger asChild>
                            <button
                              type="button"
                              onPointerDown={(e) => e.stopPropagation()}
                              className="shrink-0 p-1.5 hover:bg-daintree-text/10 text-daintree-text/40 hover:text-daintree-text transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent focus-visible:outline-offset-1"
                              aria-label="Show hidden tabs"
                              aria-haspopup="menu"
                              data-testid="dock-tabs-overflow"
                            >
                              <ChevronDown className="w-3 h-3" aria-hidden="true" />
                              <span className="sr-only"> ({hiddenTabIds.size} hidden)</span>
                            </button>
                          </DropdownMenuTrigger>
                        </TooltipTrigger>
                        <TooltipContent side="bottom">Show hidden tabs</TooltipContent>
                      </Tooltip>
                      <DropdownMenuContent
                        align="end"
                        className="min-w-[200px] max-w-[320px] max-h-[var(--radix-dropdown-menu-content-available-height)] overflow-y-auto"
                      >
                        {panels
                          .filter((p) => hiddenTabIds.has(p.id))
                          .map((panel) => {
                            const tabChrome = deriveTerminalChrome({
                              kind: panel.kind,
                              launchAgentId: panel.launchAgentId,
                              runtimeIdentity: panel.runtimeIdentity,
                              detectedAgentId: panel.detectedAgentId,
                              detectedProcessId: panel.detectedProcessId,
                              agentState: panel.agentState,
                              runtimeStatus: panel.runtimeStatus,
                              exitCode: panel.exitCode,
                              presetColor: panelPresetColors.get(panel.id),
                            });
                            const isActive = panel.id === activeTabId;
                            return (
                              <DropdownMenuItem
                                key={panel.id}
                                onSelect={() => handleTabClick(panel.id)}
                                aria-current={isActive ? "true" : undefined}
                                className={cn(isActive && "font-medium")}
                              >
                                <span className="shrink-0 mr-2 inline-flex items-center justify-center w-3.5 h-3.5">
                                  <TerminalIcon
                                    kind={panel.kind ?? "terminal"}
                                    chrome={tabChrome}
                                    className="w-3.5 h-3.5"
                                  />
                                </span>
                                <span className="truncate">{getBaseTitle(panel.title)}</span>
                              </DropdownMenuItem>
                            );
                          })}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )}
                </div>
              </LayoutGroup>
            </SortableContext>
          </DndContext>

          {/* Portal target - content is rendered in DockPanelOffscreenContainer and portaled here */}
          <div
            ref={portalContainerRef}
            className="flex-1 min-h-0 flex flex-col"
            data-dock-portal-target={activePanel.id}
          />
        </PopoverContent>
      </Popover>
      <ConfirmDialog
        isOpen={pendingCloseTabId !== null}
        onClose={handleCancelClose}
        title="Stop this agent?"
        description="The agent is currently working. Closing this tab will stop it."
        confirmLabel="Stop and close"
        onConfirm={handleConfirmClose}
        variant="destructive"
      />
    </>
  );
}
