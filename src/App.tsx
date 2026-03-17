import {
  Profiler,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from "react";
import "@xterm/xterm/css/xterm.css";
import { FolderOpen, FilterX, LayoutGrid, Plus, RefreshCw } from "lucide-react";
import { ScrollIndicator } from "./components/Worktree/ScrollIndicator";
import {
  isElectronAvailable,
  useAgentLauncher,
  useWorktrees,
  useNewTerminalPalette,
  usePanelPalette,
  useProjectSwitcherPalette,
  useTerminalConfig,
  useAppThemeConfig,
  useGlobalKeybindings,
  useContextInjection,
  useProjectSettings,
  useGridNavigation,
  useWindowNotifications,
  useWatchedPanelNotifications,
  useWorktreeActions,
  useMenuActions,
  useErrors,
  useReEntrySummary,
} from "./hooks";
import { useActionRegistry } from "./hooks/useActionRegistry";
import { useUpdateListener } from "./hooks/useUpdateListener";
import { useWorkflowListener } from "./hooks/useWorkflowListener";
import { useActionPalette } from "./hooks/useActionPalette";
import { useQuickSwitcher } from "./hooks/useQuickSwitcher";
import { useWorktreePalette } from "./hooks/useWorktreePalette";
import { useQuickCreatePalette } from "./hooks/useQuickCreatePalette";
import { useDoubleShift } from "./hooks/useDoubleShift";
import { useMcpBridge } from "./hooks/useMcpBridge";
import { useFileDropGuard } from "./hooks/useFileDropGuard";
import { createTooltipWithShortcut } from "./lib/platform";
import { useCrashRecoveryGate } from "./hooks/app/useCrashRecoveryGate";
import { CrashRecoveryDialog } from "./components/Recovery/CrashRecoveryDialog";
import {
  useAppHydration,
  useProjectSwitchRehydration,
  useFirstRunToasts,
  useTerminalStoreBootstrap,
  useSemanticWorkerLifecycle,
  useSystemWakeHandler,
  useDevServerDiscovery,
  useAccessibilityAnnouncements,
  useGettingStartedChecklist,
  useUnloadCleanup,
  useHomeDir,
  usePerformanceMonitors,
  useSettingsDialog,
  useWorktreeOverview,
  useAppEventListeners,
  useErrorRetry,
  useActiveWorktreeSync,
} from "./hooks/app";
import { AppLayout } from "./components/Layout";
import { ContentGrid } from "./components/Terminal";
import { PanelTransitionOverlay } from "./components/Panel";
import {
  WorktreeCard,
  WorktreePalette,
  WorktreeSidebarSearchBar,
  WorktreeOverviewModal,
  QuickCreatePalette,
} from "./components/Worktree";
import { CrossWorktreeDiff } from "./components/Worktree/CrossWorktreeDiff";
import { NewWorktreeDialog } from "./components/Worktree/NewWorktreeDialog";
import { TerminalInfoDialogHost } from "./components/Terminal/TerminalInfoDialogHost";
import { FileViewerModalHost } from "./components/FileViewer/FileViewerModalHost";
import { NewTerminalPalette } from "./components/TerminalPalette";
import { PanelPalette } from "./components/PanelPalette/PanelPalette";
import { MORE_AGENTS_PANEL_ID, DEFAULT_MODEL_OPTION_ID } from "./hooks/usePanelPalette";
import { GitInitDialog, ProjectOnboardingWizard, WelcomeScreen } from "./components/Project";
import { VoiceRecordingAnnouncer } from "./components/Terminal/VoiceRecordingAnnouncer";
import { AccessibilityAnnouncer } from "./components/Accessibility/AccessibilityAnnouncer";
import { CreateProjectFolderDialog } from "./components/Project/CreateProjectFolderDialog";
import { ProjectSwitcherPalette } from "./components/Project/ProjectSwitcherPalette";
import { ActionPalette } from "./components/ActionPalette";
import { QuickSwitcher } from "./components/QuickSwitcher";
import { ConfirmDialog } from "./components/ui/ConfirmDialog";
import { RecipeEditor } from "./components/TerminalRecipe/RecipeEditor";
import { NotesPalette } from "./components/Notes";
import { WorkflowSection } from "./components/Workflow";
import { SettingsDialog } from "./components/Settings";
import { ShortcutReferenceDialog } from "./components/KeyboardShortcuts";
import { Toaster } from "./components/ui/toaster";
import { ReEntrySummary } from "./components/ui/ReEntrySummary";
import { UpdateNotification } from "./components/UpdateNotification";
import { OnboardingFlow } from "./components/Onboarding/OnboardingFlow";
import { GettingStartedChecklist } from "./components/Onboarding/GettingStartedChecklist";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { DndProvider } from "./components/DragDrop";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import {
  SortableWorktreeCard,
  getWorktreeSortDragId,
} from "./components/DragDrop/SortableWorktreeCard";
import {
  useTerminalStore,
  useWorktreeSelectionStore,
  useProjectStore,
  useErrorStore,
  useAgentPreferencesStore,
  usePaletteStore,
} from "./store";
import { useShallow } from "zustand/react/shallow";
import { useMacroFocusStore } from "./store/macroFocusStore";
import type { RecipeTerminal } from "./types";
import { systemClient } from "@/clients";
import { registerBuiltInPanelComponents } from "./registry";

// Register built-in panel components before any renders
registerBuiltInPanelComponents();
import { useWorktreeFilterStore } from "./store/worktreeFilterStore";
import {
  matchesFilters,
  sortWorktrees,
  sortWorktreesByRelevance,
  groupByType,
  findIntegrationWorktree,
  filterTriageWorktrees,
  scoreWorktree,
  type DerivedWorktreeMeta,
  type FilterState,
} from "./lib/worktreeFilters";
import { parseExactNumber } from "./lib/parseExactNumber";
import type { WorktreeState, PanelKind } from "./types";
import { actionService } from "./services/ActionService";
import { voiceRecordingService } from "./services/VoiceRecordingService";
import { useRenderProfiler } from "./utils/renderProfiler";

interface SidebarContentProps {
  onOpenOverview: () => void;
}

function SidebarContent({ onOpenOverview }: SidebarContentProps) {
  const { worktrees, isLoading, error, refresh } = useWorktrees();
  const [isRefreshing, startRefreshTransition] = useTransition();
  const currentProject = useProjectStore((state) => state.currentProject);
  useProjectSettings();
  const { launchAgent, availability, agentSettings } = useAgentLauncher();
  const { activeWorktreeId, focusedWorktreeId, selectWorktree, createDialog, closeCreateDialog } =
    useWorktreeSelectionStore(
      useShallow((state) => ({
        activeWorktreeId: state.activeWorktreeId,
        focusedWorktreeId: state.focusedWorktreeId,
        selectWorktree: state.selectWorktree,
        createDialog: state.createDialog,
        closeCreateDialog: state.closeCreateDialog,
      }))
    );

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
    }))
  );
  const clearAllFilters = useWorktreeFilterStore((state) => state.clearAll);
  const hasActiveFilters = useWorktreeFilterStore((state) => state.hasActiveFilters);
  const unpinWorktree = useWorktreeFilterStore((state) => state.unpinWorktree);
  const collapsedWorktrees = useWorktreeFilterStore((state) => state.collapsedWorktrees);
  const expandWorktree = useWorktreeFilterStore((state) => state.expandWorktree);

  // Terminal store for derived metadata
  const terminals = useTerminalStore(useShallow((state) => state.terminals));

  // Error store for derived metadata
  const getWorktreeErrors = useErrorStore((state) => state.getWorktreeErrors);

  const scrollContainerRef = useRef<HTMLDivElement>(null);
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
    for (const worktree of worktrees) {
      const worktreeTerminals = terminals.filter(
        (t) => t.worktreeId === worktree.id && t.location !== "trash"
      );
      const errors = getWorktreeErrors(worktree.id);
      map.set(worktree.id, {
        hasErrors: errors.length > 0,
        terminalCount: worktreeTerminals.length,
        hasWorkingAgent: worktreeTerminals.some((t) => t.agentState === "working"),
        hasRunningAgent: worktreeTerminals.some((t) => t.agentState === "running"),
        hasWaitingAgent: worktreeTerminals.some((t) => t.agentState === "waiting"),
        hasFailedAgent: worktreeTerminals.some((t) => t.agentState === "failed"),
        hasCompletedAgent: worktreeTerminals.some((t) => t.agentState === "completed"),
        hasMergeConflict:
          worktree.worktreeChanges?.changes.some((c) => c.status === "conflicted") ?? false,
      });
    }
    return map;
  }, [worktrees, terminals, getWorktreeErrors]);

  // Apply filters and sorting
  const mainWorktree = useMemo(
    () => worktrees.find((w) => w.isMainWorktree) ?? worktrees[0] ?? null,
    [worktrees]
  );

  const integrationWorktree = useMemo(
    () => findIntegrationWorktree(worktrees, mainWorktree?.id),
    [worktrees, mainWorktree]
  );

  const triageWorktrees = useMemo(
    () =>
      filterTriageWorktrees(
        worktrees,
        derivedMetaMap,
        mainWorktree?.id,
        integrationWorktree?.id,
        query
      ),
    [worktrees, derivedMetaMap, mainWorktree, integrationWorktree, query]
  );

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
    const nonMain = worktrees.filter(
      (w) => w.id !== mainWorktree?.id && w.id !== integrationWorktree?.id
    );
    const filtered = nonMain.filter((worktree) => {
      const derived = derivedMetaMap.get(worktree.id) ?? {
        hasErrors: false,
        terminalCount: 0,
        hasWorkingAgent: false,
        hasRunningAgent: false,
        hasWaitingAgent: false,
        hasFailedAgent: false,
        hasCompletedAgent: false,
        hasMergeConflict: false,
      };
      const isActive = worktree.id === activeWorktreeId;
      const hasActiveQuery = query.trim().length > 0;

      if (alwaysShowActive && isActive && !hasActiveQuery) {
        return true;
      }

      if (alwaysShowWaiting && derived.hasWaitingAgent && !hasActiveQuery) {
        return true;
      }

      return matchesFilters(worktree, filters, derived, isActive);
    });

    const existingWorktreeIds = new Set(worktrees.map((w) => w.id));
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
    worktrees,
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
      if (!detail || typeof (detail as { worktreeId?: unknown }).worktreeId !== "string") return;
      const worktreeId = (detail as { worktreeId: string }).worktreeId;
      const initialTerminalsRaw = (detail as { initialTerminals?: unknown }).initialTerminals;
      const initialTerminals = Array.isArray(initialTerminalsRaw)
        ? (initialTerminalsRaw as RecipeTerminal[])
        : undefined;
      handleOpenRecipeEditor(worktreeId, initialTerminals);
    };

    const controller = new AbortController();
    window.addEventListener("canopy:open-recipe-editor", handleOpenRecipeEditorEvent, {
      signal: controller.signal,
    });
    return () => controller.abort();
  }, [handleOpenRecipeEditor]);

  const worktreeActions = useWorktreeActions({
    onOpenRecipeEditor: handleOpenRecipeEditor,
    launchAgent,
  });

  const handleCloseRecipeEditor = useCallback(() => {
    setIsRecipeEditorOpen(false);
    setRecipeEditorWorktreeId(undefined);
    setRecipeEditorInitialTerminals(undefined);
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
          <h2 className="text-canopy-text font-semibold text-sm tracking-wide">Worktrees</h2>
        </div>
        <div className="px-4 py-4 text-canopy-text/60 text-sm">Loading worktrees...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col h-full">
        <div className="flex items-center px-4 py-4 border-b border-divider shrink-0">
          <h2 className="text-canopy-text font-semibold text-sm tracking-wide">Worktrees</h2>
        </div>
        <div className="px-4 py-4">
          <div className="text-[var(--color-status-error)] text-sm mb-2">{error}</div>
          <button
            onClick={refresh}
            className="text-xs px-2 py-1 border border-divider rounded hover:bg-tint/[0.06] text-canopy-text"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  if (worktrees.length === 0) {
    return (
      <div className="flex flex-col h-full">
        <div className="flex items-center px-4 py-4 border-b border-divider shrink-0">
          <h2 className="text-canopy-text font-semibold text-sm tracking-wide">Worktrees</h2>
        </div>

        <div className="flex flex-col items-center justify-center py-12 px-4 text-center flex-1">
          <FolderOpen className="w-12 h-12 text-canopy-text/60 mb-3" aria-hidden="true" />

          <h3 className="text-canopy-text font-medium mb-2">No worktrees yet</h3>

          <p className="text-sm text-canopy-text/60 mb-4 max-w-xs">
            Open a Git repository with worktrees to get started. Use{" "}
            <kbd className="px-1.5 py-0.5 bg-tint/[0.06] rounded text-xs">
              File → Open Directory
            </kbd>
          </p>

          <div className="text-xs text-canopy-text/60 text-left w-full max-w-xs">
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
  const hasNonMainWorktrees = worktrees.length > 1;
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
    : worktrees.length;

  const hasQuery = query.trim().length > 0;
  const isSortDisabled = isGroupedByType || hasQuery;

  const renderWorktreeCard = (worktree: WorktreeState) => (
    <WorktreeCard
      key={worktree.id}
      worktree={worktree}
      isActive={worktree.id === activeWorktreeId}
      isFocused={worktree.id === focusedWorktreeId}
      isSingleWorktree={worktrees.length === 1}
      onSelect={() => selectWorktree(worktree.id)}
      onCopyTree={() => worktreeActions.handleCopyTree(worktree)}
      onOpenEditor={() => worktreeActions.handleOpenEditor(worktree)}
      onSaveLayout={() => worktreeActions.handleSaveLayout(worktree)}
      onLaunchAgent={(type) => worktreeActions.handleLaunchAgent(worktree.id, type)}
      agentAvailability={availability}
      agentSettings={agentSettings}
      homeDir={homeDir}
    />
  );

  return (
    <div className="flex flex-col h-full">
      {/* Header Section */}
      <div className="group/header flex items-center justify-between px-4 py-2 border-b border-divider bg-transparent shrink-0">
        <div className="flex items-baseline gap-1.5">
          <h2 className="text-canopy-text font-semibold text-sm tracking-wide">Worktrees</h2>
          <span className="text-canopy-text/50 text-xs">
            {hasFilters && visibleCount !== worktrees.length
              ? `(${visibleCount} of ${worktrees.length})`
              : `(${worktrees.length})`}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <div className="invisible group-hover/header:visible group-focus-within/header:visible flex items-center gap-1">
            <button
              onClick={onOpenOverview}
              className="p-1 text-canopy-text/40 hover:text-canopy-text hover:bg-tint/[0.06] rounded transition-colors"
              title={createTooltipWithShortcut("Open worktrees overview", "Cmd+Shift+O")}
              aria-label="Open worktrees overview"
            >
              <LayoutGrid className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={handleRefreshAll}
              disabled={isRefreshing}
              className="p-1 text-canopy-text/40 hover:text-canopy-text hover:bg-tint/[0.06] rounded transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              title="Refresh sidebar"
              aria-label="Refresh sidebar"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isRefreshing ? "animate-spin" : ""}`} />
            </button>
          </div>
          <button
            onClick={() =>
              actionService.dispatch("worktree.createDialog.open", undefined, {
                source: "user",
              })
            }
            className="p-1 text-canopy-text/40 hover:text-canopy-text hover:bg-tint/[0.06] rounded transition-colors"
            title="Create new worktree"
            aria-label="Create new worktree"
          >
            <Plus className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Inline search bar — only when there are non-main worktrees */}
      {hasNonMainWorktrees && <WorktreeSidebarSearchBar inputRef={searchInputRef} />}

      {/* Main worktree — visible unless excluded by text search */}
      {mainMatchesQuery && <div className="shrink-0">{renderWorktreeCard(mainWorktree)}</div>}

      {/* Integration branch (develop/trunk/next) — pinned below main, subject to text search */}
      {integrationMatchesQuery && (
        <div className="shrink-0">{renderWorktreeCard(integrationWorktree)}</div>
      )}

      {/* Strong divider between pinned worktrees and scrollable list */}
      {hasNonMainWorktrees && <div className="shrink-0 border-b-2 border-divider/60" />}

      {/* Non-main worktree list */}
      <div className="relative flex-1 min-h-0">
        <div ref={scrollContainerRef} className="h-full overflow-y-auto">
          <div ref={scrollContentRef}>
            {triageWorktrees.length > 0 && (
              <div>
                <div className="px-4 py-2 text-[10px] font-medium text-canopy-text/50 uppercase tracking-wide">
                  Needs Attention
                </div>
                <div className="flex flex-col">{triageWorktrees.map(renderWorktreeCard)}</div>
                <div className="border-b border-divider/60" />
              </div>
            )}
            {filteredWorktrees.length === 0 &&
            triageWorktrees.length === 0 &&
            hasActiveFilters() ? (
              <div className="flex flex-col items-center justify-center py-12 px-4 text-center">
                <FilterX className="w-10 h-10 text-canopy-text/40 mb-3" />
                <p className="text-sm text-canopy-text/60 mb-3">No worktrees match your filters</p>
                <button
                  onClick={clearAllFilters}
                  className="text-xs px-3 py-1.5 text-canopy-accent hover:bg-canopy-accent/10 rounded transition-colors"
                >
                  Clear filters
                </button>
              </div>
            ) : groupedSections ? (
              <div className="flex flex-col">
                {groupedSections.map((section) => (
                  <div key={section.type}>
                    <div className="sticky top-0 z-10 px-4 py-2 text-[10px] font-medium text-canopy-text/50 uppercase tracking-wide bg-canopy-sidebar border-b border-divider">
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
                    const showDragHandle = !isSortDisabled && !isPinned;
                    return (
                      <SortableWorktreeCard
                        key={worktree.id}
                        worktreeId={worktree.id}
                        dragStartOrder={dragStartOrder}
                        disabled={isSortDisabled || isPinned}
                      >
                        {({
                          sortableRef,
                          isDraggingSort,
                          dragHandleListeners,
                          dragHandleActivatorRef,
                        }) => (
                          <WorktreeCard
                            worktree={worktree}
                            isActive={worktree.id === activeWorktreeId}
                            isFocused={worktree.id === focusedWorktreeId}
                            isSingleWorktree={worktrees.length === 1}
                            onSelect={() => selectWorktree(worktree.id)}
                            onCopyTree={() => worktreeActions.handleCopyTree(worktree)}
                            onOpenEditor={() => worktreeActions.handleOpenEditor(worktree)}
                            onSaveLayout={() => worktreeActions.handleSaveLayout(worktree)}
                            onLaunchAgent={(type) =>
                              worktreeActions.handleLaunchAgent(worktree.id, type)
                            }
                            agentAvailability={availability}
                            agentSettings={agentSettings}
                            homeDir={homeDir}
                            sortableRef={sortableRef}
                            dragHandleListeners={showDragHandle ? dragHandleListeners : undefined}
                            dragHandleActivatorRef={
                              showDragHandle ? dragHandleActivatorRef : undefined
                            }
                            isDraggingSort={isDraggingSort}
                          />
                        )}
                      </SortableWorktreeCard>
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

      <WorkflowSection />

      <RecipeEditor
        worktreeId={recipeEditorWorktreeId}
        initialTerminals={recipeEditorInitialTerminals}
        isOpen={isRecipeEditorOpen}
        onClose={handleCloseRecipeEditor}
      />

      {rootPath && (
        <NewWorktreeDialog
          isOpen={createDialog.isOpen}
          onClose={closeCreateDialog}
          rootPath={rootPath}
          onWorktreeCreated={refresh}
          initialIssue={createDialog.initialIssue}
          initialPR={createDialog.initialPR}
          initialRecipeId={createDialog.initialRecipeId}
        />
      )}
    </div>
  );
}

function App() {
  useErrors();
  useUnloadCleanup();

  const { crossDiffDialog, closeCrossWorktreeDiff } = useWorktreeSelectionStore(
    useShallow((state) => ({
      crossDiffDialog: state.crossDiffDialog,
      closeCrossWorktreeDiff: state.closeCrossWorktreeDiff,
    }))
  );

  const { focusedId, addTerminal } = useTerminalStore(
    useShallow((state) => ({
      focusedId: state.focusedId,
      addTerminal: state.addTerminal,
    }))
  );

  const { launchAgent, availability, agentSettings, refreshSettings } = useAgentLauncher();

  useTerminalConfig();
  useAppThemeConfig();
  useWindowNotifications();
  useWatchedPanelNotifications();
  const reEntrySummary = useReEntrySummary();
  useUpdateListener();
  useWorkflowListener();
  useMcpBridge();
  const { homeDir } = useHomeDir();

  // Grid navigation hook for directional terminal switching
  const { findNearest, findByIndex, findDockByIndex, getCurrentLocation } = useGridNavigation();

  const { worktrees, worktreeMap } = useWorktrees();
  const newTerminalPalette = useNewTerminalPalette({ launchAgent, worktreeMap });
  const panelPalette = usePanelPalette();
  const projectSwitcherPalette = useProjectSwitcherPalette();
  const actionPalette = useActionPalette();
  const quickSwitcher = useQuickSwitcher();
  useDoubleShift(actionPalette.toggle);
  const currentProject = useProjectStore((state) => state.currentProject);
  const gitInitDialogOpen = useProjectStore((state) => state.gitInitDialogOpen);
  const gitInitDirectoryPath = useProjectStore((state) => state.gitInitDirectoryPath);
  const closeGitInitDialog = useProjectStore((state) => state.closeGitInitDialog);
  const handleGitInitSuccess = useProjectStore((state) => state.handleGitInitSuccess);
  const onboardingWizardOpen = useProjectStore((state) => state.onboardingWizardOpen);
  const onboardingProjectId = useProjectStore((state) => state.onboardingProjectId);
  const closeOnboardingWizard = useProjectStore((state) => state.closeOnboardingWizard);

  const createFolderDialogOpen = useProjectStore((state) => state.createFolderDialogOpen);
  const closeCreateFolderDialog = useProjectStore((state) => state.closeCreateFolderDialog);
  const openCreateFolderDialog = useProjectStore((state) => state.openCreateFolderDialog);
  const { selectWorktree, activeWorktreeId, focusedWorktreeId } = useWorktreeSelectionStore(
    useShallow((state) => ({
      selectWorktree: state.selectWorktree,
      activeWorktreeId: state.activeWorktreeId,
      focusedWorktreeId: state.focusedWorktreeId,
    }))
  );

  const { activeWorktree, defaultTerminalCwd } = useActiveWorktreeSync();

  const worktreePalette = useWorktreePalette({ worktrees });
  const quickCreatePalette = useQuickCreatePalette();

  const {
    isSettingsOpen,
    settingsTab,
    settingsSubtab,
    settingsSectionId,
    handleSettings,
    handleOpenSettingsTab,
    setIsSettingsOpen,
  } = useSettingsDialog();
  const [isShortcutsOpen, setIsShortcutsOpen] = useState(false);
  const isNotesPaletteOpen = usePaletteStore((state) => state.activePaletteId === "notes");
  const {
    isWorktreeOverviewOpen,
    toggleWorktreeOverview,
    openWorktreeOverview,
    closeWorktreeOverview,
  } = useWorktreeOverview();
  const onLayoutRender = useRenderProfiler("app-layout", { sampleRate: 0.15 });
  const onContentGridRender = useRenderProfiler("content-grid", { sampleRate: 0.15 });

  usePerformanceMonitors();

  // Crash recovery gate — must resolve before hydration runs
  const {
    state: crashState,
    resolve: resolveCrash,
    updateConfig: updateCrashConfig,
  } = useCrashRecoveryGate();

  const crashResolved = crashState.status !== "loading" && crashState.status !== "pending";

  // App lifecycle hooks
  const { isStateLoaded } = useAppHydration(crashResolved);
  useProjectSwitchRehydration();
  useFirstRunToasts(isStateLoaded);
  const gettingStarted = useGettingStartedChecklist(isStateLoaded);

  const handleLaunchAgent = useCallback(
    async (type: string) => {
      await launchAgent(type);
    },
    [launchAgent]
  );

  const handleWizardFinish = useCallback(() => {
    const defaultAgent = useAgentPreferencesStore.getState().defaultAgent;
    const selected = agentSettings?.agents
      ? Object.entries(agentSettings.agents)
          .filter(([, entry]) => entry.selected === true)
          .map(([id]) => id)
      : [];
    const primaryAgent = defaultAgent ?? selected[0];

    if (primaryAgent && availability[primaryAgent]) {
      launchAgent(primaryAgent, {
        worktreeId: activeWorktreeId ?? undefined,
      }).catch(() => {});
    }
  }, [launchAgent, activeWorktreeId, availability, agentSettings]);

  const closeNotesPalette = useCallback(() => {
    usePaletteStore.getState().closePalette("notes");
  }, []);

  const overviewWorktreeActions = useWorktreeActions({ launchAgent });

  useAppEventListeners();

  const { handleErrorRetry, handleCancelRetry } = useErrorRetry();

  const electronAvailable = isElectronAvailable();
  const { inject } = useContextInjection();

  const handleToggleSidebar = useCallback(() => {
    window.dispatchEvent(new CustomEvent("canopy:toggle-focus-mode"));
  }, []);

  useActionRegistry({
    onOpenSettings: handleSettings,
    onOpenSettingsTab: handleOpenSettingsTab,
    onToggleSidebar: handleToggleSidebar,
    onToggleFocusMode: handleToggleSidebar,
    onFocusRegionNext: () => useMacroFocusStore.getState().cycleNext(),
    onFocusRegionPrev: () => useMacroFocusStore.getState().cyclePrev(),
    onOpenActionPalette: actionPalette.open,
    onOpenQuickSwitcher: quickSwitcher.open,
    onOpenWorktreePalette: worktreePalette.open,
    onOpenQuickCreatePalette: quickCreatePalette.open,
    onToggleWorktreeOverview: toggleWorktreeOverview,
    onOpenWorktreeOverview: openWorktreeOverview,
    onCloseWorktreeOverview: closeWorktreeOverview,
    onOpenPanelPalette: panelPalette.open,
    onOpenProjectSwitcherPalette: projectSwitcherPalette.open,
    onOpenShortcuts: () => setIsShortcutsOpen(true),
    onLaunchAgent: async (agentId, options) => {
      return launchAgent(agentId, options);
    },
    onInject: inject,
    getDefaultCwd: () => defaultTerminalCwd,
    getActiveWorktreeId: () => activeWorktree?.id,
    getWorktrees: () => worktrees,
    getFocusedId: () => focusedId,
    getGridNavigation: () => ({ findNearest, findByIndex, findDockByIndex, getCurrentLocation }),
  });

  useMenuActions({
    onOpenSettings: handleSettings,
    onOpenSettingsTab: handleOpenSettingsTab,
    onToggleSidebar: handleToggleSidebar,
    onLaunchAgent: handleLaunchAgent,
    defaultCwd: defaultTerminalCwd,
    activeWorktreeId: activeWorktree?.id,
  });

  // Global keybinding handler - provides chord support and priority resolution
  // All keybindings dispatch through ActionService via this centralized handler
  useGlobalKeybindings(electronAvailable);

  // App lifecycle hooks
  useTerminalStoreBootstrap();
  useSemanticWorkerLifecycle();
  useSystemWakeHandler();
  useDevServerDiscovery();
  useAccessibilityAnnouncements();

  useEffect(() => {
    voiceRecordingService.initialize();
  }, []);

  useFileDropGuard();

  if (!isElectronAvailable()) {
    return (
      <div className="h-screen w-screen flex items-center justify-center bg-canopy-bg">
        <div className="text-canopy-text/60 text-sm">
          Electron API not available - please run in Electron
        </div>
      </div>
    );
  }

  if (crashState.status === "pending") {
    return (
      <div className="h-screen w-screen bg-canopy-bg">
        <CrashRecoveryDialog
          crash={crashState.crash}
          config={crashState.config}
          onResolve={resolveCrash}
          onUpdateConfig={updateCrashConfig}
        />
      </div>
    );
  }

  if (!crashResolved || !isStateLoaded) {
    return <div className="h-screen w-screen bg-canopy-bg" />;
  }

  return (
    <ErrorBoundary variant="fullscreen" componentName="App">
      <DndProvider>
        <VoiceRecordingAnnouncer />
        <AccessibilityAnnouncer />
        <Profiler id="app-layout" onRender={onLayoutRender}>
          <AppLayout
            sidebarContent={
              <SidebarContent
                key={currentProject?.id ?? "no-project"}
                onOpenOverview={openWorktreeOverview}
              />
            }
            onLaunchAgent={handleLaunchAgent}
            onSettings={handleSettings}
            onRetry={handleErrorRetry}
            onCancelRetry={handleCancelRetry}
            agentAvailability={availability}
            agentSettings={agentSettings}
            isHydrated={isStateLoaded}
            projectSwitcherPalette={projectSwitcherPalette}
          >
            <Profiler id="content-grid" onRender={onContentGridRender}>
              {currentProject === null ? (
                <WelcomeScreen />
              ) : (
                <ContentGrid
                  key={currentProject.id}
                  className="h-full w-full"
                  agentAvailability={availability}
                  defaultCwd={defaultTerminalCwd}
                />
              )}
            </Profiler>
          </AppLayout>
        </Profiler>
      </DndProvider>

      <QuickSwitcher
        isOpen={quickSwitcher.isOpen}
        query={quickSwitcher.query}
        results={quickSwitcher.results}
        totalResults={quickSwitcher.totalResults}
        selectedIndex={quickSwitcher.selectedIndex}
        close={quickSwitcher.close}
        setQuery={quickSwitcher.setQuery}
        selectPrevious={quickSwitcher.selectPrevious}
        selectNext={quickSwitcher.selectNext}
        selectItem={quickSwitcher.selectItem}
        confirmSelection={quickSwitcher.confirmSelection}
      />
      <NewTerminalPalette
        isOpen={newTerminalPalette.isOpen}
        query={newTerminalPalette.query}
        results={newTerminalPalette.results}
        totalResults={newTerminalPalette.totalResults}
        selectedIndex={newTerminalPalette.selectedIndex}
        onQueryChange={newTerminalPalette.setQuery}
        onSelectPrevious={newTerminalPalette.selectPrevious}
        onSelectNext={newTerminalPalette.selectNext}
        onSelect={newTerminalPalette.handleSelect}
        onConfirm={newTerminalPalette.confirmSelection}
        onClose={newTerminalPalette.close}
      />
      <WorktreePalette
        isOpen={worktreePalette.isOpen}
        query={worktreePalette.query}
        results={worktreePalette.results}
        totalResults={worktreePalette.totalResults}
        activeWorktreeId={worktreePalette.activeWorktreeId}
        selectedIndex={worktreePalette.selectedIndex}
        onQueryChange={worktreePalette.setQuery}
        onSelectPrevious={worktreePalette.selectPrevious}
        onSelectNext={worktreePalette.selectNext}
        onSelect={worktreePalette.selectWorktree}
        onConfirm={worktreePalette.confirmSelection}
        onClose={worktreePalette.close}
      />
      <QuickCreatePalette palette={quickCreatePalette} />
      <PanelPalette
        isOpen={panelPalette.isOpen}
        phase={panelPalette.phase}
        query={panelPalette.query}
        results={panelPalette.results}
        totalResults={panelPalette.totalResults}
        selectedIndex={panelPalette.selectedIndex}
        onQueryChange={panelPalette.setQuery}
        onSelectPrevious={panelPalette.selectPrevious}
        onSelectNext={panelPalette.selectNext}
        onSelect={(kind) => {
          const result = panelPalette.handleSelect(kind);
          if (!result) return;
          if (result.category === "model") {
            const agentId = panelPalette.pendingAgentId;
            if (agentId) {
              const modelId = result.id === DEFAULT_MODEL_OPTION_ID ? undefined : result.id;
              launchAgent(agentId, { modelId });
            }
            return;
          }
          if (result.id.startsWith("agent:")) {
            const agentId = result.id.slice("agent:".length);
            if (agentId) {
              launchAgent(agentId);
            }
          } else {
            addTerminal({
              kind: result.id as PanelKind,
              cwd: defaultTerminalCwd,
              worktreeId: activeWorktreeId ?? undefined,
              location: "grid",
            });
          }
        }}
        onConfirm={() => {
          const currentPhase = panelPalette.phase;
          const pendingAgent = panelPalette.pendingAgentId;
          const selected = panelPalette.confirmSelection();
          if (!selected) return;
          if (currentPhase === "model" && selected.category === "model" && pendingAgent) {
            const modelId = selected.id === DEFAULT_MODEL_OPTION_ID ? undefined : selected.id;
            launchAgent(pendingAgent, { modelId });
            return;
          }
          if (selected.id === MORE_AGENTS_PANEL_ID) return;
          if (selected.id.startsWith("agent:")) {
            const agentId = selected.id.slice("agent:".length);
            if (agentId) {
              launchAgent(agentId);
            }
          } else {
            addTerminal({
              kind: selected.id as PanelKind,
              cwd: defaultTerminalCwd,
              worktreeId: activeWorktreeId ?? undefined,
              location: "grid",
            });
          }
        }}
        onClose={panelPalette.close}
        onBack={panelPalette.backToPanel}
      />
      <ProjectSwitcherPalette
        isOpen={projectSwitcherPalette.isOpen && projectSwitcherPalette.mode === "modal"}
        query={projectSwitcherPalette.query}
        results={projectSwitcherPalette.results}
        selectedIndex={projectSwitcherPalette.selectedIndex}
        onQueryChange={projectSwitcherPalette.setQuery}
        onSelectPrevious={projectSwitcherPalette.selectPrevious}
        onSelectNext={projectSwitcherPalette.selectNext}
        onSelect={projectSwitcherPalette.selectProject}
        onClose={projectSwitcherPalette.close}
        onAddProject={projectSwitcherPalette.addProject}
        onCreateFolder={() => {
          projectSwitcherPalette.close();
          openCreateFolderDialog();
        }}
        onStopProject={(projectId) => projectSwitcherPalette.stopProject(projectId)}
        onCloseProject={(projectId) => projectSwitcherPalette.removeProject(projectId)}
        onTogglePinProject={(projectId) => projectSwitcherPalette.togglePinProject(projectId)}
        onOpenProjectSettings={() => {
          projectSwitcherPalette.close();
          void actionService.dispatch("project.settings.open", undefined, { source: "user" });
        }}
        removeConfirmProject={projectSwitcherPalette.removeConfirmProject}
        onRemoveConfirmClose={() => projectSwitcherPalette.setRemoveConfirmProject(null)}
        onConfirmRemove={projectSwitcherPalette.confirmRemoveProject}
        isRemovingProject={projectSwitcherPalette.isRemovingProject}
        groups={projectSwitcherPalette.groups}
        onCreateGroup={projectSwitcherPalette.createGroup}
        onAssignProjectToGroup={projectSwitcherPalette.assignProjectToGroup}
        onRemoveProjectFromGroup={projectSwitcherPalette.removeProjectFromGroup}
        onRenameGroup={projectSwitcherPalette.renameGroup}
        onDeleteGroup={projectSwitcherPalette.deleteGroup}
        onMoveGroupUp={projectSwitcherPalette.moveGroupUp}
        onMoveGroupDown={projectSwitcherPalette.moveGroupDown}
      />
      <ConfirmDialog
        isOpen={projectSwitcherPalette.stopConfirmProjectId != null}
        onClose={() => {
          if (projectSwitcherPalette.isStoppingProject) return;
          projectSwitcherPalette.setStopConfirmProjectId(null);
        }}
        title={`Stop project?`}
        description="This will terminate all running sessions in this project. This can't be undone."
        confirmLabel="Stop project"
        cancelLabel="Cancel"
        onConfirm={projectSwitcherPalette.confirmStopProject}
        isConfirmLoading={projectSwitcherPalette.isStoppingProject}
        variant="destructive"
      />

      <NotesPalette isOpen={isNotesPaletteOpen} onClose={closeNotesPalette} />

      <ActionPalette
        isOpen={actionPalette.isOpen}
        query={actionPalette.query}
        results={actionPalette.results}
        totalResults={actionPalette.totalResults}
        selectedIndex={actionPalette.selectedIndex}
        close={actionPalette.close}
        setQuery={actionPalette.setQuery}
        selectPrevious={actionPalette.selectPrevious}
        selectNext={actionPalette.selectNext}
        executeAction={actionPalette.executeAction}
        confirmSelection={actionPalette.confirmSelection}
      />

      <WorktreeOverviewModal
        isOpen={isWorktreeOverviewOpen}
        onClose={closeWorktreeOverview}
        worktrees={worktrees}
        activeWorktreeId={activeWorktreeId}
        focusedWorktreeId={focusedWorktreeId}
        onSelectWorktree={selectWorktree}
        onCopyTree={overviewWorktreeActions.handleCopyTree}
        onOpenEditor={overviewWorktreeActions.handleOpenEditor}
        onSaveLayout={undefined}
        onLaunchAgent={overviewWorktreeActions.handleLaunchAgent}
        agentAvailability={availability}
        agentSettings={agentSettings}
        homeDir={homeDir}
      />

      <CrossWorktreeDiff
        isOpen={crossDiffDialog.isOpen}
        onClose={closeCrossWorktreeDiff}
        initialWorktreeId={crossDiffDialog.initialWorktreeId}
      />

      <SettingsDialog
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        defaultTab={settingsTab}
        defaultSubtab={settingsSubtab}
        defaultSectionId={settingsSectionId}
        onSettingsChange={refreshSettings}
      />

      <ShortcutReferenceDialog isOpen={isShortcutsOpen} onClose={() => setIsShortcutsOpen(false)} />

      <TerminalInfoDialogHost />
      <FileViewerModalHost />

      {gitInitDirectoryPath && (
        <GitInitDialog
          isOpen={gitInitDialogOpen}
          directoryPath={gitInitDirectoryPath}
          onSuccess={handleGitInitSuccess}
          onCancel={closeGitInitDialog}
        />
      )}

      {onboardingProjectId && (
        <ProjectOnboardingWizard
          isOpen={onboardingWizardOpen}
          projectId={onboardingProjectId}
          onClose={closeOnboardingWizard}
          onFinish={handleWizardFinish}
        />
      )}

      <CreateProjectFolderDialog
        isOpen={createFolderDialogOpen}
        onClose={closeCreateFolderDialog}
      />

      <PanelTransitionOverlay />

      <Toaster />
      <ReEntrySummary state={reEntrySummary} />
      <UpdateNotification />
      <OnboardingFlow
        availability={availability}
        onRefreshSettings={refreshSettings}
        onComplete={gettingStarted.notifyOnboardingComplete}
      />
      {gettingStarted.visible && gettingStarted.checklist && (
        <GettingStartedChecklist
          checklist={gettingStarted.checklist}
          collapsed={gettingStarted.collapsed}
          onDismiss={gettingStarted.dismiss}
          onToggleCollapse={gettingStarted.toggleCollapse}
        />
      )}
    </ErrorBoundary>
  );
}

export default App;
