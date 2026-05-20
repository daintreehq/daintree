import { useMemo, useCallback, useEffect, useEffectEvent, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useDroppable } from "@dnd-kit/core";
import type { Transition, TransformProperties } from "framer-motion";
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
import { computeGridCanLaunch, computeGridSelectedAgentIds } from "./contentGridAgentFilter";
import { buildFleetPanels } from "./contentGridFleetPanels";
import { useDndPlaceholder, useIsDragging, GRID_PLACEHOLDER_ID } from "@/components/DragDrop";
import { terminalInstanceService } from "@/services/TerminalInstanceService";
import { TerminalRefreshTier } from "@shared/types/panel";
import type { TabGroup, TabGroupLocation } from "@shared/types/panel";
import {
  computeGridColumns,
  GRID_TRANSITION_DURATION_MS,
  GRID_FIT_DELAY_MS,
} from "@/lib/terminalLayout";
import {
  isSidebarLayoutTransitionLocked,
  subscribeSidebarLayoutTransitionUnlock,
} from "@/lib/layoutTransitionLock";
import { useWorktrees } from "@/hooks/useWorktrees";
import { useProjectBranding } from "@/hooks";
import { useCliAvailabilityStore } from "@/store/cliAvailabilityStore";
import type { CliAvailability } from "@shared/types";
import {
  ContextMenuActionItem,
  ContextMenuContent,
  ContextMenuCheckboxItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from "@/components/ui/context-menu";
import { MenuActionSourceContext } from "@/components/ui/menu-source";
import { buildPanelDuplicateOptions } from "@/services/terminal/panelDuplicationService";
import { getEffectiveAgentIds, getEffectiveAgentConfig } from "@shared/config/agentRegistry";
import { getMaximizedGroupFocusTarget } from "./contentGridFocus";
import { actionService } from "@/services/ActionService";

export function pixelSnapTransform({ x, y }: TransformProperties): string {
  const tx = typeof x === "number" ? x : parseFloat(x ?? "0") || 0;
  const ty = typeof y === "number" ? y : parseFloat(y ?? "0") || 0;
  return `translate3d(${Math.round(tx)}px, ${Math.round(ty)}px, 0)`;
}

export interface ContentGridProps {
  className?: string;
  defaultCwd?: string;
  agentAvailability?: CliAvailability;
  emptyContent?: React.ReactNode;
}

export interface ContentGridContext {
  defaultCwd?: string;
  agentAvailability?: CliAvailability;
  emptyContent?: React.ReactNode;
  gridTerminals: TerminalInstance[];
  tabGroups: TabGroup[];
  focusedId: string | null;
  maximizedId: string | null;
  maximizeTarget: ReturnType<typeof usePanelStore.getState>["maximizeTarget"];
  maximizedGroup: TabGroup | undefined;
  maximizedGroupPanels: TerminalInstance[];
  maximizedGroupFocusTarget: string | null;
  gridCols: number;
  fleetGridCols: number;
  layoutTransition: Transition;
  layoutConfig: ReturnType<typeof useLayoutConfigStore.getState>["layoutConfig"];
  gridWidth: number | null;
  isFleetScopeRender: boolean;
  fleetPanels: TerminalInstance[];
  fleetNeedsWorktreePrefix: boolean;
  isOver: boolean;
  isDragging: boolean;
  showPlaceholder: boolean;
  placeholderInGrid: boolean;
  placeholderIndex: number | null;
  sourceContainer: string | null;
  isGridFull: boolean;
  showGridFullOverlay: boolean;
  useTwoPaneSplitMode: boolean;
  isEmpty: boolean;
  isMacroFocused: boolean;
  isProjectSwitching: boolean;
  panelIds: string[];
  gridItemCount: number;
  twoPaneTerminals: [TerminalInstance, TerminalInstance] | null;
  gridAgentMenuItems: { id: string; name: string; canLaunch: boolean }[];
  gridContextMenuContent: React.ReactNode;
  handleAddTabForPanel: (panel: TerminalInstance) => Promise<void>;
  handleGridLaunch: (agentId: string) => void;
  handleGridLayoutChange: (strategy: "automatic" | "fixed-columns" | "fixed-rows") => void;
  handleGridRegionKeyDown: (e: React.KeyboardEvent) => void;
  hasActiveWorktree: boolean;
  activeWorktreeName: string | null;
  activeWorktreeId: string | null;
  activeWorktreeBranch: string | null;
  activeWorktreeIsDetached: boolean;
  activeWorktreeHead: string | null;
  activeWorktreePath: string | null;
  projectName: string | null;
  projectEmoji: string | null;
  showProjectPulse: boolean;
  projectIconSvg: string | undefined;
  worktreeMap: ReturnType<typeof useWorktrees>["worktreeMap"];
  isInTrash: (id: string) => boolean;
  getTabGroupPanels: (groupId: string, location?: TabGroupLocation) => TerminalInstance[];
  getPanelGroup: (panelId: string) => TabGroup | undefined;
  getActiveTabId: (groupId: string) => string | null;
  maxGridCapacity: number;
  storeTerminalIds: string[];
}

export interface ContentGridResult {
  ctx: ContentGridContext;
  bindCombinedGrid: (node: HTMLDivElement | null) => void;
  bindGridRegion: (node: HTMLDivElement | null) => void;
}

export function useContentGridContext({
  className: _className,
  defaultCwd,
  agentAvailability,
  emptyContent,
}: ContentGridProps): ContentGridResult {
  "use memo";
  // Subscribe only to structural fields. `panelsById` itself is intentionally
  // excluded — `updateAgentState`/`updateActivity` spread it on every agent
  // tick, which would invalidate `useShallow` and re-run the whole hook. The
  // structural deps below (`panelIds`, `tabGroups`, `panelIdsByWorktreeId`,
  // `trashedTerminals`) only change on add/remove/move/trash/restore. The
  // memos that actually need per-panel fields read `panelsById` non-reactively
  // via `usePanelStore.getState()` at evaluation time. See issue #8593.
  const {
    storeTerminalIds,
    storeTabGroups,
    panelIdsByWorktreeId,
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
      storeTerminalIds: state.panelIds,
      storeTabGroups: state.tabGroups,
      panelIdsByWorktreeId: state.panelIdsByWorktreeId,
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

  const twoPaneSplitEnabled = useTwoPaneSplitStore((state) => state.config.enabled);

  const isFleetScopeActive = useWorktreeSelectionStore((state) => state.isFleetScopeActive);
  const fleetScopeMode = useFleetScopeFlagStore((state) => state.mode);
  const { armedIds, armOrder } = useFleetArmingStore(
    useShallow((state) => ({ armedIds: state.armedIds, armOrder: state.armOrder }))
  );
  const isFleetScopeEnabled = fleetScopeMode === "scoped" && isFleetScopeActive;

  const gridTerminals = useMemo(() => {
    const result: TerminalInstance[] = [];
    // Scope to a single worktree's bucket so per-terminal ticks in unrelated
    // worktrees do not re-evaluate this memo. `panelIdsByWorktreeId` is
    // maintained at write-time and preserves bucket reference stability
    // (see #7451). Read `panelsById` non-reactively — structural changes are
    // already captured by `panelIdsByWorktreeId`.
    const ids = panelIdsByWorktreeId[activeWorktreeId ?? "__none__"];
    if (!ids || ids.length === 0) return result;
    const byId = usePanelStore.getState().panelsById;
    for (const id of ids) {
      const t = byId[id];
      if (t && (t.location === "grid" || t.location === undefined)) {
        result.push(t);
      }
    }
    return result;
  }, [panelIdsByWorktreeId, activeWorktreeId]);

  const getTabGroups = usePanelStore((state) => state.getTabGroups);
  const getTabGroupPanels = usePanelStore((state) => state.getTabGroupPanels);
  const getPanelGroup = usePanelStore((state) => state.getPanelGroup);
  const createTabGroup = usePanelStore((state) => state.createTabGroup);
  const addPanelToGroup = usePanelStore((state) => state.addPanelToGroup);
  const deleteTabGroup = usePanelStore((state) => state.deleteTabGroup);
  const addPanel = usePanelStore((state) => state.addPanel);
  const setActiveTab = usePanelStore((state) => state.setActiveTab);

  const tabGroups = useMemo(() => {
    // Structural-change triggers. `storeTabGroups` covers tab-group mutations.
    // `trashedTerminals` covers the trash-without-tab-group edge case in
    // `trashActions.ts` where `tabGroups` reference doesn't change but the
    // trashed terminal must disappear from the grid (see contentGridTrashDep
    // regression test).
    void storeTerminalIds;
    void storeTabGroups;
    void trashedTerminals;
    return getTabGroups("grid", activeWorktreeId ?? undefined);
  }, [getTabGroups, activeWorktreeId, storeTerminalIds, storeTabGroups, trashedTerminals]);

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

  const maxGridCapacity = getMaxGridCapacity();
  const isGridFull = tabGroups.length >= maxGridCapacity;

  const { setNodeRef, isOver } = useDroppable({
    id: "grid-container",
    data: { container: "grid" },
  });

  const gridContainerRef = useRef<HTMLDivElement>(null);
  const preMaximizeLayoutRef = useRef(preMaximizeLayout);
  useEffect(() => {
    preMaximizeLayoutRef.current = preMaximizeLayout;
  }, [preMaximizeLayout]);
  const [gridWidth, setGridWidth] = useState<number | null>(null);

  const { placeholderIndex, sourceContainer } = useDndPlaceholder();
  const isDragging = useIsDragging();
  const isDraggingRef = useRef(isDragging);
  useEffect(() => {
    isDraggingRef.current = isDragging;
  }, [isDragging]);

  const placeholderInGrid =
    placeholderIndex !== null && placeholderIndex >= 0 && placeholderIndex <= tabGroups.length;

  const showPlaceholder = placeholderInGrid && sourceContainer === "dock" && !isGridFull;
  const gridItemCount = tabGroups.length + (showPlaceholder ? 1 : 0);

  const bindGridRegion = useCallback((node: HTMLDivElement | null) => {
    useMacroFocusStore.getState().setRegionRef("grid", node);
  }, []);
  const isMacroFocused = useMacroFocusStore((state) => state.focusedRegion === "grid");

  const handleGridRegionKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (!isMacroFocused) return;

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

  const bindCombinedGrid = useCallback(
    (node: HTMLDivElement | null) => {
      setNodeRef(node);
      gridContainerRef.current = node;
    },
    [setNodeRef]
  );

  // Observe container resizes with rAF deferral to avoid RO depth-cap warnings.
  // Recreated when the container element or layout-affecting deps change.
  useEffect(() => {
    const container = gridContainerRef.current;
    if (!container) return;

    let rafId: number | null = null;
    let latestEntry: ResizeObserverEntry | null = null;
    let finalRafId: number | null = null;

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      latestEntry = entry;
      if (rafId !== null) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        const entry = latestEntry;
        latestEntry = null;
        // Skip mid-transition widths — the flex parent is reflowing every
        // frame and committing fractional widths into `grid-template-columns`
        // produces visible jitter on the panel grid edge (#6979).
        if (isSidebarLayoutTransitionLocked()) return;
        if (entry) {
          const { width, height } = entry.contentRect;
          setGridWidth((prev) => (prev === width ? prev : width));
          setGridDimensions({ width, height });
        }
      });
    });

    observer.observe(container);
    // If the effect re-mounts mid-transition (e.g., a dep like
    // `gridTerminals.length` changes during the lock window), skip the
    // initial measurement — a mid-animation `<main>` width would re-snap
    // `grid-template-columns` and reintroduce jitter. The unlock subscriber
    // below will sync the grid once the transition completes.
    if (!isSidebarLayoutTransitionLocked()) {
      setGridWidth(container.clientWidth);
      setGridDimensions({ width: container.clientWidth, height: container.clientHeight });
    }

    // Force a single measurement after the sidebar transition completes so
    // the grid lands at its post-transition size even if no further RO entry
    // fires (the geometry may already be settled by the time we unlock).
    const unsubscribe = subscribeSidebarLayoutTransitionUnlock(() => {
      const node = gridContainerRef.current;
      if (!node) return;
      if (finalRafId !== null) cancelAnimationFrame(finalRafId);
      finalRafId = requestAnimationFrame(() => {
        finalRafId = null;
        // Re-check the lock — a second toggle may have started in the ~16ms
        // between unlock and this rAF, in which case our measurement would
        // capture a mid-animation width from the new transition.
        if (isSidebarLayoutTransitionLocked()) return;
        const measureNode = gridContainerRef.current;
        if (!measureNode) return;
        const width = measureNode.clientWidth;
        const height = measureNode.clientHeight;
        setGridWidth((prev) => (prev === width ? prev : width));
        setGridDimensions({ width, height });
      });
    });

    return () => {
      observer.disconnect();
      if (rafId !== null) cancelAnimationFrame(rafId);
      if (finalRafId !== null) cancelAnimationFrame(finalRafId);
      unsubscribe();
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
        { source: "user" }
      );
    },
    [defaultCwd]
  );

  const handleGridLayoutChange = useCallback(
    (strategy: "automatic" | "fixed-columns" | "fixed-rows") => {
      void actionService.dispatch("panel.gridLayout.setStrategy", { strategy }, { source: "user" });
    },
    []
  );

  const panelIds = useMemo(() => {
    const ids = tabGroups.map((g) => g.panelIds[0] ?? g.id);
    if (showPlaceholder && placeholderInGrid) {
      const insertIndex = Math.min(Math.max(0, placeholderIndex), ids.length);
      ids.splice(insertIndex, 0, GRID_PLACEHOLDER_ID);
    }
    return ids;
  }, [tabGroups, showPlaceholder, placeholderIndex, placeholderInGrid]);

  const fleetPanels = useMemo(() => {
    if (!isFleetScopeEnabled) return [];
    // Read `panelsById` non-reactively. Structural invalidation comes from
    // `armOrder`/`armedIds` (fleet membership) and `storeTerminalIds` (panel
    // add/remove/location change — a panel moving to `trash`/`background`
    // would otherwise leave a stale entry here).
    return buildFleetPanels(armOrder, armedIds, usePanelStore.getState().panelsById);
  }, [isFleetScopeEnabled, armOrder, armedIds, storeTerminalIds]);

  const isFleetScopeRender = isFleetScopeEnabled && fleetPanels.length > 0;

  const fleetNeedsWorktreePrefix = useMemo(() => {
    if (fleetPanels.length <= 1) return false;
    const firstWorktreeId = fleetPanels[0]?.worktreeId ?? null;
    return fleetPanels.some((t) => (t.worktreeId ?? null) !== firstWorktreeId);
  }, [fleetPanels]);

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

  const prevFleetGridColsRef = useRef(fleetGridCols);
  useEffect(() => {
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
  const prevGridColsRef = useRef(gridCols);
  useEffect(() => {
    void gridCols;
    void panelIds;

    const colsChanged = prevGridColsRef.current !== gridCols;
    prevGridColsRef.current = gridCols;
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

  const showGridFullOverlay = sourceContainer === "dock" && isGridFull;

  const allGroupsAreSinglePanel = tabGroups.every((g) => g.panelIds.length === 1);
  const useTwoPaneSplitMode =
    twoPaneSplitEnabled &&
    tabGroups.length === 2 &&
    allGroupsAreSinglePanel &&
    !maximizedId &&
    !showPlaceholder;

  const twoPaneTerminals = useMemo((): [TerminalInstance, TerminalInstance] | null => {
    if (!useTwoPaneSplitMode) return null;
    const panels = tabGroups
      .slice(0, 2)
      .map((g) => getTabGroupPanels(g.id, "grid")[0])
      .filter((t): t is TerminalInstance => t !== undefined);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    return panels.length === 2 ? (panels as [TerminalInstance, TerminalInstance]) : null;
  }, [useTwoPaneSplitMode, tabGroups, getTabGroupPanels]);

  const prevModeRef = useRef<boolean>(useTwoPaneSplitMode);
  const gridTerminalsRef = useRef(gridTerminals);
  useEffect(() => {
    gridTerminalsRef.current = gridTerminals;
  }, [gridTerminals]);

  useEffect(() => {
    const prevMode = prevModeRef.current;
    const currentMode = useTwoPaneSplitMode;

    if (prevMode !== currentMode) {
      prevModeRef.current = currentMode;

      const MODE_SWITCH_FIT_DELAY_MS = 50;
      const timeoutId = window.setTimeout(() => {
        if (isDraggingRef.current) return;

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
      <ContextMenuActionItem
        actionId="agent.launch"
        args={{ agentId: "terminal", location: "grid", cwd: defaultCwd || undefined }}
      >
        New Terminal
      </ContextMenuActionItem>
      <ContextMenuActionItem
        actionId="agent.launch"
        args={{ agentId: "browser", location: "grid", cwd: defaultCwd || undefined }}
      >
        New Browser
      </ContextMenuActionItem>
      {gridAgentMenuItems.length > 0 && <ContextMenuSeparator />}
      {gridAgentMenuItems.map((agent) => (
        <ContextMenuActionItem
          key={agent.id}
          actionId="agent.launch"
          args={{ agentId: agent.id, location: "grid", cwd: defaultCwd || undefined }}
          disabled={!agent.canLaunch}
        >
          New {agent.name}
        </ContextMenuActionItem>
      ))}
      <ContextMenuSeparator />
      <ContextMenuSub>
        <ContextMenuSubTrigger>Grid Layout</ContextMenuSubTrigger>
        <ContextMenuSubContent>
          <MenuActionSourceContext.Consumer>
            {(menuSource) => (
              <>
                <ContextMenuCheckboxItem
                  checked={layoutConfig.strategy === "automatic"}
                  onSelect={() =>
                    void actionService.dispatch(
                      "panel.gridLayout.setStrategy",
                      { strategy: "automatic" },
                      { source: menuSource ?? "user" }
                    )
                  }
                >
                  Automatic
                </ContextMenuCheckboxItem>
                <ContextMenuCheckboxItem
                  checked={layoutConfig.strategy === "fixed-columns"}
                  onSelect={() =>
                    void actionService.dispatch(
                      "panel.gridLayout.setStrategy",
                      { strategy: "fixed-columns" },
                      { source: menuSource ?? "user" }
                    )
                  }
                >
                  Fixed Columns
                </ContextMenuCheckboxItem>
                <ContextMenuCheckboxItem
                  checked={layoutConfig.strategy === "fixed-rows"}
                  onSelect={() =>
                    void actionService.dispatch(
                      "panel.gridLayout.setStrategy",
                      { strategy: "fixed-rows" },
                      { source: menuSource ?? "user" }
                    )
                  }
                >
                  Fixed Rows
                </ContextMenuCheckboxItem>
              </>
            )}
          </MenuActionSourceContext.Consumer>
        </ContextMenuSubContent>
      </ContextMenuSub>
      <ContextMenuSeparator />
      <ContextMenuActionItem actionId="app.settings.openTab" args={{ tab: "terminal" }}>
        Terminal Settings...
      </ContextMenuActionItem>
    </ContextMenuContent>
  );

  const isEmpty = gridTerminals.length === 0;

  const ctx: ContentGridContext = {
    defaultCwd,
    agentAvailability,
    emptyContent,
    gridTerminals,
    tabGroups,
    focusedId,
    maximizedId,
    maximizeTarget,
    maximizedGroup,
    maximizedGroupPanels,
    maximizedGroupFocusTarget,
    gridCols,
    fleetGridCols,
    layoutTransition,
    layoutConfig,
    gridWidth,
    isFleetScopeRender,
    fleetPanels,
    fleetNeedsWorktreePrefix,
    isOver,
    isDragging,
    showPlaceholder,
    placeholderInGrid,
    placeholderIndex,
    sourceContainer,
    isGridFull,
    showGridFullOverlay,
    useTwoPaneSplitMode,
    isEmpty,
    isMacroFocused,
    isProjectSwitching,
    panelIds,
    gridItemCount,
    twoPaneTerminals,
    gridAgentMenuItems,
    gridContextMenuContent,
    handleAddTabForPanel,
    handleGridLaunch,
    handleGridLayoutChange,
    handleGridRegionKeyDown,
    hasActiveWorktree,
    activeWorktreeName,
    activeWorktreeId,
    activeWorktreeBranch: activeWorktree?.branch?.trim() || null,
    activeWorktreeIsDetached: activeWorktree?.isDetached ?? false,
    activeWorktreeHead: activeWorktree?.head ?? null,
    activeWorktreePath: activeWorktree?.path ?? null,
    projectName: currentProject?.name ?? null,
    projectEmoji: currentProject?.emoji ?? null,
    showProjectPulse,
    projectIconSvg,
    worktreeMap,
    isInTrash,
    getTabGroupPanels,
    getPanelGroup,
    getActiveTabId,
    maxGridCapacity,
    storeTerminalIds,
  };

  return { ctx, bindCombinedGrid, bindGridRegion };
}
