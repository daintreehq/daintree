import { Profiler, Suspense, lazy, useCallback, useEffect, useMemo, useState } from "react";
import "@xterm/xterm/css/xterm.css";
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
  useGlobalEscapeDispatcher,
  useContextInjection,
  useGridNavigation,
  useWindowNotifications,
  useWatchedPanelNotifications,
  useWorktreeActions,
  useMenuActions,
  useErrors,
  useReEntrySummary,
} from "./hooks";
import { useHibernationNotifications } from "./hooks/useHibernationNotifications";
import { useIdleTerminalNotifications } from "./hooks/useIdleTerminalNotifications";
import { useDiskSpaceWarnings } from "./hooks/useDiskSpaceWarnings";
import { useActionRegistry } from "./hooks/useActionRegistry";
import { useUpdateListener } from "./hooks/useUpdateListener";
import { useMainProcessToastListener } from "./hooks/useMainProcessToastListener";

import { useActionPalette } from "./hooks/useActionPalette";
import { useQuickSwitcher } from "./hooks/useQuickSwitcher";
import { useWorktreePalette } from "./hooks/useWorktreePalette";
import { useQuickCreatePalette } from "./hooks/useQuickCreatePalette";
import { useDoubleShift } from "./hooks/useDoubleShift";
import { useMcpBridge } from "./hooks/useMcpBridge";
import { useFileDropGuard } from "./hooks/useFileDropGuard";
import { useSoundPlaybackListener } from "./hooks/useSoundPlaybackListener";
import { removeStartupSkeleton } from "./utils/removeStartupSkeleton";
import { useCrashRecoveryGate } from "./hooks/app/useCrashRecoveryGate";
import { CrashRecoveryDialog } from "./components/Recovery/CrashRecoveryDialog";
import { SafeModeBanner } from "./components/Recovery/SafeModeBanner";
import {
  useAppHydration,
  useProjectSwitchRehydration,
  useShortcutHints,
  usePanelStoreBootstrap,
  useSemanticWorkerLifecycle,
  useSystemWakeHandler,
  useCloudSyncWarning,
  useAccessibilityAnnouncements,
  useGettingStartedChecklist,
  useOrchestrationMilestones,
  useAgentWaitingNudge,
  useUnloadCleanup,
  useHomeDir,
  usePerformanceMonitors,
  useSettingsDialog,
  useWorktreeOverview,
  useAppEventListeners,
  useErrorRetry,
  useActiveWorktreeSync,
} from "./hooks/app";
import { useResourceProfile } from "./hooks/useResourceProfile";
import { AppLayout } from "./components/Layout";
import { ContentGrid } from "./components/Terminal";
import { PanelTransitionOverlay } from "./components/Panel";
import { WorktreePalette, WorktreeOverviewModal, QuickCreatePalette } from "./components/Worktree";
import { CrossWorktreeDiff } from "./components/Worktree/CrossWorktreeDiff";

import { TerminalInfoDialogHost } from "./components/Terminal/TerminalInfoDialogHost";
import { FileViewerModalHost } from "./components/FileViewer/FileViewerModalHost";
import { NewTerminalPalette } from "./components/TerminalPalette";
import { PanelPalette } from "./components/PanelPalette/PanelPalette";
import { MORE_AGENTS_PANEL_ID } from "./hooks/usePanelPalette";
import { buildResumeCommand } from "@shared/types/agentSettings";
import { getEffectiveAgentConfig } from "@shared/config/agentRegistry";
import {
  GitInitDialog,
  CloneRepoDialog,
  ProjectOnboardingWizard,
  WelcomeScreen,
} from "./components/Project";
import { VoiceRecordingAnnouncer } from "./components/Terminal/VoiceRecordingAnnouncer";
import { AccessibilityAnnouncer } from "./components/Accessibility/AccessibilityAnnouncer";
import { CreateProjectFolderDialog } from "./components/Project/CreateProjectFolderDialog";
import { ProjectSwitcherPalette } from "./components/Project/ProjectSwitcherPalette";
import { ActionPalette } from "./components/ActionPalette";
import { QuickSwitcher } from "./components/QuickSwitcher";
import { SendToAgentPalette } from "./components/Terminal/SendToAgentPalette";
import { useSendToAgentPalette } from "./hooks/useSendToAgentPalette";
import { BulkCommandPalette } from "./components/BulkCommandCenter";
import { ConfirmDialog } from "./components/ui/ConfirmDialog";
import { PanelLimitConfirmDialog } from "./components/Terminal/PanelLimitConfirmDialog";
import { NotesPalette } from "./components/Notes";
import { ThemePalette } from "./components/ThemePalette";

