import {
  Profiler,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import "@xterm/xterm/css/xterm.css";
import { FolderOpen, FilterX, Maximize2 } from "lucide-react";
import { ScrollIndicator } from "./components/Worktree/ScrollIndicator";
import {
  isElectronAvailable,
  useAgentLauncher,
  useWorktrees,
  useTerminalPalette,
  useNewTerminalPalette,
  usePanelPalette,
  useProjectSwitcherPalette,
  useTerminalConfig,
  useGlobalKeybindings,
  useContextInjection,
  useProjectSettings,
  useGridNavigation,
  useWindowNotifications,
  useWorktreeActions,
  useMenuActions,
  useAppAgentDispatcher,
  useAssistantStreamProcessor,
} from "./hooks";
import { useActionRegistry } from "./hooks/useActionRegistry";
import { useUpdateListener } from "./hooks/useUpdateListener";
import { useActionPalette } from "./hooks/useActionPalette";
import { useQuickSwitcher } from "./hooks/useQuickSwitcher";
import { useWorktreePalette } from "./hooks/useWorktreePalette";
import { useDoubleShift } from "./hooks/useDoubleShift";
import { useAssistantContextSync } from "./hooks/useAssistantContextSync";
import { actionService } from "./services/ActionService";
import { createTooltipWithShortcut } from "./lib/platform";
import { getAssistantContext } from "./components/Assistant/assistantContext";
import {
  useAppHydration,
  useProjectSwitchRehydration,
  useFirstRunToasts,
  useTerminalStoreBootstrap,
  useSemanticWorkerLifecycle,
  useSystemWakeHandler,
  useDevServerDiscovery,
  type HydrationCallbacks,
} from "./hooks/app";
import { AppLayout } from "./components/Layout";
import { ContentGrid } from "./components/Terminal";
import { PanelTransitionOverlay } from "./components/Panel";
import {
  WorktreeCard,
  WorktreePalette,
  WorktreeFilterPopover,
  WorktreeOverviewModal,
} from "./components/Worktree";
import { NewWorktreeDialog } from "./components/Worktree/NewWorktreeDialog";
import { TerminalInfoDialogHost } from "./components/Terminal/TerminalInfoDialogHost";
import { TerminalPalette, NewTerminalPalette } from "./components/TerminalPalette";
import { PanelPalette } from "./components/PanelPalette/PanelPalette";
import { MORE_AGENTS_PANEL_ID } from "./hooks/usePanelPalette";
import { GitInitDialog, ProjectOnboardingWizard, WelcomeScreen } from "./components/Project";
import {
  AgentSetupWizard,
  AgentSelectionStep,
  shouldShowAgentSetupWizard,
  shouldShowAgentSelection,
} from "./components/Setup";
import { CreateProjectFolderDialog } from "./components/Project/CreateProjectFolderDialog";
import { ProjectSwitcherPalette } from "./components/Project/ProjectSwitcherPalette";
import { ActionPalette } from "./components/ActionPalette";
import { QuickSwitcher } from "./components/QuickSwitcher";
import { ConfirmDialog } from "./components/ui/ConfirmDialog";
import { RecipeEditor } from "./components/TerminalRecipe/RecipeEditor";
import { NotesPalette } from "./components/Notes";
import { SettingsDialog, type SettingsTab } from "./components/Settings";
import { ShortcutReferenceDialog } from "./components/KeyboardShortcuts";
import { Toaster } from "./components/ui/toaster";
import { UpdateNotification } from "./components/UpdateNotification";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { DndProvider } from "./components/DragDrop";
import { AssistantActionConfirmationHost } from "./components/Assistant/AssistantActionConfirmationHost";
import {
  useTerminalStore,
  useWorktreeSelectionStore,
  useProjectStore,
  useErrorStore,
  useDiagnosticsStore,
  useFocusStore,
  useAgentSettingsStore,
  cleanupWorktreeDataStore,
  useToolbarPreferencesStore,
  type RetryAction,
} from "./store";
import { useShallow } from "zustand/react/shallow";
import { useRecipeStore } from "./store/recipeStore";
import type { RecipeTerminal } from "./types";
import { errorsClient, systemClient, worktreeClient } from "@/clients";
import { registerBuiltInPanelComponents } from "./registry";

// Register built-in panel components before any renders
registerBuiltInPanelComponents();
import { useWorktreeFilterStore } from "./store/worktreeFilterStore";
import {
  matchesFilters,
  sortWorktrees,
  groupByType,
  type DerivedWorktreeMeta,
  type FilterState,
} from "./lib/worktreeFilters";
import type { WorktreeState, PanelKind } from "./types";
import { startRendererMemoryMonitor } from "./utils/performance";
import { startLongTaskMonitor } from "./utils/longTaskMonitor";
import { useRenderProfiler } from "./utils/renderProfiler";

interface SidebarContentProps {
  onOpenOverview: () => void;
}

function SidebarContent({ onOpenOverview }: SidebarContentProps) {
  const { worktrees, isLoading, error, refresh } = useWorktrees();
  useProjectSettings();
  const { launchAgent, availability, agentSettings } = useAgentLauncher();
  const {
    activeWorktreeId,
    focusedWorktreeId,
    selectWorktree,
    createDialog,
    openCreateDialog,
    closeCreateDialog,
  } = useWorktreeSelectionStore(
    useShallow((state) => ({
      activeWorktreeId: state.activeWorktreeId,
      focusedWorktreeId: state.focusedWorktreeId,
      selectWorktree: state.selectWorktree,
      createDialog: state.createDialog,
      openCreateDialog: state.openCreateDialog,
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
    pinnedWorktrees,
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
      pinnedWorktrees: state.pinnedWorktrees,
    }))
  );
  const clearAllFilters = useWorktreeFilterStore((state) => state.clearAll);
  const hasActiveFilters = useWorktreeFilterStore((state) => state.hasActiveFilters);
  const unpinWorktree = useWorktreeFilterStore((state) => state.unpinWorktree);

  // Terminal store for derived metadata
  const terminals = useTerminalStore(useShallow((state) => state.terminals));

  // Error store for derived metadata
  const getWorktreeErrors = useErrorStore((state) => state.getWorktreeErrors);

  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const scrollContentRef = useRef<HTMLDivElement>(null);
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

  // Clean up stale pinned worktrees
  useEffect(() => {
    const existingIds = new Set(worktrees.map((w) => w.id));
    const stalePins = pinnedWorktrees.filter((id) => !existingIds.has(id));
    stalePins.forEach((id) => unpinWorktree(id));
  }, [worktrees, pinnedWorktrees, unpinWorktree]);

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
      });
    }
    return map;
  }, [worktrees, terminals, getWorktreeErrors]);

  // Apply filters and sorting
  const { filteredWorktrees, groupedSections } = useMemo(() => {
    const filters: FilterState = {
      query,
      statusFilters,
      typeFilters,
      githubFilters,
      sessionFilters,
      activityFilters,
    };

    // Filter worktrees
    const filtered = worktrees.filter((worktree) => {
      const derived = derivedMetaMap.get(worktree.id) ?? {
        hasErrors: false,
        terminalCount: 0,
        hasWorkingAgent: false,
        hasRunningAgent: false,
        hasWaitingAgent: false,
        hasFailedAgent: false,
        hasCompletedAgent: false,
      };
      const isActive = worktree.id === activeWorktreeId;

      // Always show active worktree if setting is enabled
      if (alwaysShowActive && isActive) {
        return true;
      }

      return matchesFilters(worktree, filters, derived, isActive);
    });

    // Filter out pinned worktrees that no longer exist
    const existingWorktreeIds = new Set(worktrees.map((w) => w.id));
    const validPinnedWorktrees = pinnedWorktrees.filter((id) => existingWorktreeIds.has(id));

    // Sort worktrees
    const sorted = sortWorktrees(filtered, orderBy, validPinnedWorktrees);

    // Group if enabled
    if (isGroupedByType) {
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
    pinnedWorktrees,
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
            className="text-xs px-2 py-1 border border-divider rounded hover:bg-white/[0.06] text-canopy-text"
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
            <kbd className="px-1.5 py-0.5 bg-white/[0.06] rounded text-xs">
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

  const rootPath =
    worktrees.length > 0 && worktrees[0].path ? worktrees[0].path.split("/.git/")[0] : "";

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
      <div className="flex items-center justify-between px-4 py-4 border-b border-divider bg-transparent shrink-0">
        <div className="flex items-center gap-2">
          <h2 className="text-canopy-text font-semibold text-sm tracking-wide">Worktrees</h2>
          <button
            onClick={onOpenOverview}
            className="p-1 text-canopy-text/40 hover:text-canopy-text hover:bg-white/[0.06] rounded transition-colors"
            title={createTooltipWithShortcut("Toggle worktrees overview", "Cmd+Shift+O")}
            aria-label="Open worktrees overview"
          >
            <Maximize2 className="w-3.5 h-3.5" />
          </button>
        </div>
        <div className="flex items-center gap-1">
          <WorktreeFilterPopover />
          <button
            onClick={() => openCreateDialog()}
            className="flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 text-canopy-text/60 hover:text-canopy-text hover:bg-white/[0.06] rounded transition-colors"
            title="Create new worktree"
          >
            <span className="text-[11px]">+</span> New
          </button>
        </div>
      </div>

      {/* List Section */}
      <div className="relative flex-1 min-h-0">
        <div ref={scrollContainerRef} className="h-full overflow-y-auto">
          <div ref={scrollContentRef}>
            {filteredWorktrees.length === 0 && hasActiveFilters() ? (
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
              <div className="flex flex-col">{filteredWorktrees.map(renderWorktreeCard)}</div>
            )}
          </div>
        </div>
        <ScrollIndicator direction="above" count={hiddenAbove} onClick={scrollToTop} />
        <ScrollIndicator direction="below" count={hiddenBelow} onClick={scrollToBottom} />
      </div>

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
        />
      )}
    </div>
  );
}

