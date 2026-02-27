import React, { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  X,
  Maximize2,
  Minimize2,
  ArrowDownToLine,
  RotateCcw,
  Grid2X2,
  Activity,
  Plus,
} from "lucide-react";
import {
  DndContext,
  closestCenter,
  useSensor,
  useSensors,
  PointerSensor,
  TouchSensor,
  type DragEndEvent,
} from "@dnd-kit/core";
import { SortableContext, horizontalListSortingStrategy, arrayMove } from "@dnd-kit/sortable";
import { restrictToHorizontalAxis, restrictToParentElement } from "@dnd-kit/modifiers";
import type { PanelKind, TerminalType } from "@/types";
import { cn, getBaseTitle } from "@/lib/utils";
import { createTooltipWithShortcut, formatShortcutForTooltip } from "@/lib/platform";
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from "@/components/ui/tooltip";
import { getBrandColorHex } from "@/lib/colorUtils";
import { TerminalContextMenu } from "@/components/Terminal/TerminalContextMenu";
import { TerminalIcon } from "@/components/Terminal/TerminalIcon";
import { useDragHandle } from "@/components/DragDrop/DragHandleContext";
import { useBackgroundPanelStats } from "@/hooks";
import { TabButton, type TabInfo } from "./TabButton";
import { SortableTabButton } from "./SortableTabButton";
import { panelKindCanRestart } from "@shared/config/panelKindRegistry";

export interface PanelHeaderProps {
  id: string;
  title: string;
  kind: PanelKind;
  type?: TerminalType;
  agentId?: string;
  detectedProcessId?: string;
  isFocused: boolean;
  isMaximized?: boolean;
  location?: "grid" | "dock";
  isDragging?: boolean;

  // Title editing (provided by TitleEditingContext consumer)
  isEditingTitle: boolean;
  editingValue: string;
  titleInputRef: React.RefObject<HTMLInputElement | null>;
  onEditingValueChange: (value: string) => void;
  onTitleDoubleClick: (e: React.MouseEvent) => void;
  onTitleKeyDown: (e: React.KeyboardEvent) => void;
  onTitleInputKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  onTitleSave: () => void;

  // Actions
  onClose: (force?: boolean) => void;
  onFocus: () => void;
  onToggleMaximize?: () => void;
  onTitleChange?: (newTitle: string) => void;
  onMinimize?: () => void;
  onRestore?: () => void;
  onRestart?: () => void;

  // Visual states
  isPinged?: boolean;
  wasJustSelected?: boolean;

  // Slots for kind-specific content
  headerContent?: ReactNode;
  headerActions?: ReactNode;

  // Tab support
  tabs?: TabInfo[];
  groupId?: string;
  onTabClick?: (tabId: string) => void;
  onTabClose?: (tabId: string) => void;
  onTabRename?: (tabId: string, newTitle: string) => void;
  onAddTab?: () => void;
  onTabReorder?: (newOrder: string[]) => void;
}

