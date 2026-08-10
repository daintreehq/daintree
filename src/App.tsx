import { Profiler, Suspense, useCallback, useEffect, useRef, useState } from "react";
import "@xterm/xterm/css/xterm.css";
import { isElectronAvailable } from "@/hooks/useElectron";
import { useAgentLauncher } from "@/hooks/useAgentLauncher";
import { useTerminalConfig } from "@/hooks/useTerminalConfig";
import { useAppThemeConfig } from "@/hooks/useAppThemeConfig";
import { useGlobalKeybindings } from "@/hooks/useGlobalKeybindings";
import { useGlobalEscapeDispatcher } from "@/hooks/useGlobalEscapeDispatcher";
import { useContextInjection } from "@/hooks/useContextInjection";
import { useGridNavigation } from "@/hooks/useGridNavigation";
import { useWindowNotifications } from "@/hooks/useWindowNotifications";
import { useWatchedPanelNotifications } from "@/hooks/useWatchedPanelNotifications";
import { useWorktreeActions } from "@/hooks/useWorktreeActions";
import { useMenuActions } from "@/hooks/useMenuActions";
import { useErrors } from "@/hooks/useErrors";
import { useReEntrySummary } from "@/hooks/useReEntrySummary";
import type { ProjectCreationIdentity } from "@shared/types";
import { useActionRegistry } from "./hooks/useActionRegistry";
import { usePluginActions } from "./hooks/usePluginActions";
import { usePluginPanelKinds } from "./hooks/usePluginPanelKinds";
import { usePluginPanelLifecycle } from "./hooks/usePluginPanelLifecycle";
import { usePluginAgents } from "./hooks/usePluginAgents";
import { usePluginKeybindings } from "./hooks/usePluginKeybindings";
import { usePluginMcpConsentBridge } from "./hooks/usePluginMcpConsentBridge";
import { usePluginCapabilityConsentBridge } from "./hooks/usePluginCapabilityConsentBridge";
import { useMainProcessToastListener } from "./hooks/useMainProcessToastListener";

import { useKeepMounted } from "./hooks/useKeepMounted";
import { useMcpBridge } from "./hooks/useMcpBridge";
import { useMcpAnomalyStats } from "./hooks/useMcpAnomalyStats";
import { usePluginBridge } from "./hooks/usePluginBridge";
import { usePluginPromptBridge } from "./hooks/usePluginPromptBridge";
import { useFileDropGuard } from "./hooks/useFileDropGuard";
import { notifyViewPainted } from "./utils/removeStartupSkeleton";
import {
  usePanelStoreBootstrap,
  useSemanticWorkerLifecycle,
  useCloudSyncWarning,
  useRosettaWarning,
  useAccessibilityAnnouncements,
  useUnloadCleanup,
  useHomeDir,
  usePerformanceMonitors,
  useSettingsDialog,
  useWorktreeOverview,
  useAppEventListeners,
  useThemeBrowserSettingsBridge,
  useErrorRetry,
  useActiveWorktreeSync,
  useAgentActivityBroadcast,
} from "./hooks/app";
import { useResourceProfile } from "./hooks/useResourceProfile";
import { AppLayout } from "./components/Layout";
import { ContentGrid } from "./components/Terminal";
import { TypingLocator } from "./components/Terminal/TypingLocator";
import { useTypeAnywhere } from "./hooks/useTypeAnywhere";

import { useResumeAgentSession } from "./hooks/useResumeAgentSession";
import { VoiceRecordingAnnouncer } from "./components/Terminal/VoiceRecordingAnnouncer";
import { AccessibilityAnnouncer } from "./components/Accessibility/AccessibilityAnnouncer";
import { TooltipProvider } from "./components/ui/tooltip";
import { UI_TOOLTIP_DELAY_DURATION, UI_TOOLTIP_SKIP_DELAY_DURATION } from "./lib/animationUtils";
import { useE2EBridges } from "./hooks/app/useE2EBridges";
import { useModalResetKeys } from "./hooks/app/useModalResetKeys";
import { useAppBootstrap } from "./hooks/app/useAppBootstrap";
import { usePaletteWiring } from "./hooks/app/usePaletteWiring";

