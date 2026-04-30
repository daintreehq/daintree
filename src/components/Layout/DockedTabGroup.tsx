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
import { LayoutGroup, LazyMotion, domMax } from "framer-motion";
import { Plus } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn, getBaseTitle } from "@/lib/utils";
import { logError } from "@/utils/logger";
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

  // Track when popover was just programmatically opened
  const wasJustOpenedRef = useRef(false);
  const prevIsOpenRef = useRef(isOpen);
  const tabListRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    prevIsOpenRef.current = isOpen;

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
        const tabButton = tabListRef.current?.querySelector(
          `[data-tab-id="${nextPanel.id}"]`
        ) as HTMLElement | null;
        tabButton?.focus();
      }
    },
    [panels, activeTabId, handleTabClick]
  );

  // Handle add tab - duplicate the current panel as a new tab
  const handleAddTab = useCallback(async () => {
    if (!activePanel) return;

    try {
      const options = await buildPanelDuplicateOptions(activePanel, "dock");
      const newPanelId = await addPanel(options);
      if (!newPanelId) return;

      addPanelToGroup(group.id, newPanelId);
      setActiveTab(group.id, newPanelId);
      setFocused(newPanelId);
      openDockTerminal(newPanelId);
    } catch (error) {
      logError("Failed to add tab", error);
    }
  }, [
    activePanel,
    group.id,
    addPanel,
    addPanelToGroup,
    setActiveTab,
    setFocused,
    openDockTerminal,
  ]);

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
  const agentState = activeChrome.isAgent ? getDockDisplayAgentState(activePanel) : undefined;
  const isWorking = agentState === "working";
  const isWaiting = agentState === "waiting";
  const isActive = isWorking || isWaiting;
  const commandText = activePanel.activityHeadline || activePanel.lastCommand;
  const displayTitle = getBaseTitle(activePanel.title);
  const showStateIcon = agentState && agentState !== "idle" && agentState !== "completed";
  const StateIcon = showStateIcon
    ? getEffectiveStateIcon(agentState, activePanel.waitingReason)
    : null;

  return (
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
              <TerminalIcon kind={activePanel.kind} chrome={activeChrome} className="w-3.5 h-3.5" />
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
            <LazyMotion features={domMax}>
              <LayoutGroup id={`dock-tabs-${group.id}`}>
                <div
                  ref={tabListRef}
                  className="flex items-center border-b border-divider bg-daintree-sidebar shrink-0"
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
                        agentState={tabChrome.isAgent ? getDockDisplayAgentState(panel) : undefined}
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
              </LayoutGroup>
            </LazyMotion>
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
  );
}
