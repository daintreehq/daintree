import { useCallback, useEffect, useMemo, useState } from "react";
import "@xterm/xterm/css/xterm.css";
import { FolderOpen, FilterX } from "lucide-react";
import {
  isElectronAvailable,
  useAgentLauncher,
  useWorktrees,
  useTerminalPalette,
  useNewTerminalPalette,
  useTerminalConfig,
  useKeybinding,
  useContextInjection,
  useProjectSettings,
  useLinkDiscovery,
  useGridNavigation,
  useWindowNotifications,
  useWorktreeActions,
  useMenuActions,
} from "./hooks";
import { useActionRegistry } from "./hooks/useActionRegistry";
import { actionService } from "./services/ActionService";
import {
  useAppHydration,
  useProjectSwitchRehydration,
  useFirstRunToasts,
  useTerminalStoreBootstrap,
  useSemanticWorkerLifecycle,
  useSystemWakeHandler,
  type HydrationCallbacks,
} from "./hooks/app";
import { AppLayout } from "./components/Layout";
import { ContentGrid } from "./components/Terminal";
import { WorktreeCard, WorktreePalette, WorktreeFilterPopover } from "./components/Worktree";
import { NewWorktreeDialog } from "./components/Worktree/NewWorktreeDialog";
import { TerminalInfoDialogHost } from "./components/Terminal/TerminalInfoDialogHost";
import { TerminalPalette, NewTerminalPalette } from "./components/TerminalPalette";
import { RecipeEditor } from "./components/TerminalRecipe/RecipeEditor";
import { SettingsDialog, type SettingsTab } from "./components/Settings";
import { ShortcutReferenceDialog } from "./components/KeyboardShortcuts";
import { Toaster } from "./components/ui/toaster";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { DndProvider } from "./components/DragDrop";
import {
  useTerminalStore,
  useWorktreeSelectionStore,
  useProjectStore,
  useErrorStore,
  useDiagnosticsStore,
  cleanupWorktreeDataStore,
  type RetryAction,
} from "./store";
import { useShallow } from "zustand/react/shallow";
import { useRecipeStore } from "./store/recipeStore";
import type { RecipeTerminal } from "./types";
import { systemClient, errorsClient } from "@/clients";
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
import type { WorktreeState } from "./types";