import {
  LazyModalHostLayer,
  preloadSettingsDialog,
  LazyDiagnosticsReviewDialogHost,
  LazyCrashRecoveryDialog,
  loadMotionFeatures,
} from "./lazyPanels";

import { ErrorBoundary } from "./components/ErrorBoundary";
import { DndProvider } from "./components/DragDrop";
import { usePanelStore } from "@/store/panelStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { useProjectStore } from "@/store/projectStore";
import { usePaletteStore } from "@/store/paletteStore";
import { usePreferencesStore } from "@/store/preferencesStore";
import { usePluginManagerStore } from "@/store/pluginManagerStore";
import { useEmptyCanvasContent } from "./hooks/app/useEmptyCanvasContent";
// Eager side-effect import: auto-discovers every built-in plugin renderer and
// registers its builtin view slots at module-eval time, before first render.
// Must stay static — a deferred/idle import races the user, so getBuiltinView
// returns null and plugin-contributed dialogs silently never open.
import "@/registry/builtinPluginRenderers";
import { useShallow } from "zustand/react/shallow";
import { LazyMotion, MotionConfig } from "framer-motion";
import { useMacroFocusStore } from "./store/macroFocusStore";
import { voiceRecordingService } from "./services/VoiceRecordingService";
import { useRenderProfiler } from "./utils/renderProfiler";
import { logError } from "./utils/logger";

import { SidebarContent, E2EFaultInjector } from "./components/Sidebar";
import { ensureHydrationBootstrap } from "./utils/stateHydration/bootstrapGuard";

// Kick the hydration-bootstrap IPC pair (keybinding overrides + user-agent
// registry) at module-eval time so the round-trips overlap App's first render
// instead of starting in the post-commit hydration effect. The guard memoizes,
// so the await inside hydrateAppState stays the synchronization point. The
// `.catch` is required: the guard resets its memo and RETHROWS on failure, so
// a bare void call would surface an unhandled rejection — the swallowed early
// failure is retried by hydrateAppState's own await.
void ensureHydrationBootstrap().catch(() => {});

