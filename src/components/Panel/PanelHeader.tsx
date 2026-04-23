import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  X,
  Maximize2,
  Minimize2,
  RotateCcw,
  Grid2X2,
  Activity,
  Plus,
  Bell,
  BellOff,
  ChevronLeft,
  ChevronRight,
  CopyPlus,
  Ellipsis,
  Eye,
  Info,
  Lock,
  Pencil,
  Trash2,
  Unlock,
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
import { LayoutGroup } from "framer-motion";
import type { PanelKind, TerminalType } from "@/types";
import { cn, getBaseTitle } from "@/lib/utils";
import { formatShortcutForTooltip, createTooltipWithShortcut } from "@/lib/platform";
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from "@/components/ui/tooltip";
import { AnimatedLabel } from "@/components/ui/AnimatedLabel";
import { getBrandColorHex } from "@/lib/colorUtils";
import { TerminalIcon } from "@/components/Terminal/TerminalIcon";
import { MoveToDockIcon, MoveToGridIcon, WatchAlertIcon, WorktreeIcon } from "@/components/icons";
import { useDragHandle } from "@/components/DragDrop/DragHandleContext";
import {
  useBackgroundPanelStats,
  useHorizontalScrollControls,
  useKeybindingDisplay,
} from "@/hooks";
import { usePanelStore } from "@/store/panelStore";
import { resolveEffectiveAgentId } from "@/utils/agentIdentity";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { TabButton, type TabInfo } from "./TabButton";
import { SortableTabButton } from "./SortableTabButton";
import { useShallow } from "zustand/react/shallow";
import { panelKindCanRestart, panelKindHasPty } from "@shared/config/panelKindRegistry";
import { isRegisteredAgent } from "@shared/config/agentRegistry";
import type { BuiltInAgentId } from "@shared/config/agentIds";
import { actionService } from "@/services/ActionService";
import { fireWatchNotification } from "@/lib/watchNotification";
import { useFleetFailureStore } from "@/store/fleetFailureStore";

export interface PanelHeaderProps {
  id: string;
  title: string;
  kind: PanelKind;
  type?: TerminalType;
  agentId?: string;
  /** Runtime-detected agent identity (cleared when the agent exits). Drives icons and the watch button. */
  detectedAgentId?: string;
  /**
   * Agent identity sealed at spawn for full-mode terminals. Absent when an
   * agent was started inside a plain shell — the chip uses this gap to offer
   * a one-click respawn into a proper agent terminal.
   */
  capabilityAgentId?: BuiltInAgentId;
  detectedProcessId?: string;
  presetColor?: string;
  worktreeAccentColor?: string;
  worktreeBranch?: string;
  isFocused: boolean;
  isMaximized?: boolean;
  location?: "grid" | "dock";
  isDragging?: boolean;
  agentLaunchFlags?: string[];

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

  // Multi-select indicator. When the host pane is part of an armed set of
  // 2+ terminals the header surface lifts to the same bg as a focused pane.
  // No accent border, no accent title — just a highlighted title bar.
  isSelected?: boolean;

