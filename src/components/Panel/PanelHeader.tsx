import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
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
  Plus,
  RadioTower,
  Bell,
  BellOff,
  ChevronDown,
  CopyPlus,
  Ellipsis,
  Lock,
  PanelBottomClose,
  PanelTopClose,
  Pencil,
  RefreshCw,
  ShieldAlert,
  Trash2,
  Unlock,
} from "lucide-react";
import {
  DndContext,
  closestCenter,
  useSensor,
  useSensors,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  type DragEndEvent,
  type UniqueIdentifier,
} from "@dnd-kit/core";
import {
  SortableContext,
  horizontalListSortingStrategy,
  arrayMove,
  sortableKeyboardCoordinates,
} from "@dnd-kit/sortable";
import { restrictToHorizontalAxis, restrictToParentElement } from "@dnd-kit/modifiers";
import { PanelTabList } from "./PanelTabList";
import type { PanelKind } from "@/types";
import { cn } from "@/lib/utils";
import { formatShortcutForTooltip } from "@/lib/platform";
import { createTooltipContent } from "@/lib/tooltipShortcut";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { SurfaceHeader } from "@/components/ui/SurfaceHeader";
import { Button } from "@/components/ui/button";
import { AnimatedLabel } from "@/components/ui/AnimatedLabel";
import {
  STATE_COLORS,
  STATE_ICONS,
  getEffectiveStateColor,
  getEffectiveStateIcon,
  getEffectiveStateLabel,
} from "@/components/Worktree/terminalStateConfig";
import { TerminalIcon } from "@/components/Terminal/TerminalIcon";
import { PluginPanelBadges } from "@/components/Panel/PluginPanelBadges";
import { BellDot, FolderGit2 } from "@/components/icons";
import { useDragHandle } from "@/components/DragDrop/DragHandleContext";
import { makeSortableAnnouncements } from "@/components/DragDrop/sortableAnnouncements";
import {
  useAriaKeyshortcuts,
  useBackgroundPanelStats,
  useKeybindingDisplay,
  useTabOverflow,
} from "@/hooks";
import { useIsHibernated } from "@/hooks/useIsHibernated";
import { useToolbarRoving } from "@/hooks/useToolbarRoving";
import { usePanelStore } from "@/store/panelStore";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { TabButton, type TabInfo } from "./TabButton";
import { SortableTabButton } from "./SortableTabButton";

import {
  panelKindCanRestart,
  panelKindHasPty,
  panelKindIsDockable,
} from "@shared/config/panelKindRegistry";
import { isPtyPanel } from "@shared/types/panel";
import { actionService } from "@/services/ActionService";
import { fireWatchNotification } from "@/lib/watchNotification";
import { useFleetFailureStore } from "@/store/fleetFailureStore";
import { useFleetArmingStore } from "@/store/fleetArmingStore";
import type { TerminalChromeDescriptor } from "@/utils/terminalChrome";
import type { BrandMarkSurface } from "@/lib/brandIcon";

export interface PanelHeaderProps {
  id: string;
  title: string;
  /**
   * The task-first form of the title for a narrow header. Swapped in by a
   * container query at 420px of header width; the accessible name, the
   * tooltip and the rename prefill always use the full title.
   */
  compactTitle?: string;
  /** The id of the region the tab strip switches, for each tab's `aria-controls`. */
  tabPanelId?: string;
  kind: PanelKind;
  agentId?: string;
  chrome: TerminalChromeDescriptor;
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
  /**
   * Render the inline "Move to grid" control in the dock header. Gated so it
   * isn't duplicated by DockedTabGroup's own restore button on grouped panels
   * (single-panel dock only). onRestore still powers double-click + the
   * overflow-menu "Move to grid" item regardless of this flag.
   */
  showRestoreControl?: boolean;
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

  // Hover/focus preview from the fleet selection menu. When true, the title
  // bar lifts to a faint neutral tint (no accent) so the user sees which
  // panes a state-preset menu item would arm before they commit. Cleared
  // on pointer-leave / blur / menu close. Distinct from `isSelected` —
  // preview never paints the same surface as actual selection.
  isFleetPreviewed?: boolean;

  // Slots for kind-specific content. Neither renders inside the window
  // controls (#12374): `headerContent` is variable-width metadata that follows
  // the title and clips before it can reach them, and `headerStatus` is
  // transient status in a fixed box reserved just ahead of them — so nothing
  // appearing or disappearing can move close or maximize. For the two boxed
  // slots `undefined` means no box at all and `null` means an empty box, so a
  // mixed tab group can keep its boxes while a non-terminal tab is active.
  headerContent?: ReactNode;
  headerStatus?: ReactNode;
  headerActions?: ReactNode;