function SidebarContent() {
  const { worktrees, isLoading, error, refresh } = useWorktrees();
  useProjectSettings();
  const { launchAgent, availability, agentSettings } = useAgentLauncher();
  const {
    activeWorktreeId,
    focusedWorktreeId,
    selectWorktree,
    setActiveWorktree,
    createDialog,
    openCreateDialog,
    closeCreateDialog,
  } = useWorktreeSelectionStore(
    useShallow((state) => ({
      activeWorktreeId: state.activeWorktreeId,
      focusedWorktreeId: state.focusedWorktreeId,
      selectWorktree: state.selectWorktree,
      setActiveWorktree: state.setActiveWorktree,
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
    }))
  );
  const clearAllFilters = useWorktreeFilterStore((state) => state.clearAll);
  const hasActiveFilters = useWorktreeFilterStore((state) => state.hasActiveFilters);

  // Terminal store for derived metadata
  const terminals = useTerminalStore(useShallow((state) => state.terminals));

  // Error store for derived metadata
  const getWorktreeErrors = useErrorStore((state) => state.getWorktreeErrors);

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

  useEffect(() => {
    if (worktrees.length > 0) {
      // Check if activeWorktreeId is missing or doesn't exist in worktrees
      const worktreeExists = activeWorktreeId && worktrees.some((w) => w.id === activeWorktreeId);
      if (!worktreeExists) {
        // Fall back to main worktree or first available
        const mainWorktree = worktrees.find((w) => w.isMainWorktree) ?? worktrees[0];
        setActiveWorktree(mainWorktree.id);
      }
    }
  }, [worktrees, activeWorktreeId, setActiveWorktree]);

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

    // Sort worktrees
    const sorted = sortWorktrees(filtered, orderBy);

    // Group if enabled
    if (isGroupedByType) {
      return {
        filteredWorktrees: sorted,
        groupedSections: groupByType(sorted, orderBy),
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
    derivedMetaMap,
    activeWorktreeId,
  ]);

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

  if (isLoading) {
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
              <li>Launch Claude or Gemini</li>
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
      onSelect={() => selectWorktree(worktree.id)}
      onCopyTree={() => worktreeActions.handleCopyTree(worktree)}
      onOpenEditor={() => worktreeActions.handleOpenEditor(worktree)}
      onOpenIssue={
        worktree.issueNumber ? () => worktreeActions.handleOpenIssue(worktree) : undefined
      }
      onOpenPR={worktree.prUrl ? () => worktreeActions.handleOpenPR(worktree) : undefined}
      onCreateRecipe={() => worktreeActions.handleCreateRecipe(worktree.id)}
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
        <h2 className="text-canopy-text font-semibold text-sm tracking-wide">Worktrees</h2>
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
      <div className="flex-1 overflow-y-auto">
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
  const { focusedId, addTerminal } = useTerminalStore(
    useShallow((state) => ({
      focusedId: state.focusedId,
      addTerminal: state.addTerminal,
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
  const { launchAgent, availability, isCheckingAvailability, agentSettings, refreshSettings } =
    useAgentLauncher();
  const loadRecipes = useRecipeStore((state) => state.loadRecipes);
  useTerminalConfig();
  useLinkDiscovery();
  useWindowNotifications();

  // Grid navigation hook for directional terminal switching
  const { findNearest, findByIndex, findDockByIndex, getCurrentLocation } = useGridNavigation();

  const terminalPalette = useTerminalPalette();
  const { worktrees, worktreeMap } = useWorktrees();
  const newTerminalPalette = useNewTerminalPalette({ launchAgent, worktreeMap });
  const currentProject = useProjectStore((state) => state.currentProject);
  const { setActiveWorktree, selectWorktree, activeWorktreeId } = useWorktreeSelectionStore(
    useShallow((state) => ({
      setActiveWorktree: state.setActiveWorktree,
      selectWorktree: state.selectWorktree,
      activeWorktreeId: state.activeWorktreeId,
    }))
  );
  const activeWorktree = useMemo(
    () => worktrees.find((w) => w.id === activeWorktreeId) ?? null,
    [worktrees, activeWorktreeId]
  );
  const defaultTerminalCwd = useMemo(
    () => activeWorktree?.path ?? currentProject?.path ?? "",
    [activeWorktree, currentProject]
  );

  const [isWorktreePaletteOpen, setIsWorktreePaletteOpen] = useState(false);
  const [worktreePaletteQuery, setWorktreePaletteQuery] = useState("");
  const [worktreePaletteSelectedIndex, setWorktreePaletteSelectedIndex] = useState(0);
  const worktreePaletteResults = useMemo(() => {
    const search = worktreePaletteQuery.trim().toLowerCase();
    const sorted = [...worktrees].sort((a, b) => {
      if (a.id === activeWorktreeId) return -1;
      if (b.id === activeWorktreeId) return 1;
      if (a.isMainWorktree && !b.isMainWorktree) return -1;
      if (!a.isMainWorktree && b.isMainWorktree) return 1;
      return a.name.localeCompare(b.name);
    });

    const filtered = sorted.filter((worktree) => {
      if (!search) return true;
      const branch = worktree.branch ?? "";
      return (
        worktree.name.toLowerCase().includes(search) ||
        branch.toLowerCase().includes(search) ||
        worktree.path.toLowerCase().includes(search)
      );
    });

    return filtered.slice(0, 20);
  }, [worktrees, worktreePaletteQuery, activeWorktreeId]);

  useEffect(() => {
    setWorktreePaletteSelectedIndex(0);
  }, [worktreePaletteResults]);

  const closeWorktreePalette = useCallback(() => {
    setIsWorktreePaletteOpen(false);
    setWorktreePaletteQuery("");
    setWorktreePaletteSelectedIndex(0);
  }, []);

  const openWorktreePalette = useCallback(() => {
    setIsWorktreePaletteOpen(true);
    setWorktreePaletteQuery("");
    setWorktreePaletteSelectedIndex(0);
  }, []);

  const selectWorktreeFromPalette = useCallback(
    (worktreeId: string) => {
      selectWorktree(worktreeId);
      closeWorktreePalette();
    },
    [selectWorktree, closeWorktreePalette]
  );

  const selectPreviousWorktreeResult = useCallback(() => {
    if (worktreePaletteResults.length === 0) return;
    setWorktreePaletteSelectedIndex((prev) =>
      prev <= 0 ? worktreePaletteResults.length - 1 : prev - 1
    );
  }, [worktreePaletteResults]);

  const selectNextWorktreeResult = useCallback(() => {
    if (worktreePaletteResults.length === 0) return;
    setWorktreePaletteSelectedIndex((prev) =>
      prev >= worktreePaletteResults.length - 1 ? 0 : prev + 1
    );
  }, [worktreePaletteResults]);

  const confirmWorktreePaletteSelection = useCallback(() => {
    if (worktreePaletteResults.length === 0) {
      closeWorktreePalette();
      return;
    }
    const boundedIndex = Math.min(worktreePaletteSelectedIndex, worktreePaletteResults.length - 1);
    selectWorktreeFromPalette(worktreePaletteResults[boundedIndex].id);
  }, [
    worktreePaletteResults,
    worktreePaletteSelectedIndex,
    selectWorktreeFromPalette,
    closeWorktreePalette,
  ]);

  const openDiagnosticsDock = useDiagnosticsStore((state) => state.openDock);
  const removeError = useErrorStore((state) => state.removeError);

  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("general");
  const [isShortcutsOpen, setIsShortcutsOpen] = useState(false);

  // Hydration callbacks for state restoration
  const hydrationCallbacks: HydrationCallbacks = useMemo(
    () => ({
      addTerminal,
      setActiveWorktree,
      loadRecipes,
      openDiagnosticsDock,
    }),
    [addTerminal, setActiveWorktree, loadRecipes, openDiagnosticsDock]
  );

  // App lifecycle hooks
  const { isStateLoaded } = useAppHydration(hydrationCallbacks);
  useProjectSwitchRehydration(hydrationCallbacks);
  useFirstRunToasts(isStateLoaded);

  const handleLaunchAgent = useCallback(
    async (type: "claude" | "gemini" | "codex" | "terminal" | "browser") => {
      await launchAgent(type);
    },
    [launchAgent]
  );

  const handleSettings = useCallback(() => {
    setSettingsTab("general");
    setIsSettingsOpen(true);
  }, []);

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
      "agents",
      "github",
      "sidecar",
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
    actionService.setContextProvider(() => ({
      projectId: useProjectStore.getState().currentProject?.id,
      activeWorktreeId: useWorktreeSelectionStore.getState().activeWorktreeId ?? undefined,
      focusedTerminalId: useTerminalStore.getState().focusedId ?? undefined,
    }));

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
    onOpenAgentPalette: terminalPalette.open,
    onOpenWorktreePalette: openWorktreePalette,
    onOpenNewTerminalPalette: newTerminalPalette.open,
    onOpenShortcuts: () => setIsShortcutsOpen(true),
    onLaunchAgent: async (agentId, options) => {
      await launchAgent(agentId, options);
    },
    onInject: inject,
    getDefaultCwd: () => defaultTerminalCwd,
    getActiveWorktreeId: () => activeWorktree?.id,
    getWorktrees: () => worktrees.map((w) => ({ id: w.id, path: w.path })),
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

  // All keybindings dispatch through ActionService
  const dispatch = (actionId: string, args?: unknown) => {
    actionService.dispatch(actionId as Parameters<typeof actionService.dispatch>[0], args, {
      source: "keybinding",
    });
  };

  // Terminal palette and spawn
  useKeybinding("terminal.palette", () => dispatch("terminal.palette"), {
    enabled: electronAvailable,
  });
  useKeybinding("agent.palette", () => dispatch("agent.palette"), { enabled: electronAvailable });
  useKeybinding("terminal.new", () => dispatch("terminal.new"), { enabled: electronAvailable });
  useKeybinding("terminal.spawnPalette", () => dispatch("terminal.spawnPalette"), {
    enabled: electronAvailable,
  });

  // Terminal lifecycle
  useKeybinding("terminal.close", () => dispatch("terminal.close"), { enabled: electronAvailable });
  useKeybinding("terminal.reopenLast", () => dispatch("terminal.reopenLast"), {
    enabled: electronAvailable,
  });

  // Terminal focus
  useKeybinding("terminal.focusNext", () => dispatch("terminal.focusNext"), {
    enabled: electronAvailable,
  });
  useKeybinding("terminal.focusPrevious", () => dispatch("terminal.focusPrevious"), {
    enabled: electronAvailable,
  });
  useKeybinding("terminal.maximize", () => dispatch("terminal.maximize"), {
    enabled: electronAvailable && !!focusedId,
  });

  // Agent launching
  useKeybinding("agent.claude", () => dispatch("agent.claude"), { enabled: electronAvailable });
  useKeybinding("agent.gemini", () => dispatch("agent.gemini"), { enabled: electronAvailable });
  useKeybinding("agent.codex", () => dispatch("agent.codex"), { enabled: electronAvailable });
  useKeybinding("agent.terminal", () => dispatch("agent.terminal"), { enabled: electronAvailable });
  useKeybinding("agent.focusNextWaiting", () => dispatch("agent.focusNextWaiting"), {
    enabled: electronAvailable,
  });

  // Terminal reordering
  useKeybinding("terminal.moveLeft", () => dispatch("terminal.moveLeft"), {
    enabled: electronAvailable && !!focusedId,
  });
  useKeybinding("terminal.moveRight", () => dispatch("terminal.moveRight"), {
    enabled: electronAvailable && !!focusedId,
  });

  // Terminal dock operations
  useKeybinding("terminal.minimize", () => dispatch("terminal.minimize"), {
    enabled: electronAvailable && !!focusedId,
  });
  useKeybinding("terminal.restore", () => dispatch("terminal.restore"), {
    enabled: electronAvailable,
  });

  // Terminal bulk operations
  useKeybinding("terminal.closeAll", () => dispatch("terminal.closeAll"), {
    enabled: electronAvailable,
  });
  useKeybinding("terminal.killAll", () => dispatch("terminal.killAll"), {
    enabled: electronAvailable,
  });
  useKeybinding("terminal.restartAll", () => dispatch("terminal.restartAll"), {
    enabled: electronAvailable,
  });
  useKeybinding("terminal.minimizeAll", () => dispatch("terminal.minimizeAll"), {
    enabled: electronAvailable,
  });
  useKeybinding("terminal.restoreAll", () => dispatch("terminal.restoreAll"), {
    enabled: electronAvailable,
  });

  // Panel management
  useKeybinding("panel.diagnosticsLogs", () => dispatch("panel.diagnosticsLogs"), {
    enabled: electronAvailable,
  });
  useKeybinding("panel.diagnosticsEvents", () => dispatch("panel.diagnosticsEvents"), {
    enabled: electronAvailable,
  });
  useKeybinding("panel.diagnosticsMessages", () => dispatch("panel.diagnosticsMessages"), {
    enabled: electronAvailable,
  });
  useKeybinding("panel.toggleDiagnostics", () => dispatch("panel.toggleDiagnostics"), {
    enabled: electronAvailable,
  });
  useKeybinding("panel.toggleDock", () => dispatch("panel.toggleDock"), {
    enabled: electronAvailable,
  });
  useKeybinding("panel.toggleDockAlt", () => dispatch("panel.toggleDockAlt"), {
    enabled: electronAvailable,
  });
  useKeybinding("panel.toggleSidecar", () => dispatch("panel.toggleSidecar"), {
    enabled: electronAvailable,
  });

  // Navigation
  useKeybinding("nav.toggleSidebar", () => dispatch("nav.toggleSidebar"), {
    enabled: electronAvailable,
  });

  // Context injection
  useKeybinding("terminal.inject", () => dispatch("terminal.inject"), {
    enabled: electronAvailable && !!activeWorktreeId,
  });

  // Worktree switching (1-9)
  useKeybinding("worktree.switch1", () => dispatch("worktree.switchIndex", { index: 1 }), {
    enabled: electronAvailable && worktrees.length >= 1,
  });
  useKeybinding("worktree.switch2", () => dispatch("worktree.switchIndex", { index: 2 }), {
    enabled: electronAvailable && worktrees.length >= 2,
  });
  useKeybinding("worktree.switch3", () => dispatch("worktree.switchIndex", { index: 3 }), {
    enabled: electronAvailable && worktrees.length >= 3,
  });
  useKeybinding("worktree.switch4", () => dispatch("worktree.switchIndex", { index: 4 }), {
    enabled: electronAvailable && worktrees.length >= 4,
  });
  useKeybinding("worktree.switch5", () => dispatch("worktree.switchIndex", { index: 5 }), {
    enabled: electronAvailable && worktrees.length >= 5,
  });
  useKeybinding("worktree.switch6", () => dispatch("worktree.switchIndex", { index: 6 }), {
    enabled: electronAvailable && worktrees.length >= 6,
  });
  useKeybinding("worktree.switch7", () => dispatch("worktree.switchIndex", { index: 7 }), {
    enabled: electronAvailable && worktrees.length >= 7,
  });
  useKeybinding("worktree.switch8", () => dispatch("worktree.switchIndex", { index: 8 }), {
    enabled: electronAvailable && worktrees.length >= 8,
  });
  useKeybinding("worktree.switch9", () => dispatch("worktree.switchIndex", { index: 9 }), {
    enabled: electronAvailable && worktrees.length >= 9,
  });

  // Worktree navigation
  useKeybinding("worktree.next", () => dispatch("worktree.next"), {
    enabled: electronAvailable && worktrees.length > 1,
  });
  useKeybinding("worktree.previous", () => dispatch("worktree.previous"), {
    enabled: electronAvailable && worktrees.length > 1,
  });
  useKeybinding("worktree.openPalette", () => dispatch("worktree.openPalette"), {
    enabled: electronAvailable,
  });

  // Help and settings
  useKeybinding("help.shortcuts", () => dispatch("help.shortcuts"), { enabled: electronAvailable });
  useKeybinding("help.shortcutsAlt", () => dispatch("help.shortcutsAlt"), {
    enabled: electronAvailable,
  });
  useKeybinding("app.settings", () => dispatch("app.settings"), { enabled: electronAvailable });

  // Directional terminal navigation
  useKeybinding("terminal.focusUp", () => dispatch("terminal.focusUp"), {
    enabled: electronAvailable && !!focusedId,
  });
  useKeybinding("terminal.focusDown", () => dispatch("terminal.focusDown"), {
    enabled: electronAvailable && !!focusedId,
  });
  useKeybinding("terminal.focusLeft", () => dispatch("terminal.focusLeft"), {
    enabled: electronAvailable && !!focusedId,
  });
  useKeybinding("terminal.focusRight", () => dispatch("terminal.focusRight"), {
    enabled: electronAvailable && !!focusedId,
  });

  // Index-based panel navigation (Cmd+1-9)
  useKeybinding("terminal.focusIndex1", () => dispatch("panel.focusIndex", { index: 1 }), {
    enabled: electronAvailable,
  });
  useKeybinding("terminal.focusIndex2", () => dispatch("panel.focusIndex", { index: 2 }), {
    enabled: electronAvailable,
  });
  useKeybinding("terminal.focusIndex3", () => dispatch("panel.focusIndex", { index: 3 }), {
    enabled: electronAvailable,
  });
  useKeybinding("terminal.focusIndex4", () => dispatch("panel.focusIndex", { index: 4 }), {
    enabled: electronAvailable,
  });
  useKeybinding("terminal.focusIndex5", () => dispatch("panel.focusIndex", { index: 5 }), {
    enabled: electronAvailable,
  });
  useKeybinding("terminal.focusIndex6", () => dispatch("panel.focusIndex", { index: 6 }), {
    enabled: electronAvailable,
  });
  useKeybinding("terminal.focusIndex7", () => dispatch("panel.focusIndex", { index: 7 }), {
    enabled: electronAvailable,
  });
  useKeybinding("terminal.focusIndex8", () => dispatch("panel.focusIndex", { index: 8 }), {
    enabled: electronAvailable,
  });
  useKeybinding("terminal.focusIndex9", () => dispatch("panel.focusIndex", { index: 9 }), {
    enabled: electronAvailable,
  });

  // App lifecycle hooks
  useTerminalStoreBootstrap();
  useSemanticWorkerLifecycle();
  useSystemWakeHandler();

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
    return <div className="h-screen w-screen bg-canopy-bg" />;
  }

  return (
    <ErrorBoundary variant="fullscreen" componentName="App">
      <DndProvider>
        <AppLayout
          sidebarContent={<SidebarContent />}
          onLaunchAgent={handleLaunchAgent}
          onSettings={handleSettings}
          onOpenAgentSettings={handleOpenAgentSettings}
          onRetry={handleErrorRetry}
          agentAvailability={availability}
          agentSettings={agentSettings}
        >
          <ContentGrid
            className="h-full w-full"
            onLaunchAgent={handleLaunchAgent}
            agentAvailability={availability}
            isCheckingAvailability={isCheckingAvailability}
            onOpenSettings={handleOpenAgentSettings}
          />
        </AppLayout>
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
        isOpen={isWorktreePaletteOpen}
        query={worktreePaletteQuery}
        results={worktreePaletteResults}
        activeWorktreeId={activeWorktreeId}
        selectedIndex={worktreePaletteSelectedIndex}
        onQueryChange={setWorktreePaletteQuery}
        onSelectPrevious={selectPreviousWorktreeResult}
        onSelectNext={selectNextWorktreeResult}
        onSelect={(worktree) => selectWorktreeFromPalette(worktree.id)}
        onConfirm={confirmWorktreePaletteSelection}
        onClose={closeWorktreePalette}
      />

      <SettingsDialog
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        defaultTab={settingsTab}
        onSettingsChange={refreshSettings}
      />

      <ShortcutReferenceDialog isOpen={isShortcutsOpen} onClose={() => setIsShortcutsOpen(false)} />

      <TerminalInfoDialogHost />

      <Toaster />
    </ErrorBoundary>
  );
}

export default App;