function preloadSettingsDialog() {
  return import("./components/Settings/SettingsDialog");
}
const LazySettingsDialog = lazy(() =>
  preloadSettingsDialog().then((m) => ({ default: m.SettingsDialog }))
);

import { ShortcutReferenceDialog } from "./components/KeyboardShortcuts";
import { Toaster } from "./components/ui/toaster";
import { ShortcutHint } from "./components/ui/ShortcutHint";
import { ReEntrySummary } from "./components/ui/ReEntrySummary";
import { OnboardingFlow } from "./components/Onboarding/OnboardingFlow";
import { GettingStartedChecklist } from "./components/Onboarding/GettingStartedChecklist";
import { CelebrationConfetti } from "./components/Onboarding/CelebrationConfetti";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { DndProvider } from "./components/DragDrop";
import {
  usePanelStore,
  useWorktreeSelectionStore,
  useProjectStore,
  useErrorStore,
  useAgentPreferencesStore,
  usePaletteStore,
  useNotificationSettingsStore,
} from "./store";
import { isAgentReady } from "../shared/utils/agentAvailability";
import { useShallow } from "zustand/react/shallow";
import { useMacroFocusStore } from "./store/macroFocusStore";
import { useSafeModeStore } from "./store/safeModeStore";
import type { PanelKind } from "./types";
import type { TerminalType } from "@shared/types";
import { BUILT_IN_AGENT_IDS } from "@shared/config/agentIds";
import { actionService } from "./services/ActionService";
import { voiceRecordingService } from "./services/VoiceRecordingService";
import { terminalInstanceService } from "./services/terminal/TerminalInstanceService";
import { SIDEBAR_TOGGLE_LOCK_MS } from "./lib/terminalLayout";
import { useRenderProfiler } from "./utils/renderProfiler";

import { SidebarContent, preloadNewWorktreeDialog, E2EFaultInjector } from "./components/Sidebar";

