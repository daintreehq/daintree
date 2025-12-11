import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { hydrateAppState } from "./utils/stateHydration";
import { semanticAnalysisService } from "./services/SemanticAnalysisService";
import "@xterm/xterm/css/xterm.css";
import { FolderOpen } from "lucide-react";
import { shouldShowFirstRunToast, markFirstRunToastSeen } from "./lib/firstRunToast";
import { keybindingService } from "./services/KeybindingService";
import { Kbd } from "./components/ui/Kbd";
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
} from "./hooks";
import { AppLayout } from "./components/Layout";
import { TerminalGrid } from "./components/Terminal";
import { WorktreeCard, WorktreePalette } from "./components/Worktree";
import { NewWorktreeDialog } from "./components/Worktree/NewWorktreeDialog";
import { TerminalPalette, NewTerminalPalette } from "./components/TerminalPalette";
import { RecipeEditor } from "./components/TerminalRecipe/RecipeEditor";
import { SettingsDialog } from "./components/Settings";
import { ShortcutReferenceDialog } from "./components/KeyboardShortcuts";
import { Toaster } from "./components/ui/toaster";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { DndProvider } from "./components/DragDrop";
import {
  useTerminalStore,
  useWorktreeSelectionStore,
  useProjectStore,
  useErrorStore,
  useNotificationStore,
  useDiagnosticsStore,
  cleanupWorktreeDataStore,
  type RetryAction,
} from "./store";
import { useShallow } from "zustand/react/shallow";
import { useRecipeStore } from "./store/recipeStore";
import { setupTerminalStoreListeners } from "./store/terminalStore";
import type { RecipeTerminal } from "./types";
import { systemClient, projectClient, errorsClient, worktreeClient } from "@/clients";

