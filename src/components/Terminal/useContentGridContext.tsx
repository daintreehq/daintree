import {
  useMemo,
  useCallback,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useShallow } from "zustand/react/shallow";
import { useDroppable } from "@dnd-kit/core";
import type { Transition, TransformProperties } from "framer-motion";
import { logError } from "@/utils/logger";
import { useMacroFocusStore } from "@/store/macroFocusStore";
import {
  usePanelStore,
  panelStoreApi,
  useLayoutConfigStore,
  useWorktreeSelectionStore,
  usePreferencesStore,
  useTwoPaneSplitStore,
} from "@/store";
import { getNarrowPanel, getRenderablePanel } from "@/store/slices/panelRegistry/selectors";
import { useFleetArmingStore } from "@/store/fleetArmingStore";
import { useFleetScopeFlagStore } from "@/store/fleetScopeFlagStore";
import { useProjectStore } from "@/store/projectStore";
import { computeGridSelectedAgentIds } from "./contentGridAgentFilter";
import { buildFleetPanels } from "./contentGridFleetPanels";
import { useDndPlaceholder, useIsDragging, GRID_PLACEHOLDER_ID } from "@/components/DragDrop";
import { terminalInstanceService } from "@/services/TerminalInstanceService";
import {
  subscribeOptimisticClose,
  getClosingIdsSnapshot,
} from "@/services/terminal/optimisticPanelClose";
import { TerminalRefreshTier } from "@shared/types/panel";
import type { PanelInstance, TabGroup, TabGroupLocation } from "@shared/types/panel";
import {
  computeGridColumns,
  computeScrollRowHeight,
  gridRowsOverflowWithHysteresis,
  GRID_TRANSITION_DURATION_MS,
} from "@/lib/terminalLayout";
import {
  isSidebarMeasurementLocked,
  subscribeSidebarLayoutTransitionUnlock,
  subscribeSidebarHydrationUnlock,
} from "@/lib/layoutTransitionLock";
import { useWorktrees } from "@/hooks/useWorktrees";
import { useProjectBranding } from "@/hooks";
import { useCliAvailabilityStore } from "@/store/cliAvailabilityStore";
import type { CliAvailability } from "@shared/types";
import {
  ContextMenuActionItem,
  ContextMenuContent,
  ContextMenuCheckboxItem,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from "@/components/ui/context-menu";
import { MenuActionSourceContext } from "@/components/ui/menu-source";
import { buildPanelDuplicateOptions } from "@/services/terminal/panelDuplicationService";
import { getEffectiveAgentIds } from "@shared/config/agentRegistry";
import { isAssistantOnlyAgentId } from "@shared/config/agentIds";
import {
  subscribeToPluginAgentRegistry,
  getPluginAgentRegistrySnapshot,
} from "@shared/config/pluginAgentRegistry";
import { getAgentConfig } from "@/config/agents";
import {
  DockLaunchMenuItems,
  type DockLaunchAgent,
  type DockLaunchMenuComponents,
} from "@/components/Layout/DockLaunchMenuItems";
import { useToolbarPreferencesStore } from "@/store/toolbarPreferencesStore";
import { useAgentSettingsStore } from "@/store/agentSettingsStore";
import { useProjectSettingsStore } from "@/store/projectSettingsStore";
import { sortAgentsByToolbarPin } from "@/lib/agentMenuOrder";
import { getMaximizedGroupFocusTarget } from "./contentGridFocus";
import { setGridLayoutSnapshot } from "./gridLayoutSnapshot";
import { actionService } from "@/services/ActionService";

// Stable empty arrays — returned from `useShallow` selectors and memos when
// the filtered list is empty so the previous reference is reused (avoids a
// spurious re-render emitting a new `[]` each call). Module-local; never
// mutated.
const EMPTY_PANEL_IDS: string[] = [];
const EMPTY_TERMINALS: PanelInstance[] = [];
const EMPTY_TAB_GROUPS: TabGroup[] = [];

// Radix primitives mapped for the shared dock/grid launch menu. Defined per
// call site (mirrors ContentDock) so the presentational component stays
// decoupled from the consumer's Radix import space.
const GRID_CONTEXT_MENU_COMPONENTS: DockLaunchMenuComponents = {
  Item: ContextMenuItem,
  Label: ContextMenuLabel,
  Separator: ContextMenuSeparator,
};

// Module-level so the try/catch stays outside useContentGridContext — a
// statement-level try block inside the hook bails React Compiler memoization
// for the whole hook. Store actions are read at call time (see issue #8593).
export async function addTabForPanel(panel: PanelInstance): Promise<void> {
  const {
    getPanelGroup,
    createTabGroup,
    addPanelToGroup,
    deleteTabGroup,
    addPanel,
    trashPanel,
    setActiveTab,
    setFocused,
  } = panelStoreApi.getState();
  let groupId: string | undefined;
  let createdNewGroup = false;
  let newPanelId: string | null = null;

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
    newPanelId = await addPanel(options);
    if (!newPanelId) {
      if (createdNewGroup && groupId) deleteTabGroup(groupId);
      return;
    }

    // A failed add (worktree mismatch, group vanished) would otherwise leave the
    // freshly-created duplicate orphaned outside any group. Trash it first so no
    // reconciler ever sees a panel pointing at a deleted/empty group (#6596),
    // then tear down the group this call created. Skip activation/focus — the
    // panel isn't a member, so setActiveTab would no-op and setFocused would
    // focus an orphan.
    if (!addPanelToGroup(groupId, newPanelId)) {
      trashPanel(newPanelId);
      if (createdNewGroup && groupId) deleteTabGroup(groupId);
      return;
    }
    setActiveTab(groupId, newPanelId);
    setFocused(newPanelId);
  } catch (error) {
    logError("Failed to add tab", error);
    // Mirror the rejection path's cleanup: if a panel was created before the
    // throw, trash it before tearing down a group this call created, so a
    // mid-flight failure never leaves an orphaned panel behind (#10441).
    if (newPanelId) trashPanel(newPanelId);
    if (createdNewGroup && groupId) {
      deleteTabGroup(groupId);
    }
  }
}

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
  gridTerminals: PanelInstance[];
  tabGroups: TabGroup[];
  focusedId: string | null;
  maximizedId: string | null;
  maximizeTarget: ReturnType<typeof usePanelStore.getState>["maximizeTarget"];
  maximizedGroup: TabGroup | undefined;
  maximizedGroupPanels: PanelInstance[];
  maximizedGroupFocusTarget: string | null;
  gridCols: number;
  fleetGridCols: number;
  /** True once the grid becomes a vertical scroll surface (5+ panels / 3+ rows). */
  isScrollMode: boolean;
  /** Fixed row height (px) used in scroll mode; ignored in non-scroll quad mode. */
  scrollRowHeight: number;
  layoutTransition: Transition;
  layoutAnimationEnabled: boolean;
  layoutConfig: ReturnType<typeof useLayoutConfigStore.getState>["layoutConfig"];
  gridWidth: number | null;
  isFleetScopeRender: boolean;
  fleetPanels: PanelInstance[];
  fleetNeedsWorktreePrefix: boolean;
  isOver: boolean;
  isDragging: boolean;
  showPlaceholder: boolean;
  placeholderInGrid: boolean;
  placeholderIndex: number | null;
  sourceContainer: string | null;
  /**
   * The grid's scroll container element, exposed so `TerminalPane` can root its
   * IntersectionObserver at the grid (rather than the viewport). Held as state
   * — not a ref — because consumers depend on identity changes to re-create
   * observers when the container mounts/remounts.
   */
  gridScrollRoot: HTMLElement | null;
  setGridScrollRoot: (el: HTMLElement | null) => void;
  useTwoPaneSplitMode: boolean;
  isEmpty: boolean;
  isMacroFocused: boolean;
  isProjectSwitching: boolean;
  panelIds: string[];
  gridItemCount: number;
  twoPaneTerminals: [PanelInstance, PanelInstance] | null;
  gridContextMenuContent: React.ReactNode;
  handleAddTabForPanel: (panel: PanelInstance) => Promise<void>;
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
  isWorktreeInitialized: boolean;
  getTabGroupPanels: (groupId: string, location?: TabGroupLocation) => PanelInstance[];
  getPanelGroup: (panelId: string) => TabGroup | undefined;
  getActiveTabId: (groupId: string) => string | null;
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
  // Deliberately excluded from React Compiler memoization. This hook is built
  // on the #8593 pattern — subscribe to narrow structural triggers, then read
  // the full panel map via `panelStoreApi.getState()` at evaluation time. The
  // compiler cannot see those untracked store reads, so compiling the hook
  // caches derivations against stale state: in a compiled build, freshly
  // spawned panels never appeared in the grid (verified against the core E2E
  // suite). The statement-level try/catch hoist (addTabForPanel) stays — it
  // keeps this opt-out the hook's only remaining compiler obstacle if the
  // evaluation-time reads are ever migrated to tracked selectors.
  "use no memo";

  "use memo";
  // Subscribe only to structural fields. `panelsById` itself is intentionally
  // excluded — `updateAgentState`/`updateActivity` spread it on every agent
  // tick, which would invalidate `useShallow` and re-run the whole hook. The
  // structural fields below (`panelIds`, `tabGroups`, `trashedTerminals`)
  // plus the dedicated `gridPanelIds`/`fleetPanelIds` subscriptions defined
  // further down only change on add/remove/move/trash/restore. Memos that
  // need per-panel fields read `panelsById` non-reactively via
  // `panelStoreApi.getState()` at evaluation time. See issue #8593.
  const {
    storeTerminalIds,
    storeTabGroups,
    trashedTerminals,
    focusedId,
    maximizedId: rawMaximizedId,
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

  // Panels the user just clicked to close. They are filtered out of every grid
  // derivation below so the panel disappears in the same frame as the click;
  // the canonical trash commit runs ~one debounce later (see optimisticPanelClose).
  const closingIds = useSyncExternalStore(subscribeOptimisticClose, getClosingIdsSnapshot);

  // Closing the maximized panel un-maximizes instantly; the canonical commit
  // clears the store's `maximizedId` ~one debounce later.
  const maximizedId =
    rawMaximizedId !== null && closingIds.has(rawMaximizedId) ? null : rawMaximizedId;

  const activeWorktreeId = useWorktreeSelectionStore((state) => state.activeWorktreeId);
  const showProjectPulse = usePreferencesStore((state) => state.showProjectPulse);
  const currentProject = useProjectStore((state) => state.currentProject);
  const isAvailabilityInitialized = useCliAvailabilityStore((s) => s.isInitialized);
  // `useShallow` is mandatory on the `leftButtons` array slice — a bare
  // selector returns a new array reference every store tick and would
  // invalidate this hook's "use memo" block on any unrelated toolbar update.
  const leftButtons = useToolbarPreferencesStore(useShallow((s) => s.layout.leftButtons));
  const agentSettings = useAgentSettingsStore((s) => s.settings);
  const hasDevPreview = useProjectSettingsStore((s) =>
    Boolean(s.settings?.devServerCommand?.trim())
  );
  // Re-derive grid agents when a plugin loads/unloads mid-session so its agents
  // appear / disappear with current icon/name/color (#9879).
  const pluginAgentRegistry = useSyncExternalStore(
    subscribeToPluginAgentRegistry,
    getPluginAgentRegistrySnapshot
  );

  const gridSelectedAgentIds = useMemo(() => {
    // Referenced so this memo re-derives when plugins load/unload mid-session;
    // getEffectiveAgentIds() reads the merged (incl. plugin) registry (#9879).
    void pluginAgentRegistry;
    return computeGridSelectedAgentIds(
      isAvailabilityInitialized,
      agentAvailability,
      getEffectiveAgentIds()
    );
  }, [isAvailabilityInitialized, agentAvailability, pluginAgentRegistry]);
  const isProjectSwitching = false;
  const { projectIconSvg } = useProjectBranding(currentProject?.id);
  const { worktreeMap, isInitialized: isWorktreeInitialized } = useWorktrees();
  const activeWorktree = activeWorktreeId ? worktreeMap.get(activeWorktreeId) : null;
  const hasActiveWorktree = activeWorktreeId != null && activeWorktree != null;
  const activeWorktreeName = activeWorktree
    ? activeWorktree.isMainWorktree
      ? activeWorktree.name?.trim() || "Unknown Worktree"
      : activeWorktree.branch?.trim() || activeWorktree.name?.trim() || "Unknown Worktree"
    : null;

  // Mirrors ContentDock so the shared launch menu can run recipes with the
  // same worktree-scoped variable substitutions from the grid surface.
  const gridRecipeContext = activeWorktree
    ? {
        issueNumber: activeWorktree.issueNumber,
        prNumber: activeWorktree.linked?.pr?.ref.number,
        branchName: activeWorktree.branch,
        worktreePath: activeWorktree.path,
      }
    : undefined;

  const isInTrash = usePanelStore((state) => state.isInTrash);

  const twoPaneSplitEnabled = useTwoPaneSplitStore((state) => state.config.enabled);

  const isFleetScopeActive = useWorktreeSelectionStore((state) => state.isFleetScopeActive);
  const fleetScopeMode = useFleetScopeFlagStore((state) => state.mode);
  const { armedIds, armOrder } = useFleetArmingStore(
    useShallow((state) => ({ armedIds: state.armedIds, armOrder: state.armOrder }))
  );
  const isFleetScopeEnabled = fleetScopeMode === "scoped" && isFleetScopeActive;

  // Structurally-filtered list of grid panel IDs for the active worktree.
  // The selector body runs on every store update, but `useShallow` returns
  // the previous reference whenever membership and order are unchanged —
  // agent-state/activity ticks mutate `panelsById` references without
  // changing `location`, so the filter result stays stable. This is what
  // makes the location-change paths (trashPanel of ungrouped, moveTerminalTo
  // Dock/Grid of ungrouped) correctly invalidate downstream memos while
  // per-tick mutations are absorbed.
  const gridPanelIds = usePanelStore(
    useShallow((state) => {
      const ids = state.panelIdsByWorktreeId[activeWorktreeId ?? "__none__"];
      if (!ids || ids.length === 0) return EMPTY_PANEL_IDS;
      const result: string[] = [];
      for (const id of ids) {
        const t = state.panelsById[id];
        if (t && (t.location === "grid" || t.location === undefined)) {
          result.push(id);
        }
      }
      return result.length === 0 ? EMPTY_PANEL_IDS : result;
    })
  );

  const gridTerminals = useMemo(() => {
    if (gridPanelIds.length === 0) return EMPTY_TERMINALS;
    const byId = panelStoreApi.getState().panelsById;
    const result: PanelInstance[] = [];
    for (const id of gridPanelIds) {
      if (closingIds.has(id)) continue;
      // Render-eligibility (not type-narrowing): plugin-contributed kinds must
      // count as grid members so they render and don't leave `isEmpty` stuck
      // true (#10512). `getNarrowPanel` alone drops them.
      const renderable = getRenderablePanel(byId, id);
      if (renderable) result.push(renderable);
    }
    return result.length === 0 ? EMPTY_TERMINALS : result;
  }, [gridPanelIds, closingIds]);

  const getTabGroups = usePanelStore((state) => state.getTabGroups);
  const getTabGroupPanels = usePanelStore((state) => state.getTabGroupPanels);
  const getPanelGroup = usePanelStore((state) => state.getPanelGroup);

  const tabGroups = useMemo(() => {
    // Structural-change triggers:
    //   - `gridPanelIds` catches add/remove and dock↔grid location changes
    //     for ungrouped panels (where neither `storeTabGroups` nor
    //     `trashedTerminals` would fire).
    //   - `storeTabGroups` catches tab-group mutations (create, add panel,
    //     delete) where membership of grid panels is unchanged.
    //   - `trashedTerminals` retained for the contentGridTrashDep regression
    //     test contract; it overlaps with `gridPanelIds` for grid panels but
    //     also covers restore-from-trash paths.
    void gridPanelIds;
    void storeTabGroups;
    void trashedTerminals;
    const groups = getTabGroups("grid", activeWorktreeId ?? undefined);
    if (closingIds.size === 0) return groups;
    // Drop optimistically-closing panels so the grid reflows the instant X is
    // clicked — before the canonical trash commit lands in the store.
    const filtered: TabGroup[] = [];
    for (const group of groups) {
      const kept = group.panelIds.filter((id) => !closingIds.has(id));
      if (kept.length === 0) continue;
      if (kept.length === group.panelIds.length) {
        filtered.push(group);
      } else {
        filtered.push({
          ...group,
          panelIds: kept,
          activeTabId: kept.includes(group.activeTabId) ? group.activeTabId : (kept[0] ?? ""),
        });
      }
    }
    return filtered.length === 0 ? EMPTY_TAB_GROUPS : filtered;
  }, [getTabGroups, activeWorktreeId, gridPanelIds, storeTabGroups, trashedTerminals, closingIds]);

  const handleAddTabForPanel = useCallback((panel: PanelInstance) => addTabForPanel(panel), []);

  const layoutConfig = useLayoutConfigStore((state) => state.layoutConfig);
  const setGridDimensions = useLayoutConfigStore((state) => state.setGridDimensions);

  // The scroll container that hosts the panel grid. Held as state (not a ref)
  // so `TerminalPane`'s IntersectionObserver effect can depend on its identity
  // and re-create the observer when the container mounts. The setter is the
  // ref callback wired into `ContentGridDefault`'s scrolling div.
  const [gridScrollRoot, setGridScrollRootState] = useState<HTMLElement | null>(null);
  const setGridScrollRoot = useCallback((el: HTMLElement | null) => {
    setGridScrollRootState((prev) => (prev === el ? prev : el));
  }, []);

  // `EMPTY_TAB_GROUPS` is still referenced by the tab-group filter above for
  // the closing-panel fast path.
  void EMPTY_TAB_GROUPS;

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
  // Grid height is tracked locally (like `gridWidth`) rather than read from the
  // layout store: the store's `gridDimensions` is reset to null whenever the
  // ResizeObserver effect re-subscribes (it re-runs on every panel open/close),
  // which would blip `scrollRowHeight` to its default and resize every terminal.
  const [gridHeight, setGridHeight] = useState<number | null>(null);

  const { placeholderIndex, sourceContainer } = useDndPlaceholder();
  const isDragging = useIsDragging();
  const isDraggingRef = useRef(isDragging);
  useEffect(() => {
    isDraggingRef.current = isDragging;
  }, [isDragging]);

  const placeholderInGrid =
    placeholderIndex !== null && placeholderIndex >= 0 && placeholderIndex <= tabGroups.length;

  // The grid scrolls vertically now, so dock→grid drops always have a landing
  // spot — no more grid-full rejection. The placeholder shows whenever the
  // drag originates from the dock and the cursor is in the grid region.
  const showPlaceholder = placeholderInGrid && sourceContainer === "dock";
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
        // produces visible jitter on the panel grid edge (#6979). Also skip
        // during startup hydration, before the persisted sidebar width is
        // restored (#10827).
        if (isSidebarMeasurementLocked()) return;
        if (entry) {
          // Read the same `clientWidth`/`clientHeight` (content-box + padding)
          // the initial-mount and post-unlock paths use, rather than
          // `entry.contentRect` (content-box, excludes padding). The scroll
          // gutter toggles with scroll mode, but because this measurement is
          // padding-inclusive (and `#panel-grid` hides its native scrollbar in
          // CSS), that toggle doesn't move the measured size — it's what lets
          // the gutter be conditional without re-opening #10871's feedback. The
          // three paths must still agree on box model so a re-subscription never
          // jumps the measured size — the downstream
          // `maxFeasibleCols`/`gridRowsOverflow` math subtracts `GRID_PADDING_PX`
          // and expects the padding-inclusive dimension.
          const width = container.clientWidth;
          const height = container.clientHeight;
          setGridWidth((prev) => (prev === width ? prev : width));
          setGridHeight((prev) => (prev === height ? prev : height));
          setGridDimensions({ width, height });
        }
      });
    });

    observer.observe(container);
    // If the effect re-mounts mid-transition (e.g., a dep like
    // `gridTerminals.length` changes during the lock window), or while startup
    // hydration is still pending (#10827), skip the initial measurement — a
    // mid-animation or pre-restore `<main>` width would re-snap
    // `grid-template-columns` and reintroduce jitter. The unlock subscribers
    // below sync the grid once the transition completes / hydration lands.
    if (!isSidebarMeasurementLocked()) {
      setGridWidth(container.clientWidth);
      setGridHeight(container.clientHeight);
      setGridDimensions({ width: container.clientWidth, height: container.clientHeight });
    }

    // Force a single measurement after the sidebar transition completes (or
    // after startup hydration lands, #10827) so the grid reaches its settled
    // size even if no further RO entry fires (the geometry may already be
    // stable by the time we unlock). Shared by both unlock subscribers.
    const remeasureAfterUnlock = () => {
      const node = gridContainerRef.current;
      if (!node) return;
      if (finalRafId !== null) cancelAnimationFrame(finalRafId);
      finalRafId = requestAnimationFrame(() => {
        finalRafId = null;
        // Re-check both locks — a second toggle may have started in the ~16ms
        // between unlock and this rAF, in which case our measurement would
        // capture a mid-animation width from the new transition.
        if (isSidebarMeasurementLocked()) return;
        const measureNode = gridContainerRef.current;
        if (!measureNode) return;
        const width = measureNode.clientWidth;
        const height = measureNode.clientHeight;
        setGridWidth((prev) => (prev === width ? prev : width));
        setGridHeight((prev) => (prev === height ? prev : height));
        setGridDimensions({ width, height });
      });
    };

    const unsubscribeTransition = subscribeSidebarLayoutTransitionUnlock(remeasureAfterUnlock);
    // #10827: remeasure once the persisted sidebar width is restored. Fires
    // synchronously if hydration already completed before this effect mounted.
    const unsubscribeHydration = subscribeSidebarHydrationUnlock(remeasureAfterUnlock);

    return () => {
      observer.disconnect();
      if (rafId !== null) cancelAnimationFrame(rafId);
      if (finalRafId !== null) cancelAnimationFrame(finalRafId);
      unsubscribeTransition();
      unsubscribeHydration();
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

  // Previous committed column count, fed back into `computeGridColumns` for
  // breakpoint hysteresis. Held as state (not a ref) so the `gridCols` memo can
  // read it during render — the React Compiler disallows ref reads there. The
  // effect below settles it to the committed value; feeding the result back is
  // a hysteresis fixed point, so this costs at most one extra render per actual
  // column change.
  const [hysteresisGridCols, setHysteresisGridCols] = useState<number | undefined>(undefined);

  // Previous committed scroll-mode boolean, fed back into the row-overflow
  // Schmitt trigger below. Held as state (not a ref) for the same reason as
  // `hysteresisGridCols`: it is read during render (in the `isScrollMode`
  // derivation) and the React Compiler disallows ref reads there. Settled in
  // the same `useLayoutEffect` that settles `hysteresisGridCols`.
  const [hysteresisScrollMode, setHysteresisScrollMode] = useState<boolean | undefined>(undefined);

  // Switching worktrees reuses this same hook instance (`activeWorktreeId` is
  // reactive state, not a remount key), so a scroll-mode hold entered in one
  // view would otherwise carry into the next — pinning a smaller-panel-count
  // view in scroll mode at the same window size. Drop the hold on any view
  // change so the incoming worktree evaluates against the fresh threshold. The
  // close-path reset lives in the settle effect below.
  useEffect(() => {
    setHysteresisScrollMode(undefined);
  }, [activeWorktreeId]);

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
    return computeGridColumns(gridItemCount, gridWidth, strategy, value, hysteresisGridCols);
  }, [
    gridItemCount,
    layoutConfig,
    gridWidth,
    maximizedId,
    preMaximizeLayout,
    activeWorktreeId,
    hysteresisGridCols,
  ]);

  // Scroll mode is the last resort: the grid scrolls only once its rows would
  // overflow the visible height even at the small `GRID_MIN_PANEL_ROWS` floor.
  // Panel count never triggers it — a tall display fits many rows first. When
  // it does scroll, rows are fixed-height (not a `1fr` stretch) so closing a
  // panel never restretches and resizes every surviving terminal.
  //
  // The row count uses real grid groups (`tabGroups.length`), not
  // `gridItemCount`: a drag placeholder must not flip row-height mode mid-drag.
  // `closingIds.size` is added back so an in-flight optimistic close keeps the
  // pre-close count — a close otherwise exits scroll mode on the click path and
  // restretches the survivors, the exact resize fixed rows exist to avoid. The
  // layout settles once the canonical commit clears `closingIds`.
  const scrollModeCount = tabGroups.length + closingIds.size;
  const scrollModeRows = gridCols > 0 ? Math.ceil(scrollModeCount / gridCols) : scrollModeCount;
  const isScrollMode = gridRowsOverflowWithHysteresis(
    scrollModeRows,
    gridHeight,
    hysteresisScrollMode
  );
  const scrollRowHeight = useMemo(() => computeScrollRowHeight(gridHeight), [gridHeight]);

  const layoutTransition: Transition = useMemo(
    () => ({
      duration: isProjectSwitching || closingIds.size > 0 ? 0 : GRID_TRANSITION_DURATION_MS / 1000,
      ease: [0.22, 1, 0.36, 1],
    }),
    [isProjectSwitching, closingIds.size]
  );
  const layoutAnimationEnabled = !isProjectSwitching && closingIds.size === 0;

  // Build the same `DockLaunchAgent[]` shape the dock uses so the grid menu
  // renders identical brand icons, then split/order by toolbar pin state.
  const { sorted: gridLaunchAgents, pinnedCount: gridAgentPinnedCount } = useMemo(() => {
    // Referenced so this memo re-derives when plugins load/unload mid-session;
    // getEffectiveAgentIds/getAgentConfig read the merged (incl. plugin) registry (#9879).
    void pluginAgentRegistry;
    const agents: DockLaunchAgent[] = getEffectiveAgentIds()
      // Assistant-only agents are never offered in the grid launch menu.
      .filter((id) => !isAssistantOnlyAgentId(id))
      .filter((id) => !gridSelectedAgentIds || gridSelectedAgentIds.has(id))
      .map((id) => {
        const config = getAgentConfig(id);
        return {
          id,
          name: config?.name ?? id,
          icon: config?.icon,
          brandColor: config?.color,
          availability: agentAvailability?.[id],
        };
      });
    return sortAgentsByToolbarPin(agents, leftButtons, agentSettings);
  }, [agentAvailability, gridSelectedAgentIds, leftButtons, agentSettings, pluginAgentRegistry]);

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
    // All grid groups now participate in SortableContext / dnd — the scrollable
    // grid keeps every panel in the grid container, so there is no off-grid
    // overflow set to exclude.
    const ids = tabGroups.map((g) => g.panelIds[0] ?? g.id);
    if (showPlaceholder && placeholderInGrid) {
      const insertIndex = Math.min(Math.max(0, placeholderIndex), ids.length);
      ids.splice(insertIndex, 0, GRID_PLACEHOLDER_ID);
    }
    return ids;
  }, [tabGroups, showPlaceholder, placeholderIndex, placeholderInGrid]);

  // Structurally-filtered fleet panel IDs. Delegates membership to
  // `buildFleetPanels` (single source of truth — see #5989) and projects to
  // IDs so `useShallow`'s element-wise compare absorbs agent-state/activity
  // ticks. Only re-emits when fleet composition (armed set, arm order) or
  // panel location changes shift the rendered set.
  const fleetPanelIds = usePanelStore(
    useShallow((state) => {
      if (!isFleetScopeEnabled) return EMPTY_PANEL_IDS;
      const panels = buildFleetPanels(armOrder, armedIds, state.panelsById);
      if (panels.length === 0) return EMPTY_PANEL_IDS;
      return panels.map((p) => p.id);
    })
  );

  const fleetPanels = useMemo(() => {
    if (fleetPanelIds.length === 0) return EMPTY_TERMINALS;
    const byId = panelStoreApi.getState().panelsById;
    const result: PanelInstance[] = [];
    for (const id of fleetPanelIds) {
      if (closingIds.has(id)) continue;
      const narrowed = getNarrowPanel(byId, id);
      if (narrowed) result.push(narrowed);
    }
    return result.length === 0 ? EMPTY_TERMINALS : result;
  }, [fleetPanelIds, closingIds]);

  const isFleetScopeRender = isFleetScopeEnabled && fleetPanels.length > 0;

  const fleetNeedsWorktreePrefix = useMemo(() => {
    if (fleetPanels.length <= 1) return false;
    const firstWorktreeId = fleetPanels[0]?.worktreeId ?? null;
    return fleetPanels.some((t) => (t.worktreeId ?? null) !== firstWorktreeId);
  }, [fleetPanels]);

  // See `hysteresisGridCols` — same prior-render feedback for breakpoint
  // hysteresis, held as state so the `fleetGridCols` memo can read it during
  // render.
  const [hysteresisFleetCols, setHysteresisFleetCols] = useState<number | undefined>(undefined);

  const fleetGridCols = useMemo(() => {
    if (!isFleetScopeRender) return 1;
    const { strategy, value } = layoutConfig;
    return computeGridColumns(
      Math.max(fleetPanels.length, 1),
      gridWidth,
      strategy,
      value,
      hysteresisFleetCols
    );
  }, [isFleetScopeRender, fleetPanels, layoutConfig, gridWidth, hysteresisFleetCols]);

  // Mirror the live grid layout into a module-level snapshot. Two consumers
  // read it imperatively rather than as React props:
  // - `GridPanel.handleToggleMaximize` reads `gridCols`/`gridItemCount` at
  //   click time so stable props don't churn its `React.memo`.
  // - `useGridNavigation` reads `gridCols`/`fleetGridCols` at memo time so the
  //   keyboard-nav layout always agrees with the rendered grid (#8857).
  //
  // `useLayoutEffect` rather than `useEffect`: the write must land before
  // paint so a keypress immediately after a maximize/restore commit never
  // reads a stale column count. Cleanup resets to defaults on unmount so a
  // project switch doesn't briefly serve the previous grid's values while
  // the new `useContentGridContext` mounts.
  useLayoutEffect(() => {
    setGridLayoutSnapshot({ gridCols, gridItemCount, fleetGridCols });
    return () => {
      setGridLayoutSnapshot({ gridCols: 1, gridItemCount: 0, fleetGridCols: 1 });
    };
  }, [gridCols, gridItemCount, fleetGridCols]);

  const prevFleetGridColsRef = useRef(fleetGridCols);
  useLayoutEffect(() => {
    const writeFleetHysteresis =
      isFleetScopeRender && layoutConfig.strategy === "automatic" ? fleetGridCols : undefined;
    if (!isFleetScopeRender) {
      prevFleetGridColsRef.current = fleetGridCols;
      setHysteresisFleetCols(writeFleetHysteresis);
      return;
    }
    const ids = fleetPanels.map((t) => t.id);
    for (const id of ids) {
      terminalInstanceService.applyRendererPolicy(id, TerminalRefreshTier.VISIBLE);
    }
    const fleetColsChanged = prevFleetGridColsRef.current !== fleetGridCols;
    prevFleetGridColsRef.current = fleetGridCols;
    setHysteresisFleetCols(writeFleetHysteresis);

    if (isDraggingRef.current || ids.length === 0) return;

    // Schedule a coalesced fleet-pane resize off the open/close path — one
    // pass once the burst settles (see scheduleBatchResize).
    terminalInstanceService.scheduleBatchResize(ids);

    // A column-count change shifts cell widths, so the per-host ResizeObserver
    // would otherwise fire an uncoordinated second resize through the 200ms
    // FLIP. Lock those panes for the transition window; the lock's unlock pass
    // doubles as the corrective backstop.
    if (fleetColsChanged) {
      terminalInstanceService.suppressResizesDuringLayoutTransition(
        ids,
        GRID_TRANSITION_DURATION_MS
      );
    }
  }, [isFleetScopeRender, fleetPanels, fleetGridCols, layoutConfig.strategy]);

  // Reads fresh `gridTerminals` without making it an effect dependency — it
  // changes on agent-state ticks that must not retrigger a resize pass.
  const runGridBatchFit = useEffectEvent(() => {
    if (isDraggingRef.current) return;
    const ids = gridTerminals.map((t) => t.id);
    if (ids.length > 0) {
      terminalInstanceService.scheduleBatchResize(ids);
    }
  });
  const prevGridColsRef = useRef(gridCols);
  const prevPanelCountRef = useRef(panelIds.length);
  const prevScrollGeoRef = useRef(`${isScrollMode}:${scrollRowHeight}`);
  useLayoutEffect(() => {
    void gridCols;
    void panelIds;

    const colsChanged = prevGridColsRef.current !== gridCols;
    prevGridColsRef.current = gridCols;

    const scrollGeoKey = `${isScrollMode}:${scrollRowHeight}`;
    const scrollGeoChanged = prevScrollGeoRef.current !== scrollGeoKey;
    prevScrollGeoRef.current = scrollGeoKey;

    const isPureClose = panelIds.length < prevPanelCountRef.current;
    prevPanelCountRef.current = panelIds.length;

    setHysteresisGridCols(
      layoutConfig.strategy === "automatic" && !showPlaceholder ? gridCols : undefined
    );

    // Settle the scroll-mode Schmitt trigger. Unlike column hysteresis
    // (automatic-strategy only), `isScrollMode` is computed for every layout
    // strategy, so this is NOT gated on strategy (that would silently re-disable
    // the row-overflow dead band for fixed-rows / fixed-columns layouts).
    //
    // The dead band exists to smooth *resize*-driven jitter, not content-shape
    // changes. On a panel close the layout genuinely has fewer rows, and the
    // ~1.5-row buffer would otherwise dwarf that swing and pin the grid in
    // scroll mode until the window grew ~500px — a stale hold unrelated to the
    // resize the buffer is for. Reset to `undefined` on a close so the next
    // render re-evaluates against the fresh (bare) threshold; the worktree-switch
    // reset effect below covers the analogous cross-view case. `applyHysteresis`
    // gets the same self-correction for free via its `countCeiling` cap.
    setHysteresisScrollMode(isPureClose ? undefined : isScrollMode);

    if (isProjectSwitching || isDraggingRef.current) return;

    // Closing a panel in scroll mode leaves every survivor at its exact size —
    // fixed column tracks, fixed row height. Resizing them all on the close
    // path is pure waste and a real source of close-path lag, so skip the
    // batch fit when nothing about the survivors' geometry actually changed.
    const survivorGeometryStable = isScrollMode && isPureClose && !colsChanged && !scrollGeoChanged;
    if (!survivorGeometryStable) {
      // Schedule a coalesced sibling resize off the open/close path — the click
      // never waits on N xterm resizes, and a burst of opens/closes collapses
      // into a single pass once it settles (see scheduleBatchResize).
      runGridBatchFit();
    }

    // A layout-changing close (or a column change) resizes every survivor's
    // box. Each panel's own ResizeObserver in XtermAdapter would otherwise
    // fire its own un-chunked resize on top of the coalesced pass above — a
    // resize storm that is the main cause of close-path lag. Lock the panels
    // for the transition window so the single chunked pass is the only resize;
    // the lock's unlock pass is the corrective backstop.
    const layoutChangingClose = isPureClose && !survivorGeometryStable;
    if (colsChanged || scrollGeoChanged || layoutChangingClose) {
      const realPanelIds = panelIds.filter((id) => id !== GRID_PLACEHOLDER_ID);
      if (realPanelIds.length > 0) {
        terminalInstanceService.suppressResizesDuringLayoutTransition(
          realPanelIds,
          GRID_TRANSITION_DURATION_MS
        );
      }
    }
  }, [
    gridCols,
    panelIds,
    isScrollMode,
    scrollRowHeight,
    isProjectSwitching,
    layoutConfig.strategy,
    showPlaceholder,
  ]);

  const allGroupsAreSinglePanel = tabGroups.every((g) => g.panelIds.length === 1);
  // Virtual singletons use `id === panelId` (see getTabGroups in tabGroups.ts);
  // explicit groups always use `tabgroup-${uuid}`. Requiring all groups to be
  // virtual prevents split mode from activating during the transient window in
  // addTabForPanel where an explicit singleton group exists before the new panel
  // has been folded into it — which otherwise crashes the app (issue #10438).
  const allGroupsAreVirtual = tabGroups.every((g) => g.id === (g.panelIds[0] ?? ""));
  const useTwoPaneSplitMode =
    twoPaneSplitEnabled &&
    tabGroups.length === 2 &&
    allGroupsAreSinglePanel &&
    allGroupsAreVirtual &&
    !maximizedId &&
    !showPlaceholder;

  const twoPaneTerminals = useMemo((): [PanelInstance, PanelInstance] | null => {
    if (!useTwoPaneSplitMode) return null;
    const byId = panelStoreApi.getState().panelsById;
    const panels = tabGroups
      .slice(0, 2)
      .map((g) => {
        const raw = getTabGroupPanels(g.id, "grid")[0];
        return raw ? getRenderablePanel(byId, raw.id) : undefined;
      })
      .filter((p): p is PanelInstance => p !== undefined);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    return panels.length === 2 ? (panels as [PanelInstance, PanelInstance]) : null;
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
  const maximizedGroupPanels = useMemo((): PanelInstance[] => {
    if (!maximizedGroup) return [];
    const byId = panelStoreApi.getState().panelsById;
    return getTabGroupPanels(maximizedGroup.id, "grid")
      .map((raw) => getRenderablePanel(byId, raw.id))
      .filter((p): p is PanelInstance => p !== undefined);
  }, [getTabGroupPanels, maximizedGroup]);
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
      <DockLaunchMenuItems
        components={GRID_CONTEXT_MENU_COMPONENTS}
        agents={gridLaunchAgents}
        pinnedCount={gridAgentPinnedCount}
        hasDevPreview={hasDevPreview}
        activeWorktreeId={activeWorktreeId}
        cwd={defaultCwd ?? ""}
        recipeContext={gridRecipeContext}
        onLaunchAgent={handleGridLaunch}
        settingsSource="context-menu"
      />
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

  // Wrap the store's getTabGroupPanels (returns carrier shape) so the
  // context surface exposes PanelInstance[] — resolved via getRenderablePanel
  // at call time so callers never touch the carrier shape AND plugin-contributed
  // kinds stay in the rendered set (#10512).
  const getTabGroupPanelsMapped = useCallback(
    (groupId: string, location?: TabGroupLocation): PanelInstance[] => {
      const byId = panelStoreApi.getState().panelsById;
      return getTabGroupPanels(groupId, location)
        .map((raw) => getRenderablePanel(byId, raw.id))
        .filter((p): p is PanelInstance => p !== undefined);
    },
    [getTabGroupPanels]
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
    isScrollMode,
    scrollRowHeight,
    layoutTransition,
    layoutAnimationEnabled,
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
    gridScrollRoot,
    setGridScrollRoot,
    useTwoPaneSplitMode,
    isEmpty,
    isMacroFocused,
    isProjectSwitching,
    panelIds,
    gridItemCount,
    twoPaneTerminals,
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
    isWorktreeInitialized,
    getTabGroupPanels: getTabGroupPanelsMapped,
    getPanelGroup,
    getActiveTabId,
    storeTerminalIds,
  };

  return { ctx, bindCombinedGrid, bindGridRegion };
}
