import {
  Suspense,
  lazy,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from "react";
import { FolderOpen, FilterX, LayoutGrid, Plus, RefreshCw, Zap } from "lucide-react";
import { ScrollIndicator } from "@/components/Worktree/ScrollIndicator";
import {
  useAgentLauncher,
  useWorktrees,
  useProjectSettings,
  useWorktreeActions,
  useKeybindingDisplay,
} from "@/hooks";
import { createTooltipContent } from "@/lib/tooltipShortcut";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { WorktreeSidebarSearchBar, QuickStateFilterBar } from "@/components/Worktree";
import { BulkCreateWorktreeDialog } from "@/components/GitHub/BulkCreateWorktreeDialog";
import { FleetPickerPalette } from "@/components/Fleet/FleetPickerPalette";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { getWorktreeSortDragId } from "@/components/DragDrop/SortableWorktreeCard";
import { usePanelStore, useWorktreeSelectionStore, useProjectStore } from "@/store";
import { useFleetArmingStore } from "@/store/fleetArmingStore";
import { useShallow } from "zustand/react/shallow";
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
  computeChipCounts,
  type DerivedWorktreeMeta,
  type FilterState,
} from "@/lib/worktreeFilters";
import { computeChipState } from "@/components/Worktree/utils/computeChipState";
import { parseExactNumber } from "@/lib/parseExactNumber";
import type { WorktreeState } from "@/types";
import { actionService } from "@/services/ActionService";
import { SidebarWorktreeRow } from "./SidebarWorktreeRow";
import { StaticWorktreeRow } from "./StaticWorktreeRow";
import { useScrollIndicator } from "./useScrollIndicator";
import { useRecipeDialogState } from "./useRecipeDialogState";
import { RecipeEditor } from "@/components/TerminalRecipe/RecipeEditor";
import { RecipeManager } from "@/components/TerminalRecipe/RecipeManager";
import { isAgentTerminal } from "@/utils/terminalType";
import { logError } from "@/utils/logger";
import { useWorktreeGridRovingFocus } from "./useWorktreeGridRovingFocus";

export function preloadNewWorktreeDialog() {
  return import("@/components/Worktree/NewWorktreeDialog");
}
const LazyNewWorktreeDialog = lazy(() =>
  preloadNewWorktreeDialog().then((m) => ({ default: m.NewWorktreeDialog }))
);

interface SidebarContentProps {
  onOpenOverview: () => void;
}

