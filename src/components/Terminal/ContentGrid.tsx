import React, { useMemo, useCallback, useEffect, useEffectEvent, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { SortableContext, rectSortingStrategy } from "@dnd-kit/sortable";
import { useDroppable } from "@dnd-kit/core";
import {
  AnimatePresence,
  LayoutGroup,
  motion,
  type TransformProperties,
  type Transition,
} from "framer-motion";
import { cn } from "@/lib/utils";
import { logError } from "@/utils/logger";
import { useMacroFocusStore } from "@/store/macroFocusStore";
import {
  usePanelStore,
  useLayoutConfigStore,
  useWorktreeSelectionStore,
  usePreferencesStore,
  useTwoPaneSplitStore,
  type TerminalInstance,
} from "@/store";
import { useFleetArmingStore } from "@/store/fleetArmingStore";
import { useFleetScopeFlagStore } from "@/store/fleetScopeFlagStore";
import { useProjectStore } from "@/store/projectStore";
import { isAgentLaunchable } from "../../../shared/utils/agentAvailability";
import { computeGridCanLaunch, computeGridSelectedAgentIds } from "./contentGridAgentFilter";
import { buildFleetPanels } from "./contentGridFleetPanels";
import { GridPanel } from "./GridPanel";
import { GridTabGroup } from "./GridTabGroup";
import { GridNotificationBar } from "./GridNotificationBar";
import { TerminalCountWarning } from "./TerminalCountWarning";
import { GridFullOverlay } from "./GridFullOverlay";
import { TwoPaneSplitLayout } from "./TwoPaneSplitLayout";
import {
  SortableTerminal,
  useDndPlaceholder,
  useIsDragging,
  GRID_PLACEHOLDER_ID,
  SortableGridPlaceholder,
} from "@/components/DragDrop";
import { AlertTriangle, Settings } from "lucide-react";
import { DaintreeIcon } from "@/components/icons";
import { ProjectPulseCard } from "@/components/Pulse";
import { Kbd } from "@/components/ui/Kbd";
import { svgToDataUrl, sanitizeSvg } from "@/lib/svg";
import { terminalInstanceService } from "@/services/TerminalInstanceService";
import { TerminalRefreshTier } from "@shared/types/panel";
import {
  computeGridColumns,
  MIN_TERMINAL_HEIGHT_PX,
  GRID_TRANSITION_DURATION_MS,
  GRID_FIT_DELAY_MS,
} from "@/lib/terminalLayout";
import { useWorktrees } from "@/hooks/useWorktrees";
import { useProjectBranding } from "@/hooks";
import { actionService } from "@/services/ActionService";
import { useCliAvailabilityStore } from "@/store/cliAvailabilityStore";
import type { CliAvailability } from "@shared/types";
import type { ActionId } from "@shared/types/actions";
import {
  ContextMenu,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { RecipeRunner } from "./RecipeRunner/RecipeRunner";
import { buildPanelDuplicateOptions } from "@/services/terminal/panelDuplicationService";
import { getEffectiveAgentIds, getEffectiveAgentConfig } from "@shared/config/agentRegistry";
import type { BuiltInAgentId } from "@shared/config/agentIds";
import { getMaximizedGroupFocusTarget } from "./contentGridFocus";

// Snap mid-flight FLIP translations to integer pixels. xterm canvas/WebGL
// renderers blur when an ancestor receives a fractional CSS transform
// (Chromium bug 40892376) — this runs on every animation frame for grid
// panels, so we round before composing the transform string.
function pixelSnapTransform({ x, y }: TransformProperties): string {
  const tx = typeof x === "number" ? x : parseFloat(x ?? "0") || 0;
  const ty = typeof y === "number" ? y : parseFloat(y ?? "0") || 0;
  return `translate3d(${Math.round(tx)}px, ${Math.round(ty)}px, 0)`;
}

interface TipEntry {
  id: string;
  message: React.ReactNode;
  actionId?: ActionId;
  actionLabel?: string;
  requiredAgents?: BuiltInAgentId[];
}

const TIPS: TipEntry[] = [
  {
    id: "quick-switcher",
    message: (
      <>
        Press <Kbd>⌘P</Kbd> to jump between open panels
      </>
    ),
    actionId: "nav.quickSwitcher",
    actionLabel: "Open Quick Switcher",
  },
  {
    id: "new-terminal",
    message: (
      <>
        Press <Kbd>⌘⌥T</Kbd> to open a new terminal in this worktree
      </>
    ),
    actionId: "terminal.new",
    actionLabel: "New Terminal",
  },
  {
    id: "panel-palette",
    message: (
      <>
        Press <Kbd>⌘N</Kbd> to open the panel palette — add terminals, browsers, or dev previews
      </>
    ),
    actionId: "panel.palette",
    actionLabel: "Open Panel Palette",
  },
  {
    id: "launch-claude",
    message: (
      <>
        Press <Kbd>⌘⌥N</Kbd> to launch a Claude agent in this worktree
      </>
    ),
    actionId: "agent.terminal",
    actionLabel: "Launch Agent",
    requiredAgents: ["claude"],
  },
  {
    id: "launch-gemini",
    message: (
      <>
        Press <Kbd>⌘⌥N</Kbd> to launch a Gemini agent in this worktree
      </>
    ),
    actionId: "agent.terminal",
    actionLabel: "Launch Agent",
    requiredAgents: ["gemini"],
  },
  {
    id: "context-injection",
    message: (
      <>
        Press <Kbd>⌘⇧I</Kbd> to inject the project file tree into the focused terminal
      </>
    ),
    actionId: "terminal.inject",
    actionLabel: "Inject Context",
  },
  {
    id: "action-palette",
    message: (
      <>
        Press <Kbd>⌘⇧P</Kbd> to open the action palette and search all available commands
      </>
    ),
    actionId: "action.palette.open",
    actionLabel: "Open Action Palette",
  },
  {
    id: "worktree-palette",
    message: (
      <>
        Press <Kbd>⌘K</Kbd> then <Kbd>W</Kbd> to open the worktree palette and switch branches
      </>
    ),
    actionId: "worktree.openPalette",
    actionLabel: "Open Worktree Palette",
  },
  {
    id: "worktree-overview",
    message: (
      <>
        Press <Kbd>⌘⇧O</Kbd> to open the worktrees overview and manage all your branches
      </>
    ),
    actionId: "worktree.overview.open",
    actionLabel: "Open Worktrees Overview",
  },
  {
    id: "agent-switcher",
    message: (
      <>
        Press <Kbd>⌘⇧A</Kbd> to quickly switch between available AI agents
      </>
    ),
    actionId: "agent.palette",
    actionLabel: "Open Agent Switcher",
  },
  {
    id: "recipes",
    message: <>Create a recipe to run multi-terminal workflows with a single click</>,
    actionId: "recipe.manager.open",
    actionLabel: "Open Recipes",
  },
  {
    id: "new-worktree",
    message: <>Create a new worktree to isolate each task on its own branch</>,
    actionId: "worktree.createDialog.open",
    actionLabel: "New Worktree",
  },
];

let tipMountCount = 0;

function RotatingTip() {
  const mountIndex = useRef(tipMountCount++);
  const availability = useCliAvailabilityStore((s) => s.availability);

  const filteredTips = useMemo(
    () =>
      TIPS.filter(
        (tip) =>
          !tip.requiredAgents || tip.requiredAgents.some((a) => isAgentLaunchable(availability[a]))
      ),
    [availability]
  );

  if (filteredTips.length === 0) return null;

  const tip = filteredTips[mountIndex.current % filteredTips.length]!;

  return (
    <div className="flex flex-col items-center gap-2 animate-in fade-in duration-200">
      <p className="text-xs text-daintree-text/70 text-center">Tip: {tip.message}</p>
      {tip.actionId && tip.actionLabel && (
        <button
          type="button"
          onClick={() => void actionService.dispatch(tip.actionId!, undefined, { source: "user" })}
          className="text-xs text-daintree-accent hover:text-daintree-accent/80 transition-colors focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-daintree-accent/50 rounded px-1"
        >
          {tip.actionLabel}
        </button>
      )}
    </div>
  );
}

export interface ContentGridProps {
  className?: string;
  defaultCwd?: string;
  agentAvailability?: CliAvailability;
  emptyContent?: React.ReactNode;
}

function EmptyState({
  hasActiveWorktree,
  activeWorktreeName,
  activeWorktreeId,
  showProjectPulse,
  projectIconSvg,
  defaultCwd,
}: {
  hasActiveWorktree: boolean;
  activeWorktreeName?: string | null;
  activeWorktreeId?: string | null;
  showProjectPulse: boolean;
  projectIconSvg?: string;
  defaultCwd?: string;
}) {
  const handleOpenHelp = () => {
    void actionService.dispatch(
      "system.openExternal",
      { url: "https://github.com/daintreehq/daintree#readme" },
      { source: "user" }
    );
  };

  const handleOpenProjectSettings = () => {
    window.dispatchEvent(
      new CustomEvent("daintree:open-settings-tab", {
        detail: { tab: "project:general" },
      })
    );
  };

  return (
    <div className="flex flex-col items-center justify-center h-full w-full p-8 animate-in fade-in duration-500">
      <div className="max-w-3xl w-full flex flex-col items-center">
        <div className="mb-6 flex flex-col items-center text-center">
          <div className="relative group mb-4">
            {projectIconSvg ? (
              (() => {
                const sanitized = sanitizeSvg(projectIconSvg);
                if (!sanitized.ok) {
                  return <DaintreeIcon className="h-28 w-28 text-tint/65" />;
                }
                return (
                  <img
                    src={svgToDataUrl(sanitized.svg)}
                    alt="Project icon"
                    className="h-28 w-28 object-contain"
                  />
                );
              })()
            ) : (
              <DaintreeIcon className="h-28 w-28 text-tint/65" />
            )}
            {hasActiveWorktree && (
              <button
                type="button"
                onClick={handleOpenProjectSettings}
                className="absolute -bottom-1 -right-1 p-1.5 bg-daintree-sidebar border border-daintree-border rounded-full opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity hover:bg-daintree-bg focus-visible:opacity-100 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-daintree-accent"
                aria-label="Change project icon"
              >
                <Settings className="h-3 w-3 text-daintree-text/70" />
              </button>
            )}
          </div>
          <h3 className="text-2xl font-semibold text-daintree-text tracking-tight mb-3">
            {activeWorktreeName || "Daintree"}
          </h3>
          {!activeWorktreeName && (
            <p className="text-sm text-daintree-text/60 max-w-md leading-relaxed font-medium">
              A habitat for your AI agents.
            </p>
          )}
        </div>

        {!hasActiveWorktree && (
          <div
            className="flex items-center gap-2 text-xs text-status-warning bg-status-warning/10 border border-status-warning/20 rounded px-3 py-2 mb-6 max-w-md text-center"
            role="status"
            aria-live="polite"
          >
            <AlertTriangle className="h-4 w-4 shrink-0" />
            <span>Select a worktree in the sidebar to set the working directory for agents</span>
          </div>
        )}

        {hasActiveWorktree && (
          <div className="mb-6 w-full flex justify-center">
            <RecipeRunner activeWorktreeId={activeWorktreeId} defaultCwd={defaultCwd} />
          </div>
        )}

        {showProjectPulse && hasActiveWorktree && activeWorktreeId && (
          <div className="flex justify-center mb-8">
            <ProjectPulseCard worktreeId={activeWorktreeId} />
          </div>
        )}

        <div className="flex flex-col items-center gap-4 mt-4">
          {hasActiveWorktree && <RotatingTip />}

          {!hasActiveWorktree && (
            <button
              type="button"
              onClick={handleOpenHelp}
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md hover:bg-tint/5 transition-colors group focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-daintree-accent/50"
            >
              <div className="w-0 h-0 border-t-[2.5px] border-t-transparent border-l-[5px] border-l-daintree-text/50 border-b-[2.5px] border-b-transparent group-hover:border-l-daintree-text/70 transition-colors" />
              <span className="text-xs text-daintree-text/50 group-hover:text-daintree-text/70 transition-colors">
                View documentation
              </span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export function ContentGrid({
  className,
  defaultCwd,
  agentAvailability,
  emptyContent,
}: ContentGridProps) {
  "use memo";
  const {
    panelsById,
    storeTerminalIds,
    trashedTerminals,
    focusedId,
    maximizedId,
    maximizeTarget,
    preMaximizeLayout,
    clearPreMaximizeLayout,
    validateMaximizeTarget,
    getTerminal,
    getActiveTabId,
    setFocused,
  } = usePanelStore(
    useShallow((state) => ({
      panelsById: state.panelsById,
      storeTerminalIds: state.panelIds,
      trashedTerminals: state.trashedTerminals,
      focusedId: state.focusedId,
      maximizedId: state.maximizedId,
      maximizeTarget: state.maximizeTarget,
      preMaximizeLayout: state.preMaximizeLayout,
      clearPreMaximizeLayout: state.clearPreMaximizeLayout,
      validateMaximizeTarget: state.validateMaximizeTarget,
      getTerminal: state.getTerminal,
      getActiveTabId: state.getActiveTabId,
      setFocused: state.setFocused,
    }))
  );

  const activeWorktreeId = useWorktreeSelectionStore((state) => state.activeWorktreeId);
  const showProjectPulse = usePreferencesStore((state) => state.showProjectPulse);
  const currentProject = useProjectStore((state) => state.currentProject);
  const isAvailabilityInitialized = useCliAvailabilityStore((s) => s.isInitialized);

  // undefined = no filter (availability not yet probed); Set = filter to installed agents.
  // Gate on the store's `isInitialized` flag: the `agentAvailability` prop is always a
  // defined object (pre-populated by `defaultAvailability()` with every agent as "missing"),
  // so a `!agentAvailability` guard would never fire and the menu would start empty on cold
  // boot until the first probe returns. Pin state intentionally does NOT gate this menu —
  // unpinning from the toolbar must not remove an installed agent from the launch menu.
  const gridSelectedAgentIds = useMemo(
    () =>
      computeGridSelectedAgentIds(
        isAvailabilityInitialized,
        agentAvailability,
        getEffectiveAgentIds()
      ),
    [isAvailabilityInitialized, agentAvailability]
  );
  const isProjectSwitching = false;
  const { projectIconSvg } = useProjectBranding(currentProject?.id);
  const { worktreeMap } = useWorktrees();
  const activeWorktree = activeWorktreeId ? worktreeMap.get(activeWorktreeId) : null;
  const hasActiveWorktree = activeWorktreeId != null && activeWorktree != null;
  const activeWorktreeName = activeWorktree
    ? activeWorktree.isMainWorktree
      ? activeWorktree.name?.trim() || "Unknown Worktree"
      : activeWorktree.branch?.trim() || activeWorktree.name?.trim() || "Unknown Worktree"
    : null;

  const isInTrash = usePanelStore((state) => state.isInTrash);

  // Two-pane split mode settings
  const twoPaneSplitEnabled = useTwoPaneSplitStore((state) => state.config.enabled);

  // Fleet scope render state — when the flag is "scoped" and scope is active
  // the grid paints the armed set (across every worktree) as a flat grid of
  // input-locked cells. Scope is a no-op in "legacy" mode.
  const isFleetScopeActive = useWorktreeSelectionStore((state) => state.isFleetScopeActive);
  const fleetScopeMode = useFleetScopeFlagStore((state) => state.mode);
  const { armedIds, armOrder } = useFleetArmingStore(
    useShallow((state) => ({ armedIds: state.armedIds, armOrder: state.armOrder }))
  );
  const isFleetScopeEnabled = fleetScopeMode === "scoped" && isFleetScopeActive;

  // Grid terminals filtered by location and active worktree
  const gridTerminals = useMemo(() => {
    const result: TerminalInstance[] = [];
    for (const id of storeTerminalIds) {
      const t = panelsById[id];
      if (
        t &&
        (t.location === "grid" || t.location === undefined) &&
        (t.worktreeId ?? undefined) === (activeWorktreeId ?? undefined)
      ) {
        result.push(t);
      }
    }
    return result;
  }, [panelsById, storeTerminalIds, activeWorktreeId]);

  // Get tab groups for the grid
  const getTabGroups = usePanelStore((state) => state.getTabGroups);
  const getTabGroupPanels = usePanelStore((state) => state.getTabGroupPanels);
  const getPanelGroup = usePanelStore((state) => state.getPanelGroup);
  const createTabGroup = usePanelStore((state) => state.createTabGroup);
  const addPanelToGroup = usePanelStore((state) => state.addPanelToGroup);
  const deleteTabGroup = usePanelStore((state) => state.deleteTabGroup);
  const addPanel = usePanelStore((state) => state.addPanel);
  const setActiveTab = usePanelStore((state) => state.setActiveTab);

  // Get tab groups for the active worktree
  const tabGroups = useMemo(() => {
    void storeTerminalIds;
    void panelsById;
    void trashedTerminals;
    return getTabGroups("grid", activeWorktreeId ?? undefined);
  }, [getTabGroups, activeWorktreeId, storeTerminalIds, panelsById, trashedTerminals]);

  // Handler for adding a new tab to a single panel (creates a tab group)
  const handleAddTabForPanel = useCallback(
    async (panel: TerminalInstance) => {
      let groupId: string;
      let createdNewGroup = false;

      try {
        const existingGroup = getPanelGroup(panel.id);
        if (existingGroup) {
          groupId = existingGroup.id;
        } else {
          const location = panel.location === "dock" ? "dock" : "grid";
          groupId = createTabGroup(location, panel.worktreeId, [panel.id], panel.id);
          createdNewGroup = true;
        }

        const options = await buildPanelDuplicateOptions(panel, "grid");
        const newPanelId = await addPanel(options);
        if (!newPanelId) {
          if (createdNewGroup && groupId!) deleteTabGroup(groupId);
          return;
        }

        addPanelToGroup(groupId, newPanelId);
        setActiveTab(groupId, newPanelId);
        setFocused(newPanelId);
      } catch (error) {
        logError("Failed to add tab", error);
        if (createdNewGroup && groupId!) {
          deleteTabGroup(groupId);
        }
      }
    },
    [
      getPanelGroup,
      createTabGroup,
      addPanelToGroup,
      deleteTabGroup,
      addPanel,
      setActiveTab,
      setFocused,
    ]
  );

  const layoutConfig = useLayoutConfigStore((state) => state.layoutConfig);
  const setGridDimensions = useLayoutConfigStore((state) => state.setGridDimensions);
  const getMaxGridCapacity = useLayoutConfigStore((state) => state.getMaxGridCapacity);

  // Dynamic grid capacity based on current dimensions
  const maxGridCapacity = getMaxGridCapacity();
  // Use group count for capacity check (each tab group = 1 slot)
  const isGridFull = tabGroups.length >= maxGridCapacity;

  // Make the grid a droppable area
  const { setNodeRef, isOver } = useDroppable({
    id: "grid-container",
    data: { container: "grid" },
  });

  // Track container dimensions for responsive layout and capacity calculation
  const gridContainerRef = useRef<HTMLDivElement>(null);
  const preMaximizeLayoutRef = useRef(preMaximizeLayout);
  useEffect(() => {
    preMaximizeLayoutRef.current = preMaximizeLayout;
  }, [preMaximizeLayout]);
  const [gridWidth, setGridWidth] = useState<number | null>(null);

  // Get placeholder state from DnD context
  const { placeholderIndex, sourceContainer } = useDndPlaceholder();
  const isDragging = useIsDragging();
  const isDraggingRef = useRef(isDragging);
  useEffect(() => {
    isDraggingRef.current = isDragging;
  }, [isDragging]);

  // placeholderIndex is now group-based (from DndProvider), so bound by tabGroups.length
  const placeholderInGrid =
    placeholderIndex !== null && placeholderIndex >= 0 && placeholderIndex <= tabGroups.length;

  // Show placeholder when dragging from dock to grid (only if grid not full)
  const showPlaceholder = placeholderInGrid && sourceContainer === "dock" && !isGridFull;
  // Use tab groups count for grid layout (each group takes one cell)
  const gridItemCount = tabGroups.length + (showPlaceholder ? 1 : 0);

  const gridRegionRef = useCallback((node: HTMLDivElement | null) => {
    useMacroFocusStore.getState().setRegionRef("grid", node);
  }, []);
  const isMacroFocused = useMacroFocusStore((state) => state.focusedRegion === "grid");

  const handleGridRegionKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (!isMacroFocused) return;

      // Arrow keys navigate between grid cells
      const directionMap: Record<string, string> = {
        ArrowUp: "terminal.focusUp",
        ArrowDown: "terminal.focusDown",
        ArrowLeft: "terminal.focusLeft",
        ArrowRight: "terminal.focusRight",
      };
      const action = directionMap[e.key];
      if (action) {
        e.preventDefault();
        e.stopPropagation();
        void actionService.dispatch(
          action as Parameters<typeof actionService.dispatch>[0],
          undefined,
          { source: "keybinding" }
        );
        return;
      }

      // Enter activates the focused terminal
      if (e.key === "Enter" && focusedId) {
        e.preventDefault();
        e.stopPropagation();
        const instance = terminalInstanceService.get(focusedId);
        if (instance) {
          terminalInstanceService.focus(focusedId);
          useMacroFocusStore.getState().clearFocus();
        }
        return;
      }
    },
    [isMacroFocused, focusedId]
  );

  const combinedGridRef = useCallback(
    (node: HTMLDivElement | null) => {
      setNodeRef(node);
      gridContainerRef.current = node;
    },
    [setNodeRef]
  );

  // Attach ResizeObserver to track container dimensions
  useEffect(() => {
    const container = gridContainerRef.current;
    if (!container) return;

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) {
        const { width, height } = entry.contentRect;
        setGridWidth((prev) => (prev === width ? prev : width));
        setGridDimensions({ width, height });
      }
    });

    observer.observe(container);
    setGridWidth(container.clientWidth);
    setGridDimensions({ width: container.clientWidth, height: container.clientHeight });

    return () => {
      observer.disconnect();
      setGridDimensions(null);
    };
  }, [setGridDimensions, gridTerminals.length, maximizedId, twoPaneSplitEnabled, showPlaceholder]);

  useEffect(() => {
    if (
      preMaximizeLayoutRef.current &&
      preMaximizeLayoutRef.current.worktreeId !== activeWorktreeId
    ) {
      clearPreMaximizeLayout();
    }
  }, [activeWorktreeId, clearPreMaximizeLayout]);

  useEffect(() => {
    if (
      preMaximizeLayoutRef.current &&
      preMaximizeLayoutRef.current.gridItemCount !== gridItemCount
    ) {
      clearPreMaximizeLayout();
    }
  }, [gridItemCount, clearPreMaximizeLayout]);

  useEffect(() => {
    if (preMaximizeLayoutRef.current) {
      clearPreMaximizeLayout();
    }
  }, [layoutConfig, clearPreMaximizeLayout]);

  // Hysteresis input for the automatic-strategy column count: holds the prior
  // committed value so a brief drop in panel count doesn't ricochet the grid
  // back through a re-flow. Read by the useMemo below; updated in the
  // existing prevGridColsRef effect (~line 858) to mirror the codebase's
  // established "previous value via ref" pattern.
  const hysteresisGridColsRef = useRef<number | undefined>(undefined);

  const gridCols = useMemo(() => {
    if (
      !maximizedId &&
      preMaximizeLayout &&
      preMaximizeLayout.worktreeId === activeWorktreeId &&
      preMaximizeLayout.gridItemCount === gridItemCount
    ) {
      if (gridItemCount === 2 && preMaximizeLayout.gridCols !== 2) {
        return 2;
      }
      return preMaximizeLayout.gridCols;
    }
    const { strategy, value } = layoutConfig;
    return computeGridColumns(
      gridItemCount,
      gridWidth,
      strategy,
      value,
      hysteresisGridColsRef.current
    );
  }, [gridItemCount, layoutConfig, gridWidth, maximizedId, preMaximizeLayout, activeWorktreeId]);

  // FLIP transition shared across every panel in this grid. During project
  // switching the duration drops to 0 so the freshly-hydrated panels snap into
  // place — matching the prior CSS-transition `none` branch and preserving
  // #4467's project-switch fit timing. MotionConfig propagates the global
  // reduced-motion preference, so no `prefers-reduced-motion` check is needed
  // here. Ease curve mirrors the previous `ease-out` CSS transition.
  const layoutTransition: Transition = useMemo(
    () => ({
      duration: isProjectSwitching ? 0 : GRID_TRANSITION_DURATION_MS / 1000,
      ease: [0.22, 1, 0.36, 1],
    }),
    [isProjectSwitching]
  );

  const gridAgentMenuItems = useMemo(() => {
    return getEffectiveAgentIds()
      .filter((id) => !gridSelectedAgentIds || gridSelectedAgentIds.has(id))
      .map((id) => {
        const agentConfig = getEffectiveAgentConfig(id);
        const canLaunch = computeGridCanLaunch(id, isAvailabilityInitialized, agentAvailability);
        return { id, name: agentConfig?.name ?? id, canLaunch };
      });
  }, [agentAvailability, gridSelectedAgentIds, isAvailabilityInitialized]);

  const handleGridLaunch = useCallback(
    (agentId: string) => {
      void actionService.dispatch(
        "agent.launch",
        { agentId, location: "grid", cwd: defaultCwd || undefined },
        { source: "context-menu" }
      );
    },
    [defaultCwd]
  );

  const handleGridLayoutChange = useCallback(
    (strategy: "automatic" | "fixed-columns" | "fixed-rows") => {
      void actionService.dispatch(
        "panel.gridLayout.setStrategy",
        { strategy },
        { source: "context-menu" }
      );
    },
    []
  );

  // Terminal IDs for SortableContext
  const panelIds = useMemo(() => {
    const ids = tabGroups.map((g) => g.panelIds[0] ?? g.id);
    if (showPlaceholder && placeholderInGrid) {
      const insertIndex = Math.min(Math.max(0, placeholderIndex), ids.length);
      ids.splice(insertIndex, 0, GRID_PLACEHOLDER_ID);
    }
    return ids;
  }, [tabGroups, showPlaceholder, placeholderIndex, placeholderInGrid]);

  // Fleet scope projection: order is the user's arm order, dropping any ids
  // that have since been pruned, trashed, or moved to the dock. We resolve
  // against panelsById once here so GridPanel cells receive stable refs.
  // Shared with useGridNavigation so the focus model never drifts from
  // what's rendered (#5989).
  const fleetPanels = useMemo(() => {
    if (!isFleetScopeEnabled) return [];
    return buildFleetPanels(armOrder, armedIds, panelsById);
  }, [isFleetScopeEnabled, armOrder, armedIds, panelsById]);

  // Only render the fleet grid if at least one armed panel is actually
  // grid-renderable. Otherwise fall through to the normal active-worktree
  // grid so the user isn't trapped in an empty fleet view when every
  // armed terminal has been moved to the dock or trashed.
  const isFleetScopeRender = isFleetScopeEnabled && fleetPanels.length > 0;

  const fleetNeedsWorktreePrefix = useMemo(() => {
    if (fleetPanels.length <= 1) return false;
    const firstWorktreeId = fleetPanels[0]?.worktreeId ?? null;
    return fleetPanels.some((t) => (t.worktreeId ?? null) !== firstWorktreeId);
  }, [fleetPanels]);

  // Independent hysteresis state for the fleet grid — must not share with the
  // main grid because fleet spans different worktrees with its own panel
  // count history.
  const hysteresisFleetColsRef = useRef<number | undefined>(undefined);

  const fleetGridCols = useMemo(() => {
    if (!isFleetScopeRender) return 1;
    const { strategy, value } = layoutConfig;
    return computeGridColumns(
      Math.max(fleetPanels.length, 1),
      gridWidth,
      strategy,
      value,
      hysteresisFleetColsRef.current
    );
  }, [isFleetScopeRender, fleetPanels, layoutConfig, gridWidth]);

  // Dedicated fleet batch-fit: the main startBatchFit closure reads
  // `gridTerminals` and can't be redirected at the current armed set, which
  // spans worktrees. Stagger fits via rAF to let xterm reattach per cell
  // without starving the renderer — lesson #5092 flagged simultaneous cross-
  // worktree mounts as a risk for IntersectionObserver misfires. We also
  // promote every mounted fleet cell to VISIBLE so cross-worktree terminals
  // keep streaming output — worktreeStore's per-worktree policy would
  // otherwise demote them to BACKGROUND (showing stale frames).
  const prevFleetGridColsRef = useRef(fleetGridCols);
  useEffect(() => {
    // Hysteresis ref is only meaningful for the automatic strategy — fixed
    // strategies produce user-chosen counts that must not bias a future auto
    // computation. Cleared whenever strategy isn't automatic or fleet scope
    // isn't actively rendering.
    const writeFleetHysteresis =
      isFleetScopeRender && layoutConfig.strategy === "automatic" ? fleetGridCols : undefined;
    if (!isFleetScopeRender) {
      prevFleetGridColsRef.current = fleetGridCols;
      hysteresisFleetColsRef.current = writeFleetHysteresis;
      return;
    }
    const ids = fleetPanels.map((t) => t.id);
    for (const id of ids) {
      terminalInstanceService.applyRendererPolicy(id, TerminalRefreshTier.VISIBLE);
    }
    // Mirror the main grid: lock resizes for the FLIP window when fleet column
    // count changes so motion.div translations don't trigger spurious SIGWINCH.
    const fleetColsChanged = prevFleetGridColsRef.current !== fleetGridCols;
    prevFleetGridColsRef.current = fleetGridCols;
    hysteresisFleetColsRef.current = writeFleetHysteresis;
    if (fleetColsChanged && !isDraggingRef.current && ids.length > 0) {
      terminalInstanceService.suppressResizesDuringLayoutTransition(
        ids,
        GRID_TRANSITION_DURATION_MS
      );
    }
    const cancelRef = { cancelled: false };
    const timeoutId = window.setTimeout(() => {
      if (isDraggingRef.current) return;
      let index = 0;
      const processNext = () => {
        if (cancelRef.cancelled || index >= ids.length) return;
        if (isDraggingRef.current) return;
        const id = ids[index++]!;
        const managed = terminalInstanceService.get(id);
        if (managed?.hostElement.isConnected) {
          terminalInstanceService.fit(id);
        }
        requestAnimationFrame(processNext);
      };
      processNext();
    }, GRID_FIT_DELAY_MS);
    return () => {
      cancelRef.cancelled = true;
      clearTimeout(timeoutId);
    };
  }, [isFleetScopeRender, fleetPanels, fleetGridCols, layoutConfig.strategy]);

  // Batch-fit grid terminals when layout (gridCols/count) changes.
  // gridTerminals is read via useEffectEvent so the effect doesn't re-run on
  // worktree switch (which mutates gridTerminals without changing layout).
  const startBatchFit = useEffectEvent((cancelRef: { cancelled: boolean }) => {
    const ids = gridTerminals.map((t) => t.id);
    return window.setTimeout(() => {
      if (isDraggingRef.current) return;

      let index = 0;
      const processNext = () => {
        if (cancelRef.cancelled || index >= ids.length) return;
        if (isDraggingRef.current) return;

        const id = ids[index++]!;
        const managed = terminalInstanceService.get(id);

        if (managed?.hostElement.isConnected) {
          terminalInstanceService.fit(id);
        }
        requestAnimationFrame(processNext);
      };
      processNext();
    }, GRID_FIT_DELAY_MS);
  });
  // When the column count changes, the grid runs a per-panel FLIP animation
  // (`layout="position"` on each SortableTerminal). Lock xterm resizes for the
  // animation window so mid-flight `getBoundingClientRect` reads — which would
  // otherwise produce fractional dimensions and spurious SIGWINCH on Codex and
  // similar PTY-sensitive CLIs — are deferred until the panels settle. The
  // batch-fit then runs `GRID_FIT_DELAY_MS` later (200ms animation + 50ms
  // safety buffer), once geometry is final. See lessons #4170 and #4467.
  // We deliberately skip the suppress call while a drag is active: the unlock
  // fires unconditionally after 200ms and would prematurely clear a drag-held
  // resize lock if a drop crosses a column threshold.
  const prevGridColsRef = useRef(gridCols);
  useEffect(() => {
    void gridCols;
    void panelIds;

    const colsChanged = prevGridColsRef.current !== gridCols;
    prevGridColsRef.current = gridCols;
    // Only retain hysteresis state for the automatic strategy. Fixed strategies
    // produce user-chosen column counts that must not bias a future automatic
    // computation (e.g. fixed-columns=4 leaving the auto path stuck at 4).
    // Skip the write while a drag placeholder is active so a phantom +1 in
    // gridItemCount can't permanently sticky-widen the grid after a cancelled
    // drop.
    hysteresisGridColsRef.current =
      layoutConfig.strategy === "automatic" && !showPlaceholder ? gridCols : undefined;

    if (colsChanged && !isProjectSwitching && !isDraggingRef.current) {
      const realPanelIds = panelIds.filter((id) => id !== GRID_PLACEHOLDER_ID);
      if (realPanelIds.length > 0) {
        terminalInstanceService.suppressResizesDuringLayoutTransition(
          realPanelIds,
          GRID_TRANSITION_DURATION_MS
        );
      }
    }

    const cancelRef = { cancelled: false };
    const timeoutId = startBatchFit(cancelRef);

    return () => {
      cancelRef.cancelled = true;
      clearTimeout(timeoutId);
    };
  }, [gridCols, panelIds, isProjectSwitching, layoutConfig.strategy, showPlaceholder]);

  // Show "grid full" overlay when trying to drag from dock to a full grid
  const showGridFullOverlay = sourceContainer === "dock" && isGridFull;

  // Two-pane split mode detection (must be before conditional returns)
  const allGroupsAreSinglePanel = tabGroups.every((g) => g.panelIds.length === 1);
  const useTwoPaneSplitMode =
    twoPaneSplitEnabled &&
    tabGroups.length === 2 &&
    allGroupsAreSinglePanel &&
    !maximizedId &&
    !showPlaceholder;

  // Memoize the two-pane terminal pair to produce a stable array reference across renders.
  // This prevents TwoPaneSplitLayout from receiving a new prop reference on every ContentGrid
  // re-render, which avoids unnecessary child effect churn and reconciliation work.
  const twoPaneTerminals = useMemo((): [TerminalInstance, TerminalInstance] | null => {
    if (!useTwoPaneSplitMode) return null;
    const panels = tabGroups
      .slice(0, 2)
      .map((g) => getTabGroupPanels(g.id, "grid")[0])
      .filter((t): t is TerminalInstance => t !== undefined);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    return panels.length === 2 ? (panels as [TerminalInstance, TerminalInstance]) : null;
  }, [useTwoPaneSplitMode, tabGroups, getTabGroupPanels]);

  // Track mode transitions and stabilize terminals after switch
  const prevModeRef = useRef<boolean>(useTwoPaneSplitMode);
  const gridTerminalsRef = useRef(gridTerminals);
  useEffect(() => {
    gridTerminalsRef.current = gridTerminals;
  }, [gridTerminals]);

  useEffect(() => {
    const prevMode = prevModeRef.current;
    const currentMode = useTwoPaneSplitMode;

    // Mode transition detected
    if (prevMode !== currentMode) {
      prevModeRef.current = currentMode;

      // Immediate stabilization fit after mode switch
      const MODE_SWITCH_FIT_DELAY_MS = 50;
      const timeoutId = window.setTimeout(() => {
        if (isDraggingRef.current) return;

        // Read latest terminal IDs from ref to avoid cancellation issues
        const ids = gridTerminalsRef.current.map((t) => t.id);
        for (const id of ids) {
          const managed = terminalInstanceService.get(id);
          if (managed?.hostElement.isConnected) {
            terminalInstanceService.fit(id);
          }
        }
      }, MODE_SWITCH_FIT_DELAY_MS);

      return () => clearTimeout(timeoutId);
    }
    return undefined;
  }, [useTwoPaneSplitMode]);

  // Validate maximize target before rendering
  useEffect(() => {
    if (maximizedId && maximizeTarget) {
      validateMaximizeTarget(getPanelGroup, getTerminal);
    }
  }, [
    maximizedId,
    maximizeTarget,
    validateMaximizeTarget,
    getPanelGroup,
    getTerminal,
    storeTerminalIds,
  ]);

  const maximizedGroup =
    maximizedId && maximizeTarget?.type === "group"
      ? tabGroups.find((group) => group.id === maximizeTarget.id)
      : undefined;
  const maximizedGroupPanels = useMemo(
    () => (maximizedGroup ? getTabGroupPanels(maximizedGroup.id, "grid") : []),
    [getTabGroupPanels, maximizedGroup]
  );
  const maximizedGroupFocusTarget = useMemo(
    () =>
      maximizedGroup
        ? getMaximizedGroupFocusTarget({
            focusedId,
            groupId: maximizedGroup.id,
            groupPanels: maximizedGroupPanels,
            getActiveTabId,
          })
        : null,
    [focusedId, getActiveTabId, maximizedGroup, maximizedGroupPanels]
  );

  useEffect(() => {
    if (
      maximizedGroupFocusTarget &&
      maximizedGroupPanels.length > 0 &&
      maximizedGroupFocusTarget !== focusedId
    ) {
      setFocused(maximizedGroupFocusTarget);
    }
  }, [focusedId, maximizedGroupFocusTarget, maximizedGroupPanels.length, setFocused]);

  const gridContextMenuContent = (
    <ContextMenuContent>
      <ContextMenuItem onSelect={() => handleGridLaunch("terminal")}>New Terminal</ContextMenuItem>
      <ContextMenuItem onSelect={() => handleGridLaunch("browser")}>New Browser</ContextMenuItem>
      {gridAgentMenuItems.length > 0 && <ContextMenuSeparator />}
      {gridAgentMenuItems.map((agent) => (
        <ContextMenuItem
          key={agent.id}
          disabled={!agent.canLaunch}
          onSelect={() => handleGridLaunch(agent.id)}
        >
          New {agent.name}
        </ContextMenuItem>
      ))}
      <ContextMenuSeparator />
      <ContextMenuSub>
        <ContextMenuSubTrigger>Grid Layout</ContextMenuSubTrigger>
        <ContextMenuSubContent>
          <ContextMenuCheckboxItem
            checked={layoutConfig.strategy === "automatic"}
            onSelect={() => handleGridLayoutChange("automatic")}
          >
            Automatic
          </ContextMenuCheckboxItem>
          <ContextMenuCheckboxItem
            checked={layoutConfig.strategy === "fixed-columns"}
            onSelect={() => handleGridLayoutChange("fixed-columns")}
          >
            Fixed Columns
          </ContextMenuCheckboxItem>
          <ContextMenuCheckboxItem
            checked={layoutConfig.strategy === "fixed-rows"}
            onSelect={() => handleGridLayoutChange("fixed-rows")}
          >
            Fixed Rows
          </ContextMenuCheckboxItem>
        </ContextMenuSubContent>
      </ContextMenuSub>
      <ContextMenuSeparator />
      <ContextMenuItem
        onSelect={() =>
          void actionService.dispatch(
            "app.settings.openTab",
            { tab: "terminal" },
            { source: "context-menu" }
          )
        }
      >
        Terminal Settings...
      </ContextMenuItem>
    </ContextMenuContent>
  );

  // Fleet scope render path: a flat grid of armed terminals from every
  // worktree, each input-locked with a broadcast overlay. Deliberately
  // placed before the maximize branch — a maximize captured against a
  // different worktree must not shadow the fleet view. DnD, two-pane, and
  // tab-group logic are bypassed entirely; the armed set is the source of
  // truth for both membership and order.
  if (isFleetScopeRender) {
    return (
      <div
        key="fleet-scope-mode"
        ref={gridRegionRef}
        role="region"
        tabIndex={-1}
        aria-label="Fleet scope grid"
        data-fleet-scope="true"
        data-macro-focus={isMacroFocused ? "true" : undefined}
        onKeyDown={handleGridRegionKeyDown}
        className={cn(
          "h-full flex flex-col outline-hidden",
          "data-[macro-focus=true]:ring-2 data-[macro-focus=true]:ring-daintree-accent/60 data-[macro-focus=true]:ring-inset",
          className
        )}
      >
        <GridNotificationBar className="mx-1 mt-1 shrink-0" />
        <TerminalCountWarning className="mx-1 mt-1 shrink-0" />
        <div className="relative flex-1 min-h-0">
          <ContextMenu>
            <ContextMenuTrigger asChild>
              <div
                ref={combinedGridRef}
                className="h-full bg-noise p-1"
                style={{
                  display: "grid",
                  gridTemplateColumns: `repeat(${fleetGridCols}, minmax(0, 1fr))`,
                  gridAutoRows: `minmax(${MIN_TERMINAL_HEIGHT_PX}px, 1fr)`,
                  gap: "4px",
                  backgroundColor: "var(--color-grid-bg)",
                  overflowY: "auto",
                }}
                id="panel-grid"
                data-grid-container="true"
              >
                {fleetPanels.length === 0 ? (
                  <div className="col-span-full row-span-full">
                    <EmptyState
                      hasActiveWorktree={hasActiveWorktree}
                      activeWorktreeName={activeWorktreeName}
                      activeWorktreeId={activeWorktreeId}
                      showProjectPulse={showProjectPulse}
                      projectIconSvg={projectIconSvg}
                      defaultCwd={defaultCwd}
                    />
                  </div>
                ) : (
                  <LayoutGroup id="fleet-grid">
                    <AnimatePresence initial={false}>
                      {fleetPanels.map((terminal) => {
                        let titleOverride: string | undefined;
                        if (fleetNeedsWorktreePrefix) {
                          const worktreeId = terminal.worktreeId ?? null;
                          const worktree = worktreeId ? worktreeMap.get(worktreeId) : null;
                          const prefix = worktree
                            ? worktree.isMainWorktree
                              ? worktree.name?.trim() ||
                                worktree.branch?.trim() ||
                                "Unknown Worktree"
                              : worktree.branch?.trim() ||
                                worktree.name?.trim() ||
                                "Unknown Worktree"
                            : null;
                          if (prefix) {
                            titleOverride = `${prefix} — ${terminal.title}`;
                          }
                        }
                        return (
                          <motion.div
                            key={terminal.id}
                            layout="position"
                            transition={layoutTransition}
                            transformTemplate={pixelSnapTransform}
                            className="h-full min-w-0"
                          >
                            <GridPanel
                              terminal={terminal}
                              isFocused={terminal.id === focusedId}
                              gridPanelCount={fleetPanels.length}
                              gridCols={fleetGridCols}
                              isFleetScope
                              titleOverride={titleOverride}
                            />
                          </motion.div>
                        );
                      })}
                    </AnimatePresence>
                  </LayoutGroup>
                )}
              </div>
            </ContextMenuTrigger>
            {gridContextMenuContent}
          </ContextMenu>
        </div>
      </div>
    );
  }

  // Maximized terminal or group takes full screen
  if (maximizedId && maximizeTarget) {
    if (maximizeTarget.type === "group") {
      // Find the group and render it maximized with tab bar
      const group = maximizedGroup;
      const groupPanels = maximizedGroupPanels;
      if (group && groupPanels.length > 0) {
        const effectiveFocusedId = maximizedGroupFocusTarget ?? focusedId;

        return (
          <div
            ref={gridRegionRef}
            role="region"
            tabIndex={-1}
            aria-label="Panel grid region"
            data-macro-focus={isMacroFocused ? "true" : undefined}
            onKeyDown={handleGridRegionKeyDown}
            className={cn(
              "h-full flex flex-col bg-daintree-bg outline-hidden",
              "data-[macro-focus=true]:ring-2 data-[macro-focus=true]:ring-daintree-accent/60 data-[macro-focus=true]:ring-inset",
              className
            )}
          >
            <GridNotificationBar className="mx-1 mt-1 shrink-0" />
            <div className="relative min-h-0 flex-1">
              <GridTabGroup
                group={group}
                panels={groupPanels}
                focusedId={effectiveFocusedId}
                gridPanelCount={1}
                gridCols={1}
                isMaximized={true}
              />
            </div>
          </div>
        );
      }
      return null;
    } else {
      // Single panel maximize
      const terminal = gridTerminals.find((t: TerminalInstance) => t.id === maximizedId);
      if (terminal) {
        return (
          <div
            ref={gridRegionRef}
            role="region"
            tabIndex={-1}
            aria-label="Panel grid region"
            data-macro-focus={isMacroFocused ? "true" : undefined}
            onKeyDown={handleGridRegionKeyDown}
            className={cn(
              "h-full flex flex-col bg-daintree-bg outline-hidden",
              "data-[macro-focus=true]:ring-2 data-[macro-focus=true]:ring-daintree-accent/60 data-[macro-focus=true]:ring-inset",
              className
            )}
          >
            <GridNotificationBar className="mx-1 mt-1 shrink-0" />
            <div className="relative min-h-0 flex-1">
              <GridPanel
                terminal={terminal}
                isFocused={true}
                isMaximized={true}
                gridPanelCount={gridItemCount}
              />
            </div>
          </div>
        );
      }
      return null;
    }
  }

  const isEmpty = gridTerminals.length === 0;

  if (useTwoPaneSplitMode && twoPaneTerminals) {
    return (
      <div
        key="split-mode"
        ref={gridRegionRef}
        role="region"
        tabIndex={-1}
        aria-label="Panel grid"
        data-macro-focus={isMacroFocused ? "true" : undefined}
        onKeyDown={handleGridRegionKeyDown}
        className={cn(
          "h-full flex flex-col outline-hidden",
          "data-[macro-focus=true]:ring-2 data-[macro-focus=true]:ring-daintree-accent/60 data-[macro-focus=true]:ring-inset",
          className
        )}
      >
        <GridNotificationBar className="mx-1 mt-1 shrink-0" />
        <TerminalCountWarning className="mx-1 mt-1 shrink-0" />
        <ContextMenu>
          <ContextMenuTrigger asChild>
            <div
              ref={combinedGridRef}
              className={cn(
                "relative flex-1 min-h-0",
                isOver && "ring-2 ring-daintree-accent/30 ring-inset"
              )}
            >
              <TwoPaneSplitLayout
                terminals={twoPaneTerminals}
                focusedId={focusedId}
                activeWorktreeId={activeWorktreeId}
                isInTrash={isInTrash}
                onAddTabLeft={() => handleAddTabForPanel(twoPaneTerminals[0])}
                onAddTabRight={() => handleAddTabForPanel(twoPaneTerminals[1])}
              />
              <GridFullOverlay maxTerminals={maxGridCapacity} show={showGridFullOverlay} />
            </div>
          </ContextMenuTrigger>
          {gridContextMenuContent}
        </ContextMenu>
      </div>
    );
  }

  return (
    <div
      key="grid-mode"
      ref={gridRegionRef}
      role="region"
      tabIndex={-1}
      aria-label="Panel grid"
      data-macro-focus={isMacroFocused ? "true" : undefined}
      onKeyDown={handleGridRegionKeyDown}
      className={cn(
        "h-full flex flex-col outline-hidden",
        "data-[macro-focus=true]:ring-2 data-[macro-focus=true]:ring-daintree-accent/60 data-[macro-focus=true]:ring-inset",
        className
      )}
    >
      <GridNotificationBar className="mx-1 mt-1 shrink-0" />
      <TerminalCountWarning className="mx-1 mt-1 shrink-0" />
      <div className="relative flex-1 min-h-0">
        <SortableContext id="grid-container" items={panelIds} strategy={rectSortingStrategy}>
          <ContextMenu>
            <ContextMenuTrigger asChild>
              <div
                ref={combinedGridRef}
                className={cn(
                  "h-full bg-noise p-1",
                  isOver && "ring-2 ring-daintree-accent/30 ring-inset"
                )}
                style={{
                  display: "grid",
                  gridTemplateColumns: `repeat(${gridCols}, minmax(0, 1fr))`,
                  gridAutoRows: `minmax(${MIN_TERMINAL_HEIGHT_PX}px, 1fr)`,
                  gap: "4px",
                  backgroundColor: "var(--color-grid-bg)",
                  overflowY: "auto",
                }}
                id="panel-grid"
                data-grid-container="true"
              >
                {isEmpty && !showPlaceholder ? (
                  <div className="col-span-full row-span-full">
                    {emptyContent ?? (
                      <EmptyState
                        hasActiveWorktree={hasActiveWorktree}
                        activeWorktreeName={activeWorktreeName}
                        activeWorktreeId={activeWorktreeId}
                        showProjectPulse={showProjectPulse}
                        projectIconSvg={projectIconSvg}
                        defaultCwd={defaultCwd}
                      />
                    )}
                  </div>
                ) : (
                  <LayoutGroup id="main-grid">
                    {tabGroups.map((group, index) => {
                      const groupPanels = getTabGroupPanels(group.id, "grid");
                      if (groupPanels.length === 0) return null;

                      const elements: React.ReactNode[] = [];

                      if (showPlaceholder && placeholderInGrid && placeholderIndex === index) {
                        elements.push(<SortableGridPlaceholder key={GRID_PLACEHOLDER_ID} />);
                      }

                      const isGroupDisabled = groupPanels.some((p) => isInTrash(p.id));

                      if (groupPanels.length === 1) {
                        const terminal = groupPanels[0]!;
                        elements.push(
                          <SortableTerminal
                            key={group.id}
                            terminal={terminal}
                            sourceLocation="grid"
                            sourceIndex={index}
                            disabled={isGroupDisabled}
                            layoutTransition={layoutTransition}
                          >
                            <GridPanel
                              terminal={terminal}
                              isFocused={terminal.id === focusedId}
                              gridPanelCount={gridItemCount}
                              gridCols={gridCols}
                              onAddTab={() => handleAddTabForPanel(terminal)}
                            />
                          </SortableTerminal>
                        );
                      } else {
                        const firstPanel = groupPanels[0]!;
                        elements.push(
                          <SortableTerminal
                            key={group.id}
                            terminal={firstPanel}
                            sourceLocation="grid"
                            sourceIndex={index}
                            disabled={isGroupDisabled}
                            groupId={group.id}
                            groupPanelIds={group.panelIds}
                            layoutTransition={layoutTransition}
                          >
                            <GridTabGroup
                              group={group}
                              panels={groupPanels}
                              focusedId={focusedId}
                              gridPanelCount={gridItemCount}
                              gridCols={gridCols}
                            />
                          </SortableTerminal>
                        );
                      }

                      return elements;
                    })}
                    {showPlaceholder &&
                      placeholderInGrid &&
                      placeholderIndex === tabGroups.length && (
                        <SortableGridPlaceholder key={GRID_PLACEHOLDER_ID} />
                      )}
                  </LayoutGroup>
                )}
              </div>
            </ContextMenuTrigger>
            {gridContextMenuContent}
          </ContextMenu>
        </SortableContext>

        <GridFullOverlay maxTerminals={maxGridCapacity} show={showGridFullOverlay} />
      </div>
    </div>
  );
}