  // Follower indicator. Renders a 2px amber left-edge stripe on the header,
  // matching the fleet ribbon's stripe idiom, so the user can confirm
  // "this pane is going to receive what I type elsewhere" without looking
  // up at the ribbon. Always paired with isSelected, but the stripe only
  // appears on non-focused armed panes (true followers, not the primary).
  isFleetFollower?: boolean;

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
  detectedAgentId,
  capabilityAgentId,
  detectedProcessId,
  presetColor,
  worktreeAccentColor,
  worktreeBranch,
  isFocused,
  isMaximized = false,
  location = "grid",
  isDragging = false,
  agentLaunchFlags,
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
  isSelected = false,
  isFleetFollower = false,
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
  const [overflowTooltipOpen, setOverflowTooltipOpen] = useState(false);
  const armedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const countdownIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const ARMED_TIMEOUT_MS = 3000;

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
  }, [id, armedRestartId, canRestart, onRestart]);

  const dragListeners =
    (location === "grid" || location === "dock") && dragHandle?.listeners
      ? dragHandle.listeners
      : undefined;

  // Get background activity stats for Zen Mode header
  const { activeCount, workingCount } = useBackgroundPanelStats(id);

  // Check if panel has dangerous launch flags
  const hasDangerousFlags = (() => {
    const dangerousFlags = new Set([
      "--dangerously-skip-permissions",
      "--yolo",
      "--dangerously-bypass-approvals-and-sandbox",
      "--force",
    ]);
    return agentLaunchFlags?.some((flag) => dangerousFlags.has(flag)) ?? false;
  })();

  // Watch state — only relevant for agent panels
  const isWatched = usePanelStore((state) => state.watchedPanels.has(id));
  const watchPanel = usePanelStore((state) => state.watchPanel);
  const unwatchPanel = usePanelStore((state) => state.unwatchPanel);
  // Watch button tracks live agent identity: visible when an agent is currently
  // running (`detectedAgentId`) OR was launched as one (`agentId`). The fallback
  // keeps the button available right after spawn before the process detector fires.
  const effectiveAgentId = resolveEffectiveAgentId(detectedAgentId, agentId);
  const showWatchButton = !!effectiveAgentId;

  // Fleet failure state for this pane: when the most recent broadcast
  // rejected on this terminal (e.g. PTY died mid-paste), surface a red
  // dot adjacent to the title so the user can see the divergence at the
  // pane the same way a "Retry failed" button surfaces it in the ribbon.
  const isFleetFailed = useFleetFailureStore((s) => s.failedIds.has(id));
  const dismissFleetFailure = useFleetFailureStore((s) => s.dismissId);

  const duplicateShortcut = useKeybindingDisplay("terminal.duplicate");
  const moveToDockShortcut = useKeybindingDisplay("terminal.moveToDock");
  const toggleDockShortcut = useKeybindingDisplay("terminal.toggleDock");
  const maximizeShortcut = useKeybindingDisplay("terminal.maximize");
  const closeShortcut = useKeybindingDisplay("terminal.close");

  // Terminal record for overflow menu actions (single shallow selector, matching TerminalContextMenu pattern)
  const terminal = usePanelStore(useShallow((state) => state.panelsById[id]));
  const isInputLocked = terminal?.isInputLocked ?? false;
  const hasPty = panelKindHasPty(kind);

  // Observational mode: an agent is running inside a plain shell that wasn't
  // launched as an agent terminal. `capabilityAgentId` is sealed at spawn for
  // full-mode terminals; its absence alongside a live `detectedAgentId` is the
  // gap we surface — calmly, with a one-click respawn into the proper agent
  // terminal. We only show the CTA for agents the registry can spawn.
  const isObservationalAgent =
    !!detectedAgentId &&
    !capabilityAgentId &&
    isRegisteredAgent(detectedAgentId) &&
    !terminal?.isRestarting;

  // Whether the overflow "..." menu has any items to show
  const showMoveToDock = !!onMinimize && !isMaximized && location !== "dock";
  const hasOverflowItems = true;

  // Restart handler for Radix DropdownMenu onSelect
  const handleRestartSelect = useCallback(
    (e: Event) => {
      if (armedRestartId === id) {
        // Second select — confirm restart, let menu close
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
        // First select — arm, keep menu open
        e.preventDefault();
        setArmedRestartId(id);
        setCountdown(3);

        if (armedTimerRef.current) {
          clearTimeout(armedTimerRef.current);
        }
        if (countdownIntervalRef.current) {
          clearInterval(countdownIntervalRef.current);
        }

        let currentCount = 3;
        countdownIntervalRef.current = setInterval(() => {
          currentCount -= 1;
          if (currentCount > 0) {
            setCountdown(currentCount);
          }
        }, 1000);

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

  const handleWatchToggle = useCallback(() => {
    if (isWatched) {
      unwatchPanel(id);
    } else if (
      terminal?.agentState === "completed" ||
      terminal?.agentState === "waiting" ||
      terminal?.agentState === "exited"
    ) {
      fireWatchNotification(id, terminal.title ?? id, terminal.agentState);
    } else {
      watchPanel(id);
    }
  }, [id, isWatched, unwatchPanel, watchPanel, terminal]);

  // In dock, show shortened title without command summary for space efficiency
  const displayTitle = location === "dock" ? getBaseTitle(title) : title;

  const handleHeaderDoubleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    if (target.closest("button, input, [role='button']")) {
      return;
    }
    if (location === "dock") {
      onRestore?.();
    } else {
      void actionService.dispatch("nav.toggleFocusMode");
    }
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

  const {
    canScrollLeft: tabsCanScrollLeft,
    canScrollRight: tabsCanScrollRight,
    scrollLeft: tabsScrollLeft,
    scrollRight: tabsScrollRight,
  } = useHorizontalScrollControls(tabListRef);

  const activeTabId = tabs?.find((t) => t.isActive)?.id ?? null;

  useLayoutEffect(() => {
    const container = tabListRef.current;
    if (!container || !activeTabId || isDragging) return;

    const tabEl = container.querySelector(`[data-tab-id="${activeTabId}"]`) as HTMLElement | null;
    if (!tabEl) return;

    const containerLeft = container.scrollLeft;
    const containerRight = containerLeft + container.clientWidth;
    const tabLeft = tabEl.offsetLeft;
    const tabRight = tabLeft + tabEl.offsetWidth;

    if (tabLeft < containerLeft) {
      container.scrollTo({ left: tabLeft, behavior: "smooth" });
    } else if (tabRight > containerRight) {
      container.scrollTo({ left: tabRight - container.clientWidth, behavior: "smooth" });
    }
  }, [activeTabId, isDragging]);

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

  const tabFadeFrom = isMaximized
    ? "from-daintree-sidebar"
    : location === "dock"
      ? "from-surface"
      : isFocused
        ? "from-overlay-subtle"
        : "from-surface";

  return (
    <div
      {...dragListeners}
      data-selected={isSelected || undefined}
      data-fleet-follower={isFleetFollower || undefined}
      data-pane-chrome=""
      className={cn(
        "flex items-center justify-between px-3 shrink-0 text-xs transition-colors relative overflow-hidden group",
        "h-8 border-b border-divider",
        isMaximized
          ? "h-10 bg-daintree-sidebar border-daintree-border"
          : location === "dock"
            ? "bg-surface"
            : isFocused || isSelected
              ? "bg-overlay-subtle"
              : "bg-transparent",
        // Mirror the fleet ribbon's 2px amber left stripe on follower panes.
        // Renders via `before:` so it stacks alongside the worktree-identity
        // `after:` stripe on the panel container without conflicting. The
        // stripe sits in the title bar — fovea-adjacent when reading the
        // pane body — so users don't have to look up at the ribbon to verify
        // which panes will receive their keystrokes.
        isFleetFollower &&
          "before:absolute before:inset-y-0 before:left-0 before:w-0.5 before:bg-[var(--color-category-amber-border)] before:z-[1]",
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
              <div className="relative min-w-0 flex-1 flex">
                {tabsCanScrollLeft && (
                  <div
                    className={cn(
                      "absolute left-0 inset-y-0 w-8 pointer-events-none z-10 bg-gradient-to-r to-transparent flex items-center",
                      tabFadeFrom
                    )}
                  >
                    <button
                      type="button"
                      onClick={tabsScrollLeft}
                      onPointerDown={(e) => e.stopPropagation()}
                      className="pointer-events-auto p-1 text-daintree-text/60 hover:text-daintree-text transition-colors"
                      aria-label="Scroll left"
                    >
                      <ChevronLeft className="w-3 h-3" aria-hidden="true" />
                    </button>
                  </div>
                )}
                <div
                  ref={tabListRef}
                  className="flex items-center min-w-0 flex-1 overflow-x-auto scrollbar-none"
                  role="tablist"
                  aria-label="Panel tabs"
                  onKeyDown={handleTabListKeyDown}
                >
                  <LayoutGroup id={`panel-tabs-${id}`}>
                    <div className="flex items-center">
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
                          presetColor={tab.presetColor}
                          isUsingFallback={tab.isUsingFallback}
                          fallbackTooltip={tab.fallbackTooltip}
                          hasDangerousFlags={tab.hasDangerousFlags}
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
                                className="shrink-0 p-1.5 hover:bg-daintree-text/10 text-daintree-text/40 hover:text-daintree-text transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent focus-visible:outline-offset-1"
                                aria-label="Duplicate panel as new tab"
                                type="button"
                              >
                                <Plus className="w-3 h-3" aria-hidden="true" />
                              </button>
                            </TooltipTrigger>
                            <TooltipContent side="bottom">
                              {createTooltipWithShortcut(
                                "Duplicate panel as new tab",
                                duplicateShortcut
                              )}
                            </TooltipContent>
                          </Tooltip>
                        </TooltipProvider>
                      )}
                    </div>
                  </LayoutGroup>
                </div>
                {tabsCanScrollRight && (
                  <div
                    className={cn(
                      "absolute right-0 inset-y-0 w-8 pointer-events-none z-10 bg-gradient-to-l to-transparent flex items-center justify-end",
                      tabFadeFrom
                    )}
                  >
                    <button
                      type="button"
                      onClick={tabsScrollRight}
                      onPointerDown={(e) => e.stopPropagation()}
                      className="pointer-events-auto p-1 text-daintree-text/60 hover:text-daintree-text transition-colors"
                      aria-label="Scroll right"
                    >
                      <ChevronRight className="w-3 h-3" aria-hidden="true" />
                    </button>
                  </div>
                )}
              </div>
            </SortableContext>
          </DndContext>
        ) : (
          <div className="relative min-w-0 flex-1 flex">
            {tabsCanScrollLeft && (
              <div
                className={cn(
                  "absolute left-0 inset-y-0 w-8 pointer-events-none z-10 bg-gradient-to-r to-transparent flex items-center",
                  tabFadeFrom
                )}
              >
                <button
                  type="button"
                  onClick={tabsScrollLeft}
                  onPointerDown={(e) => e.stopPropagation()}
                  className="pointer-events-auto p-1 text-daintree-text/60 hover:text-daintree-text transition-colors"
                  aria-label="Scroll left"
                >
                  <ChevronLeft className="w-3 h-3" aria-hidden="true" />
                </button>
              </div>
            )}
            <div
              ref={tabListRef}
              className="flex items-center min-w-0 flex-1 overflow-x-auto scrollbar-none"
              role="tablist"
              aria-label="Panel tabs"
              onKeyDown={handleTabListKeyDown}
            >
              <LayoutGroup id={`panel-tabs-${id}`}>
                <div className="flex items-center">
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
                      presetColor={tab.presetColor}
                      isUsingFallback={tab.isUsingFallback}
                      fallbackTooltip={tab.fallbackTooltip}
                      hasDangerousFlags={tab.hasDangerousFlags}
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
                            className="shrink-0 p-1.5 hover:bg-daintree-text/10 text-daintree-text/40 hover:text-daintree-text transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent focus-visible:outline-offset-1"
                            aria-label="Duplicate panel as new tab"
                            type="button"
                          >
                            <Plus className="w-3 h-3" aria-hidden="true" />
                          </button>
                        </TooltipTrigger>
                        <TooltipContent side="bottom">
                          {createTooltipWithShortcut(
                            "Duplicate panel as new tab",
                            duplicateShortcut
                          )}
                        </TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  )}
                </div>
              </LayoutGroup>
            </div>
            {tabsCanScrollRight && (
              <div
                className={cn(
                  "absolute right-0 inset-y-0 w-8 pointer-events-none z-10 bg-gradient-to-l to-transparent flex items-center justify-end",
                  tabFadeFrom
                )}
              >
                <button
                  type="button"
                  onClick={tabsScrollRight}
                  onPointerDown={(e) => e.stopPropagation()}
                  className="pointer-events-auto p-1 text-daintree-text/60 hover:text-daintree-text transition-colors"
                  aria-label="Scroll right"
                >
                  <ChevronRight className="w-3 h-3" aria-hidden="true" />
                </button>
              </div>
            )}
          </div>
        )
      ) : (
        <div className="flex items-center gap-2 min-w-0">
          <span className="shrink-0 flex items-center justify-center w-3.5 h-3.5 text-daintree-text">
            <TerminalIcon
              kind={kind}
              agentId={agentId}
              detectedAgentId={detectedAgentId}
              detectedProcessId={detectedProcessId}
              className="w-3.5 h-3.5"
              brandColor={presetColor ?? getBrandColorHex(effectiveAgentId ?? type)}
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
              className="text-sm font-medium bg-daintree-bg/60 border border-daintree-accent/50 px-1 h-5 min-w-32 text-daintree-text select-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent focus-visible:outline-offset-1"
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
                        isFocused || isSelected ? "text-daintree-text" : "text-daintree-text/70",
                        onTitleChange && "cursor-text hover:text-daintree-text",
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

          {hasDangerousFlags && (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span
                    className="w-2 h-2 rounded-full bg-status-danger shrink-0"
                    aria-label="Launched with dangerous permissions"
                  />
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  Launched with dangerous permissions — agent can modify files without prompting
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}

          {isFleetFailed && (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      dismissFleetFailure(id);
                    }}
                    onPointerDown={(e) => e.stopPropagation()}
                    aria-label="Last fleet broadcast failed on this terminal — click to acknowledge"
                    data-testid="panel-fleet-failure-dot"
                    className="w-2 h-2 rounded-full bg-status-error shrink-0 hover:scale-125 transition-transform"
                  />
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  Last fleet broadcast failed here — click to dismiss. Run "Fleet: Retry failed
                  broadcast" from the command palette to resend.
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}

          {isObservationalAgent && (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      void actionService.dispatch(
                        "terminal.convertType",
                        { terminalId: id, type: detectedAgentId },
                        { source: "menu" }
                      );
                    }}
                    onPointerDown={(e) => e.stopPropagation()}
                    aria-label={`Restart as ${detectedAgentId} agent terminal`}
                    data-testid="panel-observational-chip"
                    className="shrink-0 inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium leading-none select-none bg-overlay-subtle text-daintree-text/70 hover:text-daintree-text hover:bg-daintree-text/10 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent focus-visible:outline-offset-1"
                  >
                    <Eye className="w-3 h-3" aria-hidden="true" />
                    <span>Observing · Restart as agent</span>
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  {`${detectedAgentId} is running inside a plain shell. Restart to give it the full agent terminal — managed environment, scrollback, and fleet membership.`}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}

          {/* Watch status indicator — non-interactive, shown when actively watching */}
          {showWatchButton && isWatched && (
            <span
              role="status"
              aria-label="Watching — waiting for agent completion"
              className="text-daintree-accent cursor-default"
            >
              <WatchAlertIcon className="w-3 h-3 animate-pulse motion-reduce:animate-none" />
            </span>
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
                    className="shrink-0 p-1.5 opacity-0 group-hover:opacity-100 hover:bg-daintree-text/10 text-daintree-text/40 hover:text-daintree-text transition focus-visible:opacity-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent focus-visible:outline-offset-1"
                    aria-label="Duplicate panel as new tab"
                    type="button"
                  >
                    <Plus className="w-3.5 h-3.5" aria-hidden="true" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  {createTooltipWithShortcut("Duplicate panel as new tab", duplicateShortcut)}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}

          {/* Worktree branch badge — shown when multiple worktrees are active */}
          {worktreeBranch && worktreeAccentColor && (
            <span
              className="shrink-0 inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium leading-none select-none max-w-[120px]"
              style={
                {
                  color: worktreeAccentColor,
                  backgroundColor: "color-mix(in oklab, var(--worktree-color) 12%, transparent)",
                  "--worktree-color": worktreeAccentColor,
                } as React.CSSProperties
              }
              aria-label={`Branch: ${worktreeBranch}`}
            >
              <span className="truncate">{worktreeBranch}</span>
            </span>
          )}
        </div>
      )}

      {/* Centered Zen Mode indicator (only visible when maximized) */}
      {isMaximized && activeCount > 0 && (
        <div
          className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 flex items-center gap-3 text-daintree-text/40 select-none pointer-events-none"
          role="status"
          aria-live="polite"
        >
          <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wider font-semibold max-w-[300px]">
            <Grid2X2 className="w-3 h-3 shrink-0" aria-hidden="true" />
            <span className="truncate tabular-nums inline-flex items-center gap-1">
              <AnimatedLabel label={String(activeCount)} textClassName="tabular-nums" /> Background
            </span>
            {workingCount > 0 && (
              <span className="flex items-center gap-1 text-state-working tabular-nums ml-1">
                <Activity
                  className="w-3 h-3 animate-pulse motion-reduce:animate-none"
                  aria-hidden="true"
                />
                <AnimatedLabel label={String(workingCount)} textClassName="tabular-nums" /> working
              </span>
            )}
          </div>
        </div>
      )}

      <div className="flex items-center gap-1">
        {/* Overflow menu — panel management actions */}
        {hasOverflowItems && (
          <TooltipProvider>
            <DropdownMenu
              onOpenChange={(open) => {
                if (open) setOverflowTooltipOpen(false);
              }}
            >
              <Tooltip open={overflowTooltipOpen} onOpenChange={setOverflowTooltipOpen}>
                <TooltipTrigger asChild>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      onPointerDown={(e) => e.stopPropagation()}
                      className="p-1.5 hover:bg-daintree-text/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent focus-visible:outline-offset-2 text-daintree-text/60 hover:text-daintree-text transition-colors"
                      aria-label="More panel actions"
                    >
                      <Ellipsis className="w-3 h-3" aria-hidden="true" />
                    </button>
                  </DropdownMenuTrigger>
                </TooltipTrigger>
                <TooltipContent side="bottom">More panel actions</TooltipContent>
              </Tooltip>
              <DropdownMenuContent align="end" className="min-w-[160px]">
                {/* Session group */}
                {canRestart && onRestart && (
                  <DropdownMenuItem
                    onSelect={handleRestartSelect}
                    className={cn(
                      armedRestartId === id && "bg-status-warning/10 text-status-warning"
                    )}
                    data-testid={armedRestartId === id ? "panel-restart-confirm" : "panel-restart"}
                    aria-label={
                      armedRestartId === id
                        ? `Armed — click again to confirm restart. ${countdown !== null ? `${countdown} seconds remaining` : ""}`
                        : "Restart Session"
                    }
                  >
                    <RotateCcw className="w-3 h-3 mr-2" aria-hidden="true" />
                    {armedRestartId === id
                      ? `Confirm Restart (${countdown ?? 0}s)`
                      : "Restart Session"}
                  </DropdownMenuItem>
                )}

                {agentId && (
                  <DropdownMenuItem
                    onSelect={() =>
                      void actionService.dispatch(
                        "terminal.moveToNewWorktree",
                        { terminalId: id },
                        { source: "menu" }
                      )
                    }
                  >
                    <WorktreeIcon className="w-3 h-3 mr-2" aria-hidden="true" />
                    Move to New Worktree…
                  </DropdownMenuItem>
                )}

                {/* Management group */}
                {((canRestart && onRestart) || agentId) && <DropdownMenuSeparator />}
                {location === "dock" && onRestore && (
                  <DropdownMenuItem onSelect={() => onRestore()}>
                    <MoveToGridIcon className="w-3 h-3 mr-2" aria-hidden="true" />
                    Restore to Grid
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem
                  onSelect={() =>
                    void actionService.dispatch(
                      "terminal.rename",
                      { terminalId: id },
                      { source: "menu" }
                    )
                  }
                >
                  <Pencil className="w-3 h-3 mr-2" aria-hidden="true" />
                  Rename
                </DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={() =>
                    void actionService.dispatch(
                      "terminal.duplicate",
                      { terminalId: id },
                      { source: "menu" }
                    )
                  }
                >
                  <CopyPlus className="w-3 h-3 mr-2" aria-hidden="true" />
                  Duplicate
                </DropdownMenuItem>
                {hasPty && (
                  <DropdownMenuItem
                    onSelect={() =>
                      void actionService.dispatch(
                        "terminal.toggleInputLock",
                        { terminalId: id },
                        { source: "menu" }
                      )
                    }
                  >
                    {isInputLocked ? (
                      <Unlock className="w-3 h-3 mr-2" aria-hidden="true" />
                    ) : (
                      <Lock className="w-3 h-3 mr-2" aria-hidden="true" />
                    )}
                    {isInputLocked ? "Unlock Input" : "Lock Input"}
                  </DropdownMenuItem>
                )}
                {showWatchButton && (
                  <DropdownMenuItem onSelect={handleWatchToggle}>
                    {isWatched ? (
                      <BellOff className="w-3 h-3 mr-2" aria-hidden="true" />
                    ) : (
                      <Bell className="w-3 h-3 mr-2" aria-hidden="true" />
                    )}
                    {isWatched ? "Cancel Watch" : "Watch"}
                  </DropdownMenuItem>
                )}
                {hasPty && (
                  <DropdownMenuItem
                    onSelect={() =>
                      void actionService.dispatch(
                        "terminal.viewInfo",
                        { terminalId: id },
                        { source: "menu" }
                      )
                    }
                  >
                    <Info className="w-3 h-3 mr-2" aria-hidden="true" />
                    View Terminal Info
                  </DropdownMenuItem>
                )}

                {/* Header actions slot */}
                {headerActions && <DropdownMenuSeparator />}
                {headerActions}

                {/* Destructive group */}
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  destructive
                  onSelect={() =>
                    void actionService.dispatch(
                      "terminal.trash",
                      { terminalId: id },
                      { source: "menu" }
                    )
                  }
                >
                  <Trash2 className="w-3 h-3 mr-2" aria-hidden="true" />
                  Trash
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </TooltipProvider>
        )}

        {/* Move to Dock — visible button for grid panels */}
        {showMoveToDock && (
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onMinimize!();
                  }}
                  onPointerDown={(e) => e.stopPropagation()}
                  className="p-1.5 hover:bg-daintree-text/10 focus-visible:bg-daintree-text/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent focus-visible:outline-offset-2 text-daintree-text/60 hover:text-daintree-text transition-colors"
                  aria-label="Move to Dock"
                  data-testid="panel-move-to-dock"
                >
                  <MoveToDockIcon className="w-3 h-3" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                {createTooltipWithShortcut("Move to Dock", moveToDockShortcut)}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        )}

        {/* Middle control: Collapse-to-Dock / Maximize / Exit Focus */}
        {location === "dock" && onMinimize ? (
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onMinimize();
                  }}
                  onPointerDown={(e) => e.stopPropagation()}
                  className="p-1.5 hover:bg-daintree-text/10 focus-visible:bg-daintree-text/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent focus-visible:outline-offset-2 text-daintree-text/60 hover:text-daintree-text transition-colors"
                  aria-label="Collapse to Dock"
                  data-testid="panel-collapse-to-dock"
                >
                  <MoveToDockIcon className="w-3 h-3" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                {createTooltipWithShortcut("Collapse to Dock", toggleDockShortcut)}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        ) : onToggleMaximize && isMaximized ? (
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onFocus();
                    onToggleMaximize();
                  }}
                  onPointerDown={(e) => e.stopPropagation()}
                  className="flex items-center gap-1.5 px-2 py-1 bg-daintree-accent/10 text-daintree-accent hover:bg-daintree-accent/20 rounded transition-colors mr-1 focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent focus-visible:outline-offset-2"
                  aria-label="Exit Focus mode and restore grid view"
                >
                  <Minimize2 className="w-3.5 h-3.5" aria-hidden="true" />
                  <span className="font-medium">Exit Focus</span>
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                {createTooltipWithShortcut("Restore Grid View", maximizeShortcut)}
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
                    onPointerDown={(e) => e.stopPropagation()}
                    className="p-1.5 hover:bg-daintree-text/10 focus-visible:bg-daintree-text/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent focus-visible:outline-offset-2 text-daintree-text/60 hover:text-daintree-text transition-colors"
                    aria-label="Maximize"
                  >
                    <Maximize2 className="w-3 h-3" aria-hidden="true" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  {createTooltipWithShortcut("Maximize", maximizeShortcut)}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )
        )}

        {/* Close button */}
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
                onPointerDown={(e) => e.stopPropagation()}
                className="p-1.5 hover:bg-[color-mix(in_oklab,var(--color-status-error)_15%,transparent)] focus-visible:bg-[color-mix(in_oklab,var(--color-status-error)_15%,transparent)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-status-error focus-visible:outline-offset-2 text-daintree-text/60 hover:text-status-error transition-colors"
                data-testid="panel-close"
                aria-label={formatShortcutForTooltip(
                  "Close session. Hold Alt and click to force close without recovery."
                )}
              >
                <X className="w-3 h-3" aria-hidden="true" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {createTooltipWithShortcut("Close Session", closeShortcut) +
                " · " +
                formatShortcutForTooltip("Alt+Click to force close")}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>

        {/* Kind-specific header content slot */}
        {headerContent}
      </div>
    </div>
  );
}

export const PanelHeader = PanelHeaderComponent;