function SidebarContent({ onOpenOverview }: SidebarContentProps) {
  const overviewShortcut = useKeybindingDisplay("worktree.overview");
  const refreshShortcut = useKeybindingDisplay("worktree.refresh");
  const createWorktreeShortcut = useKeybindingDisplay("worktree.createDialog.open");
  const { gridRef, handleGridKeyDown, handleGridFocusCapture } = useWorktreeGridRovingFocus();
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

  const [isFleetPickerOpen, setIsFleetPickerOpen] = useState(false);
  const openFleetPicker = useCallback(() => setIsFleetPickerOpen(true), []);
  const closeFleetPicker = useCallback(() => setIsFleetPickerOpen(false), []);
  const armedSize = useFleetArmingStore((s) => s.armedIds.size);

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
  const clearQuickStateFilter = useWorktreeFilterStore((state) => state.clearQuickStateFilter);

  // Terminal store for derived metadata
  const panelsById = usePanelStore(useShallow((state) => state.panelsById));
  const panelIds = usePanelStore(useShallow((state) => state.panelIds));

  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const scrollContentRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const {
    isRecipeEditorOpen,
    recipeEditorWorktreeId,
    recipeEditorInitialTerminals,
    recipeEditorDefaultScope,
    recipeManagerEdit,
    isRecipeManagerOpen,
    handleOpenRecipeEditor,
    handleCloseRecipeEditor,
    handleCloseRecipeManager,
    handleRecipeManagerEdit,
    handleRecipeManagerCreate,
  } = useRecipeDialogState();

  const [homeDir, setHomeDir] = useState<string | undefined>(undefined);

  useEffect(() => {
    systemClient
      .getHomeDir()
      .then(setHomeDir)
      .catch((err) => logError("Failed to get home dir", err));
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
      let hasWaitingAgent = false;
      let hasCompletedAgent = false;
      let hasExitedAgent = false;

      for (const id of panelIds) {
        const t = panelsById[id];
        if (!t || t.worktreeId !== worktree.id || t.location === "trash") continue;
        terminalCount++;
        if (!isAgentTerminal(t)) continue;
        if (t.agentState === "working") hasWorkingAgent = true;
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
        hasActiveAgent: hasWorkingAgent,
      });

      map.set(worktree.id, {
        terminalCount,
        hasWorkingAgent,
        hasWaitingAgent,
        hasCompletedAgent,
        hasExitedAgent,
        hasMergeConflict:
          worktree.worktreeChanges?.changes.some((c) => c.status === "conflicted") ?? false,
        chipState,
      });
    }
    return map;
  }, [deferredWorktrees, panelsById, panelIds]);

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

  const chipCounts = useMemo(() => {
    const nonMain = deferredWorktrees.filter(
      (w) => w.id !== mainWorktree?.id && w.id !== integrationWorktree?.id
    );
    return computeChipCounts(nonMain, derivedMetaMap, activeWorktreeId);
  }, [deferredWorktrees, derivedMetaMap, mainWorktree, integrationWorktree, activeWorktreeId]);

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

  const { filteredWorktrees, groupedSections, hasResultsWithoutQuickState } = useMemo(() => {
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
    let withoutQuickStateMatch = false;
    const filtered = nonMain.filter((worktree) => {
      const derived = derivedMetaMap.get(worktree.id) ?? {
        terminalCount: 0,
        hasWorkingAgent: false,
        hasWaitingAgent: false,
        hasCompletedAgent: false,
        hasExitedAgent: false,
        hasMergeConflict: false,
        chipState: null,
      };
      const isActive = worktree.id === activeWorktreeId;
      const hasActiveQuery = query.trim().length > 0;

      // Counterfactual: would this worktree be visible if the quick state
      // filter were "all"? Mirrors the same precedence below (active /
      // waiting bypasses → matchesFilters), with quickStateFilter forced
      // to "all". Short-circuit once we find any match — only the boolean
      // matters for the empty-state branch.
      if (!withoutQuickStateMatch && quickStateFilter !== "all") {
        if (alwaysShowActive && isActive && !hasActiveQuery) {
          withoutQuickStateMatch = true;
        } else if (alwaysShowWaiting && derived.hasWaitingAgent && !hasActiveQuery) {
          withoutQuickStateMatch = true;
        } else if (matchesFilters(worktree, filters, derived, isActive)) {
          withoutQuickStateMatch = true;
        }
      }

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
        hasResultsWithoutQuickState: withoutQuickStateMatch,
      };
    }

    return {
      filteredWorktrees: sorted,
      groupedSections: null,
      hasResultsWithoutQuickState: withoutQuickStateMatch,
    };
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

  const { hiddenAbove, hiddenBelow, scrollToTop, scrollToBottom } = useScrollIndicator({
    scrollContainerRef,
    scrollContentRef,
    itemCount: filteredWorktrees.length,
  });

  const worktreeActions = useWorktreeActions({
    onOpenRecipeEditor: handleOpenRecipeEditor,
  });

  const sortableIds = useMemo(
    () => filteredWorktrees.map((w) => getWorktreeSortDragId(w.id)),
    [filteredWorktrees]
  );

  const dragStartOrder = useMemo(() => filteredWorktrees.map((w) => w.id), [filteredWorktrees]);

  // Hoisted before early returns so the dialog still mounts when the zero-
  // worktrees branch fires — its empty-state nudge dispatches
  // worktree.createDialog.open and the dialog has nowhere else to live.
  const dialogRootPath = currentProject?.path ?? "";
  const newWorktreeDialogElement = dialogRootPath &&
    (createDialog.isOpen || hasOpenedNewWorktree) && (
      <ErrorBoundary
        variant="component"
        componentName="NewWorktreeDialog"
        resetKeys={[Number(createDialog.isOpen)]}
      >
        <Suspense fallback={null}>
          <LazyNewWorktreeDialog
            isOpen={createDialog.isOpen}
            onClose={closeCreateDialog}
            rootPath={dialogRootPath}
            onWorktreeCreated={(worktreeId) => {
              refresh();
              createDialog.onCreated?.(worktreeId);
            }}
            initialIssue={createDialog.initialIssue}
            initialPR={createDialog.initialPR}
            initialRecipeId={createDialog.initialRecipeId}
          />
        </Suspense>
      </ErrorBoundary>
    );

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
      <>
        <div className="flex flex-col h-full">
          <div className="flex items-center px-4 py-4 border-b border-divider shrink-0">
            <h2 className="text-daintree-text font-semibold text-sm tracking-wide">Worktrees</h2>
          </div>

          <div className="flex flex-col items-center justify-center py-12 px-4 text-center flex-1">
            <FolderOpen className="w-8 h-8 text-daintree-text/60 mb-3" aria-hidden="true" />

            <h3 className="text-daintree-text font-medium mb-2">No worktrees yet</h3>

            <p className="text-sm text-daintree-text/60 max-w-xs">
              Open a Git repository to get started. Use{" "}
              <kbd className="px-1.5 py-0.5 bg-tint/[0.06] rounded text-xs">
                File → Open Directory
              </kbd>
            </p>
          </div>
        </div>
        {newWorktreeDialogElement}
      </>
    );
  }

  const hasNonMainWorktrees = deferredWorktrees.length > 1;
  const hasFilters = hasActiveFilters();
  const hasPopoverFilters =
    query.trim().length > 0 ||
    statusFilters.size > 0 ||
    typeFilters.size > 0 ||
    githubFilters.size > 0 ||
    sessionFilters.size > 0 ||
    activityFilters.size > 0;
  const showQuickStateEmptyState =
    filteredWorktrees.length === 0 &&
    quickStateFilter !== "all" &&
    hasResultsWithoutQuickState &&
    hasNonMainWorktrees;
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
          <div className="opacity-0 pointer-events-none transition-opacity duration-150 group-hover/header:opacity-100 group-hover/header:pointer-events-auto group-focus-within/header:opacity-100 group-focus-within/header:pointer-events-auto flex items-center gap-1">
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
                {createTooltipContent("Open worktrees overview", overviewShortcut)}
              </TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={openFleetPicker}
                  className="p-1 text-daintree-text/40 hover:text-daintree-text hover:bg-tint/[0.06] rounded transition-colors"
                  aria-label="Select terminals to arm"
                >
                  <Zap className="w-3.5 h-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                {createTooltipContent("Select terminals to arm")}
              </TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={handleRefreshAll}
                  disabled={isRefreshing}
                  className="p-1 text-daintree-text/40 hover:text-daintree-text hover:bg-tint/[0.06] rounded transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-daintree-text/40"
                  aria-label="Refresh sidebar"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${isRefreshing ? "animate-spin" : ""}`} />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                {createTooltipContent("Refresh sidebar", refreshShortcut)}
              </TooltipContent>
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
                onPointerEnter={() => void preloadNewWorktreeDialog()}
                className="p-1 text-daintree-text/40 hover:text-daintree-text hover:bg-tint/[0.06] rounded transition-colors"
                aria-label="Create new worktree"
              >
                <Plus className="w-3.5 h-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {createTooltipContent("Create new worktree", createWorktreeShortcut)}
            </TooltipContent>
          </Tooltip>
        </div>
      </div>

      {/* Inline search bar — only when there are non-main worktrees */}
      {hasNonMainWorktrees && (
        <WorktreeSidebarSearchBar inputRef={searchInputRef} chipCounts={chipCounts} />
      )}

      {/* Arm all terminals matching the active filter — only when a filter narrows the list */}
      {hasNonMainWorktrees && hasFilters && filteredWorktrees.length > 0 && (
        <div className="shrink-0 px-4 py-1.5 border-b border-divider">
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() =>
                  actionService.dispatch(
                    "fleet.armMatchingFilter",
                    { worktreeIds: filteredWorktrees.map((w) => w.id) },
                    { source: "user" }
                  )
                }
                className="w-full flex items-center justify-center gap-1.5 text-xs px-2 py-1 text-text-secondary hover:text-daintree-text hover:bg-overlay-soft rounded transition-colors"
                aria-label={
                  armedSize > 0
                    ? `Arm ${filteredWorktrees.length} more matching worktrees`
                    : `Arm ${filteredWorktrees.length} matching worktrees`
                }
              >
                <Zap className="w-3 h-3" />
                {armedSize > 0
                  ? `Arm ${filteredWorktrees.length} more matching`
                  : `Arm ${filteredWorktrees.length} matching`}
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {armedSize > 0
                ? `Add eligible terminals in the ${filteredWorktrees.length} worktrees visible below to the existing armed selection`
                : `Arm all eligible terminals in the ${filteredWorktrees.length} worktrees visible below`}
            </TooltipContent>
          </Tooltip>
        </div>
      )}

      {/* Worktree list — single role="grid" with roving tab stop spans pinned + scrollable rows */}
      <div
        ref={gridRef}
        role="grid"
        aria-label="Worktrees"
        onKeyDown={handleGridKeyDown}
        onFocusCapture={handleGridFocusCapture}
        className="flex flex-col flex-1 min-h-0"
      >
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
              {showQuickStateEmptyState ? (
                <div className="flex flex-col items-center justify-center py-12 px-4 text-center">
                  <FilterX className="w-10 h-10 text-daintree-text/40 mb-3" />
                  <p className="text-sm text-daintree-text/80 mb-1">
                    No {quickStateFilter} worktrees
                  </p>
                  <p className="text-xs text-daintree-text/50 mb-3">
                    {hasPopoverFilters
                      ? "Try a different state, or clear your other filters"
                      : "Try a different state to see the rest"}
                  </p>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={clearQuickStateFilter}
                      className="text-xs px-3 py-1.5 text-accent-primary hover:bg-overlay-soft rounded transition-colors font-medium"
                    >
                      Show all states
                    </button>
                    {hasPopoverFilters ? (
                      <button
                        onClick={clearAllFilters}
                        className="text-xs px-3 py-1.5 text-daintree-text/60 hover:text-daintree-text hover:bg-overlay-soft rounded transition-colors"
                      >
                        Clear all filters
                      </button>
                    ) : null}
                  </div>
                </div>
              ) : filteredWorktrees.length === 0 && hasFilters && hasNonMainWorktrees ? (
                <div className="flex flex-col items-center justify-center py-12 px-4 text-center">
                  <FilterX className="w-10 h-10 text-daintree-text/40 mb-3" />
                  <p className="text-sm text-daintree-text/60 mb-3">
                    No worktrees match your filters
                  </p>
                  <button
                    onClick={clearAllFilters}
                    className="text-xs px-3 py-1.5 text-daintree-text/60 hover:text-daintree-text hover:bg-overlay-soft rounded transition-colors"
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
                    {filteredWorktrees.map((worktree, idx) => {
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
                          rowIndex={idx}
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
      </div>

      <ErrorBoundary
        variant="component"
        componentName="RecipeEditor"
        resetKeys={[Number(isRecipeEditorOpen)]}
      >
        <RecipeEditor
          recipe={recipeManagerEdit}
          worktreeId={recipeEditorWorktreeId}
          initialTerminals={recipeEditorInitialTerminals}
          defaultScope={recipeEditorDefaultScope}
          isOpen={isRecipeEditorOpen}
          onClose={handleCloseRecipeEditor}
        />
      </ErrorBoundary>

      <ErrorBoundary
        variant="component"
        componentName="RecipeManager"
        resetKeys={[Number(isRecipeManagerOpen)]}
      >
        <RecipeManager
          isOpen={isRecipeManagerOpen}
          onClose={handleCloseRecipeManager}
          onEditRecipe={handleRecipeManagerEdit}
          onCreateRecipe={handleRecipeManagerCreate}
        />
      </ErrorBoundary>

      {newWorktreeDialogElement}

      <ErrorBoundary
        variant="component"
        componentName="BulkCreateWorktreeDialog"
        resetKeys={[Number(bulkCreateDialog.isOpen)]}
      >
        <BulkCreateWorktreeDialog
          isOpen={bulkCreateDialog.isOpen}
          onClose={closeBulkCreateDialog}
          mode={bulkCreateDialog.mode}
          selectedIssues={bulkCreateDialog.selectedIssues}
          selectedPRs={bulkCreateDialog.selectedPRs}
          onComplete={closeBulkCreateDialog}
        />
      </ErrorBoundary>

      <ErrorBoundary
        variant="component"
        componentName="FleetPickerPalette"
        resetKeys={[Number(isFleetPickerOpen)]}
      >
        <FleetPickerPalette isOpen={isFleetPickerOpen} onClose={closeFleetPicker} />
      </ErrorBoundary>
    </div>
  );
}

export { SidebarContent };