function App() {
  const { focusedId, addTerminal, setReconnectError, hydrateTabGroups, hydrateMru } =
    useTerminalStore(
      useShallow((state) => ({
        focusedId: state.focusedId,
        addTerminal: state.addTerminal,
        setReconnectError: state.setReconnectError,
        hydrateTabGroups: state.hydrateTabGroups,
        hydrateMru: state.hydrateMru,
      }))
    );

  useEffect(() => {
    const handleBeforeUnload = () => {
      cleanupWorktreeDataStore();
    };

    window.addEventListener("beforeunload", handleBeforeUnload);

    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
      cleanupWorktreeDataStore();
    };
  }, []);
  const { launchAgent, availability, agentSettings, refreshSettings, isCheckingAvailability } =
    useAgentLauncher();
  const [isAgentSetupOpen, setIsAgentSetupOpen] = useState(false);
  const agentSetupCheckedRef = useRef(false);

  // Agent selection step state for first-run onboarding
  const [agentSelectionOpen, setAgentSelectionOpen] = useState(false);
  const [onboardingSetupOpen, setOnboardingSetupOpen] = useState(false);
  const [onboardingSetupAgentIds, setOnboardingSetupAgentIds] = useState<string[]>([]);

  useEffect(() => {
    if (agentSetupCheckedRef.current || isCheckingAvailability) return;
    agentSetupCheckedRef.current = true;
    if (shouldShowAgentSetupWizard(availability)) {
      setIsAgentSetupOpen(true);
    }
  }, [isCheckingAvailability, availability]);

  useEffect(() => {
    const handleOpenWizard = () => setIsAgentSetupOpen(true);
    window.addEventListener("canopy:open-agent-setup-wizard", handleOpenWizard);
    return () => window.removeEventListener("canopy:open-agent-setup-wizard", handleOpenWizard);
  }, []);

  const loadRecipes = useRecipeStore((state) => state.loadRecipes);
  useTerminalConfig();
  useWindowNotifications();
  useUpdateListener();
  useAppAgentDispatcher(); // Enable Assistant tool calling via action dispatch
  useAssistantStreamProcessor(); // Process Assistant chunks even when pane is closed

  const [homeDir, setHomeDir] = useState<string | undefined>(undefined);
  useEffect(() => {
    systemClient.getHomeDir().then(setHomeDir).catch(console.error);
  }, []);

  // Grid navigation hook for directional terminal switching
  const { findNearest, findByIndex, findDockByIndex, getCurrentLocation } = useGridNavigation();

  const terminalPalette = useTerminalPalette();
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

  const agentSettingsInitialized = useAgentSettingsStore((state) => state.isInitialized);

  // Intercept onboarding to show agent selection on first run.
  // Depends on agentSettingsInitialized so it re-evaluates once settings load.
  useEffect(() => {
    if (!onboardingWizardOpen || !onboardingProjectId) return;
    if (shouldShowAgentSelection()) {
      setAgentSelectionOpen(true);
    }
  }, [onboardingWizardOpen, onboardingProjectId, agentSettingsInitialized]);

  // Reset local flow state whenever onboarding closes to avoid stale state on next project.
  useEffect(() => {
    if (!onboardingWizardOpen && !onboardingProjectId) {
      setAgentSelectionOpen(false);
      setOnboardingSetupOpen(false);
      setOnboardingSetupAgentIds([]);
    }
  }, [onboardingWizardOpen, onboardingProjectId]);

  const handleAgentSelectionContinue = useCallback(
    (uninstalledIds: string[]) => {
      setAgentSelectionOpen(false);
      void refreshSettings();
      if (uninstalledIds.length > 0) {
        setOnboardingSetupAgentIds(uninstalledIds);
        setOnboardingSetupOpen(true);
      }
    },
    [refreshSettings]
  );

  const handleAgentSelectionSkip = useCallback(() => {
    setAgentSelectionOpen(false);
  }, []);

  const handleOnboardingSetupClose = useCallback(() => {
    setOnboardingSetupOpen(false);
    setOnboardingSetupAgentIds([]);
  }, []);

  const createFolderDialogOpen = useProjectStore((state) => state.createFolderDialogOpen);
  const closeCreateFolderDialog = useProjectStore((state) => state.closeCreateFolderDialog);
  const openCreateFolderDialog = useProjectStore((state) => state.openCreateFolderDialog);
  const { setActiveWorktree, selectWorktree, activeWorktreeId, focusedWorktreeId } =
    useWorktreeSelectionStore(
      useShallow((state) => ({
        setActiveWorktree: state.setActiveWorktree,
        selectWorktree: state.selectWorktree,
        activeWorktreeId: state.activeWorktreeId,
        focusedWorktreeId: state.focusedWorktreeId,
      }))
    );
  const lastSyncedActiveRef = useRef<{ projectId: string | null; worktreeId: string | null }>({
    projectId: null,
    worktreeId: null,
  });
  const activeWorktree = useMemo(
    () => worktrees.find((w) => w.id === activeWorktreeId) ?? null,
    [worktrees, activeWorktreeId]
  );
  useEffect(() => {
    if (worktrees.length === 0) return;

    const worktreeExists = activeWorktreeId && worktrees.some((w) => w.id === activeWorktreeId);
    if (!worktreeExists) {
      const mainWorktree = worktrees.find((w) => w.isMainWorktree) ?? worktrees[0];
      selectWorktree(mainWorktree.id);
    }
  }, [worktrees, activeWorktreeId, selectWorktree]);
  useEffect(() => {
    const projectId = currentProject?.id ?? null;
    const selectedWorktreeId = activeWorktreeId ?? null;

    if (!projectId || !selectedWorktreeId) {
      lastSyncedActiveRef.current = { projectId, worktreeId: null };
      return;
    }

    const worktreeExists = worktrees.some((w) => w.id === selectedWorktreeId);
    if (!worktreeExists) {
      return;
    }

    if (
      lastSyncedActiveRef.current.projectId === projectId &&
      lastSyncedActiveRef.current.worktreeId === selectedWorktreeId
    ) {
      return;
    }

    lastSyncedActiveRef.current = { projectId, worktreeId: selectedWorktreeId };
    worktreeClient.setActive(selectedWorktreeId).catch(() => {
      if (
        lastSyncedActiveRef.current.projectId === projectId &&
        lastSyncedActiveRef.current.worktreeId === selectedWorktreeId
      ) {
        lastSyncedActiveRef.current = { projectId, worktreeId: null };
      }
    });
  }, [activeWorktreeId, currentProject?.id, worktrees]);
  const defaultTerminalCwd = useMemo(
    () => activeWorktree?.path ?? currentProject?.path ?? "",
    [activeWorktree, currentProject]
  );

  const worktreePalette = useWorktreePalette({ worktrees });

  const openDiagnosticsDock = useDiagnosticsStore((state) => state.openDock);
  const removeError = useErrorStore((state) => state.removeError);
  const setFocusMode = useFocusStore((state) => state.setFocusMode);

  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("general");
  const [isShortcutsOpen, setIsShortcutsOpen] = useState(false);
  const [isNotesPaletteOpen, setIsNotesPaletteOpen] = useState(false);
  const [isWorktreeOverviewOpen, setIsWorktreeOverviewOpen] = useState(false);
  const onLayoutRender = useRenderProfiler("app-layout", { sampleRate: 0.15 });
  const onContentGridRender = useRenderProfiler("content-grid", { sampleRate: 0.15 });

  useEffect(() => {
    const stopMonitor = startRendererMemoryMonitor();
    const stopLongTaskMonitor = startLongTaskMonitor();
    return () => {
      stopMonitor();
      stopLongTaskMonitor();
    };
  }, []);

  // Hydration callbacks for state restoration
  const hydrationCallbacks: HydrationCallbacks = useMemo(
    () => ({
      addTerminal,
      setActiveWorktree,
      loadRecipes,
      openDiagnosticsDock,
      setFocusMode,
      setReconnectError,
      hydrateTabGroups,
      hydrateMru,
    }),
    [
      addTerminal,
      setActiveWorktree,
      loadRecipes,
      openDiagnosticsDock,
      setFocusMode,
      setReconnectError,
      hydrateTabGroups,
      hydrateMru,
    ]
  );

  // App lifecycle hooks
  const { isStateLoaded } = useAppHydration(hydrationCallbacks);
  useProjectSwitchRehydration(hydrationCallbacks);
  useFirstRunToasts(isStateLoaded);

  const handleLaunchAgent = useCallback(
    async (type: "claude" | "gemini" | "codex" | "opencode" | "terminal" | "browser") => {
      await launchAgent(type);
    },
    [launchAgent]
  );

  const handleSettings = useCallback(() => {
    setSettingsTab("general");
    setIsSettingsOpen(true);
  }, []);

  const handleWizardFinish = useCallback(() => {
    const defaultAgent = useToolbarPreferencesStore.getState().launcher.defaultAgent;
    const selected = agentSettings?.agents
      ? Object.entries(agentSettings.agents)
          .filter(([, entry]) => entry.selected === true)
          .map(([id]) => id)
      : [];
    const primaryAgent = defaultAgent ?? selected[0];

    if (primaryAgent && availability[primaryAgent]) {
      launchAgent(primaryAgent, {
        worktreeId: activeWorktreeId ?? undefined,
        prompt: "Hi! I'm ready to help with this project. What would you like to know?",
      }).catch(() => {});
    }
  }, [launchAgent, activeWorktreeId, availability, agentSettings]);

  const handleOpenAgentSettings = useCallback(() => {
    setSettingsTab("agents");
    setIsSettingsOpen(true);
  }, []);

  const handleOpenSettingsTab = useCallback((tab: string) => {
    const allowedTabs: SettingsTab[] = [
      "general",
      "keyboard",
      "terminal",
      "terminalAppearance",
      "worktree",
      "assistant",
      "agents",
      "github",
      "sidecar",
      "toolbar",
      "troubleshooting",
    ];
    if (!allowedTabs.includes(tab as SettingsTab)) {
      setSettingsTab("general");
      setIsSettingsOpen(true);
      return;
    }
    setSettingsTab(tab as SettingsTab);
    setIsSettingsOpen(true);
  }, []);

  useEffect(() => {
    const handleOpenSettingsTabEvent = (event: Event) => {
      const customEvent = event as CustomEvent<unknown>;
      const tab = typeof customEvent.detail === "string" ? customEvent.detail : "";
      handleOpenSettingsTab(tab);
    };

    window.addEventListener("canopy:open-settings-tab", handleOpenSettingsTabEvent);
    return () => window.removeEventListener("canopy:open-settings-tab", handleOpenSettingsTabEvent);
  }, [handleOpenSettingsTab]);

  const openNotesPalette = useCallback(() => {
    setIsNotesPaletteOpen(true);
  }, []);

  const closeNotesPalette = useCallback(() => {
    setIsNotesPaletteOpen(false);
  }, []);

  const toggleWorktreeOverview = useCallback(() => {
    setIsWorktreeOverviewOpen((prev) => !prev);
  }, []);

  const openWorktreeOverview = useCallback(() => {
    setIsWorktreeOverviewOpen(true);
  }, []);

  const closeWorktreeOverview = useCallback(() => {
    setIsWorktreeOverviewOpen(false);
  }, []);

  const overviewWorktreeActions = useWorktreeActions({ launchAgent });

  useEffect(() => {
    const handleOpenNotesPalette = () => {
      openNotesPalette();
    };

    window.addEventListener("canopy:open-notes-palette", handleOpenNotesPalette);
    return () => window.removeEventListener("canopy:open-notes-palette", handleOpenNotesPalette);
  }, [openNotesPalette]);

  const handleErrorRetry = useCallback(
    async (errorId: string, action: RetryAction, args?: Record<string, unknown>) => {
      try {
        await errorsClient.retry(errorId, action, args);
        removeError(errorId);
      } catch (error) {
        console.error("Error retry failed:", error);
      }
    },
    [removeError]
  );

  const electronAvailable = isElectronAvailable();
  const { inject } = useContextInjection();

  useEffect(() => {
    actionService.setContextProvider(() => getAssistantContext());

    return () => actionService.setContextProvider(null);
  }, []);

  const handleToggleSidebar = useCallback(() => {
    window.dispatchEvent(new CustomEvent("canopy:toggle-focus-mode"));
  }, []);

  useActionRegistry({
    onOpenSettings: handleSettings,
    onOpenSettingsTab: handleOpenSettingsTab,
    onToggleSidebar: handleToggleSidebar,
    onToggleFocusMode: handleToggleSidebar,
    onOpenActionPalette: actionPalette.open,
    onOpenQuickSwitcher: quickSwitcher.open,
    onOpenAgentPalette: terminalPalette.open,
    onOpenWorktreePalette: worktreePalette.open,
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
    onOpenAgentPalette: terminalPalette.open,
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
  useAssistantContextSync();
  useDevServerDiscovery();

  if (!isElectronAvailable()) {
    return (
      <div className="h-screen w-screen flex items-center justify-center bg-canopy-bg">
        <div className="text-canopy-text/60 text-sm">
          Electron API not available - please run in Electron
        </div>
      </div>
    );
  }

  if (!isStateLoaded) {
    return (
      <>
        <div className="h-screen w-screen bg-canopy-bg" />
        <AssistantActionConfirmationHost />
      </>
    );
  }

  return (
    <ErrorBoundary variant="fullscreen" componentName="App">
      <DndProvider>
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
            onOpenAgentSettings={handleOpenAgentSettings}
            onRetry={handleErrorRetry}
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

      <TerminalPalette
        isOpen={terminalPalette.isOpen}
        query={terminalPalette.query}
        results={terminalPalette.results}
        selectedIndex={terminalPalette.selectedIndex}
        onQueryChange={terminalPalette.setQuery}
        onSelectPrevious={terminalPalette.selectPrevious}
        onSelectNext={terminalPalette.selectNext}
        onSelect={terminalPalette.selectTerminal}
        onClose={terminalPalette.close}
      />
      <QuickSwitcher
        isOpen={quickSwitcher.isOpen}
        query={quickSwitcher.query}
        results={quickSwitcher.results}
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
        activeWorktreeId={worktreePalette.activeWorktreeId}
        selectedIndex={worktreePalette.selectedIndex}
        onQueryChange={worktreePalette.setQuery}
        onSelectPrevious={worktreePalette.selectPrevious}
        onSelectNext={worktreePalette.selectNext}
        onSelect={worktreePalette.selectWorktree}
        onConfirm={worktreePalette.confirmSelection}
        onClose={worktreePalette.close}
      />
      <PanelPalette
        isOpen={panelPalette.isOpen}
        query={panelPalette.query}
        results={panelPalette.results}
        selectedIndex={panelPalette.selectedIndex}
        onQueryChange={panelPalette.setQuery}
        onSelectPrevious={panelPalette.selectPrevious}
        onSelectNext={panelPalette.selectNext}
        onSelect={(kind) => {
          panelPalette.handleSelect(kind);
          if (kind.id === MORE_AGENTS_PANEL_ID) return;
          if (kind.id.startsWith("agent:")) {
            const agentId = kind.id.slice("agent:".length);
            if (agentId) {
              launchAgent(agentId);
            }
          } else {
            addTerminal({
              kind: kind.id as PanelKind,
              cwd: defaultTerminalCwd,
              worktreeId: activeWorktreeId ?? undefined,
              location: "grid",
            });
          }
        }}
        onConfirm={() => {
          const selected = panelPalette.confirmSelection();
          if (selected && selected.id !== MORE_AGENTS_PANEL_ID) {
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
          }
        }}
        onClose={panelPalette.close}
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
        removeConfirmProject={projectSwitcherPalette.removeConfirmProject}
        onRemoveConfirmClose={() => projectSwitcherPalette.setRemoveConfirmProject(null)}
        onConfirmRemove={projectSwitcherPalette.confirmRemoveProject}
        isRemovingProject={projectSwitcherPalette.isRemovingProject}
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

      <SettingsDialog
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        defaultTab={settingsTab}
        onSettingsChange={refreshSettings}
      />

      <ShortcutReferenceDialog isOpen={isShortcutsOpen} onClose={() => setIsShortcutsOpen(false)} />

      <TerminalInfoDialogHost />

      {gitInitDirectoryPath && (
        <GitInitDialog
          isOpen={gitInitDialogOpen}
          directoryPath={gitInitDirectoryPath}
          onSuccess={handleGitInitSuccess}
          onCancel={closeGitInitDialog}
        />
      )}

      {onboardingProjectId && (
        <AgentSelectionStep
          isOpen={agentSelectionOpen}
          onContinue={handleAgentSelectionContinue}
          onSkip={handleAgentSelectionSkip}
        />
      )}

      {onboardingProjectId && (
        <ProjectOnboardingWizard
          isOpen={onboardingWizardOpen && !agentSelectionOpen && !onboardingSetupOpen}
          projectId={onboardingProjectId}
          onClose={closeOnboardingWizard}
          onFinish={handleWizardFinish}
        />
      )}

      {onboardingSetupOpen && (
        <AgentSetupWizard
          isOpen={onboardingSetupOpen}
          onClose={handleOnboardingSetupClose}
          initialAvailability={availability}
          agentIds={onboardingSetupAgentIds}
        />
      )}

      <AgentSetupWizard
        isOpen={isAgentSetupOpen && !onboardingWizardOpen}
        onClose={() => setIsAgentSetupOpen(false)}
        initialAvailability={availability}
      />

      <CreateProjectFolderDialog
        isOpen={createFolderDialogOpen}
        onClose={closeCreateFolderDialog}
      />

      <PanelTransitionOverlay />

      <AssistantActionConfirmationHost />

      <Toaster />
      <UpdateNotification />
    </ErrorBoundary>
  );
}

export default App;