function PanelHeaderComponent({
  id,
  title,
  kind,
  type,
  agentId,
  detectedProcessId,
  isFocused,
  isMaximized = false,
  location = "grid",
  isDragging = false,
  isEditingTitle,
  editingValue,
  titleInputRef,
  onEditingValueChange,
  onTitleDoubleClick,
  onTitleKeyDown,
  onTitleInputKeyDown,
  onTitleSave,
  onClose,
  onFocus,
  onToggleMaximize,
  onTitleChange,
  onMinimize,
  onRestore,
  onRestart,
  isPinged,
  wasJustSelected = false,
  headerContent,
  headerActions,
  tabs,
  groupId,
  onTabClick,
  onTabClose,
  onTabRename,
  onAddTab,
  onTabReorder,
}: PanelHeaderProps) {
  const dragHandle = useDragHandle();

  // Check if panel kind supports restart via registry
  const canRestart = panelKindCanRestart(kind);

  // Armed restart confirmation state (2-click pattern with 3s timeout)
  const [armedRestartId, setArmedRestartId] = useState<string | null>(null);
  const [countdown, setCountdown] = useState<number | null>(null);
  const armedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const countdownIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastClickTimeRef = useRef<number>(0);
  const ARMED_TIMEOUT_MS = 3000;
  const MIN_CLICK_INTERVAL_MS = 300;

  useEffect(() => {
    return () => {
      if (armedTimerRef.current) {
        clearTimeout(armedTimerRef.current);
      }
      if (countdownIntervalRef.current) {
        clearInterval(countdownIntervalRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (armedRestartId !== null && (armedRestartId !== id || !canRestart || !onRestart)) {
      setArmedRestartId(null);
      setCountdown(null);
      if (armedTimerRef.current) {
        clearTimeout(armedTimerRef.current);
        armedTimerRef.current = null;
      }
      if (countdownIntervalRef.current) {
        clearInterval(countdownIntervalRef.current);
        countdownIntervalRef.current = null;
      }
    }
    // Reset click throttle when panel ID changes to prevent cross-panel throttling
    lastClickTimeRef.current = 0;
  }, [id, armedRestartId, canRestart, onRestart]);

  const handleRestartClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();

      const now = Date.now();
      // Skip throttle check when already armed (allow fast confirmation)
      if (armedRestartId !== id && now - lastClickTimeRef.current < MIN_CLICK_INTERVAL_MS) {
        return;
      }
      lastClickTimeRef.current = now;

      if (armedRestartId === id) {
        // Second click - confirm and execute restart
        setArmedRestartId(null);
        setCountdown(null);
        if (armedTimerRef.current) {
          clearTimeout(armedTimerRef.current);
          armedTimerRef.current = null;
        }
        if (countdownIntervalRef.current) {
          clearInterval(countdownIntervalRef.current);
          countdownIntervalRef.current = null;
        }
        onRestart?.();
      } else {
        // First click - arm confirmation with countdown
        setArmedRestartId(id);
        setCountdown(3);

        // Clear any existing timers
        if (armedTimerRef.current) {
          clearTimeout(armedTimerRef.current);
        }
        if (countdownIntervalRef.current) {
          clearInterval(countdownIntervalRef.current);
        }

        // Start countdown interval (updates every second)
        let currentCount = 3;
        countdownIntervalRef.current = setInterval(() => {
          currentCount -= 1;
          if (currentCount > 0) {
            setCountdown(currentCount);
          }
        }, 1000);

        // Disarm after timeout
        armedTimerRef.current = setTimeout(() => {
          setArmedRestartId(null);
          setCountdown(null);
          if (countdownIntervalRef.current) {
            clearInterval(countdownIntervalRef.current);
            countdownIntervalRef.current = null;
          }
          armedTimerRef.current = null;
        }, ARMED_TIMEOUT_MS);
      }
    },
    [id, armedRestartId, onRestart]
  );
  const dragListeners =
    (location === "grid" || location === "dock") && dragHandle?.listeners
      ? dragHandle.listeners
      : undefined;

  // Get background activity stats for Zen Mode header
  const { activeCount, workingCount } = useBackgroundPanelStats(id);

  // In dock, show shortened title without command summary for space efficiency
  const displayTitle = location === "dock" ? getBaseTitle(title) : title;

  const handleHeaderDoubleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    if (target.tagName === "INPUT" || target.tagName === "BUTTON") {
      return;
    }
    onToggleMaximize?.();
  };

  const getAriaLabel = () => {
    if (kind === "browser") return "Edit browser title";
    if (!agentId && type === "terminal") return "Edit terminal title";
    return "Edit agent title";
  };

  const getTitleAriaLabel = () => {
    const prefix =
      kind === "browser"
        ? "Browser title"
        : !agentId && type === "terminal"
          ? "Terminal title"
          : "Agent title";
    return `${prefix}: ${title}. Press Enter or F2 to edit`;
  };

  const hasTabs = tabs && tabs.length > 1;
  const tabListRef = useRef<HTMLDivElement>(null);
  const canReorderTabs = hasTabs && !!onTabReorder && !!groupId;
  const tabIds = tabs?.map((t) => t.id) ?? [];

  // Sensors for tab drag-and-drop (require small distance to differentiate from clicks)
  const tabSensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 5 },
    }),
    useSensor(TouchSensor, {
      activationConstraint: { delay: 150, tolerance: 5 },
    })
  );

  // Handle tab reorder drag end
  const handleTabDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id || !tabs || !onTabReorder) return;

      const oldIndex = tabs.findIndex((t) => t.id === active.id);
      const newIndex = tabs.findIndex((t) => t.id === over.id);

      if (oldIndex !== -1 && newIndex !== -1 && oldIndex !== newIndex) {
        const newOrder = arrayMove(
          tabs.map((t) => t.id),
          oldIndex,
          newIndex
        );
        onTabReorder(newOrder);
      }
    },
    [tabs, onTabReorder]
  );

  // Arrow key navigation for tabs (standard tablist behavior)
  const handleTabListKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (!tabs || tabs.length < 2 || !onTabClick) return;

      const currentIndex = tabs.findIndex((t) => t.isActive);
      let nextIndex: number | undefined;

      switch (e.key) {
        case "ArrowLeft":
          nextIndex = currentIndex > 0 ? currentIndex - 1 : tabs.length - 1;
          break;
        case "ArrowRight":
          nextIndex = currentIndex < tabs.length - 1 ? currentIndex + 1 : 0;
          break;
        case "Home":
          nextIndex = 0;
          break;
        case "End":
          nextIndex = tabs.length - 1;
          break;
        default:
          return;
      }

      e.preventDefault();
      const nextTab = tabs[nextIndex];
      if (nextTab) {
        onTabClick(nextTab.id);
        // Focus the new tab button
        const tabButton = tabListRef.current?.querySelector(
          `[data-tab-id="${nextTab.id}"]`
        ) as HTMLElement | null;
        tabButton?.focus();
      }
    },
    [tabs, onTabClick]
  );

  return (
    <TerminalContextMenu terminalId={id} forceLocation={location}>
      <div
        {...dragListeners}
        className={cn(
          "flex items-center justify-between px-3 shrink-0 text-xs transition-colors relative overflow-hidden group",
          "h-8 border-b border-divider",
          isMaximized
            ? "h-10 bg-canopy-sidebar border-canopy-border"
            : location === "dock"
              ? "bg-[var(--color-surface)]"
              : isFocused
                ? "bg-white/[0.02]"
                : "bg-transparent",
          dragListeners && "cursor-grab active:cursor-grabbing",
          isPinged && !isMaximized && "animate-terminal-header-ping",
          isDragging && "pointer-events-none"
        )}
        onDoubleClick={handleHeaderDoubleClick}
      >
        {/* Tab bar - shown when there are multiple tabs */}
        {hasTabs ? (
          canReorderTabs ? (
            <DndContext
              sensors={tabSensors}
              collisionDetection={closestCenter}
              onDragEnd={handleTabDragEnd}
              modifiers={[restrictToHorizontalAxis, restrictToParentElement]}
            >
              <SortableContext items={tabIds} strategy={horizontalListSortingStrategy}>
                <div
                  ref={tabListRef}
                  className="flex items-center min-w-0 flex-1 overflow-x-auto scrollbar-none"
                  role="tablist"
                  aria-label="Panel tabs"
                  onKeyDown={handleTabListKeyDown}
                >
                  {tabs.map((tab) => (
                    <SortableTabButton
                      key={tab.id}
                      id={tab.id}
                      title={getBaseTitle(tab.title)}
                      type={tab.type}
                      agentId={tab.agentId}
                      detectedProcessId={tab.detectedProcessId}
                      kind={tab.kind}
                      agentState={tab.agentState}
                      isActive={tab.isActive}
                      onClick={() => onTabClick?.(tab.id)}
                      onClose={() => onTabClose?.(tab.id)}
                      onRename={
                        onTabRename ? (newTitle) => onTabRename(tab.id, newTitle) : undefined
                      }
                    />
                  ))}
                  {onAddTab && (
                    <TooltipProvider>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              onAddTab();
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
                  )}
                </div>
              </SortableContext>
            </DndContext>
          ) : (
            <div
              ref={tabListRef}
              className="flex items-center min-w-0 flex-1 overflow-x-auto scrollbar-none"
              role="tablist"
              aria-label="Panel tabs"
              onKeyDown={handleTabListKeyDown}
            >
              {tabs.map((tab) => (
                <TabButton
                  key={tab.id}
                  id={tab.id}
                  title={getBaseTitle(tab.title)}
                  type={tab.type}
                  agentId={tab.agentId}
                  detectedProcessId={tab.detectedProcessId}
                  kind={tab.kind}
                  agentState={tab.agentState}
                  isActive={tab.isActive}
                  onClick={() => onTabClick?.(tab.id)}
                  onClose={() => onTabClose?.(tab.id)}
                  onRename={onTabRename ? (newTitle) => onTabRename(tab.id, newTitle) : undefined}
                />
              ))}
              {onAddTab && (
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          onAddTab();
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
              )}
            </div>
          )
        ) : (
          <div className="flex items-center gap-2 min-w-0">
            <span className="shrink-0 flex items-center justify-center w-3.5 h-3.5 text-canopy-text">
              <TerminalIcon
                type={type}
                kind={kind}
                agentId={agentId}
                detectedProcessId={detectedProcessId}
                className="w-3.5 h-3.5"
                brandColor={getBrandColorHex(agentId ?? type)}
              />
            </span>

            {isEditingTitle ? (
              <input
                ref={titleInputRef}
                type="text"
                value={editingValue}
                onChange={(e) => onEditingValueChange(e.target.value)}
                onKeyDown={onTitleInputKeyDown}
                onBlur={onTitleSave}
                className="text-sm font-medium bg-canopy-bg/60 border border-canopy-accent/50 px-1 h-5 min-w-32 text-canopy-text select-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-canopy-accent focus-visible:outline-offset-1"
                aria-label={getAriaLabel()}
              />
            ) : (
              <div className="flex items-center gap-2 min-w-0">
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span
                        className={cn(
                          "text-xs font-medium font-sans select-none transition-colors",
                          isFocused ? "text-canopy-text" : "text-canopy-text/70",
                          onTitleChange && "cursor-text hover:text-canopy-text",
                          isPinged &&
                            !isMaximized &&
                            (wasJustSelected ? "animate-eco-title-select" : "animate-eco-title")
                        )}
                        onDoubleClick={onTitleDoubleClick}
                        onKeyDown={onTitleKeyDown}
                        tabIndex={onTitleChange ? 0 : undefined}
                        role={onTitleChange ? "button" : undefined}
                        aria-label={onTitleChange ? getTitleAriaLabel() : undefined}
                      >
                        {displayTitle}
                      </span>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">
                      {onTitleChange ? `${title} — Double-click to edit` : title}
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </div>
            )}

            {/* Add tab button for single panels */}
            {onAddTab && (
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onAddTab();
                      }}
                      onPointerDown={(e) => e.stopPropagation()}
                      className="shrink-0 p-1.5 opacity-0 group-hover:opacity-100 hover:bg-canopy-text/10 text-canopy-text/40 hover:text-canopy-text transition-all focus-visible:opacity-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-canopy-accent focus-visible:outline-offset-1"
                      aria-label="Duplicate panel as new tab"
                      type="button"
                    >
                      <Plus className="w-3.5 h-3.5" aria-hidden="true" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">Duplicate panel as new tab</TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )}
          </div>
        )}

        {/* Centered Zen Mode indicator (only visible when maximized) */}
        {isMaximized && activeCount > 0 && (
          <div
            className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 flex items-center gap-3 text-canopy-text/40 select-none pointer-events-none"
            role="status"
            aria-live="polite"
          >
            <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wider font-semibold max-w-[300px]">
              <Grid2X2 className="w-3 h-3 shrink-0" aria-hidden="true" />
              <span className="truncate">{activeCount} Background</span>
              {workingCount > 0 && (
                <span className="flex items-center gap-1 text-[var(--color-state-working)] ml-1">
                  <Activity
                    className="w-3 h-3 animate-pulse motion-reduce:animate-none"
                    aria-hidden="true"
                  />
                  {workingCount} working
                </span>
              )}
            </div>
          </div>
        )}

        <div className="flex items-center gap-1.5">
          {/* Window controls - hover only */}
          <div className="flex items-center gap-1.5 opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto group-focus-within:opacity-100 group-focus-within:pointer-events-auto transition-opacity motion-reduce:transition-none">
            {headerActions}
            {/* Restart button - only shown for panel kinds that declare canRestart capability */}
            {canRestart && onRestart && (
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={handleRestartClick}
                      className={cn(
                        "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 transition-colors flex items-center gap-1.5",
                        armedRestartId === id
                          ? "px-2 py-1 bg-amber-500/20 text-amber-500 ring-2 ring-amber-500/50 focus-visible:outline-amber-500"
                          : "p-1.5 hover:bg-canopy-text/10 focus-visible:bg-canopy-text/10 focus-visible:outline-canopy-accent text-canopy-text/60 hover:text-canopy-text"
                      )}
                      aria-label={
                        armedRestartId === id
                          ? `Armed — click again to confirm restart. ${countdown !== null ? `${countdown} seconds remaining` : ""}`
                          : "Restart Session"
                      }
                      aria-pressed={armedRestartId === id ? "true" : "false"}
                    >
                      <RotateCcw className="w-3 h-3" aria-hidden="true" />
                      {armedRestartId === id && (
                        <>
                          <span className="text-[10px] font-semibold uppercase tracking-wide">
                            Click to Confirm
                          </span>
                          {countdown !== null && (
                            <span className="text-[10px] font-bold min-w-[1ch]" aria-hidden="true">
                              {countdown}
                            </span>
                          )}
                        </>
                      )}
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">
                    {armedRestartId === id ? "Click again to confirm restart" : "Restart Session"}
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )}
            {onMinimize && !isMaximized && (
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onMinimize();
                      }}
                      className="p-1.5 hover:bg-canopy-text/10 focus-visible:bg-canopy-text/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-canopy-accent focus-visible:outline-offset-2 text-canopy-text/60 hover:text-canopy-text transition-colors"
                      aria-label={location === "dock" ? "Minimize" : "Minimize to dock"}
                    >
                      <ArrowDownToLine className="w-3 h-3" aria-hidden="true" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">
                    {location === "dock" ? "Minimize" : "Minimize to dock"}
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )}
            {location === "dock" && onRestore && (
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onRestore();
                      }}
                      className="p-1.5 hover:bg-canopy-text/10 focus-visible:bg-canopy-text/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-canopy-accent focus-visible:outline-offset-2 text-canopy-text/60 hover:text-canopy-text transition-colors"
                      aria-label="Restore to grid"
                    >
                      <Maximize2 className="w-3 h-3" aria-hidden="true" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">Restore to grid</TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )}
            {onToggleMaximize && isMaximized ? (
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onFocus();
                        onToggleMaximize();
                      }}
                      className="flex items-center gap-1.5 px-2 py-1 bg-canopy-accent/10 text-canopy-accent hover:bg-canopy-accent/20 rounded transition-colors mr-1 focus-visible:outline focus-visible:outline-2 focus-visible:outline-canopy-accent focus-visible:outline-offset-2"
                      aria-label="Exit Focus mode and restore grid view"
                    >
                      <Minimize2 className="w-3.5 h-3.5" aria-hidden="true" />
                      <span className="font-medium">Exit Focus</span>
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">
                    {createTooltipWithShortcut("Restore Grid View", "Ctrl+Shift+F")}
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            ) : (
              onToggleMaximize && (
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          onFocus();
                          onToggleMaximize();
                        }}
                        className="p-1.5 hover:bg-canopy-text/10 focus-visible:bg-canopy-text/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-canopy-accent focus-visible:outline-offset-2 text-canopy-text/60 hover:text-canopy-text transition-colors"
                        aria-label="Maximize"
                      >
                        <Maximize2 className="w-3 h-3" aria-hidden="true" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">
                      {createTooltipWithShortcut("Maximize", "Ctrl+Shift+F")}
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              )
            )}
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onClose(e.altKey);
                    }}
                    onKeyDown={(e) => {
                      if ((e.key === "Enter" || e.key === " ") && e.altKey) {
                        e.preventDefault();
                        e.stopPropagation();
                        onClose(true);
                      }
                    }}
                    className="p-1.5 hover:bg-[color-mix(in_oklab,var(--color-status-error)_15%,transparent)] focus-visible:bg-[color-mix(in_oklab,var(--color-status-error)_15%,transparent)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-status-error)] focus-visible:outline-offset-2 text-canopy-text/60 hover:text-[var(--color-status-error)] transition-colors"
                    aria-label={formatShortcutForTooltip(
                      "Close session. Hold Alt and click to force close without recovery."
                    )}
                  >
                    <X className="w-3 h-3" aria-hidden="true" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  {formatShortcutForTooltip("Close Session (Alt+Click to force close)")}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </div>

          {/* Kind-specific header content slot */}
          {headerContent}
        </div>
      </div>
    </TerminalContextMenu>
  );
}

export const PanelHeader = PanelHeaderComponent;