function App() {
  useErrors();
  useHibernationNotifications();
  useIdleTerminalNotifications();
  useDiskSpaceWarnings();
  useUnloadCleanup();
  useResourceProfile();

  useEffect(() => {
    window.__DAINTREE_E2E_ERROR_STORE__ = () =>
      useErrorStore.getState().errors.map((e) => ({
        id: e.id,
        source: e.source,
        message: e.message,
        fromPreviousSession: e.fromPreviousSession,
      }));
    window.__DAINTREE_E2E_ADD_ERROR__ = (message: string) => {
      useErrorStore.getState().addError({
        type: "unknown",
        message,
        isTransient: false,
        source: "e2e-test",
      });
    };
    window.__DAINTREE_E2E_CLEAR_ERRORS__ = () => {
      useErrorStore.getState().clearAll();
    };
    return () => {
      delete window.__DAINTREE_E2E_ERROR_STORE__;
      delete window.__DAINTREE_E2E_ADD_ERROR__;
      delete window.__DAINTREE_E2E_CLEAR_ERRORS__;
    };
  }, []);

  const { crossDiffDialog, closeCrossWorktreeDiff } = useWorktreeSelectionStore(
    useShallow((state) => ({
      crossDiffDialog: state.crossDiffDialog,
      closeCrossWorktreeDiff: state.closeCrossWorktreeDiff,
    }))
  );

  const { focusedId, addPanel } = usePanelStore(
    useShallow((state) => ({
      focusedId: state.focusedId,
      addPanel: state.addPanel,
    }))
  );

  const { launchAgent, availability, agentSettings, refreshSettings } = useAgentLauncher();

  const hasAnySelectedAgent = useMemo(() => {
    if (agentSettings === null) return null;
    const agents = agentSettings.agents ?? {};
    return BUILT_IN_AGENT_IDS.some((id) => agents[id]?.pinned === true);
  }, [agentSettings]);

  useTerminalConfig();
  useAppThemeConfig();
  useWindowNotifications();
  useWatchedPanelNotifications();
  const reEntrySummary = useReEntrySummary();
  useMainProcessToastListener();

  useMcpBridge();
  useSoundPlaybackListener();
  const { homeDir } = useHomeDir();

  // Grid navigation hook for directional terminal switching
  const { findNearest, findByIndex, findDockByIndex, getCurrentLocation } = useGridNavigation();

  const { worktrees, worktreeMap } = useWorktrees();
  const newTerminalPalette = useNewTerminalPalette({ launchAgent, worktreeMap });
  const panelPalette = usePanelPalette();
  const projectSwitcherPalette = useProjectSwitcherPalette();
  const actionPalette = useActionPalette();
  const quickSwitcher = useQuickSwitcher();
  const sendToAgentPalette = useSendToAgentPalette();
  useDoubleShift(actionPalette.toggle);
  const currentProject = useProjectStore((state) => state.currentProject);
  const gitInitDialogOpen = useProjectStore((state) => state.gitInitDialogOpen);
  const gitInitDirectoryPath = useProjectStore((state) => state.gitInitDirectoryPath);
  const closeGitInitDialog = useProjectStore((state) => state.closeGitInitDialog);
  const handleGitInitSuccess = useProjectStore((state) => state.handleGitInitSuccess);
  const onboardingWizardOpen = useProjectStore((state) => state.onboardingWizardOpen);
  const onboardingProjectId = useProjectStore((state) => state.onboardingProjectId);
  const closeOnboardingWizard = useProjectStore((state) => state.closeOnboardingWizard);
  const switchProject = useProjectStore((state) => state.switchProject);

  const createFolderDialogOpen = useProjectStore((state) => state.createFolderDialogOpen);
  const closeCreateFolderDialog = useProjectStore((state) => state.closeCreateFolderDialog);

  const cloneRepoDialogOpen = useProjectStore((state) => state.cloneRepoDialogOpen);
  const closeCloneRepoDialog = useProjectStore((state) => state.closeCloneRepoDialog);
  const handleCloneSuccess = useProjectStore((state) => state.handleCloneSuccess);
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
  const [hasOpenedSettings, setHasOpenedSettings] = useState(false);
  useEffect(() => {
    if (isSettingsOpen) setHasOpenedSettings(true);
  }, [isSettingsOpen]);
  const [isShortcutsOpen, setIsShortcutsOpen] = useState(false);
  const isNotesPaletteOpen = usePaletteStore((state) => state.activePaletteId === "notes");
  const isThemePaletteOpen = usePaletteStore((state) => state.activePaletteId === "theme");
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
  useEffect(() => {
    if (isStateLoaded) removeStartupSkeleton();
  }, [isStateLoaded]);
  useEffect(() => {
    useNotificationSettingsStore.getState().hydrate();
  }, []);
  useProjectSwitchRehydration();
  useShortcutHints(isStateLoaded);
  const gettingStarted = useGettingStartedChecklist(isStateLoaded);
  const onboardingOverlayActive = gettingStarted.visible || gettingStarted.showCelebration;
  useUpdateListener(onboardingOverlayActive);
  useOrchestrationMilestones(isStateLoaded);
  useAgentWaitingNudge(isStateLoaded);

  useEffect(() => {
    if (!isStateLoaded) return;
    const id = requestIdleCallback(
      () => {
        preloadSettingsDialog();
        preloadNewWorktreeDialog();
      },
      { timeout: 5000 }
    );
    return () => cancelIdleCallback(id);
  }, [isStateLoaded]);

  const handlePreloadSettings = useCallback(() => {
    preloadSettingsDialog();
  }, []);

  const handleLaunchAgent = useCallback(
    async (type: string) => {
      await launchAgent(type);
    },
    [launchAgent]
  );

  const handleWizardFinish = useCallback(
    (finishedProjectId: string) => {
      // Switch to the newly-onboarded project. Opening the wizard on the
      // current view (rather than pre-switching) avoids stranding it in a
      // throttled background view; we complete the switch here instead.
      if (finishedProjectId && finishedProjectId !== currentProject?.id) {
        void switchProject(finishedProjectId);
      }

      // In e2e mode, skip the automatic primary-agent launch — it leaves an
      // extra panel in the grid that breaks panel-count assertions in tests
      // that expect a clean post-onboarding state. The behaviour is locally
      // observable only when an agent CLI (e.g., Claude) is installed, so
      // tests pass on CI but fail on dev machines without this guard.
      if (typeof window !== "undefined" && window.__DAINTREE_E2E_MODE__) {
        return;
      }

      const defaultAgent = useAgentPreferencesStore.getState().defaultAgent;
      const selected = agentSettings?.agents
        ? Object.entries(agentSettings.agents)
            .filter(([, entry]) => entry.pinned === true)
            .map(([id]) => id)
        : [];
      const primaryAgent = defaultAgent ?? selected[0];

      if (primaryAgent && isAgentReady(availability[primaryAgent])) {
        launchAgent(primaryAgent, {
          worktreeId: activeWorktreeId ?? undefined,
        }).catch(() => {});
      }
    },
    [launchAgent, activeWorktreeId, availability, agentSettings, switchProject, currentProject?.id]
  );

  const closeNotesPalette = useCallback(() => {
    usePaletteStore.getState().closePalette("notes");
  }, []);

  const closeThemePalette = useCallback(() => {
    usePaletteStore.getState().closePalette("theme");
  }, []);

  const overviewWorktreeActions = useWorktreeActions({ launchAgent });

  useAppEventListeners();

  const { handleErrorRetry, handleCancelRetry } = useErrorRetry();

  const electronAvailable = isElectronAvailable();
  const { inject } = useContextInjection();

  const handleToggleSidebar = useCallback(() => {
    const activeWtId = useWorktreeSelectionStore.getState().activeWorktreeId;
    const storeState = usePanelStore.getState();
    const gridIds: string[] = [];
    for (const id of storeState.panelIds) {
      const t = storeState.panelsById[id];
      if (t && t.location !== "dock" && t.worktreeId === activeWtId) {
        gridIds.push(t.id);
      }
    }
    terminalInstanceService.suppressResizesDuringLayoutTransition(gridIds, SIDEBAR_TOGGLE_LOCK_MS);
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
    onAddTerminal: async (options) => {
      await usePanelStore.getState().addPanel(options);
    },
    getDefaultCwd: () => defaultTerminalCwd,
    getActiveWorktreeId: () => activeWorktree?.id,
    getWorktrees: () => worktrees,
    getFocusedId: () => focusedId,
    getIsSettingsOpen: () => isSettingsOpen,
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
  useGlobalEscapeDispatcher();

  // App lifecycle hooks
  usePanelStoreBootstrap();
  useSemanticWorkerLifecycle();
  useSystemWakeHandler();
  useCloudSyncWarning(homeDir);
  useAccessibilityAnnouncements();

  useEffect(() => {
    voiceRecordingService.initialize();
  }, []);

  useFileDropGuard();

  const isSafeMode = useSafeModeStore((s) => s.safeMode);

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
      <E2EFaultInjector />
      {isSafeMode && <SafeModeBanner />}
      <DndProvider>
        <VoiceRecordingAnnouncer />
        <AccessibilityAnnouncer />
        <Profiler id="app-layout" onRender={onLayoutRender}>
          <AppLayout
            sidebarContent={<SidebarContent onOpenOverview={openWorktreeOverview} />}
            onLaunchAgent={handleLaunchAgent}
            onSettings={handleSettings}
            onPreloadSettings={handlePreloadSettings}
            onRetry={handleErrorRetry}
            onCancelRetry={handleCancelRetry}
            agentAvailability={availability}
            agentSettings={agentSettings}
            isHydrated={isStateLoaded}
            projectSwitcherPalette={projectSwitcherPalette}
          >
            <Profiler id="content-grid" onRender={onContentGridRender}>
              <ContentGrid
                className="h-full w-full"
                agentAvailability={availability}
                defaultCwd={defaultTerminalCwd}
                emptyContent={
                  currentProject === null ? (
                    <WelcomeScreen gettingStarted={gettingStarted} />
                  ) : undefined
                }
              />
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
      <SendToAgentPalette
        isOpen={sendToAgentPalette.isOpen}
        query={sendToAgentPalette.query}
        results={sendToAgentPalette.results}
        totalResults={sendToAgentPalette.totalResults}
        selectedIndex={sendToAgentPalette.selectedIndex}
        close={sendToAgentPalette.close}
        setQuery={sendToAgentPalette.setQuery}
        selectPrevious={sendToAgentPalette.selectPrevious}
        selectNext={sendToAgentPalette.selectNext}
        selectItem={sendToAgentPalette.selectItem}
        confirmSelection={sendToAgentPalette.confirmSelection}
      />
      <BulkCommandPalette />
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
        query={panelPalette.query}
        results={panelPalette.results}
        totalResults={panelPalette.totalResults}
        selectedIndex={panelPalette.selectedIndex}
        matchesById={panelPalette.matchesById}
        onQueryChange={panelPalette.setQuery}
        onSelectPrevious={panelPalette.selectPrevious}
        onSelectNext={panelPalette.selectNext}
        onSelect={(kind) => {
          const result = panelPalette.handleSelect(kind);
          if (!result) return;
          if (result.resumeSession) {
            const session = result.resumeSession;
            const agentConfig = getEffectiveAgentConfig(session.agentId);
            const command = buildResumeCommand(
              session.agentId,
              session.sessionId,
              session.agentLaunchFlags
            );
            if (command && agentConfig) {
              addPanel({
                kind: "agent",
                type: session.agentId as TerminalType,
                agentId: session.agentId,
                title: agentConfig.name,
                cwd: defaultTerminalCwd,
                worktreeId: activeWorktreeId ?? undefined,
                command,
                location: "grid",
              });
            }
          } else if (result.id.startsWith("agent:")) {
            const agentId = result.id.slice("agent:".length);
            if (agentId) {
              launchAgent(agentId);
            }
          } else {
            addPanel({
              kind: result.id as PanelKind,
              cwd: defaultTerminalCwd,
              worktreeId: activeWorktreeId ?? undefined,
              location: "grid",
            });
          }
        }}
        onConfirm={() => {
          const selected = panelPalette.confirmSelection();
          if (!selected) return;
          if (selected.id === MORE_AGENTS_PANEL_ID) return;
          if (selected.resumeSession) {
            const session = selected.resumeSession;
            const agentConfig = getEffectiveAgentConfig(session.agentId);
            const command = buildResumeCommand(
              session.agentId,
              session.sessionId,
              session.agentLaunchFlags
            );
            if (command && agentConfig) {
              addPanel({
                kind: "agent",
                type: session.agentId as TerminalType,
                agentId: session.agentId,
                title: agentConfig.name,
                cwd: defaultTerminalCwd,
                worktreeId: activeWorktreeId ?? undefined,
                command,
                location: "grid",
              });
            }
          } else if (selected.id.startsWith("agent:")) {
            const agentId = selected.id.slice("agent:".length);
            if (agentId) {
              launchAgent(agentId);
            }
          } else {
            addPanel({
              kind: selected.id as PanelKind,
              cwd: defaultTerminalCwd,
              worktreeId: activeWorktreeId ?? undefined,
              location: "grid",
            });
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
        onSelectNewWindow={(project) => {
          projectSwitcherPalette.close();
          void actionService.dispatch(
            "app.newWindow",
            { projectPath: project.path },
            { source: "user" }
          );
        }}
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

      <ThemePalette isOpen={isThemePaletteOpen} onClose={closeThemePalette} />

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

      {(isSettingsOpen || hasOpenedSettings) && (
        <Suspense fallback={null}>
          <LazySettingsDialog
            isOpen={isSettingsOpen}
            onClose={() => setIsSettingsOpen(false)}
            defaultTab={settingsTab}
            defaultSubtab={settingsSubtab}
            defaultSectionId={settingsSectionId}
            onSettingsChange={refreshSettings}
            projectId={currentProject?.id ?? null}
          />
        </Suspense>
      )}

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

      <CloneRepoDialog
        isOpen={cloneRepoDialogOpen}
        onSuccess={handleCloneSuccess}
        onCancel={closeCloneRepoDialog}
      />

      <PanelTransitionOverlay />
      <PanelLimitConfirmDialog />

      <Toaster />
      <ShortcutHint />
      <ReEntrySummary state={reEntrySummary} />
      <OnboardingFlow
        availability={availability}
        onRefreshSettings={refreshSettings}
        hasAnySelectedAgent={hasAnySelectedAgent}
        onComplete={gettingStarted.notifyOnboardingComplete}
      />
      {currentProject !== null && gettingStarted.visible && gettingStarted.checklist && (
        <GettingStartedChecklist
          checklist={gettingStarted.checklist}
          collapsed={gettingStarted.collapsed}
          onDismiss={gettingStarted.dismiss}
          onToggleCollapse={gettingStarted.toggleCollapse}
          onMarkItem={gettingStarted.markItem}
        />
      )}
      {gettingStarted.showCelebration && <CelebrationConfetti />}
    </ErrorBoundary>
  );
}

export default App;