function SidebarContent() {
  const { worktrees, isLoading, error, refresh } = useWorktrees();
  const { settings: projectSettings } = useProjectSettings();
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
    if (worktrees.length > 0 && !activeWorktreeId) {
      setActiveWorktree(worktrees[0].id);
    }
  }, [worktrees, activeWorktreeId, setActiveWorktree]);

  const handleOpenRecipeEditor = useCallback(
    (worktreeId: string, initialTerminals?: RecipeTerminal[]) => {
      setRecipeEditorWorktreeId(worktreeId);
      setRecipeEditorInitialTerminals(initialTerminals);
      setIsRecipeEditorOpen(true);
    },
    []
  );

  const worktreeActions = useWorktreeActions({
    projectSettings: projectSettings ?? undefined,
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
      <div className="p-4">
        <h2 className="text-canopy-text font-semibold text-sm mb-4">Worktrees</h2>
        <div className="text-canopy-text/60 text-sm">Loading worktrees...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-4">
        <h2 className="text-canopy-text font-semibold text-sm mb-4">Worktrees</h2>
        <div className="text-[var(--color-status-error)] text-sm mb-2">{error}</div>
        <button
          onClick={refresh}
          className="text-xs px-2 py-1 border border-canopy-border rounded hover:bg-canopy-border text-canopy-text"
        >
          Retry
        </button>
      </div>
    );
  }

  if (worktrees.length === 0) {
    return (
      <div className="p-4">
        <h2 className="text-canopy-text font-semibold text-sm mb-4">Worktrees</h2>

        <div className="flex flex-col items-center justify-center py-12 px-4 text-center">
          <FolderOpen className="w-12 h-12 text-canopy-text/60 mb-3" aria-hidden="true" />

          <h3 className="text-canopy-text font-medium mb-2">No worktrees yet</h3>

          <p className="text-sm text-canopy-text/60 mb-4 max-w-xs">
            Open a Git repository with worktrees to get started. Use{" "}
            <kbd className="px-1.5 py-0.5 bg-canopy-border rounded text-xs">
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

  return (
    <div className="flex flex-col h-full">
      {/* Header Section */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-canopy-border bg-canopy-sidebar shrink-0">
        <h2 className="text-canopy-text font-semibold text-sm tracking-wide">Worktrees</h2>
        <button
          onClick={() => openCreateDialog()}
          className="flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 text-canopy-text/60 hover:text-canopy-text hover:bg-canopy-border/50 rounded transition-colors"
          title="Create new worktree"
        >
          <span className="text-[10px]">+</span> New
        </button>
      </div>

      {/* List Section - Flat list with borders */}
      <div className="flex-1 overflow-y-auto">
        <div className="flex flex-col">
          {worktrees.map((worktree) => (
            <WorktreeCard
              key={worktree.id}
              worktree={worktree}
              isActive={worktree.id === activeWorktreeId}
              isFocused={worktree.id === focusedWorktreeId}
              onSelect={() => selectWorktree(worktree.id)}
              onCopyTree={() => worktreeActions.handleCopyTree(worktree)}
              onOpenEditor={() => worktreeActions.handleOpenEditor(worktree)}
              onToggleServer={() => worktreeActions.handleToggleServer(worktree)}
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
              devServerSettings={projectSettings?.devServer}
            />
          ))}
        </div>
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
  const {
    focusNext,
    focusPrevious,
    focusDirection,
    focusByIndex,
    focusDockDirection,
    focusNextWaiting,
    toggleMaximize,
    focusedId,
    addTerminal,
    reorderTerminals,
    moveTerminalToDock,
    moveTerminalToGrid,
    trashTerminal,
    bulkTrashAll,
    bulkRestartAll,
    bulkMoveToDock,
    bulkMoveToGrid,
    restoreLastTrashed,
    isInTrash,
  } = useTerminalStore(
    useShallow((state) => ({
      focusNext: state.focusNext,
      focusPrevious: state.focusPrevious,
      focusDirection: state.focusDirection,
      focusByIndex: state.focusByIndex,
      focusDockDirection: state.focusDockDirection,
      focusNextWaiting: state.focusNextWaiting,
      toggleMaximize: state.toggleMaximize,
      focusedId: state.focusedId,
      addTerminal: state.addTerminal,
      reorderTerminals: state.reorderTerminals,
      moveTerminalToDock: state.moveTerminalToDock,
      moveTerminalToGrid: state.moveTerminalToGrid,
      trashTerminal: state.trashTerminal,
      bulkTrashAll: state.bulkTrashAll,
      bulkRestartAll: state.bulkRestartAll,
      bulkMoveToDock: state.bulkMoveToDock,
      bulkMoveToGrid: state.bulkMoveToGrid,
      restoreLastTrashed: state.restoreLastTrashed,
      isInTrash: state.isInTrash,
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
  const terminals = useTerminalStore(useShallow((state) => state.terminals));
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
  const toggleDiagnosticsDock = useDiagnosticsStore((state) => state.toggleDock);
  const removeError = useErrorStore((state) => state.removeError);

  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<"general" | "agents" | "troubleshooting">(
    "general"
  );
  const [isShortcutsOpen, setIsShortcutsOpen] = useState(false);
  const [isStateLoaded, setIsStateLoaded] = useState(false);

  const hasRestoredState = useRef(false);

  useEffect(() => {
    if (!isElectronAvailable() || hasRestoredState.current) {
      return;
    }

    hasRestoredState.current = true;

    const restoreState = async () => {
      try {
        await hydrateAppState({
          addTerminal,
          setActiveWorktree,
          loadRecipes,
          openDiagnosticsDock,
        });
      } catch (error) {
        console.error("Failed to restore app state:", error);
      } finally {
        setIsStateLoaded(true);
      }
    };

    restoreState();
  }, [addTerminal, setActiveWorktree, loadRecipes, openDiagnosticsDock]);

  const addNotification = useNotificationStore((state) => state.addNotification);

  useEffect(() => {
    if (!isElectronAvailable() || !isStateLoaded) {
      return;
    }

    if (shouldShowFirstRunToast()) {
      markFirstRunToastSeen();

      const shortcuts = [
        { id: "terminal.palette", label: "switch terminals" },
        { id: "terminal.new", label: "new terminal" },
        { id: "worktree.openPalette", label: "worktrees" },
      ];

      const shortcutElements = shortcuts.map(({ id, label }, index) => {
        const combo = keybindingService.getDisplayCombo(id);
        return (
          <span key={id}>
            <Kbd>{combo}</Kbd> ({label}){index < shortcuts.length - 1 ? ", " : ""}
          </span>
        );
      });

      addNotification({
        type: "info",
        title: "Quick Shortcuts",
        message: <div className="flex flex-wrap gap-x-1">{shortcutElements}</div>,
        duration: 9000,
      });
    }
  }, [isStateLoaded, addNotification]);

  useEffect(() => {
    if (!isElectronAvailable()) {
      return;
    }

    const handleProjectSwitch = async () => {
      console.log("[App] Received project-switched event, re-hydrating state...");
      try {
        await hydrateAppState({
          addTerminal,
          setActiveWorktree,
          loadRecipes,
          openDiagnosticsDock,
        });
        console.log("[App] State re-hydration complete");
      } catch (error) {
        console.error("[App] Failed to re-hydrate state after project switch:", error);
      }
    };

    window.addEventListener("project-switched", handleProjectSwitch);

    const cleanup = projectClient.onSwitch(() => {
      console.log("[App] Received PROJECT_ON_SWITCH from main process, re-hydrating...");
      window.dispatchEvent(new CustomEvent("project-switched"));
    });

    return () => {
      window.removeEventListener("project-switched", handleProjectSwitch);
      cleanup();
    };
  }, [addTerminal, setActiveWorktree, loadRecipes, openDiagnosticsDock]);

  const handleLaunchAgent = useCallback(
    async (type: "claude" | "gemini" | "codex" | "terminal") => {
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

  useKeybinding("terminal.palette", () => terminalPalette.toggle(), { enabled: electronAvailable });
  useKeybinding("agent.palette", () => terminalPalette.open(), { enabled: electronAvailable });
  useKeybinding(
    "terminal.new",
    () => {
      const worktreeId = activeWorktree?.id;
      addTerminal({ type: "terminal", cwd: defaultTerminalCwd, worktreeId }).catch((error) => {
        console.error("Failed to create terminal:", error);
      });
    },
    { enabled: electronAvailable }
  );
  useKeybinding("terminal.spawnPalette", () => newTerminalPalette.open(), {
    enabled: electronAvailable,
  });

  useKeybinding(
    "terminal.close",
    () => {
      const targetId = focusedId ?? terminals.find((t) => t.location !== "trash")?.id ?? null;

      if (!targetId) return;
      useTerminalStore.getState().trashTerminal(targetId);
    },
    { enabled: electronAvailable }
  );

  useKeybinding(
    "terminal.reopenLast",
    () => {
      restoreLastTrashed();
    },
    { enabled: electronAvailable }
  );

  useKeybinding("terminal.focusNext", () => focusNext(), { enabled: electronAvailable });
  useKeybinding("terminal.focusPrevious", () => focusPrevious(), { enabled: electronAvailable });
  useKeybinding(
    "terminal.maximize",
    () => {
      if (focusedId) toggleMaximize(focusedId);
    },
    { enabled: electronAvailable && !!focusedId }
  );

  useKeybinding("agent.claude", () => handleLaunchAgent("claude"), { enabled: electronAvailable });
  useKeybinding("agent.gemini", () => handleLaunchAgent("gemini"), { enabled: electronAvailable });
  useKeybinding("agent.codex", () => handleLaunchAgent("codex"), { enabled: electronAvailable });
  useKeybinding("agent.terminal", () => handleLaunchAgent("terminal"), {
    enabled: electronAvailable,
  });
  useKeybinding("agent.focusNextWaiting", () => focusNextWaiting(isInTrash), {
    enabled: electronAvailable,
  });

  useKeybinding(
    "terminal.moveLeft",
    () => {
      if (!focusedId) return;
      const gridTerminals = terminals.filter(
        (t) => t.location === "grid" || t.location === undefined
      );
      const currentIndex = gridTerminals.findIndex((t) => t.id === focusedId);
      if (currentIndex > 0) {
        reorderTerminals(currentIndex, currentIndex - 1, "grid");
      }
    },
    { enabled: electronAvailable && !!focusedId }
  );
  useKeybinding(
    "terminal.moveRight",
    () => {
      if (!focusedId) return;
      const gridTerminals = terminals.filter(
        (t) => t.location === "grid" || t.location === undefined
      );
      const currentIndex = gridTerminals.findIndex((t) => t.id === focusedId);
      if (currentIndex >= 0 && currentIndex < gridTerminals.length - 1) {
        reorderTerminals(currentIndex, currentIndex + 1, "grid");
      }
    },
    { enabled: electronAvailable && !!focusedId }
  );

  // Terminal dock operations
  useKeybinding(
    "terminal.minimize",
    () => {
      if (focusedId) moveTerminalToDock(focusedId);
    },
    { enabled: electronAvailable && !!focusedId }
  );
  useKeybinding(
    "terminal.restore",
    () => {
      const dockTerminals = terminals.filter((t) => t.location === "dock");
      if (dockTerminals.length > 0) {
        moveTerminalToGrid(dockTerminals[0].id);
      }
    },
    { enabled: electronAvailable }
  );

  // Terminal bulk operations
  useKeybinding("terminal.closeAll", () => bulkTrashAll(), { enabled: electronAvailable });
  useKeybinding(
    "terminal.killAll",
    () => {
      terminals.forEach((t) => {
        if (t.location !== "trash") trashTerminal(t.id);
      });
    },
    { enabled: electronAvailable }
  );
  useKeybinding("terminal.restartAll", () => bulkRestartAll(), { enabled: electronAvailable });
  useKeybinding("terminal.minimizeAll", () => bulkMoveToDock(), { enabled: electronAvailable });
  useKeybinding("terminal.restoreAll", () => bulkMoveToGrid(), { enabled: electronAvailable });

  // Panel management
  useKeybinding("panel.diagnosticsLogs", () => openDiagnosticsDock("logs"), {
    enabled: electronAvailable,
  });
  useKeybinding("panel.diagnosticsEvents", () => openDiagnosticsDock("events"), {
    enabled: electronAvailable,
  });
  useKeybinding("panel.diagnosticsMessages", () => openDiagnosticsDock("problems"), {
    enabled: electronAvailable,
  });
  useKeybinding("panel.toggleDiagnostics", () => toggleDiagnosticsDock(), {
    enabled: electronAvailable,
  });
  useKeybinding(
    "panel.toggleDock",
    () => {
      window.dispatchEvent(new CustomEvent("canopy:toggle-terminal-dock"));
    },
    { enabled: electronAvailable }
  );
  useKeybinding(
    "panel.toggleDockAlt",
    () => {
      window.dispatchEvent(new CustomEvent("canopy:toggle-terminal-dock"));
    },
    { enabled: electronAvailable }
  );
  useKeybinding(
    "panel.toggleSidecar",
    () => {
      window.dispatchEvent(new CustomEvent("canopy:toggle-sidecar"));
    },
    { enabled: electronAvailable }
  );

  // Navigation
  useKeybinding(
    "nav.toggleSidebar",
    () => {
      window.dispatchEvent(new CustomEvent("canopy:toggle-focus-mode"));
    },
    { enabled: electronAvailable }
  );

  useKeybinding(
    "terminal.inject",
    () => {
      if (activeWorktreeId) {
        inject(activeWorktreeId);
      }
    },
    { enabled: electronAvailable && !!activeWorktreeId }
  );

  useKeybinding("worktree.switch1", () => worktrees[0] && selectWorktree(worktrees[0].id), {
    enabled: electronAvailable && worktrees.length >= 1,
  });
  useKeybinding("worktree.switch2", () => worktrees[1] && selectWorktree(worktrees[1].id), {
    enabled: electronAvailable && worktrees.length >= 2,
  });
  useKeybinding("worktree.switch3", () => worktrees[2] && selectWorktree(worktrees[2].id), {
    enabled: electronAvailable && worktrees.length >= 3,
  });
  useKeybinding("worktree.switch4", () => worktrees[3] && selectWorktree(worktrees[3].id), {
    enabled: electronAvailable && worktrees.length >= 4,
  });
  useKeybinding("worktree.switch5", () => worktrees[4] && selectWorktree(worktrees[4].id), {
    enabled: electronAvailable && worktrees.length >= 5,
  });
  useKeybinding("worktree.switch6", () => worktrees[5] && selectWorktree(worktrees[5].id), {
    enabled: electronAvailable && worktrees.length >= 6,
  });
  useKeybinding("worktree.switch7", () => worktrees[6] && selectWorktree(worktrees[6].id), {
    enabled: electronAvailable && worktrees.length >= 7,
  });
  useKeybinding("worktree.switch8", () => worktrees[7] && selectWorktree(worktrees[7].id), {
    enabled: electronAvailable && worktrees.length >= 8,
  });
  useKeybinding("worktree.switch9", () => worktrees[8] && selectWorktree(worktrees[8].id), {
    enabled: electronAvailable && worktrees.length >= 9,
  });

  useKeybinding(
    "worktree.next",
    () => {
      if (worktrees.length === 0) return;
      const currentIndex = activeWorktreeId
        ? worktrees.findIndex((w) => w.id === activeWorktreeId)
        : -1;
      const nextIndex = currentIndex === -1 ? 0 : (currentIndex + 1) % worktrees.length;
      selectWorktree(worktrees[nextIndex].id);
    },
    { enabled: electronAvailable && worktrees.length > 1 }
  );

  useKeybinding(
    "worktree.previous",
    () => {
      if (worktrees.length === 0) return;
      const currentIndex = activeWorktreeId
        ? worktrees.findIndex((w) => w.id === activeWorktreeId)
        : -1;
      const prevIndex =
        currentIndex === -1 ? 0 : (currentIndex - 1 + worktrees.length) % worktrees.length;
      selectWorktree(worktrees[prevIndex].id);
    },
    { enabled: electronAvailable && worktrees.length > 1 }
  );
  useKeybinding("worktree.openPalette", () => openWorktreePalette(), {
    enabled: electronAvailable,
  });

  // Help and settings
  useKeybinding("help.shortcuts", () => setIsShortcutsOpen(true), { enabled: electronAvailable });
  useKeybinding("help.shortcutsAlt", () => setIsShortcutsOpen(true), {
    enabled: electronAvailable,
  });
  useKeybinding("app.settings", () => handleSettings(), { enabled: electronAvailable });

  // Directional terminal navigation (Ctrl+Alt+Arrow keys)
  useKeybinding(
    "terminal.focusUp",
    () => {
      const location = getCurrentLocation();
      if (location === "grid") {
        focusDirection("up", findNearest);
      }
    },
    { enabled: electronAvailable && !!focusedId }
  );
  useKeybinding(
    "terminal.focusDown",
    () => {
      const location = getCurrentLocation();
      if (location === "grid") {
        focusDirection("down", findNearest);
      }
    },
    { enabled: electronAvailable && !!focusedId }
  );
  useKeybinding(
    "terminal.focusLeft",
    () => {
      const location = getCurrentLocation();
      if (location === "grid") {
        focusDirection("left", findNearest);
      } else if (location === "dock") {
        focusDockDirection("left", findDockByIndex);
      }
    },
    { enabled: electronAvailable && !!focusedId }
  );
  useKeybinding(
    "terminal.focusRight",
    () => {
      const location = getCurrentLocation();
      if (location === "grid") {
        focusDirection("right", findNearest);
      } else if (location === "dock") {
        focusDockDirection("right", findDockByIndex);
      }
    },
    { enabled: electronAvailable && !!focusedId }
  );

  // Index-based terminal navigation (Cmd+1-9)
  useKeybinding("terminal.focusIndex1", () => focusByIndex(1, findByIndex), {
    enabled: electronAvailable,
  });
  useKeybinding("terminal.focusIndex2", () => focusByIndex(2, findByIndex), {
    enabled: electronAvailable,
  });
  useKeybinding("terminal.focusIndex3", () => focusByIndex(3, findByIndex), {
    enabled: electronAvailable,
  });
  useKeybinding("terminal.focusIndex4", () => focusByIndex(4, findByIndex), {
    enabled: electronAvailable,
  });
  useKeybinding("terminal.focusIndex5", () => focusByIndex(5, findByIndex), {
    enabled: electronAvailable,
  });
  useKeybinding("terminal.focusIndex6", () => focusByIndex(6, findByIndex), {
    enabled: electronAvailable,
  });
  useKeybinding("terminal.focusIndex7", () => focusByIndex(7, findByIndex), {
    enabled: electronAvailable,
  });
  useKeybinding("terminal.focusIndex8", () => focusByIndex(8, findByIndex), {
    enabled: electronAvailable,
  });
  useKeybinding("terminal.focusIndex9", () => focusByIndex(9, findByIndex), {
    enabled: electronAvailable,
  });

  useEffect(() => {
    if (!electronAvailable) return;
    const cleanup = setupTerminalStoreListeners();
    return cleanup;
  }, [electronAvailable]);

  // Initialize semantic analysis Web Worker
  useEffect(() => {
    if (!electronAvailable) return;

    semanticAnalysisService.initialize().catch((error) => {
      console.warn("[App] Failed to initialize semantic analysis service:", error);
    });

    return () => {
      semanticAnalysisService.dispose();
    };
  }, [electronAvailable]);

  // Handle system wake events for renderer-side re-hydration
  useEffect(() => {
    if (!electronAvailable) return;

    const cleanup = systemClient.onWake(({ sleepDuration }) => {
      console.log(`[App] System woke after ${Math.round(sleepDuration / 1000)}s sleep`);

      // Dispatch event to notify terminal components to refresh WebGL contexts
      window.dispatchEvent(new CustomEvent("canopy:system-wake"));

      // If sleep was long (>5min), refresh worktree status
      const LONG_SLEEP_THRESHOLD_MS = 5 * 60 * 1000;
      if (sleepDuration > LONG_SLEEP_THRESHOLD_MS) {
        console.log("[App] Long sleep detected, refreshing worktree status");
        worktreeClient.refresh().catch((err) => {
          console.warn("[App] Failed to refresh worktrees after wake:", err);
        });
      }
    });

    return cleanup;
  }, [electronAvailable]);

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
          <TerminalGrid
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

      <Toaster />
    </ErrorBoundary>
  );
}

export default App;