  // The agent state glyph. It is the single most important signal in the app
  // and a deliberate special case: it renders all the way right, PAST the close
  // button, in a fixed box reserved whenever the slot is wired. It NEVER MOVES —
  // not for a status, not for metadata, not for anything else that comes and
  // goes — and nothing else is ever placed after the close button.
  agentIndicator?: ReactNode;

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
  compactTitle,
  tabPanelId,
  kind,
  agentId,
  chrome,
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
  showRestoreControl,
  onRestart,
  isPinged,
  wasJustSelected = false,
  isSelected = false,
  isFleetFollower = false,
  isFleetPreviewed = false,
  headerContent,
  headerStatus,
  headerActions,
  agentIndicator,
  tabs,
  groupId,
  onTabClick,
  onTabClose,
  onTabRename,
  onAddTab,
  onTabReorder,
}: PanelHeaderProps) {
  const dragHandle = useDragHandle();

  // The window controls are one toolbar: one Tab stop per pane, arrows within.
  // Six panes cost six presses to cross, not twenty-four.
  // Not in the dock: a dock preview is hosted inside a Radix popover, and the
  // hook excludes controls under a popper wrapper (it means an open menu),
  // which would leave a dock header with no Tab stop at all.
  const controlsRef = useRef<HTMLDivElement | null>(null);
  const handleControlsKeyDown = useToolbarRoving(controlsRef, location !== "dock");
  const pendingTabFocusRef = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (pendingTabFocusRef.current !== null) {
        cancelAnimationFrame(pendingTabFocusRef.current);
      }
    },
    []
  );

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
  const { activeCount, workingCount, waitingCount } = useBackgroundPanelStats(id, isMaximized);

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
  const showWatchButton = chrome.isAgent;

  // Fleet failure state for this pane: when the most recent broadcast
  // rejected on this terminal (e.g. PTY died mid-paste), surface a red
  // dot adjacent to the title so the user can see the divergence at the
  // pane the same way a "Retry failed" button surfaces it in the ribbon.
  const isFleetFailed = useFleetFailureStore((s) => s.failedIds.has(id));
  const dismissFleetFailure = useFleetFailureStore((s) => s.dismissId);
  const isArmed = useFleetArmingStore((s) => s.armedIds.has(id));

  const duplicateShortcut = useKeybindingDisplay("terminal.duplicate");
  const moveToDockShortcut = useKeybindingDisplay("terminal.moveToDock");
  const maximizeShortcut = useKeybindingDisplay("terminal.maximize");
  const closeShortcut = useKeybindingDisplay("terminal.close");
  const duplicateAriaShortcut = useAriaKeyshortcuts("terminal.duplicate");
  const moveToDockAriaShortcut = useAriaKeyshortcuts("terminal.moveToDock");
  const maximizeAriaShortcut = useAriaKeyshortcuts("terminal.maximize");
  const closeAriaShortcut = useAriaKeyshortcuts("terminal.close");
  const addTabTooltipContent = createTooltipContent(
    "Duplicate panel as new tab",
    duplicateShortcut
  );

  const isInputLocked = usePanelStore((state) => {
    const panel = state.panelsById[id];
    return panel && isPtyPanel(panel) ? (panel.isInputLocked ?? false) : false;
  });
  const hasPty = panelKindHasPty(kind);
  const isHibernated = useIsHibernated(id);

  // Whether the overflow "..." menu has any items to show.
  // Dock membership is capability-gated by the registry: kinds are dockable by
  // default and a handful opt out with `dockable: false` (#10985, #11917).
  // Offering the affordance for an opted-out kind would silently strand it.
  const showMoveToDock =
    !!onMinimize && !isMaximized && location !== "dock" && panelKindIsDockable(kind);
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
      return;
    }
    const panel = usePanelStore.getState().panelsById[id];
    const panelPty = panel && isPtyPanel(panel) ? panel : undefined;
    if (
      panelPty?.agentState === "completed" ||
      panelPty?.agentState === "waiting" ||
      panelPty?.agentState === "exited"
    ) {
      fireWatchNotification(id, panel?.title ?? id, panelPty.agentState);
    } else {
      watchPanel(id);
    }
  }, [id, isWatched, unwatchPanel, watchPanel]);

  // Bump a generation counter on each false→true transition of
  // `isFleetPreviewed` so the enter-cue overlay (keyed by this counter)
  // remounts and re-runs its keyframe. Avoids a per-pane `void offsetWidth`
  // forced reflow that would thrash layout across a fleet of headers.
  const prevFleetPreviewedRef = useRef(isFleetPreviewed);
  const [previewEnterGen, setPreviewEnterGen] = useState(0);
  useEffect(() => {
    if (!prevFleetPreviewedRef.current && isFleetPreviewed) {
      setPreviewEnterGen((g) => g + 1);
    }
    prevFleetPreviewedRef.current = isFleetPreviewed;
  }, [isFleetPreviewed]);

  // The title prop is already variant-resolved by ContentPanel (identity-only
  // in the dock, task-composed in the grid) — render it verbatim.
  const displayTitle = title;
  // What the title actually paints: the full composition, or under 420px of
  // header the task alone — "fix flaky auth tests" tells panes apart where
  // "Claud…" cannot, and the glyph carries identity. Shared by the static
  // title and by the invisible copy that sizes the rename field, so the two
  // measure identically.
  const titleContent =
    compactTitle && compactTitle !== displayTitle ? (
      <>
        <span className="@max-[420px]/header:hidden">{displayTitle}</span>
        <span className="hidden @max-[420px]/header:inline">{compactTitle}</span>
      </>
    ) : (
      displayTitle
    );
  // A truncated badge, or one hidden by the compact query, still has to give
  // the branch back somewhere — the title tooltip carries it.
  const titleTooltip = [title, worktreeBranch && worktreeAccentColor ? worktreeBranch : null]
    .filter(Boolean)
    .join(" · ");

  const handleHeaderDoubleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    if (target.closest("button, input, [role='button']")) {
      return;
    }
    if (location === "dock") {
      onRestore?.();
    } else {
      onToggleMaximize?.();
    }
  };

  const getAriaLabel = () => {
    if (kind === "browser") return "Edit browser title";
    if (kind === "review") return "Edit review title";
    if (!chrome.isAgent && kind === "terminal") return "Edit terminal title";
    return "Edit agent title";
  };

  const getTitleAriaLabel = () => {
    const prefix =
      kind === "browser"
        ? "Browser title"
        : kind === "review"
          ? "Review title"
          : !chrome.isAgent && kind === "terminal"
            ? "Terminal title"
            : "Agent title";
    return `${prefix}: ${title}. Press Enter or F2 to edit`;
  };

  const hasTabs = tabs && tabs.length > 1;
  const [tabListEl, setTabListEl] = useState<HTMLDivElement | null>(null);
  const canReorderTabs = hasTabs && !!onTabReorder && !!groupId;
  const tabIds = tabs?.map((t) => t.id) ?? [];

  const hiddenTabIds = useTabOverflow(tabListEl, tabIds);
  const hiddenTabs = tabs?.filter((t) => hiddenTabIds.has(t.id)) ?? [];

  const activeTabId = tabs?.find((t) => t.isActive)?.id ?? null;

  useLayoutEffect(() => {
    if (!tabListEl || !activeTabId || isDragging) return;

    const tabEl = tabListEl.querySelector(`[data-tab-id="${activeTabId}"]`) as HTMLElement | null;
    if (!tabEl) return;

    const containerLeft = tabListEl.scrollLeft;
    const containerRight = containerLeft + tabListEl.clientWidth;
    const tabLeft = tabEl.offsetLeft;
    const tabRight = tabLeft + tabEl.offsetWidth;

    // A tab wider than the strip cannot fit either way; show its start — the
    // brand glyph and the first words are what identify it, not its close.
    if (tabLeft < containerLeft || tabEl.offsetWidth > tabListEl.clientWidth) {
      tabListEl.scrollTo({ left: tabLeft, behavior: "smooth" });
    } else if (tabRight > containerRight) {
      tabListEl.scrollTo({ left: tabRight - tabListEl.clientWidth, behavior: "smooth" });
    }
  }, [activeTabId, isDragging, tabListEl]);

  // Sensors for tab drag-and-drop (require small distance to differentiate from clicks)
  const tabSensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 5 },
    }),
    useSensor(TouchSensor, {
      activationConstraint: { delay: 150, tolerance: 5 },
    }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  // Surface-specific ARIA announcements — without this dnd-kit reads the
  // generic English defaults ("Picked up draggable item <id>").
  const getTabLabel = useCallback(
    (tabId: UniqueIdentifier) => {
      const tab = tabs?.find((t) => t.id === tabId);
      return tab ? tab.title : null;
    },
    [tabs]
  );
  const tabAnnouncements = useMemo(
    () => makeSortableAnnouncements(getTabLabel, "tab"),
    [getTabLabel]
  );

  // Restrict dnd-kit's autoscroller to the horizontal tab strip itself so its
  // scrollable-ancestor walk doesn't scroll the surrounding panel content.
  const tabAutoScroll = useMemo(
    () => ({ canScroll: (el: Element) => el === tabListEl }),
    [tabListEl]
  );

  // While a tab drag is live (keyboard pickup), the tablist arrow handler must
  // not also move focus/selection — dnd-kit's sensor owns the arrow keys.
  const isTabDragActiveRef = useRef(false);
  const handleTabDragStart = useCallback(() => {
    isTabDragActiveRef.current = true;
  }, []);
  const handleTabDragCancel = useCallback(() => {
    isTabDragActiveRef.current = false;
  }, []);

  // Handle tab reorder drag end
  const handleTabDragEnd = useCallback(
    (event: DragEndEvent) => {
      isTabDragActiveRef.current = false;
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
      if (isTabDragActiveRef.current) return;
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
        // Focus after the activation has rendered: a parked tab is
        // `visibility: hidden` until it becomes active, and a hidden element
        // refuses focus.
        if (pendingTabFocusRef.current !== null) {
          cancelAnimationFrame(pendingTabFocusRef.current);
        }
        pendingTabFocusRef.current = requestAnimationFrame(() => {
          pendingTabFocusRef.current = null;
          const tabButton = tabListEl?.querySelector(
            `[data-tab-id="${nextTab.id}"]`
          ) as HTMLElement | null;
          tabButton?.focus();
        });
      }
    },
    [tabs, onTabClick, tabListEl]
  );

  // A tab you cannot see can still be the one asking for you. The trigger wears
  // the same waiting mark the hidden tab would, so the strip never hides an
  // agent that needs input behind a bare chevron.
  const hiddenWaitingCount = hiddenTabs.filter((t) => t.agentState === "waiting").length;
  const hiddenTabsLabel =
    hiddenWaitingCount > 0
      ? `Show ${hiddenTabs.length} hidden tabs, ${hiddenWaitingCount} waiting for input`
      : `Show ${hiddenTabs.length} hidden tabs`;
  const overflowTrigger = hiddenTabs.length > 0 && (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              onPointerDown={(e) => e.stopPropagation()}
              className="relative shrink-0"
              aria-label={hiddenTabsLabel}
              aria-haspopup="menu"
              data-testid="panel-tabs-overflow"
            >
              <ChevronDown aria-hidden="true" />
              {hiddenWaitingCount > 0 && (
                <span
                  className="status-mark absolute top-0.5 right-0.5 h-1.5 w-1.5 rounded-full bg-[var(--color-state-waiting)]"
                  data-testid="panel-tabs-overflow-waiting"
                  aria-hidden="true"
                />
              )}
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom">{hiddenTabsLabel}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent
        align="end"
        className="min-w-[200px] max-w-[320px] max-h-[var(--radix-dropdown-menu-content-available-height)] overflow-y-auto"
      >
        {hiddenTabs.map((tab) => {
          const StateIcon = tab.agentState ? getEffectiveStateIcon(tab.agentState) : null;
          return (
            <DropdownMenuItem
              key={tab.id}
              onSelect={() => onTabClick?.(tab.id)}
              aria-current={tab.isActive ? "true" : undefined}
              className={cn(tab.isActive && "font-medium")}
            >
              <span className="shrink-0 mr-2 inline-flex items-center justify-center w-3.5 h-3.5">
                <TerminalIcon
                  kind={tab.kind}
                  chrome={tab.chrome}
                  className="w-3.5 h-3.5"
                  brandColor={tab.presetColor ?? tab.chrome.color}
                />
              </span>
              <span className="truncate">{tab.title}</span>
              {StateIcon && tab.agentState && (
                <span className="sr-only">, {getEffectiveStateLabel(tab.agentState)}</span>
              )}
              {StateIcon && tab.agentState && (
                <StateIcon
                  className={cn(
                    "ml-auto h-3 w-3 shrink-0",
                    getEffectiveStateColor(tab.agentState),
                    tab.agentState === "working" && "animate-spin-slow motion-reduce:animate-none"
                  )}
                  aria-hidden="true"
                />
              )}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );

  // The whole header is the drag surface for pointer drag. For keyboard drag,
  // dnd-kit's KeyboardSensor needs a focusable activator node; falling back to
  // the sortable container's setNodeRef silently fails because SortableTerminal
  // / SortableDockItem strip role/tabIndex to satisfy axe nested-interactive.
  // Attach setActivatorNodeRef here and add tabIndex={0} only when drag
  // listeners are live (i.e. the panel is reorderable). aria-roledescription
  // gives screen reader users an action hint paired with the live
  // screenReaderInstructions wired in DndProvider.
  const headerHasDrag = !!dragListeners;
  const headerActivatorRef = headerHasDrag ? dragHandle?.setActivatorNodeRef : undefined;

  // The backdrop this title bar's brand marks are measured against — the same
  // colour the header paints below, named rather than re-derived. Several light
  // themes repaint title bars outright through `panel-header-*`, so the
  // extension is part of the answer rather than a refinement of it.
  const brandSurface: BrandMarkSurface = isMaximized
    ? { surface: "surface-sidebar" }
    : location === "dock"
      ? { surface: "surface-panel" }
      : isFocused || isSelected
        ? {
            surface: "surface-panel",
            extension: "panel-header-focus-bg",
            lift: "overlay-medium",
          }
        : { surface: "surface-panel", extension: "panel-header-bg" };

  return (
    // Compact density supplies the shared frame (h-8, px-3, border-b
    // border-divider, flex alignment, shrink-0); everything panel-only —
    // drag surface, state backgrounds, follower stripe, tab strip, badges,
    // control cluster — stays composed here rather than folded into the
    // primitive.
    <SurfaceHeader
      density="compact"
      brandSurface={brandSurface}
      ref={headerActivatorRef}
      {...dragListeners}
      tabIndex={headerHasDrag ? 0 : undefined}
      role={headerHasDrag ? "group" : undefined}
      aria-roledescription={
        headerHasDrag
          ? "Draggable panel header — press Space or Enter to pick up, arrows to move, Escape to cancel"
          : undefined
      }
      data-selected={isSelected || undefined}
      data-fleet-follower={isFleetFollower || undefined}
      data-fleet-previewed={isFleetPreviewed || undefined}
      data-pane-chrome=""
      className={cn(
        "@container/header text-xs transition-colors relative overflow-hidden group select-none",
        isMaximized
          ? "h-10 bg-surface-sidebar border-border-default"
          : location === "dock"
            ? "bg-surface"
            : isFocused || isSelected
              ? // The var hook lets a theme repaint the lifted bar; the fallback
                // is the strongest neutral overlay step, so on a theme without
                // the hook the pane you type into still reads as lifted.
                "bg-[var(--panel-header-focus-bg,var(--color-overlay-medium))]"
              : // Preview tint sits between transparent and the focus lift so a
                // previewed-but-unselected pane reads distinctly from both.
                // Neutral surface, no accent — accent restraint per CLAUDE.md.
                isFleetPreviewed
                ? "bg-overlay-subtle"
                : "bg-[var(--panel-header-bg,transparent)]",
        // Mirror the fleet ribbon's 2px amber left stripe on follower panes.
        // The stripe sits in the title bar — fovea-adjacent when reading the
        // pane body — so users don't have to look up at the ribbon to verify
        // which panes will receive their keystrokes.
        isFleetFollower &&
          // Solid amber, not the ribbon's mixed border token: on the lifted header
          // that mix measures under 1.7:1 and the stripe is the follower's only
          // cue besides the glyph.
          "before:absolute before:inset-y-0 before:left-0 before:w-0.5 before:bg-category-amber before:z-[1] forced-colors:before:bg-[CanvasText]",
        dragListeners && "cursor-grab active:cursor-grabbing",
        isPinged && !isMaximized && "animate-terminal-header-ping",
        isDragging && "pointer-events-none"
      )}
      onDoubleClick={handleHeaderDoubleClick}
    >
      {/* The only region that absorbs width changes: title or tabs, then
          kind-specific metadata. The status box and controls after it never
          shrink, so their position depends on the header width alone. */}
      <div className="flex min-w-0 flex-1 items-center gap-2 self-stretch">
        {/* Tab bar - shown when there are multiple tabs */}
        {hasTabs && tabs ? (
          canReorderTabs ? (
            <DndContext
              sensors={tabSensors}
              collisionDetection={closestCenter}
              onDragStart={handleTabDragStart}
              onDragEnd={handleTabDragEnd}
              onDragCancel={handleTabDragCancel}
              modifiers={[restrictToHorizontalAxis, restrictToParentElement]}
              autoScroll={tabAutoScroll}
              accessibility={{ announcements: tabAnnouncements }}
            >
              <SortableContext items={tabIds} strategy={horizontalListSortingStrategy}>
                <PanelTabList
                  layoutGroupId={`panel-tabs-dnd-${id}`}
                  tabs={tabs}
                  hiddenTabIds={hiddenTabIds}
                  tabListRef={setTabListEl}
                  onKeyDown={handleTabListKeyDown}
                  onAddTab={onAddTab}
                  addTabTooltipContent={addTabTooltipContent}
                  overflowTrigger={overflowTrigger}
                  renderTab={(tab, parked) => (
                    <SortableTabButton
                      key={tab.id}
                      id={tab.id}
                      parked={parked}
                      title={tab.title}
                      fullTitle={tab.fullTitle}
                      chrome={tab.chrome}
                      kind={tab.kind}
                      agentState={tab.agentState}
                      isActive={tab.isActive}
                      presetColor={tab.presetColor}
                      isUsingFallback={tab.isUsingFallback}
                      fallbackTooltip={tab.fallbackTooltip}
                      hasDangerousFlags={tab.hasDangerousFlags}
                      tabPanelId={tabPanelId}
                      onClick={() => onTabClick?.(tab.id)}
                      onClose={() => onTabClose?.(tab.id)}
                      onRename={
                        onTabRename ? (newTitle) => onTabRename(tab.id, newTitle) : undefined
                      }
                    />
                  )}
                />
              </SortableContext>
            </DndContext>
          ) : (
            <PanelTabList
              layoutGroupId={`panel-tabs-static-${id}`}
              tabs={tabs}
              hiddenTabIds={hiddenTabIds}
              tabListRef={setTabListEl}
              onKeyDown={handleTabListKeyDown}
              onAddTab={onAddTab}
              addTabTooltipContent={addTabTooltipContent}
              overflowTrigger={overflowTrigger}
              renderTab={(tab, parked) => (
                <TabButton
                  key={tab.id}
                  id={tab.id}
                  parked={parked}
                  title={tab.title}
                  fullTitle={tab.fullTitle}
                  chrome={tab.chrome}
                  kind={tab.kind}
                  agentState={tab.agentState}
                  isActive={tab.isActive}
                  presetColor={tab.presetColor}
                  isUsingFallback={tab.isUsingFallback}
                  fallbackTooltip={tab.fallbackTooltip}
                  hasDangerousFlags={tab.hasDangerousFlags}
                  tabPanelId={tabPanelId}
                  onClick={() => onTabClick?.(tab.id)}
                  onClose={() => onTabClose?.(tab.id)}
                  onRename={onTabRename ? (newTitle) => onTabRename(tab.id, newTitle) : undefined}
                />
              )}
            />
          )
        ) : (
          // overflow-hidden is the hard edge: whatever this group cannot fit is
          // clipped here, never painted over the status box or the controls.
          // px-1 -mx-1 reserves 4px inside the clip on both sides: the rename
          // field extends that far past the title's box, and without the room its
          // own edge is what gets clipped when the title is the last item.
          <div className="-mx-1 flex min-w-0 items-center gap-2 self-stretch overflow-hidden px-1">
            {/* The pane you are working in wears its agent's real brand colour;
              the ones you are not sit a step back. `data-brand-active` goes on
              the glyph's own wrapper rather than the header so it cannot leak
              onto the tab strip, where selection is each tab's to signal. */}
            <span
              data-brand-active={isFocused || isSelected || undefined}
              className="shrink-0 flex items-center justify-center w-3.5 h-3.5 text-text-primary"
            >
              <TerminalIcon
                kind={kind}
                chrome={chrome}
                className="w-3.5 h-3.5"
                brandColor={presetColor ?? chrome.color}
              />
            </span>

            {isEditingTitle ? (
              // The field takes exactly the box the static title had: an
              // invisible copy of the title sizes the cell and the input fills
              // it, so nothing beside it moves when editing starts and ends.
              // px-1 is paid back with -mx-1 so the first glyph stays put.
              // Chrome-free by ruling (#7926): the lift is the cue.
              <div className="grid min-w-0 shrink" data-testid="panel-title-edit-box">
                <span
                  aria-hidden="true"
                  className="invisible col-start-1 row-start-1 block h-6 min-w-[6ch] truncate text-xs font-medium leading-6"
                >
                  {titleContent}
                </span>
                {/* [data-no-dnd] opts the rename field out of the header drag
                    surface: without it, drag-selecting the title text travels
                    past DRAG_ACTIVATION_DISTANCE and picks the panel up instead. */}
                <input
                  data-no-dnd
                  ref={titleInputRef}
                  type="text"
                  value={editingValue}
                  onChange={(e) => onEditingValueChange(e.target.value)}
                  onKeyDown={onTitleInputKeyDown}
                  onBlur={onTitleSave}
                  // Focus is shown by the field itself, without accent (#7926):
                  // the wash deepens and its edge appears while it has focus.
                  className="col-start-1 row-start-1 -mx-1 h-6 w-[calc(100%+0.5rem)] rounded-sm border border-transparent bg-overlay-soft px-1 text-xs font-medium leading-6 text-text-primary select-text transition-colors focus:outline-hidden focus-visible:border-divider focus-visible:bg-overlay-medium"
                  aria-label={getAriaLabel()}
                />
              </div>
            ) : (
              <div className="flex items-center gap-2 min-w-0">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span
                      className={cn(
                        // min-w-[6ch]: the title is the last thing to yield —
                        // a badge or a queue count never squeezes it to nothing.
                        // The ring is declared here rather than left to the UA
                        // default so it matches the controls beside it.
                        "text-xs font-medium font-sans select-none transition-colors block truncate min-w-[6ch] min-h-6 leading-6 rounded-sm",
                        onTitleChange &&
                          "focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:outline-offset-1",
                        isFocused || isSelected ? "text-text-primary" : "text-text-secondary",
                        onTitleChange && "cursor-text hover:text-text-primary",
                        isPinged &&
                          !isMaximized &&
                          (wasJustSelected ? "animate-eco-title-select" : "animate-eco-title")
                      )}
                      onDoubleClick={onTitleDoubleClick}
                      onKeyDown={onTitleKeyDown}
                      tabIndex={onTitleChange ? 0 : undefined}
                      role={onTitleChange ? "button" : undefined}
                      aria-label={onTitleChange ? getTitleAriaLabel() : undefined}
                      data-fleet-gesture-passthrough=""
                    >
                      {titleContent}
                    </span>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">
                    {onTitleChange
                      ? `${titleTooltip} — Double-click or F2 to rename`
                      : titleTooltip}
                  </TooltipContent>
                </Tooltip>
              </div>
            )}

            {hasDangerousFlags && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span
                    role="img"
                    className="inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center text-status-danger"
                    aria-label="Launched with dangerous permissions"
                    data-testid="panel-dangerous-flags-mark"
                  >
                    <ShieldAlert className="h-3.5 w-3.5" aria-hidden="true" />
                  </span>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  Launched with dangerous permissions — agent can modify files without prompting
                </TooltipContent>
              </Tooltip>
            )}

            {isFleetFailed && (
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
                    // The mark stays an 8px dot; the button around it is the
                    // 24px target. -mx-1 keeps its footprint in the row at 16px.
                    className="-mx-1 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-sm transition-colors hover:bg-overlay-soft focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:outline-offset-1"
                  >
                    <span
                      className="status-mark h-2 w-2 rounded-full bg-status-error"
                      aria-hidden="true"
                    />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  Last fleet broadcast failed here — click to dismiss. Run "Fleet: Retry failed
                  broadcast" from the command palette to resend.
                </TooltipContent>
              </Tooltip>
            )}

            {chrome.isAgent && isArmed && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span
                    role="status"
                    aria-label="Armed for fleet broadcast"
                    data-testid="panel-armed-broadcast-indicator"
                    className="shrink-0 text-category-amber-text"
                  >
                    <RadioTower className="h-3.5 w-3.5" aria-hidden="true" />
                  </span>
                </TooltipTrigger>
                <TooltipContent side="bottom">Armed for fleet broadcast</TooltipContent>
              </Tooltip>
            )}

            {/* Watch status indicator — non-interactive, shown when actively watching */}
            {showWatchButton && isWatched && (
              <span
                role="status"
                aria-label="Watching — waiting for agent completion"
                className="text-text-secondary cursor-default"
              >
                <BellDot className="w-3 h-3 animate-pulse motion-reduce:animate-none" />
              </span>
            )}

            {/* Live plugin-contributed badges (host.setPanelBadge) for this panel */}
            <PluginPanelBadges panelId={id} />

            {/* Add tab button for single panels */}
            {onAddTab && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    onClick={(e) => {
                      e.stopPropagation();
                      onAddTab();
                    }}
                    onPointerDown={(e) => e.stopPropagation()}
                    // Revealed by hover or by keyboard focus anywhere in the
                    // header, so a keyboard user on the title can find it.
                    className="shrink-0 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 @max-[420px]/header:hidden"
                    aria-label="Duplicate panel as new tab"
                    aria-keyshortcuts={duplicateAriaShortcut}
                  >
                    <Plus aria-hidden="true" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  {createTooltipContent("Duplicate panel as new tab", duplicateShortcut)}
                </TooltipContent>
              </Tooltip>
            )}

            {/* Worktree branch badge — shown when multiple worktrees are active */}
            {worktreeBranch && worktreeAccentColor && (
              // The worktree colour carries identity through the wash and the
              // edge; the text itself stays on the readable token — the palette
              // measures under 4.5:1 as ink on either light or dark headers.
              // min-w-[7ch] with truncate: the badge yields before the title
              // does but never to a single letter; the tooltip has the rest.
              <Tooltip>
                <TooltipTrigger asChild>
                  <span
                    className="min-w-[7ch] max-w-[120px] inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-3xs font-medium leading-none text-text-primary select-none @max-[420px]/header:hidden"
                    style={
                      {
                        backgroundColor:
                          "color-mix(in oklab, var(--worktree-color) 18%, transparent)",
                        borderColor: "color-mix(in oklab, var(--worktree-color) 45%, transparent)",
                        "--worktree-color": worktreeAccentColor,
                      } as React.CSSProperties
                    }
                    aria-label={`Branch: ${worktreeBranch}`}
                  >
                    <span className="truncate">{worktreeBranch}</span>
                  </span>
                </TooltipTrigger>
                <TooltipContent side="bottom">{worktreeBranch}</TooltipContent>
              </Tooltip>
            )}

            {/* Process runs somewhere other than the worktree this panel is filed
              under, by the user's own choice (#11840). */}
          </div>
        )}

        {headerContent != null && (
          // Keeps its full width until it would take more than half the region,
          // then clips from the telemetry end instead of squeezing the title to
          // nothing. px-1 keeps edge items' focus rings inside the clip; -mr-1
          // gives that padding back so the spacing to the controls is unchanged.
          <div
            data-testid="panel-header-content"
            className="-mr-1 ml-auto flex max-w-[50%] shrink-0 items-center gap-1.5 self-stretch overflow-hidden whitespace-nowrap px-1"
          >
            {headerContent}
          </div>
        )}
      </div>

      {/* Centered Zen Mode indicator (only visible when maximized) */}
      {isMaximized && activeCount > 0 && (
        <div
          className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 flex items-center gap-3 text-text-secondary select-none pointer-events-none"
          role="status"
          aria-live="polite"
        >
          <div className="flex items-center gap-1.5 text-2xs uppercase tracking-wider font-semibold whitespace-nowrap">
            <Grid2X2 className="w-3 h-3 shrink-0" aria-hidden="true" />
            <span className="tabular-nums inline-flex items-center gap-1">
              <AnimatedLabel label={String(activeCount)} textClassName="tabular-nums" /> Background
            </span>
            {workingCount > 0 && (
              <span
                className={cn("flex items-center gap-1 tabular-nums ml-1", STATE_COLORS.working)}
              >
                <STATE_ICONS.working
                  className="w-3 h-3 animate-spin-slow motion-reduce:animate-none"
                  aria-hidden="true"
                />
                <AnimatedLabel label={String(workingCount)} textClassName="tabular-nums" /> working
              </span>
            )}
            {waitingCount > 0 && (
              <span
                className={cn("flex items-center gap-1 tabular-nums ml-1", STATE_COLORS.waiting)}
              >
                <STATE_ICONS.waiting className="w-3 h-3" aria-hidden="true" />
                <AnimatedLabel label={String(waitingCount)} textClassName="tabular-nums" /> waiting
              </span>
            )}
          </div>
        </div>
      )}

      {headerStatus !== undefined && (
        // Reserved whether or not a status is showing: the box never changes
        // size, so a status coming or going cannot move the controls.
        <div
          data-testid="panel-header-status"
          className="ml-1.5 flex h-5 w-5 shrink-0 items-center justify-center"
        >
          {headerStatus}
        </div>
      )}

      <div
        ref={controlsRef}
        role="toolbar"
        aria-label="Panel controls"
        aria-orientation="horizontal"
        onKeyDown={handleControlsKeyDown}
        data-testid="panel-header-controls"
        className="ml-1.5 flex shrink-0 items-center gap-1.5"
      >
        {/* Overflow menu — panel management actions */}
        {hasOverflowItems && (
          <DropdownMenu
            onOpenChange={(open) => {
              if (open) setOverflowTooltipOpen(false);
            }}
          >
            <Tooltip open={overflowTooltipOpen} onOpenChange={setOverflowTooltipOpen}>
              <TooltipTrigger asChild>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    onPointerDown={(e) => e.stopPropagation()}
                    aria-label="More panel actions"
                  >
                    <Ellipsis aria-hidden="true" />
                  </Button>
                </DropdownMenuTrigger>
              </TooltipTrigger>
              <TooltipContent side="bottom">More panel actions</TooltipContent>
            </Tooltip>
            <DropdownMenuContent align="end" className="min-w-[160px]">
              {/* Session group */}
              {hasPty && (
                <DropdownMenuItem
                  disabled={isHibernated}
                  onSelect={() =>
                    void actionService.dispatch(
                      "terminal.redraw",
                      { terminalId: id },
                      { source: "menu" }
                    )
                  }
                  data-testid="panel-redraw"
                >
                  <RefreshCw className="w-3.5 h-3.5 mr-2" aria-hidden="true" />
                  Redraw
                </DropdownMenuItem>
              )}

              {canRestart && onRestart && (
                <DropdownMenuItem
                  onSelect={handleRestartSelect}
                  className={cn(
                    armedRestartId === id && "bg-status-warning/10 text-status-warning"
                  )}
                  data-testid={armedRestartId === id ? "panel-restart-confirm" : "panel-restart"}
                  aria-label={
                    armedRestartId === id
                      ? `Armed — click again to confirm restart. ${countdown !== null ? `Confirmation expires in ${countdown} seconds` : ""}`
                      : "Restart session"
                  }
                >
                  <RotateCcw className="w-3.5 h-3.5 mr-2" aria-hidden="true" />
                  {armedRestartId === id
                    ? `Confirm restart (${countdown ?? 0}s)`
                    : "Restart session"}
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
                  <FolderGit2 className="w-3.5 h-3.5 mr-2" aria-hidden="true" />
                  Move to new worktree…
                </DropdownMenuItem>
              )}

              {/* Management group */}
              {((canRestart && onRestart) || hasPty || agentId) && <DropdownMenuSeparator />}
              {location === "dock" && onRestore && (
                <DropdownMenuItem onSelect={() => onRestore()}>
                  <PanelTopClose className="w-3.5 h-3.5 mr-2" aria-hidden="true" />
                  Move to grid
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
                <Pencil className="w-3.5 h-3.5 mr-2" aria-hidden="true" />
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
                <CopyPlus className="w-3.5 h-3.5 mr-2" aria-hidden="true" />
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
                    <Unlock className="w-3.5 h-3.5 mr-2" aria-hidden="true" />
                  ) : (
                    <Lock className="w-3.5 h-3.5 mr-2" aria-hidden="true" />
                  )}
                  {isInputLocked ? "Unlock input" : "Lock input"}
                </DropdownMenuItem>
              )}
              {showWatchButton && (
                <DropdownMenuItem onSelect={handleWatchToggle}>
                  {isWatched ? (
                    <BellOff className="w-3.5 h-3.5 mr-2" aria-hidden="true" />
                  ) : (
                    <Bell className="w-3.5 h-3.5 mr-2" aria-hidden="true" />
                  )}
                  {isWatched ? "Cancel watch" : "Watch"}
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
                <Trash2 className="w-3.5 h-3.5 mr-2" aria-hidden="true" />
                Trash
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}

        {/* Move to dock — visible button for grid panels */}
        {showMoveToDock && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={(e) => {
                  e.stopPropagation();
                  onMinimize!();
                }}
                onPointerDown={(e) => e.stopPropagation()}
                aria-label="Move to dock"
                aria-keyshortcuts={moveToDockAriaShortcut}
                data-testid="panel-move-to-dock"
              >
                <PanelBottomClose aria-hidden="true" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {createTooltipContent("Move to dock", moveToDockShortcut)}
            </TooltipContent>
          </Tooltip>
        )}

        {/* Middle control: Move-to-grid (dock) / Maximize / Restore. Dock panels
            never receive onToggleMaximize, so this branch owns the slot whenever
            location is "dock". Collapse is handled by Escape, outside-click, and
            the dock chip toggle — no dedicated header button. */}
        {location === "dock" ? (
          <>
            {onRestore && showRestoreControl && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    onClick={(e) => {
                      e.stopPropagation();
                      onRestore();
                    }}
                    onPointerDown={(e) => e.stopPropagation()}
                    aria-label="Move to grid"
                    data-testid="panel-move-to-grid"
                  >
                    <PanelTopClose aria-hidden="true" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom">Move to grid</TooltipContent>
              </Tooltip>
            )}
          </>
        ) : onToggleMaximize && isMaximized ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                onClick={(e) => {
                  e.stopPropagation();
                  onFocus();
                  onToggleMaximize();
                }}
                onPointerDown={(e) => e.stopPropagation()}
                aria-label="Restore grid view"
                aria-keyshortcuts={maximizeAriaShortcut}
              >
                <Minimize2 aria-hidden="true" />
                Restore
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {createTooltipContent("Restore grid view", maximizeShortcut)}
            </TooltipContent>
          </Tooltip>
        ) : (
          onToggleMaximize && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={(e) => {
                    e.stopPropagation();
                    onFocus();
                    onToggleMaximize();
                  }}
                  onPointerDown={(e) => e.stopPropagation()}
                  aria-label="Maximize"
                  aria-keyshortcuts={maximizeAriaShortcut}
                >
                  <Maximize2 aria-hidden="true" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                {createTooltipContent("Maximize", maximizeShortcut)}
              </TooltipContent>
            </Tooltip>
          )
        )}

        {/* Close button */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
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
              // Quiet at rest like its neighbours; the destructive hue arrives
              // only on hover and focus, where it names what the click does.
              className="hover:bg-status-error/15 hover:text-status-error focus-visible:bg-status-error/15 focus-visible:text-status-error focus-visible:outline-status-error"
              data-testid="panel-close"
              aria-label={formatShortcutForTooltip(
                location === "dock"
                  ? "Dismiss preview. Hold Alt and click to force close without recovery."
                  : "Close session. Hold Alt and click to force close without recovery."
              )}
              // Dock previews dismiss non-destructively; the terminal.close chord
              // (Cmd+W) still trashes the focused panel, so don't advertise it as
              // the way to dismiss the preview (#11186).
              aria-keyshortcuts={location === "dock" ? undefined : closeAriaShortcut}
            >
              <X aria-hidden="true" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            <div className="flex flex-col gap-1">
              {location === "dock"
                ? createTooltipContent("Dismiss preview")
                : createTooltipContent("Close session", closeShortcut)}
              <span className="text-text-secondary text-2xs">
                {formatShortcutForTooltip("Alt+Click to force close")}
              </span>
            </div>
          </TooltipContent>
        </Tooltip>
      </div>

      {agentIndicator !== undefined && (
        // The agent state glyph's home: the far right, past close. It never
        // moves, and nothing else goes after it.
        <div
          data-testid="panel-header-agent-indicator"
          className="ml-1.5 flex h-5 w-5 shrink-0 items-center justify-center"
        >
          {agentIndicator}
        </div>
      )}
      {isFleetPreviewed ? (
        <span
          key={previewEnterGen}
          className="fleet-preview-enter-overlay"
          aria-hidden="true"
          data-testid="fleet-preview-enter-overlay"
        />
      ) : null}
    </SurfaceHeader>
  );
}

export const PanelHeader = PanelHeaderComponent;
