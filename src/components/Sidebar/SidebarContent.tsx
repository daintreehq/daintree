import React, {
  Suspense,
  lazy,
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from "react";
import { FolderOpen, FilterX, LayoutGrid, Plus, RefreshCw } from "lucide-react";
import { BroadcastTerminalIcon } from "@/components/icons";
import { ScrollIndicator } from "@/components/Worktree/ScrollIndicator";
import { useAgentLauncher, useWorktrees, useProjectSettings, useWorktreeActions } from "@/hooks";
import { createTooltipWithShortcut } from "@/lib/platform";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import {
  WorktreeCard,
  type WorktreeCardProps,
  WorktreeSidebarSearchBar,
  QuickStateFilterBar,
} from "@/components/Worktree";
import { BulkCreateWorktreeDialog } from "@/components/GitHub/BulkCreateWorktreeDialog";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { WorktreeCardErrorFallback } from "@/components/Worktree/WorktreeCardErrorFallback";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import {
  SortableWorktreeCard,
  getWorktreeSortDragId,
} from "@/components/DragDrop/SortableWorktreeCard";
import { usePanelStore, useWorktreeSelectionStore, useProjectStore, useErrorStore } from "@/store";
import { useShallow } from "zustand/react/shallow";
import type { RecipeTerminal } from "@/types";
import { systemClient } from "@/clients";
import { useWorktreeFilterStore } from "@/store/worktreeFilterStore";
import {
  matchesFilters,
  matchesQuickStateFilter,
  sortWorktrees,
  sortWorktreesByRelevance,
  groupByType,
  findIntegrationWorktree,
  scoreWorktree,
  type DerivedWorktreeMeta,
  type FilterState,
} from "@/lib/worktreeFilters";
import { computeChipState } from "@/components/Worktree/utils/computeChipState";
import { parseExactNumber } from "@/lib/parseExactNumber";
import type { WorktreeState } from "@/types";
import { actionService } from "@/services/ActionService";
import { useWorktreeStore } from "@/hooks/useWorktreeStore";
import { useRecipeStore } from "@/store/recipeStore";
import type { WorktreeActions } from "@/hooks/useWorktreeActions";
import type { UseAgentLauncherReturn } from "@/hooks/useAgentLauncher";
import { RecipeEditor } from "@/components/TerminalRecipe/RecipeEditor";
import { RecipeManager } from "@/components/TerminalRecipe/RecipeManager";

export function preloadNewWorktreeDialog() {
  return import("@/components/Worktree/NewWorktreeDialog");
}
const LazyNewWorktreeDialog = lazy(() =>
  preloadNewWorktreeDialog().then((m) => ({ default: m.NewWorktreeDialog }))
);

interface SidebarWorktreeRowProps {
  worktreeId: string;
  activeWorktreeId: string | null;
  focusedWorktreeId: string | null;
  totalWorktreeCount: number;
  selectWorktree: (id: string) => void;
  worktreeActions: WorktreeActions;
  availability: UseAgentLauncherReturn["availability"];
  agentSettings: UseAgentLauncherReturn["agentSettings"];
  homeDir: string | undefined;
  dragStartOrder: string[];
  isSortDisabled: boolean;
  isPinned: boolean;
}

const SidebarWorktreeRow = React.memo(function SidebarWorktreeRow({
  worktreeId,
  activeWorktreeId,
  focusedWorktreeId,
  totalWorktreeCount,
  selectWorktree,
  worktreeActions,
  availability,
  agentSettings,
  homeDir,
  dragStartOrder,
  isSortDisabled,
  isPinned,
}: SidebarWorktreeRowProps) {
  const worktreeSnap = useWorktreeStore((state) => state.worktrees.get(worktreeId));
  const worktree = useMemo(
    () =>
      worktreeSnap
        ? ({
            ...worktreeSnap,
            worktreeChanges: worktreeSnap.worktreeChanges ?? null,
            lastActivityTimestamp: worktreeSnap.lastActivityTimestamp ?? null,
          } as WorktreeState)
        : undefined,
    [worktreeSnap]
  );

  const onSelect = useCallback(() => selectWorktree(worktreeId), [selectWorktree, worktreeId]);
  const onCopyTree = useCallback(
    () => worktree && worktreeActions.handleCopyTree(worktree),
    [worktree, worktreeActions]
  );
  const onOpenEditor = useCallback(
    () => worktree && worktreeActions.handleOpenEditor(worktree),
    [worktree, worktreeActions]
  );
  const onSaveLayout = useCallback(
    () => worktree && worktreeActions.handleSaveLayout(worktree),
    [worktree, worktreeActions]
  );
  const onLaunchAgent = useCallback(
    (agentId: string) => worktreeActions.handleLaunchAgent(worktreeId, agentId),
    [worktreeActions, worktreeId]
  );

  if (!worktree) return null;

  const showDragHandle = !isSortDisabled && !isPinned;
  const isActive = worktreeId === activeWorktreeId;
  const isFocused = worktreeId === focusedWorktreeId;
  const isSingleWorktree = totalWorktreeCount === 1;

  if (showDragHandle) {
    return (
      <SortableWorktreeCard
        worktreeId={worktreeId}
        dragStartOrder={dragStartOrder}
        disabled={isSortDisabled || isPinned}
      >
        {({ isDraggingSort, dragHandleListeners, dragHandleActivatorRef }) => (
          <ErrorBoundary
            variant="component"
            componentName="WorktreeCard"
            fallback={WorktreeCardErrorFallback}
            resetKeys={[worktreeId]}
            context={{ worktreeId }}
          >
            <WorktreeCard
              worktree={worktree}
              isActive={isActive}
              isFocused={isFocused}
              isSingleWorktree={isSingleWorktree}
              onSelect={onSelect}
              onCopyTree={onCopyTree}
              onOpenEditor={onOpenEditor}
              onSaveLayout={onSaveLayout}
              onLaunchAgent={onLaunchAgent}
              agentAvailability={availability}
              agentSettings={agentSettings}
              homeDir={homeDir}
              dragHandleListeners={dragHandleListeners}
              dragHandleActivatorRef={dragHandleActivatorRef}
              isDraggingSort={isDraggingSort}
            />
          </ErrorBoundary>
        )}
      </SortableWorktreeCard>
    );
  }

  return (
    <SortableWorktreeCard worktreeId={worktreeId} dragStartOrder={dragStartOrder} disabled={true}>
      {({ isDraggingSort }) => (
        <ErrorBoundary
          variant="component"
          componentName="WorktreeCard"
          fallback={WorktreeCardErrorFallback}
          resetKeys={[worktreeId]}
          context={{ worktreeId }}
        >
          <WorktreeCard
            worktree={worktree}
            isActive={isActive}
            isFocused={isFocused}
            isSingleWorktree={isSingleWorktree}
            onSelect={onSelect}
            onCopyTree={onCopyTree}
            onOpenEditor={onOpenEditor}
            onSaveLayout={onSaveLayout}
            onLaunchAgent={onLaunchAgent}
            agentAvailability={availability}
            agentSettings={agentSettings}
            homeDir={homeDir}
            isDraggingSort={isDraggingSort}
          />
        </ErrorBoundary>
      )}
    </SortableWorktreeCard>
  );
});

interface StaticWorktreeRowProps {
  worktreeId: string;
  activeWorktreeId: string | null;
  focusedWorktreeId: string | null;
  totalWorktreeCount: number;
  selectWorktree: (id: string) => void;
  worktreeActions: WorktreeActions;
  availability: UseAgentLauncherReturn["availability"];
  agentSettings: UseAgentLauncherReturn["agentSettings"];
  homeDir: string | undefined;
  aggregateCounts?: WorktreeCardProps["aggregateCounts"];
}

const StaticWorktreeRow = React.memo(function StaticWorktreeRow({
  worktreeId,
  activeWorktreeId,
  focusedWorktreeId,
  totalWorktreeCount,
  selectWorktree,
  worktreeActions,
  availability,
  agentSettings,
  homeDir,
  aggregateCounts,
}: StaticWorktreeRowProps) {
  const worktreeSnap = useWorktreeStore((state) => state.worktrees.get(worktreeId));
  const worktree = useMemo(
    () =>
      worktreeSnap
        ? ({
            ...worktreeSnap,
            worktreeChanges: worktreeSnap.worktreeChanges ?? null,
            lastActivityTimestamp: worktreeSnap.lastActivityTimestamp ?? null,
          } as WorktreeState)
        : undefined,
    [worktreeSnap]
  );

  const onSelect = useCallback(() => selectWorktree(worktreeId), [selectWorktree, worktreeId]);
  const onCopyTree = useCallback(
    () => worktree && worktreeActions.handleCopyTree(worktree),
    [worktree, worktreeActions]
  );
  const onOpenEditor = useCallback(
    () => worktree && worktreeActions.handleOpenEditor(worktree),
    [worktree, worktreeActions]
  );
  const onSaveLayout = useCallback(
    () => worktree && worktreeActions.handleSaveLayout(worktree),
    [worktree, worktreeActions]
  );
  const onLaunchAgent = useCallback(
    (agentId: string) => worktreeActions.handleLaunchAgent(worktreeId, agentId),
    [worktreeActions, worktreeId]
  );

  if (!worktree) return null;

  return (
    <ErrorBoundary
      variant="component"
      componentName="WorktreeCard"
      fallback={WorktreeCardErrorFallback}
      resetKeys={[worktreeId]}
      context={{ worktreeId }}
    >
      <WorktreeCard
        worktree={worktree}
        isActive={worktreeId === activeWorktreeId}
        isFocused={worktreeId === focusedWorktreeId}
        isSingleWorktree={totalWorktreeCount === 1}
        aggregateCounts={aggregateCounts}
        onSelect={onSelect}
        onCopyTree={onCopyTree}
        onOpenEditor={onOpenEditor}
        onSaveLayout={onSaveLayout}
        onLaunchAgent={onLaunchAgent}
        agentAvailability={availability}
        agentSettings={agentSettings}
        homeDir={homeDir}
      />
    </ErrorBoundary>
  );
});

interface SidebarContentProps {
  onOpenOverview: () => void;
}

function SidebarContent({ onOpenOverview }: SidebarContentProps) {
  const { worktrees, isLoading, isReconnecting, error, refresh } = useWorktrees();
  const deferredWorktrees = useDeferredValue(worktrees);
  const [isRefreshing, startRefreshTransition] = useTransition();
  const currentProject = useProjectStore((state) => state.currentProject);
  useProjectSettings();
  const { availability, agentSettings } = useAgentLauncher();
  const {
    activeWorktreeId,
    focusedWorktreeId,
    selectWorktree,
    createDialog,
    closeCreateDialog,
    bulkCreateDialog,
    closeBulkCreateDialog,
  } = useWorktreeSelectionStore(
    useShallow((state) => ({
      activeWorktreeId: state.activeWorktreeId,
      focusedWorktreeId: state.focusedWorktreeId,
      selectWorktree: state.selectWorktree,
      createDialog: state.createDialog,
      closeCreateDialog: state.closeCreateDialog,
      bulkCreateDialog: state.bulkCreateDialog,
      closeBulkCreateDialog: state.closeBulkCreateDialog,
    }))
  );

  const [hasOpenedNewWorktree, setHasOpenedNewWorktree] = useState(false);
  useEffect(() => {
    if (createDialog.isOpen) setHasOpenedNewWorktree(true);
  }, [createDialog.isOpen]);

  // Filter/sort state - destructured for stable memoization
  const {
    query,
    orderBy,
    groupByType: isGroupedByType,
    statusFilters,
    typeFilters,
    githubFilters,
    sessionFilters,
    activityFilters,
    alwaysShowActive,
    alwaysShowWaiting,
    pinnedWorktrees,
    manualOrder,
    quickStateFilter,
  } = useWorktreeFilterStore(
    useShallow((state) => ({
      query: state.query,
      orderBy: state.orderBy,
      groupByType: state.groupByType,
      statusFilters: state.statusFilters,
      typeFilters: state.typeFilters,
      githubFilters: state.githubFilters,
      sessionFilters: state.sessionFilters,
      activityFilters: state.activityFilters,
      alwaysShowActive: state.alwaysShowActive,
      alwaysShowWaiting: state.alwaysShowWaiting,
      pinnedWorktrees: state.pinnedWorktrees,
      manualOrder: state.manualOrder,
      quickStateFilter: state.quickStateFilter,
    }))
  );
  const clearAllFilters = useWorktreeFilterStore((state) => state.clearAll);
  const hasActiveFilters = useWorktreeFilterStore((state) => state.hasActiveFilters);
  const unpinWorktree = useWorktreeFilterStore((state) => state.unpinWorktree);
  const collapsedWorktrees = useWorktreeFilterStore((state) => state.collapsedWorktrees);
  const expandWorktree = useWorktreeFilterStore((state) => state.expandWorktree);
  const setQuickStateFilter = useWorktreeFilterStore((state) => state.setQuickStateFilter);

  // Terminal store for derived metadata
  const panelsById = usePanelStore(useShallow((state) => state.panelsById));
  const panelIds = usePanelStore(useShallow((state) => state.panelIds));

  // Error store for derived metadata
  const getWorktreeErrors = useErrorStore((state) => state.getWorktreeErrors);

  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [recipeManagerEdit, setRecipeManagerEdit] = useState<
    import("@/types").TerminalRecipe | undefined
  >(undefined);
  const scrollContentRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [hiddenAbove, setHiddenAbove] = useState(0);
  const [hiddenBelow, setHiddenBelow] = useState(0);

  const [isRecipeEditorOpen, setIsRecipeEditorOpen] = useState(false);
  const [recipeEditorWorktreeId, setRecipeEditorWorktreeId] = useState<string | undefined>(
    undefined
  );
  const [recipeEditorInitialTerminals, setRecipeEditorInitialTerminals] = useState<
    RecipeTerminal[] | undefined
  >(undefined);
  const [recipeEditorDefaultScope, setRecipeEditorDefaultScope] = useState<
    "global" | "project" | undefined
  >(undefined);

  const [isRecipeManagerOpen, setIsRecipeManagerOpen] = useState(false);

  const [homeDir, setHomeDir] = useState<string | undefined>(undefined);

  useEffect(() => {
    systemClient.getHomeDir().then(setHomeDir).catch(console.error);
  }, []);

  const handleRefreshAll = useCallback(() => {
    if (isRefreshing) return;
    startRefreshTransition(async () => {
      await actionService.dispatch("worktree.refresh", undefined, { source: "user" });
    });
  }, [isRefreshing, startRefreshTransition]);

  const setManualOrder = useWorktreeFilterStore((state) => state.setManualOrder);

  // Clean up stale pinned and collapsed worktrees
  useEffect(() => {
    const existingIds = new Set(worktrees.map((w) => w.id));
    const stalePins = pinnedWorktrees.filter((id) => !existingIds.has(id));
    stalePins.forEach((id) => unpinWorktree(id));
    const staleCollapsed = collapsedWorktrees.filter((id) => !existingIds.has(id));
    staleCollapsed.forEach((id) => expandWorktree(id));
  }, [worktrees, pinnedWorktrees, unpinWorktree, collapsedWorktrees, expandWorktree]);

  // Clean up stale manual order entries
  useEffect(() => {
    if (manualOrder.length === 0) return;
    const existingIds = new Set(worktrees.map((w) => w.id));
    const cleaned = manualOrder.filter((id) => existingIds.has(id));
    if (cleaned.length !== manualOrder.length) {
      setManualOrder(cleaned);
    }
  }, [worktrees, manualOrder, setManualOrder]);

  // Compute derived metadata for each worktree
  const derivedMetaMap = useMemo(() => {
    const map = new Map<string, DerivedWorktreeMeta>();
    for (const worktree of deferredWorktrees) {
      let terminalCount = 0;
      let waitingTerminalCount = 0;
      let hasWorkingAgent = false;
      let hasRunningAgent = false;
      let hasWaitingAgent = false;
      let hasCompletedAgent = false;
      let hasExitedAgent = false;

      for (const id of panelIds) {
        const t = panelsById[id];
        if (!t || t.worktreeId !== worktree.id || t.location === "trash") continue;
        terminalCount++;
        if (t.agentState === "working") hasWorkingAgent = true;
        if (t.agentState === "running") hasRunningAgent = true;
        if (t.agentState === "waiting") {
          hasWaitingAgent = true;
          waitingTerminalCount++;
        }
        if (t.agentState === "completed") hasCompletedAgent = true;
        if (t.agentState === "exited") hasExitedAgent = true;
      }

      // chipState logic mirrors useWorktreeStatus.ts — keep in sync
      const hasChanges = (worktree.worktreeChanges?.changedFileCount ?? 0) > 0;
      const isComplete =
        !!worktree.issueNumber &&
        !!worktree.prNumber &&
        !hasChanges &&
        worktree.worktreeChanges !== null;

      let lifecycleStage: "in-review" | "merged" | "ready-for-cleanup" | null = null;
      if (!worktree.isMainWorktree && worktree.worktreeChanges !== null) {
        if (worktree.prState === "merged") {
          lifecycleStage = worktree.issueNumber ? "ready-for-cleanup" : "merged";
        } else if (worktree.prState === "open") {
          lifecycleStage = "in-review";
        }
      }

      const chipState = computeChipState({
        waitingTerminalCount,
        lifecycleStage,
        isComplete,
        hasActiveAgent: hasWorkingAgent || hasRunningAgent,
      });

      map.set(worktree.id, {
        terminalCount,
        hasWorkingAgent,
        hasRunningAgent,
        hasWaitingAgent,
        hasCompletedAgent,
        hasExitedAgent,
        hasMergeConflict:
          worktree.worktreeChanges?.changes.some((c) => c.status === "conflicted") ?? false,
        chipState,
      });
    }
    return map;
  }, [deferredWorktrees, panelsById, panelIds, getWorktreeErrors]);

  // Apply filters and sorting
  const mainWorktree = useMemo(
    () => deferredWorktrees.find((w) => w.isMainWorktree) ?? deferredWorktrees[0] ?? null,
    [deferredWorktrees]
  );

  const integrationWorktree = useMemo(
    () => findIntegrationWorktree(deferredWorktrees, mainWorktree?.id),
    [deferredWorktrees, mainWorktree]
  );

  const quickStateCounts = useMemo(() => {
    const counts = { working: 0, waiting: 0, finished: 0 };
    for (const w of deferredWorktrees) {
      if (w.id === mainWorktree?.id || w.id === integrationWorktree?.id) continue;
      const meta = derivedMetaMap.get(w.id);
      if (!meta) continue;
      if (matchesQuickStateFilter("working", meta)) counts.working++;
      if (matchesQuickStateFilter("waiting", meta)) counts.waiting++;
      if (matchesQuickStateFilter("finished", meta)) counts.finished++;
    }
    return counts;
  }, [deferredWorktrees, derivedMetaMap, mainWorktree, integrationWorktree]);

  const mainWorktreeAggregateCounts = useMemo(() => {
    const nonMainCount = deferredWorktrees.length - 1 - (integrationWorktree ? 1 : 0);
    if (
      nonMainCount === 0 &&
      quickStateCounts.working === 0 &&
      quickStateCounts.waiting === 0 &&
      quickStateCounts.finished === 0
    ) {
      return undefined;
    }
    return {
      worktrees: nonMainCount,
      working: quickStateCounts.working,
      waiting: quickStateCounts.waiting,
      finished: quickStateCounts.finished,
    };
  }, [deferredWorktrees.length, integrationWorktree, quickStateCounts]);

  const { filteredWorktrees, groupedSections } = useMemo(() => {
    const filters: FilterState = {
      query,
      statusFilters,
      typeFilters,
      githubFilters,
      sessionFilters,
      activityFilters,
    };

    // Filter non-main worktrees only (exclude main and integration by ID)
    const nonMain = deferredWorktrees.filter(
      (w) => w.id !== mainWorktree?.id && w.id !== integrationWorktree?.id
    );
    const filtered = nonMain.filter((worktree) => {
      const derived = derivedMetaMap.get(worktree.id) ?? {
        terminalCount: 0,
        hasWorkingAgent: false,
        hasRunningAgent: false,
        hasWaitingAgent: false,
        hasCompletedAgent: false,
        hasExitedAgent: false,
        hasMergeConflict: false,
        chipState: null,
      };
      const isActive = worktree.id === activeWorktreeId;
      const hasActiveQuery = query.trim().length > 0;

      if (alwaysShowActive && isActive && !hasActiveQuery && quickStateFilter === "all") {
        return true;
      }

      if (
        alwaysShowWaiting &&
        derived.hasWaitingAgent &&
        !hasActiveQuery &&
        quickStateFilter === "all"
      ) {
        return true;
      }

      if (quickStateFilter !== "all" && !matchesQuickStateFilter(quickStateFilter, derived)) {
        return false;
      }

      return matchesFilters(worktree, filters, derived, isActive);
    });

    const existingWorktreeIds = new Set(deferredWorktrees.map((w) => w.id));
    const validPinnedWorktrees = pinnedWorktrees.filter((id) => existingWorktreeIds.has(id));

    const hasQuery = query.trim().length > 0;
    const sorted = hasQuery
      ? sortWorktreesByRelevance(filtered, query, orderBy, validPinnedWorktrees, manualOrder)
      : sortWorktrees(filtered, orderBy, validPinnedWorktrees, manualOrder);

    if (isGroupedByType && !hasQuery) {
      return {
        filteredWorktrees: sorted,
        groupedSections: groupByType(sorted, orderBy, validPinnedWorktrees),
      };
    }

    return { filteredWorktrees: sorted, groupedSections: null };
  }, [
    deferredWorktrees,
    query,
    orderBy,
    isGroupedByType,
    statusFilters,
    typeFilters,
    githubFilters,
    sessionFilters,
    activityFilters,
    alwaysShowActive,
    alwaysShowWaiting,
    pinnedWorktrees,
    manualOrder,
    mainWorktree,
    integrationWorktree,
    derivedMetaMap,
    activeWorktreeId,
    quickStateFilter,
  ]);

  const updateScrollIndicators = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    const { scrollTop, scrollHeight, clientHeight } = container;
    const totalItems = filteredWorktrees.length;

    if (scrollHeight <= clientHeight + 1) {
      setHiddenAbove(0);
      setHiddenBelow(0);
      return;
    }

    const scrollableHeight = scrollHeight - clientHeight;
    if (scrollableHeight <= 0) {
      setHiddenAbove(0);
      setHiddenBelow(0);
      return;
    }

    const scrollFraction = Math.min(1, Math.max(0, scrollTop / scrollableHeight));
    const visibleFraction = clientHeight / scrollHeight;
    const approxVisible = Math.max(1, Math.round(totalItems * visibleFraction));
    const totalHidden = Math.max(0, totalItems - approxVisible);

    const above = Math.round(totalHidden * scrollFraction);
    const below = totalHidden - above;

    setHiddenAbove(above);
    setHiddenBelow(below);
  }, [filteredWorktrees.length]);

  useLayoutEffect(() => {
    updateScrollIndicators();
  }, [updateScrollIndicators, filteredWorktrees, groupedSections]);

  useEffect(() => {
    const container = scrollContainerRef.current;
    const content = scrollContentRef.current;
    if (!container) return;

    let rafId: number | null = null;
    const handleScroll = () => {
      if (rafId !== null) return;
      rafId = requestAnimationFrame(() => {
        updateScrollIndicators();
        rafId = null;
      });
    };

    container.addEventListener("scroll", handleScroll, { passive: true });
    const resizeObserver = new ResizeObserver(() => updateScrollIndicators());
    resizeObserver.observe(container);
    if (content) resizeObserver.observe(content);

    return () => {
      container.removeEventListener("scroll", handleScroll);
      if (rafId !== null) cancelAnimationFrame(rafId);
      resizeObserver.disconnect();
    };
  }, [updateScrollIndicators]);

  const scrollToTop = useCallback(() => {
    scrollContainerRef.current?.scrollTo({ top: 0, behavior: "smooth" });
  }, []);

  const scrollToBottom = useCallback(() => {
    const container = scrollContainerRef.current;
    if (container) {
      container.scrollTo({ top: container.scrollHeight, behavior: "smooth" });
    }
  }, []);

  const handleOpenRecipeEditor = useCallback(
    (worktreeId: string, initialTerminals?: RecipeTerminal[]) => {
      setRecipeEditorWorktreeId(worktreeId);
      setRecipeEditorInitialTerminals(initialTerminals);
      setIsRecipeEditorOpen(true);
    },
    []
  );

  useEffect(() => {
    const handleOpenRecipeEditorEvent = (event: Event) => {
      if (!(event instanceof CustomEvent)) return;
      const detail = event.detail as unknown;
      if (!detail) return;
      const d = detail as { worktreeId?: unknown; recipeId?: unknown; initialTerminals?: unknown };

      // If recipeId is provided, open the editor for that recipe
      if (typeof d.recipeId === "string") {
        const recipe = useRecipeStore.getState().getRecipeById(d.recipeId);
        if (recipe) {
          setIsRecipeManagerOpen(false);
          setRecipeEditorWorktreeId(recipe.worktreeId);
          setRecipeEditorDefaultScope(recipe.projectId === undefined ? "global" : "project");
          setRecipeEditorInitialTerminals(undefined);
          setRecipeManagerEdit(recipe);
          setIsRecipeEditorOpen(true);
          return;
        }
      }

      if (typeof d.worktreeId !== "string") return;
      const worktreeId = d.worktreeId;
      const initialTerminals = Array.isArray(d.initialTerminals)
        ? (d.initialTerminals as RecipeTerminal[])
        : undefined;
      handleOpenRecipeEditor(worktreeId, initialTerminals);
    };

    const controller = new AbortController();
    window.addEventListener("daintree:open-recipe-editor", handleOpenRecipeEditorEvent, {
      signal: controller.signal,
    });
    return () => controller.abort();
  }, [handleOpenRecipeEditor]);

  useEffect(() => {
    const handleOpenRecipeManagerEvent = () => {
      setIsRecipeManagerOpen(true);
    };
    const controller = new AbortController();
    window.addEventListener("daintree:open-recipe-manager", handleOpenRecipeManagerEvent, {
      signal: controller.signal,
    });
    return () => controller.abort();
  }, []);

  const handleCloseRecipeManager = useCallback(() => {
    setIsRecipeManagerOpen(false);
  }, []);

  const handleRecipeManagerEdit = useCallback((recipe: import("@/types").TerminalRecipe) => {
    setIsRecipeManagerOpen(false);
    setRecipeEditorWorktreeId(recipe.worktreeId);
    setRecipeEditorDefaultScope(recipe.projectId === undefined ? "global" : "project");
    setRecipeEditorInitialTerminals(undefined);
    // Small delay to let the manager dialog close first
    setTimeout(() => {
      setIsRecipeEditorOpen(true);
    }, 100);
    setRecipeManagerEdit(recipe);
  }, []);

  const handleRecipeManagerCreate = useCallback((scope: "global" | "project") => {
    setIsRecipeManagerOpen(false);
    setRecipeEditorDefaultScope(scope);
    setRecipeEditorWorktreeId(undefined);
    setRecipeEditorInitialTerminals(undefined);
    setRecipeManagerEdit(undefined);
    setTimeout(() => {
      setIsRecipeEditorOpen(true);
    }, 100);
  }, []);

  const worktreeActions = useWorktreeActions({
    onOpenRecipeEditor: handleOpenRecipeEditor,
  });

  const handleCloseRecipeEditor = useCallback(() => {
    setIsRecipeEditorOpen(false);
    setRecipeEditorWorktreeId(undefined);
    setRecipeEditorInitialTerminals(undefined);
    setRecipeEditorDefaultScope(undefined);
    setRecipeManagerEdit(undefined);
  }, []);

  const sortableIds = useMemo(
    () => filteredWorktrees.map((w) => getWorktreeSortDragId(w.id)),
    [filteredWorktrees]
  );

  const dragStartOrder = useMemo(() => filteredWorktrees.map((w) => w.id), [filteredWorktrees]);

  if (isLoading && worktrees.length === 0) {
    return (
      <div className="flex flex-col h-full">
        <div className="flex items-center px-4 py-4 border-b border-divider shrink-0">
          <h2 className="text-daintree-text font-semibold text-sm tracking-wide">Worktrees</h2>
        </div>
        <div className="px-4 py-4 text-daintree-text/60 text-sm">Loading worktrees...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col h-full">
        <div className="flex items-center px-4 py-4 border-b border-divider shrink-0">
          <h2 className="text-daintree-text font-semibold text-sm tracking-wide">Worktrees</h2>
        </div>
        <div className="px-4 py-4">
          <div className="text-[var(--color-status-error)] text-sm mb-2">{error}</div>
          <button
            onClick={() => {
              void actionService.dispatch("worktree.restartService", undefined, { source: "user" });
            }}
            className="text-xs px-2 py-1 border border-divider rounded hover:bg-tint/[0.06] text-daintree-text"
          >
            Restart Service
          </button>
        </div>
      </div>
    );
  }

  if (worktrees.length === 0) {
    return (
      <div className="flex flex-col h-full">
        <div className="flex items-center px-4 py-4 border-b border-divider shrink-0">
          <h2 className="text-daintree-text font-semibold text-sm tracking-wide">Worktrees</h2>
        </div>

        <div className="flex flex-col items-center justify-center py-12 px-4 text-center flex-1">
          <FolderOpen className="w-12 h-12 text-daintree-text/60 mb-3" aria-hidden="true" />

          <h3 className="text-daintree-text font-medium mb-2">No worktrees yet</h3>

          <p className="text-sm text-daintree-text/60 mb-4 max-w-xs">
            Open a Git repository with worktrees to get started. Use{" "}
            <kbd className="px-1.5 py-0.5 bg-tint/[0.06] rounded text-xs">
              File → Open Directory
            </kbd>
          </p>

          <div className="text-xs text-daintree-text/60 text-left w-full max-w-xs">
            <div className="font-medium mb-1">Quick Start:</div>
            <ol className="space-y-1 list-decimal list-inside">
              <li>Open a repository</li>
              <li>Launch an agent</li>
              <li>Inject context to AI agent</li>
            </ol>
          </div>
        </div>
      </div>
    );
  }

  const rootPath = currentProject?.path ?? "";
  const hasNonMainWorktrees = deferredWorktrees.length > 1;
  const hasFilters = hasActiveFilters();
  const worktreeMatchesQuery = (w: WorktreeState) => {
    if (!query) return true;
    const exactNum = parseExactNumber(query);
    if (exactNum !== null) {
      return w.issueNumber === exactNum || w.prNumber === exactNum;
    }
    return scoreWorktree(w, query) > 0;
  };
  const mainMatchesQuery = mainWorktree && worktreeMatchesQuery(mainWorktree);
  const integrationMatchesQuery = integrationWorktree && worktreeMatchesQuery(integrationWorktree);
  const visibleCount = hasFilters
    ? filteredWorktrees.length + (mainMatchesQuery ? 1 : 0) + (integrationMatchesQuery ? 1 : 0)
    : deferredWorktrees.length;

  const hasQuery = query.trim().length > 0;
  const isSortDisabled = isGroupedByType || hasQuery;

  const renderWorktreeCard = (worktree: WorktreeState) => (
    <StaticWorktreeRow
      key={worktree.id}
      worktreeId={worktree.id}
      activeWorktreeId={activeWorktreeId}
      focusedWorktreeId={focusedWorktreeId}
      totalWorktreeCount={deferredWorktrees.length}
      selectWorktree={selectWorktree}
      worktreeActions={worktreeActions}
      availability={availability}
      agentSettings={agentSettings}
      homeDir={homeDir}
    />
  );

  return (
    <TooltipProvider delayDuration={400} skipDelayDuration={300}>
      <div className="flex flex-col h-full">
        {/* Header Section */}
        <div className="group/header flex items-center justify-between px-4 py-2 border-b border-divider bg-transparent shrink-0">
          <div className="flex items-baseline gap-1.5">
            <h2 className="text-daintree-text font-semibold text-sm tracking-wide">Worktrees</h2>
            <span className="text-daintree-text/50 text-xs">
              {hasFilters && visibleCount !== deferredWorktrees.length
                ? `(${visibleCount} of ${deferredWorktrees.length})`
                : `(${deferredWorktrees.length})`}
            </span>
            {isReconnecting && (
              <span
                role="status"
                aria-live="polite"
                className="flex items-center gap-1 text-daintree-text/60 text-xs"
              >
                <RefreshCw className="w-3 h-3 animate-spin" aria-hidden="true" />
                Reconnecting…
              </span>
            )}
          </div>
          <div className="flex items-center gap-1">
            <div className="invisible group-hover/header:visible group-focus-within/header:visible flex items-center gap-1">
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    onClick={onOpenOverview}
                    className="p-1 text-daintree-text/40 hover:text-daintree-text hover:bg-tint/[0.06] rounded transition-colors"
                    aria-label="Open worktrees overview"
                  >
                    <LayoutGrid className="w-3.5 h-3.5" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  {createTooltipWithShortcut("Open worktrees overview", "Cmd+Shift+O")}
                </TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    onClick={() =>
                      actionService.dispatch("terminal.bulkCommand", undefined, {
                        source: "user",
                      })
                    }
                    className="p-1 text-daintree-text/40 hover:text-daintree-text hover:bg-tint/[0.06] rounded transition-colors"
                    aria-label="Open Fleet Deck"
                  >
                    <BroadcastTerminalIcon className="w-3.5 h-3.5" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  {createTooltipWithShortcut("Fleet Deck", "Cmd+Alt+Shift+B")}
                </TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    onClick={handleRefreshAll}
                    disabled={isRefreshing}
                    className="p-1 text-daintree-text/40 hover:text-daintree-text hover:bg-tint/[0.06] rounded transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                    aria-label="Refresh sidebar"
                  >
                    <RefreshCw className={`w-3.5 h-3.5 ${isRefreshing ? "animate-spin" : ""}`} />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom">Refresh sidebar</TooltipContent>
              </Tooltip>
            </div>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={() =>
                    actionService.dispatch("worktree.createDialog.open", undefined, {
                      source: "user",
                    })
                  }
                  className="p-1 text-daintree-text/40 hover:text-daintree-text hover:bg-tint/[0.06] rounded transition-colors"
                  aria-label="Create new worktree"
                >
                  <Plus className="w-3.5 h-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom">Create new worktree</TooltipContent>
            </Tooltip>
          </div>
        </div>

        {/* Inline search bar — only when there are non-main worktrees */}
        {hasNonMainWorktrees && <WorktreeSidebarSearchBar inputRef={searchInputRef} />}

        {/* Main worktree — visible unless excluded by text search */}
        {mainMatchesQuery && (
          <div
            className="shrink-0"
            style={{ contentVisibility: "auto", containIntrinsicSize: "auto 180px" }}
          >
            <StaticWorktreeRow
              key={mainWorktree.id}
              worktreeId={mainWorktree.id}
              activeWorktreeId={activeWorktreeId}
              focusedWorktreeId={focusedWorktreeId}
              totalWorktreeCount={deferredWorktrees.length}
              selectWorktree={selectWorktree}
              worktreeActions={worktreeActions}
              availability={availability}
              agentSettings={agentSettings}
              homeDir={homeDir}
              aggregateCounts={mainWorktreeAggregateCounts}
            />
          </div>
        )}

        {/* Integration branch (develop/trunk/next) — pinned below main, subject to text search */}
        {integrationMatchesQuery && (
          <div
            className="shrink-0"
            style={{ contentVisibility: "auto", containIntrinsicSize: "auto 180px" }}
          >
            {renderWorktreeCard(integrationWorktree)}
          </div>
        )}

        {/* Strong divider between pinned worktrees and scrollable list */}
        {hasNonMainWorktrees && <div className="shrink-0 border-b border-border-default" />}

        {/* Non-main worktree list */}
        <div className="relative flex-1 min-h-0">
          <div ref={scrollContainerRef} className="h-full overflow-y-auto scrollbar-none">
            <div ref={scrollContentRef}>
              {hasNonMainWorktrees && (
                <QuickStateFilterBar
                  value={quickStateFilter}
                  onChange={setQuickStateFilter}
                  counts={quickStateCounts}
                />
              )}
              {filteredWorktrees.length === 0 && hasFilters && hasNonMainWorktrees ? (
                <div className="flex flex-col items-center justify-center py-12 px-4 text-center">
                  <FilterX className="w-10 h-10 text-daintree-text/40 mb-3" />
                  <p className="text-sm text-daintree-text/60 mb-3">
                    No worktrees match your filters
                  </p>
                  <button
                    onClick={clearAllFilters}
                    className="text-xs px-3 py-1.5 text-daintree-accent hover:bg-daintree-accent/10 rounded transition-colors"
                  >
                    Clear filters
                  </button>
                </div>
              ) : groupedSections ? (
                <div className="flex flex-col">
                  {groupedSections.map((section) => (
                    <div key={section.type}>
                      <div className="sticky top-0 z-10 px-4 py-2 text-[10px] font-medium text-daintree-text/50 uppercase tracking-wide bg-daintree-sidebar border-b border-divider">
                        {section.displayName} ({section.worktrees.length})
                      </div>
                      {section.worktrees.map(renderWorktreeCard)}
                    </div>
                  ))}
                </div>
              ) : (
                <SortableContext items={sortableIds} strategy={verticalListSortingStrategy}>
                  <div className="flex flex-col">
                    {filteredWorktrees.map((worktree) => {
                      const isPinned = pinnedWorktrees.includes(worktree.id);
                      return (
                        <SidebarWorktreeRow
                          key={worktree.id}
                          worktreeId={worktree.id}
                          activeWorktreeId={activeWorktreeId}
                          focusedWorktreeId={focusedWorktreeId}
                          totalWorktreeCount={deferredWorktrees.length}
                          selectWorktree={selectWorktree}
                          worktreeActions={worktreeActions}
                          availability={availability}
                          agentSettings={agentSettings}
                          homeDir={homeDir}
                          dragStartOrder={dragStartOrder}
                          isSortDisabled={isSortDisabled}
                          isPinned={isPinned}
                        />
                      );
                    })}
                  </div>
                </SortableContext>
              )}
            </div>
          </div>
          <ScrollIndicator direction="above" count={hiddenAbove} onClick={scrollToTop} />
          <ScrollIndicator direction="below" count={hiddenBelow} onClick={scrollToBottom} />
        </div>

        <RecipeEditor
          recipe={recipeManagerEdit}
          worktreeId={recipeEditorWorktreeId}
          initialTerminals={recipeEditorInitialTerminals}
          defaultScope={recipeEditorDefaultScope}
          isOpen={isRecipeEditorOpen}
          onClose={handleCloseRecipeEditor}
        />

        <RecipeManager
          isOpen={isRecipeManagerOpen}
          onClose={handleCloseRecipeManager}
          onEditRecipe={handleRecipeManagerEdit}
          onCreateRecipe={handleRecipeManagerCreate}
        />

        {rootPath && (createDialog.isOpen || hasOpenedNewWorktree) && (
          <Suspense fallback={null}>
            <LazyNewWorktreeDialog
              isOpen={createDialog.isOpen}
              onClose={closeCreateDialog}
              rootPath={rootPath}
              onWorktreeCreated={(worktreeId) => {
                refresh();
                createDialog.onCreated?.(worktreeId);
              }}
              initialIssue={createDialog.initialIssue}
              initialPR={createDialog.initialPR}
              initialRecipeId={createDialog.initialRecipeId}
            />
          </Suspense>
        )}

        <BulkCreateWorktreeDialog
          isOpen={bulkCreateDialog.isOpen}
          onClose={closeBulkCreateDialog}
          mode={bulkCreateDialog.mode}
          selectedIssues={bulkCreateDialog.selectedIssues}
          selectedPRs={bulkCreateDialog.selectedPRs}
          onComplete={closeBulkCreateDialog}
        />
      </div>
    </TooltipProvider>
  );
}

export { SidebarContent };
