import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useDndMonitor } from "@dnd-kit/core";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn, getBaseTitle } from "@/lib/utils";
import { getBrandColorHex } from "@/lib/colorUtils";
import {
  useTerminalInputStore,
  useTerminalStore,
  useSidecarStore,
  type TerminalInstance,
} from "@/store";
import { TerminalContextMenu } from "@/components/Terminal/TerminalContextMenu";
import { TerminalIcon } from "@/components/Terminal/TerminalIcon";
import { getTerminalFocusTarget } from "@/components/Terminal/terminalFocus";
import { STATE_ICONS, STATE_COLORS } from "@/components/Worktree/terminalStateConfig";
import { TerminalRefreshTier } from "@/types";
import { terminalClient } from "@/clients";
import { terminalInstanceService } from "@/services/TerminalInstanceService";
import { useDockPanelPortal } from "./DockPanelOffscreenContainer";
import { TabButton } from "@/components/Panel/TabButton";
import type { TabGroup } from "@/types";

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
  const hybridInputEnabled = useTerminalInputStore((s) => s.hybridInputEnabled);
  const hybridInputAutoFocus = useTerminalInputStore((s) => s.hybridInputAutoFocus);

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

  const collisionPadding = useMemo(() => {
    const basePadding = 32;
    return {
      top: basePadding,
      left: basePadding,
      bottom: basePadding,
      right: sidecarOpen ? sidecarWidth + basePadding : basePadding,
    };
  }, [sidecarOpen, sidecarWidth]);

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

            try {
              await terminalClient.resize(activePanel.id, dims.cols, dims.rows);
            } catch (resizeError) {
              console.warn(`Failed to resize PTY for terminal ${activePanel.id}:`, resizeError);
              return;
            }

            if (cancelled) return;

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

  if (!activePanel || panels.length === 0) {
    return null;
  }

  const isWorking = activePanel.agentState === "working";
  const isRunning = activePanel.agentState === "running";
  const isWaiting = activePanel.agentState === "waiting";
  const isActive = isWorking || isRunning || isWaiting;
  const commandText = activePanel.activityHeadline || activePanel.lastCommand;
  const brandColor = getBrandColorHex(activePanel.type);
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
            title={`${activePanel.title} (${panels.length} tabs) - Click to preview, drag to reorder`}
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
                <span
                  className="truncate flex-1 min-w-0 text-[11px] text-canopy-text/50 font-mono"
                  title={commandText}
                >
                  {commandText}
                </span>
              </>
            )}

            {showStateIcon && StateIcon && (
              <div
                className={cn("flex items-center shrink-0", STATE_COLORS[agentState])}
                title={`Agent ${agentState}`}
              >
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
            )}
          </button>
        </PopoverTrigger>
      </TerminalContextMenu>

      <PopoverContent
        className="w-[700px] max-w-[90vw] h-[500px] max-h-[80vh] p-0 bg-canopy-bg/95 backdrop-blur-sm border border-[var(--border-overlay)] shadow-[var(--shadow-dock-popover)] rounded-[var(--radius-lg)] overflow-hidden"
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
        <div
          className="flex items-center border-b border-divider bg-canopy-sidebar shrink-0"
          role="tablist"
          aria-label="Dock panel tabs"
        >
          {panels.map((panel) => (
            <TabButton
              key={panel.id}
              id={panel.id}
              title={getBaseTitle(panel.title)}
              type={panel.type}
              agentId={panel.agentId}
              kind={panel.kind ?? "terminal"}
              agentState={panel.agentState}
              isActive={panel.id === activeTabId}
              onClick={() => handleTabClick(panel.id)}
              onClose={() => handleTabClose(panel.id)}
            />
          ))}
        </div>

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
