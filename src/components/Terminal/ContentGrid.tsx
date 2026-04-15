import React, { useMemo, useCallback, useEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { SortableContext, rectSortingStrategy } from "@dnd-kit/sortable";
import { useDroppable } from "@dnd-kit/core";
import { cn } from "@/lib/utils";
import { useMacroFocusStore } from "@/store/macroFocusStore";
import {
  usePanelStore,
  useLayoutConfigStore,
  useWorktreeSelectionStore,
  usePreferencesStore,
  useTwoPaneSplitStore,
  type TerminalInstance,
} from "@/store";
import { useProjectStore } from "@/store/projectStore";
import { isAgentReady } from "../../../shared/utils/agentAvailability";
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
import { useAgentSettingsStore } from "@/store/agentSettingsStore";
import { buildPanelDuplicateOptions } from "@/services/terminal/panelDuplicationService";
import { getEffectiveAgentIds, getEffectiveAgentConfig } from "@shared/config/agentRegistry";
import type { BuiltInAgentId } from "@shared/config/agentIds";
import { getMaximizedGroupFocusTarget } from "./contentGridFocus";

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
        Press <Kbd>⌘N</Kbd> to open the panel palette — add terminals, browsers, notes, or dev
        previews
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
          !tip.requiredAgents || tip.requiredAgents.some((a) => isAgentReady(availability[a]))
      ),
    [availability]
  );

  if (filteredTips.length === 0) return null;

  const tip = filteredTips[mountIndex.current % filteredTips.length];

  return (
    <div className="flex flex-col items-center gap-2 animate-in fade-in duration-300">
      <p className="text-xs text-daintree-text/70 text-center">Tip: {tip.message}</p>
      {tip.actionId && tip.actionLabel && (
        <button
          type="button"
          onClick={() => void actionService.dispatch(tip.actionId!, undefined, { source: "user" })}
          className="text-xs text-daintree-accent hover:text-daintree-accent/80 transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-daintree-accent/50 rounded px-1"
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
      { url: "https://github.com/canopyide/canopy#readme" },
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
                className="absolute -bottom-1 -right-1 p-1.5 bg-daintree-sidebar border border-daintree-border rounded-full opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity hover:bg-daintree-bg focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-daintree-accent"
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
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md hover:bg-tint/5 transition-colors group focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-daintree-accent/50"
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
  const gridAgentSettings = useAgentSettingsStore((state) => state.settings);

  // undefined = no filter (settings not loaded or pre-migration); Set = loaded, filter to non-hidden
  const gridSelectedAgentIds = useMemo((): Set<string> | undefined => {
    if (!gridAgentSettings?.agents) return undefined;
    return new Set(
      Object.entries(gridAgentSettings.agents)
        .filter(([, entry]) => entry.pinned === true)
        .map(([id]) => id)
    );
  }, [gridAgentSettings]);
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
    return getTabGroups("grid", activeWorktreeId ?? undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- storeTerminalIds/panelsById/trashedTerminals are intentional trigger deps
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
        console.error("Failed to add tab:", error);
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
  preMaximizeLayoutRef.current = preMaximizeLayout;
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
          instance.terminal.focus();
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
    return computeGridColumns(gridItemCount, gridWidth, strategy, value);
  }, [gridItemCount, layoutConfig, gridWidth, maximizedId, preMaximizeLayout, activeWorktreeId]);

  const gridAgentMenuItems = useMemo(() => {
    return getEffectiveAgentIds()
      .filter((id) => !gridSelectedAgentIds || gridSelectedAgentIds.has(id))
      .map((id) => {
        const agentConfig = getEffectiveAgentConfig(id);
        const canLaunch =
          id === "terminal" ? true : !agentAvailability || isAgentReady(agentAvailability[id]);
        return { id, name: agentConfig?.name ?? id, canLaunch };
      });
  }, [agentAvailability, gridSelectedAgentIds]);

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

  // Batch-fit grid terminals when layout (gridCols/count) changes
  useEffect(() => {
    const ids = gridTerminals.map((t) => t.id);
    let cancelled = false;

    const timeoutId = window.setTimeout(() => {
      if (isDraggingRef.current) return;

      let index = 0;
      const processNext = () => {
        if (cancelled || index >= ids.length) return;
        if (isDraggingRef.current) return;

        const id = ids[index++];
        const managed = terminalInstanceService.get(id);

        if (managed?.hostElement.isConnected) {
          terminalInstanceService.fit(id);
        }
        requestAnimationFrame(processNext);
      };
      processNext();
    }, GRID_FIT_DELAY_MS);

    return () => {
      cancelled = true;
      clearTimeout(timeoutId);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- gridTerminals intentionally excluded to prevent redundant fit cycles on worktree switch
  }, [gridCols, panelIds]);

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
    return panels.length === 2 ? (panels as [TerminalInstance, TerminalInstance]) : null;
  }, [useTwoPaneSplitMode, tabGroups, getTabGroupPanels]);

  // Track mode transitions and stabilize terminals after switch
  const prevModeRef = useRef<boolean>(useTwoPaneSplitMode);
  const gridTerminalsRef = useRef(gridTerminals);
  gridTerminalsRef.current = gridTerminals;

  useEffect(() => {
    const prevMode = prevModeRef.current;
    const currentMode = useTwoPaneSplitMode;

    // Mode transition detected
    if (prevMode !== currentMode) {
      prevModeRef.current = currentMode;

      // Immediate stabilization fit after mode switch
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
      }, 50);

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
              "h-full flex flex-col bg-daintree-bg outline-none",
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
              "h-full flex flex-col bg-daintree-bg outline-none",
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
          "h-full flex flex-col outline-none",
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
        "h-full flex flex-col outline-none",
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
                  transition: isProjectSwitching
                    ? "none"
                    : `grid-template-columns ${GRID_TRANSITION_DURATION_MS}ms ease-out`,
                  overflowY: "auto",
                }}
                role="grid"
                id="panel-grid"
                aria-label="Panel grid"
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
                  <>
                    {tabGroups.map((group, index) => {
                      const groupPanels = getTabGroupPanels(group.id, "grid");
                      if (groupPanels.length === 0) return null;

                      const elements: React.ReactNode[] = [];

                      if (showPlaceholder && placeholderInGrid && placeholderIndex === index) {
                        elements.push(<SortableGridPlaceholder key={GRID_PLACEHOLDER_ID} />);
                      }

                      const isGroupDisabled = groupPanels.some((p) => isInTrash(p.id));

                      if (groupPanels.length === 1) {
                        const terminal = groupPanels[0];
                        elements.push(
                          <SortableTerminal
                            key={group.id}
                            terminal={terminal}
                            sourceLocation="grid"
                            sourceIndex={index}
                            disabled={isGroupDisabled}
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
                        const firstPanel = groupPanels[0];
                        elements.push(
                          <SortableTerminal
                            key={group.id}
                            terminal={firstPanel}
                            sourceLocation="grid"
                            sourceIndex={index}
                            disabled={isGroupDisabled}
                            groupId={group.id}
                            groupPanelIds={group.panelIds}
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
                  </>
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

export default ContentGrid;
