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
import { Plus } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn, getBaseTitle } from "@/lib/utils";
import { getBrandColorHex } from "@/lib/colorUtils";
import {
  useTerminalInputStore,
  useTerminalStore,
  useSidecarStore,
  useFocusStore,
  type TerminalInstance,
} from "@/store";
import { TerminalContextMenu } from "@/components/Terminal/TerminalContextMenu";
import { TerminalIcon } from "@/components/Terminal/TerminalIcon";
import { getTerminalFocusTarget } from "@/components/Terminal/terminalFocus";
import { STATE_ICONS, STATE_COLORS } from "@/components/Worktree/terminalStateConfig";
import { TerminalRefreshTier } from "@/types";
import { terminalInstanceService } from "@/services/TerminalInstanceService";
import { useDockPanelPortal } from "./DockPanelOffscreenContainer";
import { SortableTabButton } from "@/components/Panel/SortableTabButton";
import type { TabGroup } from "@/types";
import { buildPanelDuplicateOptions } from "@/services/terminal/panelDuplicationService";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

interface DockedTabGroupProps {
  group: TabGroup;
  panels: TerminalInstance[];
}

export function DockedTabGroup({ group, panels }: DockedTabGroupProps) {
  const activeDockTerminalId = useTerminalStore((s) => s.activeDockTerminalId);
  const openDockTerminal = useTerminalStore((s) => s.openDockTerminal);
  const closeDockTerminal = useTerminalStore((s) => s.closeDockTerminal);
  const backendStatus = useTerminalStore((s) => s.backendStatus);
  const setActiveTab = useTerminalStore((s) => s.setActiveTab);
  const setFocused = useTerminalStore((s) => s.setFocused);
  const trashTerminal = useTerminalStore((s) => s.trashTerminal);
  const updateTitle = useTerminalStore((s) => s.updateTitle);
  const hybridInputEnabled = useTerminalInputStore((s) => s.hybridInputEnabled);
  const hybridInputAutoFocus = useTerminalInputStore((s) => s.hybridInputAutoFocus);
  const reorderPanelsInGroup = useTerminalStore((s) => s.reorderPanelsInGroup);
  const addTerminal = useTerminalStore((s) => s.addTerminal);
  const addPanelToGroup = useTerminalStore((s) => s.addPanelToGroup);

  // Subscribe to stored active tab for this group
  const storedActiveTabId = useTerminalStore(
    (state) => state.activeTabByGroup.get(group.id) ?? null
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

  const { isOpen: sidecarOpen, width: sidecarWidth } = useSidecarStore(
    useShallow((s) => ({ isOpen: s.isOpen, width: s.width }))
  );

  const isFocusMode = useFocusStore((s) => s.isFocusMode);

  const collisionPadding = useMemo(() => {
    const basePadding = 32;
    return {
      top: basePadding,
      left: isFocusMode ? 8 : basePadding,
      bottom: basePadding,
      right: sidecarOpen ? sidecarWidth + basePadding : basePadding,
    };
  }, [isFocusMode, sidecarOpen, sidecarWidth]);

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
      trashTerminal(tabId);
    },
    [activeTabId, panels, group.id, setActiveTab, setFocused, trashTerminal]
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
      const newPanelId = await addTerminal(options);

      addPanelToGroup(group.id, newPanelId);
      setActiveTab(group.id, newPanelId);
      setFocused(newPanelId);
      openDockTerminal(newPanelId);
    } catch (error) {
      console.error("Failed to add tab:", error);
    }
  }, [
    activePanel,
    group.id,
    addTerminal,
    addPanelToGroup,
    setActiveTab,
    setFocused,
    openDockTerminal,
  ]);

  if (!activePanel || panels.length === 0) {
    return null;
  }

  const isWorking = activePanel.agentState === "working";
  const isRunning = activePanel.agentState === "running";
  const isWaiting = activePanel.agentState === "waiting";
  const isActive = isWorking || isRunning || isWaiting;
  const commandText = activePanel.activityHeadline || activePanel.lastCommand;
  const brandColor = getBrandColorHex(activePanel.agentId ?? activePanel.type);
  const agentState = activePanel.agentState;
  const displayTitle = getBaseTitle(activePanel.title);
  const showStateIcon = agentState && agentState !== "idle" && agentState !== "completed";
  const StateIcon = showStateIcon ? STATE_ICONS[agentState] : null;

  return (
    <Popover open={isOpen} onOpenChange={handleOpenChange}>
      <TerminalContextMenu terminalId={activePanel.id} forceLocation="dock">
        <PopoverTrigger asChild>
          <button
            className={cn(
              "flex items-center gap-1.5 px-3 h-[var(--dock-item-height)] rounded-[var(--radius-md)] text-xs border transition-all duration-150 max-w-[280px]",
              "bg-white/[0.02] border-divider text-canopy-text/70",
              "hover:text-canopy-text hover:bg-white/[0.04]",
              "focus-visible:outline focus-visible:outline-2 focus-visible:outline-canopy-accent focus-visible:outline-offset-2",
              "cursor-grab active:cursor-grabbing",
              isOpen &&
                "bg-white/[0.08] text-canopy-text border-canopy-accent/40 ring-1 ring-inset ring-canopy-accent/30"
            )}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              if (isOpen) {
                closeDockTerminal();
              } else {
                openDockTerminal(activeTabId);
              }
            }}
            aria-label={`${activePanel.title} (${panels.length} tabs) - Click to preview, drag to reorder`}
          >
            <div
              className={cn(
                "flex items-center justify-center transition-opacity shrink-0",
                isOpen || isActive ? "opacity-100" : "opacity-70"
              )}
            >
              <TerminalIcon
                type={activePanel.type}
                kind={activePanel.kind}
                agentId={activePanel.agentId}
                detectedProcessId={activePanel.detectedProcessId}
                className="w-3.5 h-3.5"
                brandColor={brandColor}
              />
            </div>
            <span className="truncate min-w-[48px] max-w-[140px] font-sans font-medium">
              {displayTitle}
            </span>

            {/* Tab count indicator */}
            <span className="text-[10px] text-canopy-text/40 shrink-0">({panels.length})</span>

            {isActive && commandText && (
              <>
                <div className="h-3 w-px bg-white/10 shrink-0" aria-hidden="true" />
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="truncate flex-1 min-w-0 text-[11px] text-canopy-text/50 font-mono">
                        {commandText}
                      </span>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">{commandText}</TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </>
            )}

            {showStateIcon && StateIcon && (
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <div className={cn("flex items-center shrink-0", STATE_COLORS[agentState])}>
                      <StateIcon
                        className={cn(
                          "w-3.5 h-3.5",
                          agentState === "working" && "animate-spin",
                          agentState === "waiting" && "animate-breathe",
                          "motion-reduce:animate-none"
                        )}
                        aria-hidden="true"
                      />
                    </div>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">{`Agent ${agentState}`}</TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )}
          </button>
        </PopoverTrigger>
      </TerminalContextMenu>

      <PopoverContent
        className="w-[700px] max-w-[90vw] h-[500px] max-h-[80vh] p-0 bg-canopy-bg/95 backdrop-blur-sm border border-[var(--border-dock-popup)] shadow-[var(--shadow-dock-panel-popover)] rounded-[var(--radius-lg)] overflow-hidden"
        side="top"
        align="start"
        sideOffset={10}
        collisionPadding={collisionPadding}
        onEscapeKeyDown={(e) => e.preventDefault()}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          const focusTarget = getTerminalFocusTarget({
            isAgentTerminal: activePanel.type !== "terminal",
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
            <div
              ref={tabListRef}
              className="flex items-center border-b border-divider bg-canopy-sidebar shrink-0"
              role="tablist"
              aria-label="Dock panel tabs"
              onKeyDown={handleTabListKeyDown}
            >
              {panels.map((panel) => (
                <SortableTabButton
                  key={panel.id}
                  id={panel.id}
                  title={getBaseTitle(panel.title)}
                  type={panel.type}
                  agentId={panel.agentId}
                  detectedProcessId={panel.detectedProcessId}
                  kind={panel.kind ?? "terminal"}
                  agentState={panel.agentState}
                  isActive={panel.id === activeTabId}
                  onClick={() => handleTabClick(panel.id)}
                  onClose={() => handleTabClose(panel.id)}
                  onRename={(newTitle) => handleTabRename(panel.id, newTitle)}
                />
              ))}
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleAddTab();
                      }}
                      onPointerDown={(e) => e.stopPropagation()}
                      className="shrink-0 p-1.5 hover:bg-canopy-text/10 text-canopy-text/40 hover:text-canopy-text transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-canopy-accent focus-visible:outline-offset-1"
                      aria-label="Duplicate panel as new tab"
                      type="button"
                    >
                      <Plus className="w-3 h-3" aria-hidden="true" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">Duplicate panel as new tab</TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </div>
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