function AppInner() {
  useErrors();
  useUnloadCleanup();
  useResourceProfile();

  useE2EBridges();

  const { crossDiffDialog, closeCrossWorktreeDiff } = useWorktreeSelectionStore(
    useShallow((state) => ({
      crossDiffDialog: state.crossDiffDialog,
      closeCrossWorktreeDiff: state.closeCrossWorktreeDiff,
    }))
  );

  const focusedId = usePanelStore((state) => state.focusedId);

  const { launchAgent, availability, agentSettings, refreshSettings } = useAgentLauncher();

  useTerminalConfig();
  useAppThemeConfig();
  useWindowNotifications();
  useWatchedPanelNotifications();
  const reEntrySummary = useReEntrySummary();
  useMainProcessToastListener();

  useMcpBridge();
  useMcpAnomalyStats();
  usePluginBridge();
  usePluginPromptBridge();
  const { homeDir } = useHomeDir();

  // Grid navigation hook for directional terminal switching
  const { findNearest, findByIndex, findDockByIndex, getCurrentLocation } = useGridNavigation();

  const {
    worktrees,
    isLoading,
    newTerminalPalette,
    panelPalette,
    projectSwitcherPalette,
    actionPalette,
    quickSwitcher,
    sendToAgentPalette,
    worktreePalette,
    quickCreatePalette,
    isThemePaletteOpen,
    isLogLevelPaletteOpen,
    isResumeSessionsPaletteOpen,
    isProjectSwitcherModalOpen,
    shouldMountQuickSwitcher,
    shouldMountSendToAgentPalette,
    shouldMountNewTerminalPalette,
    shouldMountWorktreePalette,
    shouldMountQuickCreatePalette,
    shouldMountPanelPalette,
    shouldMountThemePalette,
    shouldMountResumeSessionsPalette,
    shouldMountLogLevelPalette,
    shouldMountActionPalette,
  } = usePaletteWiring();
  const currentProject = useProjectStore((state) => state.currentProject);
  const gitInitDialogOpen = useProjectStore((state) => state.gitInitDialogOpen);
  const gitInitDirectoryPath = useProjectStore((state) => state.gitInitDirectoryPath);
  const gitInitIdentity = useProjectStore((state) => state.gitInitIdentity);
  const closeGitInitDialog = useProjectStore((state) => state.closeGitInitDialog);
  const handleGitInitSuccess = useProjectStore((state) => state.handleGitInitSuccess);
  const gitInitDialogStep = useProjectStore((state) => state.gitInitDialogStep);
  const openWithoutGit = useProjectStore((state) => state.openWithoutGit);
  const createFolderDialogOpen = useProjectStore((state) => state.createFolderDialogOpen);
  const closeCreateFolderDialog = useProjectStore((state) => state.closeCreateFolderDialog);

  const cloneRepoDialogOpen = useProjectStore((state) => state.cloneRepoDialogOpen);
  const closeCloneRepoDialog = useProjectStore((state) => state.closeCloneRepoDialog);
  const handleCloneSuccess = useProjectStore((state) => state.handleCloneSuccess);

  const shouldMountCreateFolderDialog = useKeepMounted(createFolderDialogOpen);
  const shouldMountCloneRepoDialog = useKeepMounted(cloneRepoDialogOpen);
  // GitInitDialog mounts on the directory path (its `directoryPath` prop is
  // non-nullable), but closeGitInitDialog() clears `gitInitDialogOpen`,
  // `gitInitDirectoryPath` and `gitInitIdentity` in one set(). Latch path and
  // identity as ONE object so the dialog keeps valid props through its exit
  // animation window (#9917) and the two can never be latched out of step. On
  // the next open the store sets both before isOpen, so a fresh context wins.
  const shouldMountGitInitDialog = useKeepMounted(gitInitDialogOpen);
  const [latchedGitInit, setLatchedGitInit] = useState<{
    path: string;
    identity: ProjectCreationIdentity | null;
  } | null>(null);
  useEffect(() => {
    if (gitInitDirectoryPath) {
      setLatchedGitInit({ path: gitInitDirectoryPath, identity: gitInitIdentity });
    }
  }, [gitInitDirectoryPath, gitInitIdentity]);
  const effectiveGitInit = gitInitDirectoryPath
    ? { path: gitInitDirectoryPath, identity: gitInitIdentity }
    : latchedGitInit;
  const effectiveGitInitPath = effectiveGitInit?.path ?? null;
  const effectiveGitInitIdentity = effectiveGitInit?.identity ?? null;
  const { selectWorktree, activeWorktreeId, focusedWorktreeId } = useWorktreeSelectionStore(
    useShallow((state) => ({
      selectWorktree: state.selectWorktree,
      activeWorktreeId: state.activeWorktreeId,
      focusedWorktreeId: state.focusedWorktreeId,
    }))
  );

  const { activeWorktree, defaultTerminalCwd } = useActiveWorktreeSync();
  useAgentActivityBroadcast();
  const resumeSession = useResumeAgentSession();

  const {
    isSettingsOpen,
    settingsTab,
    settingsSubtab,
    settingsSectionId,
    handleSettings,
    handleOpenSettingsTab,
    setIsSettingsOpen,
  } = useSettingsDialog();
  const shouldMountSettings = useKeepMounted(isSettingsOpen);

  useThemeBrowserSettingsBridge(isSettingsOpen, setIsSettingsOpen);
  const [isShortcutsOpen, setIsShortcutsOpen] = useState(false);
  // The plugin manager graduated from a modal to a first-class view (#9558);
  // visibility now lives in usePluginManagerStore so the `app.pluginManager`
  // action and `daintree://` deep links can open it without prop-drilling.
  const isPluginManagerOpen = usePluginManagerStore((s) => s.isOpen);
  // Keep the view mounted after its first open so the plugin list and any
  // pending operation state survive a close/reopen (mirrors SettingsDialog).
  const shouldMountPluginManager = useKeepMounted(isPluginManagerOpen);
  // Close Settings when the manager opens so the two surfaces don't stack —
  // covers both entry points (the `app.pluginManager` action dispatched from
  // the Plugins settings tab, and the deep-link path below). Mirrors the
  // theme-browser <-> Settings coordination in useThemeBrowserSettingsBridge.
  const prevPluginManagerOpenRef = useRef(false);
  useEffect(() => {
    const wasOpen = prevPluginManagerOpenRef.current;
    prevPluginManagerOpenRef.current = isPluginManagerOpen;
    if (!wasOpen && isPluginManagerOpen) setIsSettingsOpen(false);
  }, [isPluginManagerOpen, setIsSettingsOpen]);
  const {
    isWorktreeOverviewOpen,
    toggleWorktreeOverview,
    openWorktreeOverview,
    closeWorktreeOverview,
  } = useWorktreeOverview();

  const shouldMountCrossDiffDialog = useKeepMounted(crossDiffDialog.isOpen);
  const shouldMountShortcutsDialog = useKeepMounted(isShortcutsOpen);

  const onLayoutRender = useRenderProfiler("app-layout", { sampleRate: 0.15 });
  const onContentGridRender = useRenderProfiler("content-grid", { sampleRate: 0.15 });

  usePerformanceMonitors();

  const {
    bootResult,
    crashState,
    resolveCrash,
    updateCrashConfig,
    crashResolved,
    isStateLoaded,
    pluginDeepLink,
    gettingStarted,
  } = useAppBootstrap();

  const { emptyContent, workspaceId } = useEmptyCanvasContent(gettingStarted);

  const {
    gitPushResetKey,
    gitPullRebaseResetKey,
    panelLimitResetKey,
    recipeConflictResetKey,
    mcpConfirmResetKey,
    pluginConfirmResetKey,
    pluginMcpConfirmResetKey,
    pluginCapabilityConfirmResetKey,
    pluginArchiveInstallResetKey,
    diagnosticsReviewResetKey,
    terminalInfoResetKey,
  } = useModalResetKeys();

  const handlePreloadSettings = useCallback(() => {
    void preloadSettingsDialog();
  }, []);

  const handleLaunchAgent = useCallback(
    async (type: string) => {
      // launchAgent throws on an unresolvable worktreeId (#10812) or an agent id
      // that resolves to no agent (#11498). This callback passes no explicit
      // worktreeId (falling back to the active one) and its callers supply
      // built-in or synthetic ids, so both are only reachable via a stale-state
      // race — keep it a quiet no-op rather than an unhandled rejection.
      try {
        await launchAgent(type);
      } catch (error) {
        logError("Failed to launch agent", error);
      }
    },
    [launchAgent]
  );

  const closeThemePalette = useCallback(() => {
    usePaletteStore.getState().closePalette("theme");
  }, []);

  const closeLogLevelPalette = useCallback(() => {
    usePaletteStore.getState().closePalette("log-level");
  }, []);

  const overviewWorktreeActions = useWorktreeActions();

  useAppEventListeners({ onOpenNewTerminalPalette: newTerminalPalette.open });

  const { handleErrorRetry, handleCancelRetry } = useErrorRetry();

  const electronAvailable = isElectronAvailable();
  const { inject } = useContextInjection();

  // Worktree-sidebar-only toggle (Toolbar button + nav.toggleSidebar). Routed
  // through a dedicated event so AppLayout can read the live sidebar width
  // and diagnostics state when invoking the gesture-aware focus store.
  const handleToggleSidebar = useCallback(() => {
    window.dispatchEvent(new CustomEvent("daintree:toggle-sidebar"));
  }, []);

  // Double-click chrome gesture (nav.toggleFocusMode). Snapshot/revert across
  // both sidebars — kept as a separate path so it can hide whichever sidebars
  // are currently visible without affecting the per-sidebar toggles.
  const handleToggleFocusMode = useCallback(() => {
    window.dispatchEvent(new CustomEvent("daintree:toggle-focus-mode"));
  }, []);

  useActionRegistry({
    onOpenSettings: handleSettings,
    onOpenSettingsTab: handleOpenSettingsTab,
    onToggleSidebar: handleToggleSidebar,
    onToggleFocusMode: handleToggleFocusMode,
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
    onOpenResumeSessionsPalette: () => usePaletteStore.getState().openPalette("resume-sessions"),
    onOpenProjectSwitcherPalette: projectSwitcherPalette.toggle,
    onConfirmCloseActiveProject: (projectId: string) => {
      void projectSwitcherPalette.removeProject(projectId);
    },
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

  usePluginActions();
  usePluginPanelKinds();
  usePluginPanelLifecycle();
  usePluginAgents();
  usePluginKeybindings();
  usePluginMcpConsentBridge();
  usePluginCapabilityConsentBridge();

  useMenuActions();

  // Global keybinding handler - provides chord support and priority resolution
  // All keybindings dispatch through ActionService via this centralized handler
  useGlobalKeybindings(electronAvailable);
  // Registered after the central keybindings so a handled shortcut has already
  // claimed the event before the rescue considers it (#11134).
  useTypeAnywhere();
  useGlobalEscapeDispatcher();

  // App lifecycle hooks
  usePanelStoreBootstrap(bootResult?.terminalConfig ?? null);
  useSemanticWorkerLifecycle();
  useCloudSyncWarning(homeDir);
  useRosettaWarning(bootResult);
  useAccessibilityAnnouncements();

  useEffect(() => {
    voiceRecordingService.initialize();
  }, []);

  useFileDropGuard();

  const reduceAnimations = usePreferencesStore((s) => s.reduceAnimations);

  if (!isElectronAvailable()) {
    return (
      <div className="h-screen w-screen flex items-center justify-center bg-daintree-bg">
        <div className="text-daintree-text/60 text-sm">
          Electron API not available - please run in Electron
        </div>
      </div>
    );
  }

  if (crashState.status === "pending" || crashState.status === "failed") {
    return (
      <div className="h-screen w-screen bg-daintree-bg">
        <Suspense fallback={null}>
          <LazyCrashRecoveryDialog
            crash={crashState.crash}
            config={crashState.config}
            onResolve={resolveCrash}
            onUpdateConfig={updateCrashConfig}
            {...(crashState.status === "failed" && { initialError: crashState.errorMessage })}
          />
        </Suspense>
        {/* Diagnostics host stays reachable while the crash dialog is blocking
            the app — without this, the inline "Send diagnostics" action in
            CrashRecoveryDialog (recovery-failed banner) has nothing to render
            the dialog into. */}
        <Suspense fallback={null}>
          <LazyDiagnosticsReviewDialogHost />
        </Suspense>
      </div>
    );
  }

  if (!crashResolved || !isStateLoaded) {
    // Render the structural chrome (toolbar, dock) behind the HTML skeleton so
    // the cold-start handoff has positionally-stable surfaces underneath when
    // the skeleton fades out. AppLayout's `isHydrated={false}` mode skips the
    // focus-mode persistence and renders no sidebar/main content.
    return (
      <LazyMotion strict features={loadMotionFeatures}>
        <MotionConfig reducedMotion={reduceAnimations ? "always" : "user"}>
          <ErrorBoundary variant="fullscreen" componentName="App">
            <TooltipProvider
              delayDuration={UI_TOOLTIP_DELAY_DURATION}
              skipDelayDuration={UI_TOOLTIP_SKIP_DELAY_DURATION}
              disableHoverableContent
            >
              <DndProvider>
                <AppLayout
                  onLaunchAgent={handleLaunchAgent}
                  onSettings={handleSettings}
                  onPreloadSettings={handlePreloadSettings}
                  agentAvailability={availability}
                  agentSettings={agentSettings}
                  isHydrated={false}
                  projectSwitcherPalette={projectSwitcherPalette}
                />
              </DndProvider>
            </TooltipProvider>
          </ErrorBoundary>
        </MotionConfig>
      </LazyMotion>
    );
  }

  return (
    <LazyMotion strict features={loadMotionFeatures}>
      <MotionConfig reducedMotion={reduceAnimations ? "always" : "user"}>
        <ErrorBoundary variant="fullscreen" componentName="App">
          <TooltipProvider
            delayDuration={UI_TOOLTIP_DELAY_DURATION}
            skipDelayDuration={UI_TOOLTIP_SKIP_DELAY_DURATION}
            disableHoverableContent
          >
            {window.__DAINTREE_E2E_MODE__ === true && <E2EFaultInjector />}
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
                  <ErrorBoundary
                    variant="section"
                    componentName="ContentGrid"
                    resetKeys={[workspaceId].filter((k): k is string => k != null)}
                  >
                    <Profiler id="content-grid" onRender={onContentGridRender}>
                      <div className="relative h-full w-full">
                        <ContentGrid
                          className="h-full w-full"
                          agentAvailability={availability}
                          defaultCwd={defaultTerminalCwd}
                          emptyContent={emptyContent}
                        />
                        <TypingLocator />
                      </div>
                    </Profiler>
                  </ErrorBoundary>
                </AppLayout>
              </Profiler>
            </DndProvider>

            <Suspense fallback={null}>
              <LazyModalHostLayer
                quickSwitcher={quickSwitcher}
                shouldMountQuickSwitcher={shouldMountQuickSwitcher}
                sendToAgentPalette={sendToAgentPalette}
                shouldMountSendToAgentPalette={shouldMountSendToAgentPalette}
                newTerminalPalette={newTerminalPalette}
                shouldMountNewTerminalPalette={shouldMountNewTerminalPalette}
                worktreePalette={worktreePalette}
                shouldMountWorktreePalette={shouldMountWorktreePalette}
                quickCreatePalette={quickCreatePalette}
                shouldMountQuickCreatePalette={shouldMountQuickCreatePalette}
                panelPalette={panelPalette}
                shouldMountPanelPalette={shouldMountPanelPalette}
                resumeSession={resumeSession}
                handleLaunchAgent={handleLaunchAgent}
                defaultTerminalCwd={defaultTerminalCwd}
                activeWorktreeId={activeWorktreeId}
                isProjectSwitcherModalOpen={isProjectSwitcherModalOpen}
                projectSwitcherPalette={projectSwitcherPalette}
                isThemePaletteOpen={isThemePaletteOpen}
                shouldMountThemePalette={shouldMountThemePalette}
                closeThemePalette={closeThemePalette}
                isResumeSessionsPaletteOpen={isResumeSessionsPaletteOpen}
                shouldMountResumeSessionsPalette={shouldMountResumeSessionsPalette}
                isLogLevelPaletteOpen={isLogLevelPaletteOpen}
                shouldMountLogLevelPalette={shouldMountLogLevelPalette}
                closeLogLevelPalette={closeLogLevelPalette}
                actionPalette={actionPalette}
                shouldMountActionPalette={shouldMountActionPalette}
                isWorktreeOverviewOpen={isWorktreeOverviewOpen}
                closeWorktreeOverview={closeWorktreeOverview}
                worktrees={worktrees}
                isLoading={isLoading}
                focusedWorktreeId={focusedWorktreeId}
                selectWorktree={selectWorktree}
                overviewWorktreeActions={overviewWorktreeActions}
                availability={availability}
                agentSettings={agentSettings}
                homeDir={homeDir}
                crossDiffDialog={crossDiffDialog}
                shouldMountCrossDiffDialog={shouldMountCrossDiffDialog}
                closeCrossWorktreeDiff={closeCrossWorktreeDiff}
                isSettingsOpen={isSettingsOpen}
                shouldMountSettings={shouldMountSettings}
                setIsSettingsOpen={setIsSettingsOpen}
                settingsTab={settingsTab}
                settingsSubtab={settingsSubtab}
                settingsSectionId={settingsSectionId}
                refreshSettings={refreshSettings}
                currentProject={currentProject}
                isShortcutsOpen={isShortcutsOpen}
                shouldMountShortcutsDialog={shouldMountShortcutsDialog}
                setIsShortcutsOpen={setIsShortcutsOpen}
                isPluginManagerOpen={isPluginManagerOpen}
                shouldMountPluginManager={shouldMountPluginManager}
                pluginDeepLink={pluginDeepLink}
                terminalInfoResetKey={terminalInfoResetKey}
                isStateLoaded={isStateLoaded}
                mcpConfirmResetKey={mcpConfirmResetKey}
                pluginConfirmResetKey={pluginConfirmResetKey}
                pluginMcpConfirmResetKey={pluginMcpConfirmResetKey}
                pluginCapabilityConfirmResetKey={pluginCapabilityConfirmResetKey}
                pluginArchiveInstallResetKey={pluginArchiveInstallResetKey}
                panelLimitResetKey={panelLimitResetKey}
                diagnosticsReviewResetKey={diagnosticsReviewResetKey}
                gitPushResetKey={gitPushResetKey}
                gitPullRebaseResetKey={gitPullRebaseResetKey}
                recipeConflictResetKey={recipeConflictResetKey}
                gitInitDialogOpen={gitInitDialogOpen}
                shouldMountGitInitDialog={shouldMountGitInitDialog}
                effectiveGitInitPath={effectiveGitInitPath}
                effectiveGitInitIdentity={effectiveGitInitIdentity}
                gitInitDialogStep={gitInitDialogStep}
                handleGitInitSuccess={handleGitInitSuccess}
                openWithoutGit={openWithoutGit}
                closeGitInitDialog={closeGitInitDialog}
                createFolderDialogOpen={createFolderDialogOpen}
                shouldMountCreateFolderDialog={shouldMountCreateFolderDialog}
                closeCreateFolderDialog={closeCreateFolderDialog}
                cloneRepoDialogOpen={cloneRepoDialogOpen}
                shouldMountCloneRepoDialog={shouldMountCloneRepoDialog}
                handleCloneSuccess={handleCloneSuccess}
                closeCloneRepoDialog={closeCloneRepoDialog}
                reEntrySummary={reEntrySummary}
                gettingStarted={gettingStarted}
              />
            </Suspense>
          </TooltipProvider>
        </ErrorBoundary>
      </MotionConfig>
    </LazyMotion>
  );
}

// `AppInner` suspends on the module-scope `app:boot` promise via `use()`. The
// Suspense boundary lives here rather than in `main.tsx` so the boot read has a
// fallback if the IPC hasn't settled by first render. `fallback={null}` keeps
// the cold-start `#startup-skeleton` (a sibling of `#root`) visible during the
// flight — it's removed by `removeStartupSkeleton()` once hydration completes.
function App() {
  // Signal the main process that React has committed its first frame so
  // ProjectViewManager can release the outgoing view of a cold project switch.
  // This lives in the Suspense *parent* (not `AppInner`) so it fires the moment
  // the boundary commits — even while `AppInner` is suspended on `app:boot` —
  // preserving the pre-#8820 guarantee that the paint signal lands before
  // hydration regardless of IPC latency. Double rAF mirrors
  // `removeStartupSkeleton`: first rAF lands after React's commit, second waits
  // for Chromium to submit that frame. Cleanup only cancels the outer rAF —
  // under Strict Mode's double-mount the inner rAF may still fire, but
  // `notifyViewPainted` is idempotent (one-shot module-level guard).
  useEffect(() => {
    const id = requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        notifyViewPainted();
      });
    });
    return () => cancelAnimationFrame(id);
  }, []);

  return (
    <Suspense fallback={null}>
      <AppInner />
    </Suspense>
  );
}

export default App;
