import { Profiler, Suspense, lazy, useCallback, useEffect, useRef, useState } from "react";
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
import { useActionRegistry } from "./hooks/useActionRegistry";
import { usePluginActions } from "./hooks/usePluginActions";
import { usePluginPanelKinds } from "./hooks/usePluginPanelKinds";
import { usePluginAgents } from "./hooks/usePluginAgents";
import { usePluginKeybindings } from "./hooks/usePluginKeybindings";
import { usePluginMcpConsentBridge } from "./hooks/usePluginMcpConsentBridge";
import { usePluginCapabilityConsentBridge } from "./hooks/usePluginCapabilityConsentBridge";
import { useUpdateListener } from "./hooks/useUpdateListener";
import { useMainProcessToastListener } from "./hooks/useMainProcessToastListener";

import { useActionPalette } from "./hooks/useActionPalette";
import { useQuickSwitcher } from "./hooks/useQuickSwitcher";
import { useWorktreePalette } from "./hooks/useWorktreePalette";
import { useQuickCreatePalette } from "./hooks/useQuickCreatePalette";
import { useDoubleShift } from "./hooks/useDoubleShift";
import { useProjectMruSwitcher } from "./hooks/useProjectMruSwitcher";
import { useKeepMounted } from "./hooks/useKeepMounted";
import { stashViewFileRequest } from "./components/FileViewer/pendingViewFileRequest";
import { stashViewDiffRequest } from "./components/Worktree/pendingViewDiffRequest";
import { useMcpBridge } from "./hooks/useMcpBridge";
import { useMcpAnomalyStats } from "./hooks/useMcpAnomalyStats";
import { usePluginBridge } from "./hooks/usePluginBridge";
import { usePluginPromptBridge } from "./hooks/usePluginPromptBridge";
import { useFileDropGuard } from "./hooks/useFileDropGuard";
import { notifyViewPainted, removeStartupSkeleton } from "./utils/removeStartupSkeleton";
import { useAppBoot } from "./hooks/app/useAppBoot";
import { useCrashRecoveryGate } from "./hooks/app/useCrashRecoveryGate";
import {
  useAppHydration,
  useShortcutHints,
  usePanelStoreBootstrap,
  useSemanticWorkerLifecycle,
  useCloudSyncWarning,
  useRosettaWarning,
  useAccessibilityAnnouncements,
  useGettingStartedChecklist,
  useOrchestrationMilestones,
  useAgentWaitingNudge,
  useForgeEnableRecommendation,
  useFocusOnActivateIntent,
  useBackgroundWindowResize,
  useResetSwitchOverlayOnReveal,
  usePluginDeepLink,
  useNotificationHistoryPruning,
  useUnloadCleanup,
  useHomeDir,
  usePerformanceMonitors,
  useSettingsDialog,
  useWorktreeOverview,
  useAppEventListeners,
  useThemeBrowserSettingsBridge,
  useErrorRetry,
  useActiveWorktreeSync,
} from "./hooks/app";
import { useResourceProfile } from "./hooks/useResourceProfile";
import { AppLayout } from "./components/Layout";
import { PostHydrationListeners } from "./components/PostHydrationListeners";
import { ContentGrid } from "./components/Terminal";
import { PanelTransitionOverlay } from "./components/Panel";

import { TerminalInfoDialogHost } from "./components/Terminal/TerminalInfoDialogHost";
import { MORE_AGENTS_PANEL_ID } from "./hooks/usePanelPalette";
import {
  buildResumeCommand,
  buildResumeLatestCommand,
  reconcileBypassFlags,
  resolveEffectiveBypass,
} from "@shared/types/agentSettings";
import { getEffectiveAgentConfig } from "@shared/config/agentRegistry";
import { VoiceRecordingAnnouncer } from "./components/Terminal/VoiceRecordingAnnouncer";
import { AccessibilityAnnouncer } from "./components/Accessibility/AccessibilityAnnouncer";
import { useSendToAgentPalette } from "./hooks/useSendToAgentPalette";
import { ConfirmDialog } from "./components/ui/ConfirmDialog";
import { TooltipProvider } from "./components/ui/tooltip";
import { primeRadix } from "./components/ui/radix-loader";
import { UI_TOOLTIP_DELAY_DURATION, UI_TOOLTIP_SKIP_DELAY_DURATION } from "./lib/animationUtils";

// Module-scope loaders: raw import() expressions inside component effects bail
// React Compiler memoization for AppInner; hoisting keeps the specifiers
// static for chunking while letting the component compile.
const loadE2ENotificationBackdoor = () => import("./lib/e2eNotificationBackdoor");
const loadJetbrainsMono500 = () => import("@fontsource/jetbrains-mono/latin-500.css");
const loadJetbrainsMono600 = () => import("@fontsource/jetbrains-mono/latin-600.css");
const preloadFileViewerModal = () => import("@/components/FileViewer/FileViewerModal");

// Reconciles a resumed session's persisted launch flags against the current
// global skip-permissions setting (#10432, the "resume trap"): the snapshot may
// have been captured while the global switch was in a different state, so strip
// the agent's canonical bypass flag and re-add it only if it currently resolves.
function reconcileResumeLaunchFlags(session: {
  agentId: string;
  agentLaunchFlags?: string[];
}): string[] | undefined {
  const settings = useAgentSettingsStore.getState().settings;
  const entry = settings?.agents?.[session.agentId] ?? {};
  const effectiveBypass = resolveEffectiveBypass(
    entry,
    session.agentId,
    settings?.globalSkipPermissions
  );
  // Pass [] when no flags were captured so global-on still injects the bypass
  // token for a supported agent (reconcileBypassFlags no-ops for others).
  return reconcileBypassFlags(
    session.agentLaunchFlags ?? [],
    session.agentId,
    effectiveBypass,
    entry.dangerousArgs as string | undefined
  );
}

// Direct file import (not the Project barrel) so the lazy chunk doesn't pull
// in barrel siblings. Renders only when no project is open, so it stays off
// the returning-user first-paint path.
function preloadWelcomeScreen() {
  return import("./components/Project/WelcomeScreen");
}
const LazyWelcomeScreen = lazy(() =>
  preloadWelcomeScreen().then((m) => ({ default: m.WelcomeScreen }))
);

function preloadSettingsDialog() {
  return import("./components/Settings/SettingsDialog");
}
const LazySettingsDialog = lazy(() =>
  preloadSettingsDialog().then((m) => ({ default: m.SettingsDialog }))
);

function preloadWorktreePalette() {
  return import("./components/Worktree/WorktreePalette");
}
const LazyWorktreePalette = lazy(() =>
  preloadWorktreePalette().then((m) => ({ default: m.WorktreePalette }))
);

function preloadWorktreeOverviewModal() {
  return import("./components/Worktree/WorktreeOverviewModal");
}
const LazyWorktreeOverviewModal = lazy(() =>
  preloadWorktreeOverviewModal().then((m) => ({ default: m.WorktreeOverviewModal }))
);

function preloadQuickCreatePalette() {
  return import("./components/Worktree/QuickCreatePalette");
}
const LazyQuickCreatePalette = lazy(() =>
  preloadQuickCreatePalette().then((m) => ({ default: m.QuickCreatePalette }))
);

function preloadCrossWorktreeDiff() {
  return import("./components/Worktree/CrossWorktreeDiff");
}
const LazyCrossWorktreeDiff = lazy(() =>
  preloadCrossWorktreeDiff().then((m) => ({ default: m.CrossWorktreeDiff }))
);

function preloadNewTerminalPalette() {
  return import("./components/TerminalPalette/NewTerminalPalette");
}
const LazyNewTerminalPalette = lazy(() =>
  preloadNewTerminalPalette().then((m) => ({ default: m.NewTerminalPalette }))
);

function preloadSendToAgentPalette() {
  return import("./components/Terminal/SendToAgentPalette");
}
const LazySendToAgentPalette = lazy(() =>
  preloadSendToAgentPalette().then((m) => ({ default: m.SendToAgentPalette }))
);

function preloadPanelPalette() {
  return import("./components/PanelPalette/PanelPalette");
}
const LazyPanelPalette = lazy(() =>
  preloadPanelPalette().then((m) => ({ default: m.PanelPalette }))
);

function preloadActionPalette() {
  return import("./components/ActionPalette/ActionPalette");
}
const LazyActionPalette = lazy(() =>
  preloadActionPalette().then((m) => ({ default: m.ActionPalette }))
);

function preloadQuickSwitcher() {
  return import("./components/QuickSwitcher/QuickSwitcher");
}
const LazyQuickSwitcher = lazy(() =>
  preloadQuickSwitcher().then((m) => ({ default: m.QuickSwitcher }))
);

function preloadProjectSwitcherPalette() {
  return import("./components/Project/ProjectSwitcherPalette");
}
const LazyProjectSwitcherPalette = lazy(() =>
  preloadProjectSwitcherPalette().then((m) => ({ default: m.ProjectSwitcherPalette }))
);

function preloadGitInitDialog() {
  return import("./components/Project/GitInitDialog");
}
const LazyGitInitDialog = lazy(() =>
  preloadGitInitDialog().then((m) => ({ default: m.GitInitDialog }))
);

function preloadCloneRepoDialog() {
  return import("./components/Project/CloneRepoDialog");
}
const LazyCloneRepoDialog = lazy(() =>
  preloadCloneRepoDialog().then((m) => ({ default: m.CloneRepoDialog }))
);

function preloadCreateProjectFolderDialog() {
  return import("./components/Project/CreateProjectFolderDialog");
}
const LazyCreateProjectFolderDialog = lazy(() =>
  preloadCreateProjectFolderDialog().then((m) => ({ default: m.CreateProjectFolderDialog }))
);

function preloadThemePalette() {
  return import("./components/ThemePalette/ThemePalette");
}
const LazyThemePalette = lazy(() =>
  preloadThemePalette().then((m) => ({ default: m.ThemePalette }))
);

function preloadLogLevelPalette() {
  return import("./components/LogLevelPalette/LogLevelPalette");
}
const LazyLogLevelPalette = lazy(() =>
  preloadLogLevelPalette().then((m) => ({ default: m.LogLevelPalette }))
);

function preloadShortcutReferenceDialog() {
  return import("./components/KeyboardShortcuts/ShortcutReferenceDialog");
}
const LazyShortcutReferenceDialog = lazy(() =>
  preloadShortcutReferenceDialog().then((m) => ({ default: m.ShortcutReferenceDialog }))
);

function preloadPluginManagerView() {
  return import("./components/Plugin/PluginManagerView");
}
const LazyPluginManagerView = lazy(() =>
  preloadPluginManagerView().then((m) => ({ default: m.PluginManagerView }))
);

function preloadOnboardingFlow() {
  return import("./components/Onboarding/OnboardingFlow");
}
const LazyOnboardingFlow = lazy(() =>
  preloadOnboardingFlow().then((m) => ({ default: m.OnboardingFlow }))
);

function preloadGettingStartedChecklist() {
  return import("./components/Onboarding/GettingStartedChecklist");
}
const LazyGettingStartedChecklist = lazy(() =>
  preloadGettingStartedChecklist().then((m) => ({ default: m.GettingStartedChecklist }))
);

function preloadCelebrationConfetti() {
  return import("./components/Onboarding/CelebrationConfetti");
}
const LazyCelebrationConfetti = lazy(() =>
  preloadCelebrationConfetti().then((m) => ({ default: m.CelebrationConfetti }))
);

function preloadFileViewerModalHost() {
  return import("./components/FileViewer/FileViewerModalHost");
}
const LazyFileViewerModalHost = lazy(() =>
  preloadFileViewerModalHost().then((m) => ({ default: m.FileViewerModalHost }))
);

function preloadDiffViewerModalHost() {
  return import("./components/Worktree/DiffViewerModalHost");
}
const LazyDiffViewerModalHost = lazy(() =>
  preloadDiffViewerModalHost().then((m) => ({ default: m.DiffViewerModalHost }))
);

function preloadMcpConfirmDialog() {
  return import("./components/McpConfirmDialog");
}
const LazyMcpConfirmDialog = lazy(() =>
  preloadMcpConfirmDialog().then((m) => ({ default: m.McpConfirmDialog }))
);

function preloadPluginConfirmDialog() {
  return import("./components/Plugin/PluginConfirmDialog");
}
const LazyPluginConfirmDialog = lazy(() =>
  preloadPluginConfirmDialog().then((m) => ({ default: m.PluginConfirmDialog }))
);

function preloadPluginMcpConfirmDialog() {
  return import("./components/Plugin/PluginMcpConfirmDialog");
}
const LazyPluginMcpConfirmDialog = lazy(() =>
  preloadPluginMcpConfirmDialog().then((m) => ({ default: m.PluginMcpConfirmDialog }))
);

const LazyPluginQuickPickDialog = lazy(() =>
  import("./components/Plugin/PluginQuickPickDialog").then((m) => ({
    default: m.PluginQuickPickDialog,
  }))
);
const LazyPluginInputBoxDialog = lazy(() =>
  import("./components/Plugin/PluginInputBoxDialog").then((m) => ({
    default: m.PluginInputBoxDialog,
  }))
);
const LazyPluginConfirmPromptDialog = lazy(() =>
  import("./components/Plugin/PluginConfirmPromptDialog").then((m) => ({
    default: m.PluginConfirmPromptDialog,
  }))
);
function preloadPluginCapabilityConfirmDialog() {
  return import("./components/Plugin/PluginCapabilityConfirmDialog");
}
const LazyPluginCapabilityConfirmDialog = lazy(() =>
  preloadPluginCapabilityConfirmDialog().then((m) => ({
    default: m.PluginCapabilityConfirmDialog,
  }))
);

function preloadPanelLimitConfirmDialog() {
  return import("./components/Terminal/PanelLimitConfirmDialog");
}
const LazyPanelLimitConfirmDialog = lazy(() =>
  preloadPanelLimitConfirmDialog().then((m) => ({ default: m.PanelLimitConfirmDialog }))
);

function preloadDiagnosticsReviewDialogHost() {
  return import("./components/Settings/DiagnosticsReviewDialogHost");
}
const LazyDiagnosticsReviewDialogHost = lazy(() =>
  preloadDiagnosticsReviewDialogHost().then((m) => ({ default: m.DiagnosticsReviewDialogHost }))
);

function preloadGitPushConfirmDialog() {
  return import("./components/Git/GitPushConfirmDialog");
}
const LazyGitPushConfirmDialog = lazy(() =>
  preloadGitPushConfirmDialog().then((m) => ({ default: m.GitPushConfirmDialog }))
);

function preloadGitPullRebaseConfirmDialog() {
  return import("./components/Git/GitPullRebaseConfirmDialog");
}
const LazyGitPullRebaseConfirmDialog = lazy(() =>
  preloadGitPullRebaseConfirmDialog().then((m) => ({
    default: m.GitPullRebaseConfirmDialog,
  }))
);

function preloadRecipeConflictDialog() {
  return import("./components/TerminalRecipe/RecipeConflictDialog");
}
const LazyRecipeConflictDialog = lazy(() =>
  preloadRecipeConflictDialog().then((m) => ({ default: m.RecipeConflictDialog }))
);

function preloadCrashRecoveryDialog() {
  return import("./components/Recovery/CrashRecoveryDialog");
}
const LazyCrashRecoveryDialog = lazy(() =>
  preloadCrashRecoveryDialog().then((m) => ({ default: m.CrashRecoveryDialog }))
);

import { Toaster } from "./components/ui/toaster";
import { ShortcutHint } from "./components/ui/ShortcutHint";
import { ReEntrySummary } from "./components/ui/ReEntrySummary";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { DndProvider } from "./components/DragDrop";
import {
  usePanelStore,
  useWorktreeSelectionStore,
  useProjectStore,
  useErrorStore,
  usePaletteStore,
  useNotificationSettingsStore,
  usePreferencesStore,
  usePluginManagerStore,
  useDiagnosticsStore,
  usePerformanceModeStore,
} from "./store";
import { usePerfMetricsStore } from "./store/perfMetricsStore";
import { useRecipeConflictStore } from "./store/recipeConflictStore";
import { useGitPushConfirmStore } from "./store/gitPushConfirmStore";
import { useGitPullRebaseConfirmStore } from "./store/gitPullRebaseConfirmStore";
import { usePanelLimitStore } from "./store/panelLimitStore";
import { useMcpConfirmStore } from "./store/mcpConfirmStore";
import { usePluginConfirmStore } from "./store/pluginConfirmStore";
import { usePluginMcpConfirmStore } from "./store/pluginMcpConfirmStore";
import { usePluginCapabilityConfirmStore } from "./store/pluginCapabilityConfirmStore";
import { useDiagnosticsReviewStore } from "./store/diagnosticsReviewStore";
import { useAgentSettingsStore } from "./store/agentSettingsStore";
// Eager side-effect import: auto-discovers every built-in plugin renderer and
// registers its builtin view slots at module-eval time, before first render.
// Must stay static — a deferred/idle import races the user, so getBuiltinView
// returns null and plugin-contributed dialogs silently never open.
import "@/registry/builtinPluginRenderers";
import { useShallow } from "zustand/react/shallow";
import { LazyMotion, MotionConfig } from "framer-motion";
import { useMacroFocusStore } from "./store/macroFocusStore";
import type { BuiltInPanelKind } from "./types";
import { actionService, installE2EActionDispatchBridge } from "./services/ActionService";
import { voiceRecordingService } from "./services/VoiceRecordingService";
import { useRenderProfiler } from "./utils/renderProfiler";
import { logError } from "./utils/logger";

import { SidebarContent, preloadNewWorktreeDialog, E2EFaultInjector } from "./components/Sidebar";
import { ensureHydrationBootstrap } from "./utils/stateHydration/bootstrapGuard";

// Kick the hydration-bootstrap IPC pair (keybinding overrides + user-agent
// registry) at module-eval time so the round-trips overlap App's first render
// instead of starting in the post-commit hydration effect. The guard memoizes,
// so the await inside hydrateAppState stays the synchronization point. The
// `.catch` is required: the guard resets its memo and RETHROWS on failure, so
// a bare void call would surface an unhandled rejection — the swallowed early
// failure is retried by hydrateAppState's own await.
void ensureHydrationBootstrap().catch(() => {});

const loadMotionFeatures = () => import("./lib/motionFeatures").then((mod) => mod.default);

function AppInner() {
  useErrors();
  useUnloadCleanup();
  useResourceProfile();

  useEffect(() => {
    installE2EActionDispatchBridge();
  }, []);

  useEffect(() => {
    // All E2E renderer backdoors are gated on the preload-injected
    // __DAINTREE_E2E_MODE__ flag (set only under DAINTREE_E2E_MODE=1 on
    // non-packaged builds) so none of these store accessors attach in
    // production sessions.
    if (window.__DAINTREE_E2E_MODE__ === true) {
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
          retryability: "none",
          source: "e2e-test",
        });
      };
      window.__DAINTREE_E2E_CLEAR_ERRORS__ = () => {
        useErrorStore.getState().reset();
      };
      // Parks a synthetic in-repo recipe stale-write conflict so E2E can exercise
      // the RecipeConflictDialog without racing a real on-disk file mutation. The
      // returned promise resolves with the user's choice; tests don't await it —
      // they assert the dialog renders and that reload/overwrite dismiss it.
      window.__DAINTREE_E2E_TRIGGER_RECIPE_CONFLICT__ = (recipeName: string) => {
        void useRecipeConflictStore.getState().requestConflict({
          recipeId: `inrepo-${recipeName}`,
          recipeName,
          updates: { name: recipeName },
        });
      };

      // Per-window store accessors for the multi-window isolation spec (#9599).
      // Each project view is its own V8 context, so these Zustand singletons are
      // per-window — mutating one window's store must not leak into another's.
      window.__DAINTREE_E2E_DIAGNOSTICS_STATE__ = () => ({
        isOpen: useDiagnosticsStore.getState().isOpen,
      });
      window.__DAINTREE_E2E_OPEN_DIAGNOSTICS__ = () => useDiagnosticsStore.getState().openDock();
      window.__DAINTREE_E2E_PERF_METRICS_STATE__ = () => {
        const s = usePerfMetricsStore.getState();
        return { fps: s.fps, lafCount30s: s.lafCount30s, cls30s: s.cls30s };
      };
      window.__DAINTREE_E2E_SET_PERF_METRIC__ = (fps: number) =>
        usePerfMetricsStore.getState().setLiveMetrics({ fps, lafCount30s: 0, cls30s: 0 });
      window.__DAINTREE_E2E_PERF_MODE_STATE__ = () => ({
        performanceMode: usePerformanceModeStore.getState().performanceMode,
      });
      window.__DAINTREE_E2E_SET_PERF_MODE__ = (enabled: boolean) =>
        usePerformanceModeStore.getState().setPerformanceMode(enabled);

      // Lazy-load the notification backdoor only under E2E so its module closure
      // stays out of the production first-paint chunk. Fire-and-forget: the helper
      // side in e2e/helpers/notifications.ts waits for __daintreeNotificationsE2E
      // before use, so the async resolve doesn't need to block the effect.
      void loadE2ENotificationBackdoor()
        .then(({ installE2ENotificationBackdoor }) => {
          installE2ENotificationBackdoor();
        })
        .catch(() => {});
    }

    return () => {
      delete window.__DAINTREE_E2E_ERROR_STORE__;
      delete window.__DAINTREE_E2E_ADD_ERROR__;
      delete window.__DAINTREE_E2E_CLEAR_ERRORS__;
      delete window.__DAINTREE_E2E_TRIGGER_RECIPE_CONFLICT__;
      delete window.__DAINTREE_E2E_DIAGNOSTICS_STATE__;
      delete window.__DAINTREE_E2E_OPEN_DIAGNOSTICS__;
      delete window.__DAINTREE_E2E_PERF_METRICS_STATE__;
      delete window.__DAINTREE_E2E_SET_PERF_METRIC__;
      delete window.__DAINTREE_E2E_PERF_MODE_STATE__;
      delete window.__DAINTREE_E2E_SET_PERF_MODE__;
      delete window.__daintreeNotificationsE2E;
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

  const { worktrees, worktreeMap, isLoading } = useWorktrees();
  const newTerminalPalette = useNewTerminalPalette({ worktreeMap });
  const panelPalette = usePanelPalette();
  const projectSwitcherPalette = useProjectSwitcherPalette();
  const actionPalette = useActionPalette();
  const quickSwitcher = useQuickSwitcher();
  const sendToAgentPalette = useSendToAgentPalette();
  useDoubleShift(actionPalette.toggle);
  useProjectMruSwitcher();
  const currentProject = useProjectStore((state) => state.currentProject);
  const gitInitDialogOpen = useProjectStore((state) => state.gitInitDialogOpen);
  const gitInitDirectoryPath = useProjectStore((state) => state.gitInitDirectoryPath);
  const closeGitInitDialog = useProjectStore((state) => state.closeGitInitDialog);
  const handleGitInitSuccess = useProjectStore((state) => state.handleGitInitSuccess);
  const createFolderDialogOpen = useProjectStore((state) => state.createFolderDialogOpen);
  const closeCreateFolderDialog = useProjectStore((state) => state.closeCreateFolderDialog);

  const cloneRepoDialogOpen = useProjectStore((state) => state.cloneRepoDialogOpen);
  const closeCloneRepoDialog = useProjectStore((state) => state.closeCloneRepoDialog);
  const handleCloneSuccess = useProjectStore((state) => state.handleCloneSuccess);

  const shouldMountCreateFolderDialog = useKeepMounted(createFolderDialogOpen);
  const shouldMountCloneRepoDialog = useKeepMounted(cloneRepoDialogOpen);
  // GitInitDialog mounts on the directory path (its `directoryPath` prop is
  // non-nullable), but closeGitInitDialog() clears both `gitInitDialogOpen` and
  // `gitInitDirectoryPath` in one set(). Latch the last non-null path so the
  // dialog keeps a valid prop through its exit animation window (#9917). On the
  // next open the store sets the path before isOpen, so a fresh path wins.
  const shouldMountGitInitDialog = useKeepMounted(gitInitDialogOpen);
  const [latchedGitInitPath, setLatchedGitInitPath] = useState<string | null>(null);
  useEffect(() => {
    if (gitInitDirectoryPath) setLatchedGitInitPath(gitInitDirectoryPath);
  }, [gitInitDirectoryPath]);
  const effectiveGitInitPath = gitInitDirectoryPath ?? latchedGitInitPath;
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
  const isThemePaletteOpen = usePaletteStore((state) => state.activePaletteId === "theme");
  const isLogLevelPaletteOpen = usePaletteStore((state) => state.activePaletteId === "log-level");
  const {
    isWorktreeOverviewOpen,
    toggleWorktreeOverview,
    openWorktreeOverview,
    closeWorktreeOverview,
  } = useWorktreeOverview();

  // Keep each palette/dialog mounted after its first open so its exit animation
  // (driven by useAnimatedPresence) can run — gating directly on `isOpen`
  // unmounts in the same React commit that flips it false, killing the exit
  // (#9917). The component still receives `isOpen` and gates its own DOM via
  // `shouldRender`.
  const isProjectSwitcherModalOpen =
    projectSwitcherPalette.isOpen && projectSwitcherPalette.mode === "modal";
  const shouldMountQuickSwitcher = useKeepMounted(quickSwitcher.isOpen);
  const shouldMountSendToAgentPalette = useKeepMounted(sendToAgentPalette.isOpen);
  const shouldMountNewTerminalPalette = useKeepMounted(newTerminalPalette.isOpen);
  const shouldMountWorktreePalette = useKeepMounted(worktreePalette.isOpen);
  const shouldMountQuickCreatePalette = useKeepMounted(quickCreatePalette.isOpen);
  const shouldMountPanelPalette = useKeepMounted(panelPalette.isOpen);
  const shouldMountThemePalette = useKeepMounted(isThemePaletteOpen);
  const shouldMountLogLevelPalette = useKeepMounted(isLogLevelPaletteOpen);
  const shouldMountActionPalette = useKeepMounted(actionPalette.isOpen);
  const shouldMountCrossDiffDialog = useKeepMounted(crossDiffDialog.isOpen);
  const shouldMountShortcutsDialog = useKeepMounted(isShortcutsOpen);

  const onLayoutRender = useRenderProfiler("app-layout", { sampleRate: 0.15 });
  const onContentGridRender = useRenderProfiler("content-grid", { sampleRate: 0.15 });

  usePerformanceMonitors();

  // Batched cold-start payload — replaces the legacy fan-out of
  // crash-recovery:get-pending + crash-recovery:get-config + app:hydrate +
  // terminal-config:get into a single IPC round-trip (#8620). The IPC is fired
  // at module-eval time and read here via `use()` (#8820); a boot failure
  // resolves to `{ ok: false }` so the app still renders its cold-start chrome.
  const safeBoot = useAppBoot();
  const bootResult = safeBoot.ok ? safeBoot.result : null;

  // Crash recovery gate — must resolve before hydration runs
  const {
    state: crashState,
    resolve: resolveCrash,
    updateConfig: updateCrashConfig,
  } = useCrashRecoveryGate(bootResult);

  const crashResolved = crashState.status !== "loading" && crashState.status !== "pending";

  // When crash recovery was pending at boot, the resolve path (`restoreBackup`
  // or `resetToFresh` in CrashRecoveryService) mutates `store.appState` after
  // `bootResult` was captured. Passing the stale prefetched payload would
  // hydrate from the pre-resolution terminal list and skip the one-shot
  // `consumePanelFilter` the restore path queued. Force the live IPC path in
  // that case so hydration reads the post-resolution store.
  const hadPendingCrash = bootResult?.crashPending != null;
  // App lifecycle hooks
  const { isStateLoaded } = useAppHydration(crashResolved, hadPendingCrash ? null : bootResult);
  useEffect(() => {
    if (isStateLoaded) removeStartupSkeleton();
  }, [isStateLoaded]);

  // ErrorBoundary reset signals for the always-mounted dialog hosts (#9918).
  // A static `[Number(isStateLoaded)]` collapses to `[1]` after hydration and
  // never changes, so a host that crashes once stays dead for the session (and
  // its deferred promise leaks). Each host instead resets on its own
  // pending-request signal, so a fresh request remounts the crashed boundary:
  //   - request-counter stores bump `requestSeq` on every request (covers the
  //     back-to-back supersede case where `pendingConfirm` never returns to null)
  //   - FIFO-queue stores key off the live `current.requestId` UUID
  //   - the diagnostics host toggles on its own `isOpen`
  //   - the event-driven hosts (terminal-info, file-viewer) hold no store state,
  //     so a local counter increments on each open event below.
  const gitPushResetKey = useGitPushConfirmStore((s) => s.requestSeq);
  const gitPullRebaseResetKey = useGitPullRebaseConfirmStore((s) => s.requestSeq);
  const panelLimitResetKey = usePanelLimitStore((s) => s.requestSeq);
  const recipeConflictResetKey = useRecipeConflictStore((s) => s.requestSeq);
  const mcpConfirmResetKey = useMcpConfirmStore((s) => s.current?.requestId ?? "");
  const pluginConfirmResetKey = usePluginConfirmStore((s) => s.current?.requestId ?? "");
  const pluginMcpConfirmResetKey = usePluginMcpConfirmStore((s) => s.current?.requestId ?? "");
  const pluginCapabilityConfirmResetKey = usePluginCapabilityConfirmStore(
    (s) => s.current?.requestId ?? ""
  );
  const diagnosticsReviewResetKey = useDiagnosticsReviewStore((s) => s.requestSeq);
  const [terminalInfoResetKey, setTerminalInfoResetKey] = useState(0);
  const [fileViewerResetKey, setFileViewerResetKey] = useState(0);
  const [diffViewerResetKey, setDiffViewerResetKey] = useState(0);
  useEffect(() => {
    const onTerminalInfo = () => setTerminalInfoResetKey((k) => k + 1);
    const onViewFile = (e: Event) => {
      // Stash for FileViewerModalHost's mount replay — the host's own listener
      // lives in a lazy chunk and may not be registered yet.
      stashViewFileRequest(e);
      setFileViewerResetKey((k) => k + 1);
    };
    const onViewDiff = (e: Event) => {
      // Stash for DiffViewerModalHost's mount replay — same lazy-chunk race as
      // the file viewer above.
      stashViewDiffRequest(e);
      setDiffViewerResetKey((k) => k + 1);
    };
    window.addEventListener("daintree:open-terminal-info", onTerminalInfo);
    window.addEventListener("daintree:view-file", onViewFile);
    window.addEventListener("daintree:view-diff", onViewDiff);
    return () => {
      window.removeEventListener("daintree:open-terminal-info", onTerminalInfo);
      window.removeEventListener("daintree:view-file", onViewFile);
      window.removeEventListener("daintree:view-diff", onViewDiff);
    };
  }, []);
  // Cross-project focus intent receiver. Subscribes unconditionally so the
  // listener is registered before `notifyViewPainted` fires, then defers the
  // local `agent.focusNextWaiting` dispatch until hydration completes (the
  // paint signal arrives before panel state is loaded — a direct dispatch
  // would silently no-op against an empty panelStore).
  useFocusOnActivateIntent(isStateLoaded);
  // Background window-resize receiver — keeps PTY geometry tracking the
  // window while this project view is detached (#10415).
  useBackgroundWindowResize();
  // Clears a stale switch busy flag when this cached view is reactivated, so a
  // view that switched away never re-shows its switch overlay on return (#10736).
  useResetSwitchOverlayOnReveal();
  // `daintree://` deep-link receiver (#9559). Surfaces the intent once hydration
  // settles; the effect below opens the Plugin Manager, which consumes it.
  const pluginDeepLink = usePluginDeepLink(isStateLoaded);
  useEffect(() => {
    if (!pluginDeepLink.intent) return;
    // Opening the manager also closes Settings via the open-transition effect
    // above, so the two surfaces don't stack when the deep link arrives.
    usePluginManagerStore.getState().open();
  }, [pluginDeepLink.intent]);
  // The skeleton is z-index 9999 and intercepts pointer events. The crash
  // recovery dialog is rendered before hydration completes, so without this
  // the dialog would be visible but unclickable until hydration finishes
  // (which it can't, since the user must resolve the crash first).
  useEffect(() => {
    if (crashState.status === "pending" || crashState.status === "failed") {
      removeStartupSkeleton();
    }
  }, [crashState.status]);
  useEffect(() => {
    void useNotificationSettingsStore.getState().hydrate();
    // Subscribe to OS DND transitions before hydrate resolves so a transition
    // mid-hydration cannot be missed. Push events from main are tolerant of
    // an `undefined` namespace at preload (renderer harness in tests).
    const unsubscribe = window.electron?.osDnd?.onStateChanged?.((payload) => {
      useNotificationSettingsStore.getState().setOsDndActive(payload.osDndActive);
    });
    return () => unsubscribe?.();
  }, []);
  // Defers the post-hydration housekeeping IPC reads (shortcut-hint counts,
  // milestones, forge-recommendation plugin/remotes probes) out of the
  // synchronous isStateLoaded effect flush: their sends would otherwise land
  // on main ahead of the loaded-frame paint and compete with the
  // deferred-services drain. The flag flips from the background-priority task
  // below, so the gated hooks hydrate at idle; each reconciles current store
  // state on attach, so nothing observable is lost in the gap.
  const [idleHousekeepingReady, setIdleHousekeepingReady] = useState(false);
  useShortcutHints(isStateLoaded && idleHousekeepingReady);
  const gettingStarted = useGettingStartedChecklist(isStateLoaded);
  const onboardingOverlayActive = gettingStarted.visible || gettingStarted.showCelebration;
  useUpdateListener(onboardingOverlayActive);
  useOrchestrationMilestones(isStateLoaded && idleHousekeepingReady);
  useAgentWaitingNudge(isStateLoaded);
  useForgeEnableRecommendation(isStateLoaded && idleHousekeepingReady);
  useNotificationHistoryPruning();

  useEffect(() => {
    if (!isStateLoaded) return;

    const controller = new AbortController();

    const execute = () => {
      if (controller.signal.aborted) return;
      setIdleHousekeepingReady(true);
      void preloadSettingsDialog();
      void preloadNewWorktreeDialog();
      void preloadActionPalette();
      void preloadQuickSwitcher();
      preloadProjectSwitcherPalette().catch(() => {});
      void preloadWorktreePalette();
      void preloadNewTerminalPalette();
      void preloadPanelPalette();
      void preloadThemePalette();
      void preloadSendToAgentPalette();
      void preloadQuickCreatePalette();
      void preloadLogLevelPalette();
      void preloadPluginManagerView();
      void preloadWorktreeOverviewModal();
      void preloadShortcutReferenceDialog();
      void preloadCrossWorktreeDiff();
      loadJetbrainsMono500().catch(() => {});
      loadJetbrainsMono600().catch(() => {});
      // Warm the FileViewerModal/DiffViewer chunk split out of the eager
      // closure (#8626). It is reached through a lazy boundary in
      // `Worktree/FileDiffModal.tsx`, so an explicit post-paint prefetch keeps
      // it snappy on first use.
      preloadFileViewerModal().catch(() => {});
      // Warm the shared Radix overlay primitives chunk (`radix-deferred`) so the
      // ProjectSwitcherPalette popover and context menus are ready on first
      // interaction in a freshly loaded project view. Otherwise this chunk is
      // only demand-loaded on the first pointer/focus gesture (#10752). Each
      // WebContentsView has its own module cache, so this fires per view.
      primeRadix().catch(() => {});
    };

    if (typeof scheduler !== "undefined" && typeof scheduler.postTask === "function") {
      void scheduler
        .postTask(execute, { priority: "background", signal: controller.signal })
        .catch(() => {});
    } else {
      const id = requestIdleCallback(execute, { timeout: 5000 });
      const cancel = () => cancelIdleCallback(id);
      controller.signal.addEventListener("abort", cancel, { once: true });
    }

    return () => controller.abort();
  }, [isStateLoaded]);

  const handlePreloadSettings = useCallback(() => {
    void preloadSettingsDialog();
  }, []);

  const handleLaunchAgent = useCallback(
    async (type: string) => {
      // launchAgent now throws on an unresolvable worktreeId (#10812). UI surfaces
      // pass no explicit worktreeId (they fall back to the active one), so this is
      // only reachable via a stale activeWorktreeId race — keep it a quiet no-op,
      // matching the pre-fix silent behavior, rather than an unhandled rejection.
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
  usePluginAgents();
  usePluginKeybindings();
  usePluginMcpConsentBridge();
  usePluginCapabilityConsentBridge();

  useMenuActions();

  // Global keybinding handler - provides chord support and priority resolution
  // All keybindings dispatch through ActionService via this centralized handler
  useGlobalKeybindings(electronAvailable);
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
                    resetKeys={[currentProject?.id].filter((k): k is string => k != null)}
                  >
                    <Profiler id="content-grid" onRender={onContentGridRender}>
                      <ContentGrid
                        className="h-full w-full"
                        agentAvailability={availability}
                        defaultCwd={defaultTerminalCwd}
                        emptyContent={
                          currentProject === null ? (
                            <Suspense fallback={null}>
                              <LazyWelcomeScreen gettingStarted={gettingStarted} />
                            </Suspense>
                          ) : undefined
                        }
                      />
                    </Profiler>
                  </ErrorBoundary>
                </AppLayout>
              </Profiler>
            </DndProvider>

            <ErrorBoundary
              variant="component"
              componentName="QuickSwitcher"
              resetKeys={[Number(quickSwitcher.isOpen)]}
            >
              {shouldMountQuickSwitcher && (
                <Suspense fallback={null}>
                  <LazyQuickSwitcher
                    isOpen={quickSwitcher.isOpen}
                    query={quickSwitcher.query}
                    results={quickSwitcher.results}
                    totalResults={quickSwitcher.totalResults}
                    selectedIndex={quickSwitcher.selectedIndex}
                    isLoading={quickSwitcher.isLoading}
                    close={quickSwitcher.close}
                    setQuery={quickSwitcher.setQuery}
                    setSelectedIndex={quickSwitcher.setSelectedIndex}
                    selectPrevious={quickSwitcher.selectPrevious}
                    selectNext={quickSwitcher.selectNext}
                    selectItem={quickSwitcher.selectItem}
                    confirmSelection={quickSwitcher.confirmSelection}
                  />
                </Suspense>
              )}
            </ErrorBoundary>
            <ErrorBoundary
              variant="component"
              componentName="SendToAgentPalette"
              resetKeys={[Number(sendToAgentPalette.isOpen)]}
            >
              {shouldMountSendToAgentPalette && (
                <Suspense fallback={null}>
                  <LazySendToAgentPalette
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
                </Suspense>
              )}
            </ErrorBoundary>
            <ErrorBoundary
              variant="component"
              componentName="NewTerminalPalette"
              resetKeys={[Number(newTerminalPalette.isOpen)]}
            >
              {shouldMountNewTerminalPalette && (
                <Suspense fallback={null}>
                  <LazyNewTerminalPalette
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
                    onHoverIndex={newTerminalPalette.setSelectedIndex}
                  />
                </Suspense>
              )}
            </ErrorBoundary>
            <ErrorBoundary
              variant="component"
              componentName="WorktreePalette"
              resetKeys={[Number(worktreePalette.isOpen)]}
            >
              {shouldMountWorktreePalette && (
                <Suspense fallback={null}>
                  <LazyWorktreePalette
                    isOpen={worktreePalette.isOpen}
                    query={worktreePalette.query}
                    results={worktreePalette.results}
                    totalResults={worktreePalette.totalResults}
                    activeWorktreeId={worktreePalette.activeWorktreeId}
                    selectedIndex={worktreePalette.selectedIndex}
                    isStale={worktreePalette.isStale}
                    onQueryChange={worktreePalette.setQuery}
                    onSelectPrevious={worktreePalette.selectPrevious}
                    onSelectNext={worktreePalette.selectNext}
                    onSelect={worktreePalette.selectWorktree}
                    onConfirm={worktreePalette.confirmSelection}
                    onClose={worktreePalette.close}
                  />
                </Suspense>
              )}
            </ErrorBoundary>
            <ErrorBoundary
              variant="component"
              componentName="QuickCreatePalette"
              resetKeys={[Number(quickCreatePalette.isOpen)]}
            >
              {shouldMountQuickCreatePalette && (
                <Suspense fallback={null}>
                  <LazyQuickCreatePalette palette={quickCreatePalette} />
                </Suspense>
              )}
            </ErrorBoundary>
            <ErrorBoundary
              variant="component"
              componentName="PanelPalette"
              resetKeys={[Number(panelPalette.isOpen)]}
            >
              {shouldMountPanelPalette && (
                <Suspense fallback={null}>
                  <LazyPanelPalette
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
                        const resumeFlags = reconcileResumeLaunchFlags(session);
                        const command =
                          buildResumeCommand(session.agentId, session.sessionId, resumeFlags) ??
                          buildResumeLatestCommand(session.agentId, resumeFlags);
                        if (command && agentConfig) {
                          addPanel({
                            kind: "terminal",
                            launchAgentId: session.agentId,
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
                          void handleLaunchAgent(agentId);
                        }
                      } else {
                        addPanel({
                          kind: result.id as BuiltInPanelKind,
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
                        const resumeFlags = reconcileResumeLaunchFlags(session);
                        const command =
                          buildResumeCommand(session.agentId, session.sessionId, resumeFlags) ??
                          buildResumeLatestCommand(session.agentId, resumeFlags);
                        if (command && agentConfig) {
                          addPanel({
                            kind: "terminal",
                            launchAgentId: session.agentId,
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
                          void handleLaunchAgent(agentId);
                        }
                      } else {
                        addPanel({
                          kind: selected.id as BuiltInPanelKind,
                          cwd: defaultTerminalCwd,
                          worktreeId: activeWorktreeId ?? undefined,
                          location: "grid",
                        });
                      }
                    }}
                    onClose={panelPalette.close}
                  />
                </Suspense>
              )}
            </ErrorBoundary>
            <ErrorBoundary
              variant="component"
              componentName="ProjectSwitcherPalette"
              resetKeys={[Number(isProjectSwitcherModalOpen)]}
            >
              {isProjectSwitcherModalOpen && (
                <Suspense fallback={null}>
                  <LazyProjectSwitcherPalette
                    isOpen={isProjectSwitcherModalOpen}
                    query={projectSwitcherPalette.query}
                    results={projectSwitcherPalette.results}
                    selectedIndex={projectSwitcherPalette.selectedIndex}
                    onQueryChange={projectSwitcherPalette.setQuery}
                    onSelectPrevious={projectSwitcherPalette.selectPrevious}
                    onSelectNext={projectSwitcherPalette.selectNext}
                    onSelect={projectSwitcherPalette.selectProject}
                    onHoverProject={projectSwitcherPalette.onHoverProject}
                    onHoverProjectEnd={projectSwitcherPalette.onHoverProjectEnd}
                    onClose={projectSwitcherPalette.close}
                    onStopProject={(projectId) =>
                      void projectSwitcherPalette.stopProject(projectId)
                    }
                    onCloseProject={(projectId) =>
                      void projectSwitcherPalette.removeProject(projectId)
                    }
                    onLocateProject={(projectId) =>
                      void projectSwitcherPalette.locateProject(projectId)
                    }
                    onTogglePinProject={(projectId) =>
                      void projectSwitcherPalette.togglePinProject(projectId)
                    }
                    onCopyPath={projectSwitcherPalette.copyPath}
                    removeConfirmProject={projectSwitcherPalette.removeConfirmProject}
                    onRemoveConfirmClose={() =>
                      projectSwitcherPalette.setRemoveConfirmProject(null)
                    }
                    onConfirmRemove={projectSwitcherPalette.confirmRemoveProject}
                    isRemovingProject={projectSwitcherPalette.isRemovingProject}
                    onSelectNewWindow={(project) => {
                      projectSwitcherPalette.close();
                      void actionService.dispatch(
                        "app.newWindow",
                        { projectPath: project.path },
                        { source: "user" }
                      );
                    }}
                    scratchResults={projectSwitcherPalette.scratchResults}
                    onCreateScratch={() => void projectSwitcherPalette.createScratch()}
                    onSelectScratch={(scratch) =>
                      void projectSwitcherPalette.selectScratch(scratch)
                    }
                    onRemoveScratch={(scratchId) =>
                      void projectSwitcherPalette.removeScratchAction(scratchId)
                    }
                    onSaveAsProject={(scratchId) =>
                      void projectSwitcherPalette.saveAsProject(scratchId)
                    }
                    saveAsProjectConfirm={projectSwitcherPalette.saveAsProjectConfirm}
                    onDismissSaveAsProjectConfirm={
                      projectSwitcherPalette.dismissSaveAsProjectConfirm
                    }
                    onConfirmDeleteOriginalScratch={() =>
                      void projectSwitcherPalette.confirmDeleteOriginalScratch()
                    }
                    isDeletingOriginalScratch={projectSwitcherPalette.isDeletingOriginalScratch}
                  />
                </Suspense>
              )}
            </ErrorBoundary>
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

            <ErrorBoundary
              variant="component"
              componentName="ThemePalette"
              resetKeys={[Number(isThemePaletteOpen)]}
            >
              {shouldMountThemePalette && (
                <Suspense fallback={null}>
                  <LazyThemePalette isOpen={isThemePaletteOpen} onClose={closeThemePalette} />
                </Suspense>
              )}
            </ErrorBoundary>

            <ErrorBoundary
              variant="component"
              componentName="LogLevelPalette"
              resetKeys={[Number(isLogLevelPaletteOpen)]}
            >
              {shouldMountLogLevelPalette && (
                <Suspense fallback={null}>
                  <LazyLogLevelPalette
                    isOpen={isLogLevelPaletteOpen}
                    onClose={closeLogLevelPalette}
                  />
                </Suspense>
              )}
            </ErrorBoundary>

            <ErrorBoundary
              variant="component"
              componentName="ActionPalette"
              resetKeys={[Number(actionPalette.isOpen)]}
            >
              {shouldMountActionPalette && (
                <Suspense fallback={null}>
                  <LazyActionPalette
                    isOpen={actionPalette.isOpen}
                    query={actionPalette.query}
                    results={actionPalette.results}
                    totalResults={actionPalette.totalResults}
                    selectedIndex={actionPalette.selectedIndex}
                    isStale={actionPalette.isStale}
                    pinnedCount={actionPalette.pinnedCount}
                    close={actionPalette.close}
                    setQuery={actionPalette.setQuery}
                    setSelectedIndex={actionPalette.setSelectedIndex}
                    selectPrevious={actionPalette.selectPrevious}
                    selectNext={actionPalette.selectNext}
                    executeAction={actionPalette.executeAction}
                    confirmSelection={actionPalette.confirmSelection}
                    pinAction={actionPalette.pinAction}
                    unpinAction={actionPalette.unpinAction}
                    hideAction={actionPalette.hideAction}
                  />
                </Suspense>
              )}
            </ErrorBoundary>

            <ErrorBoundary
              variant="component"
              componentName="WorktreeOverviewModal"
              resetKeys={[Number(isWorktreeOverviewOpen)]}
            >
              {isWorktreeOverviewOpen && (
                <Suspense fallback={null}>
                  <LazyWorktreeOverviewModal
                    isOpen={isWorktreeOverviewOpen}
                    onClose={closeWorktreeOverview}
                    worktrees={worktrees}
                    isLoading={isLoading}
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
                </Suspense>
              )}
            </ErrorBoundary>

            <ErrorBoundary
              variant="component"
              componentName="CrossWorktreeDiff"
              resetKeys={[Number(crossDiffDialog.isOpen)]}
            >
              {shouldMountCrossDiffDialog && (
                <Suspense fallback={null}>
                  <LazyCrossWorktreeDiff
                    isOpen={crossDiffDialog.isOpen}
                    onClose={closeCrossWorktreeDiff}
                    initialWorktreeId={crossDiffDialog.initialWorktreeId}
                  />
                </Suspense>
              )}
            </ErrorBoundary>

            <ErrorBoundary
              variant="component"
              componentName="SettingsDialog"
              resetKeys={[Number(isSettingsOpen)]}
            >
              {shouldMountSettings && (
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
            </ErrorBoundary>

            <ErrorBoundary
              variant="component"
              componentName="ShortcutReferenceDialog"
              resetKeys={[Number(isShortcutsOpen)]}
            >
              {shouldMountShortcutsDialog && (
                <Suspense fallback={null}>
                  <LazyShortcutReferenceDialog
                    isOpen={isShortcutsOpen}
                    onClose={() => setIsShortcutsOpen(false)}
                  />
                </Suspense>
              )}
            </ErrorBoundary>

            <ErrorBoundary
              variant="component"
              componentName="PluginManagerView"
              resetKeys={[Number(isPluginManagerOpen)]}
              onError={() => usePluginManagerStore.getState().close()}
            >
              {shouldMountPluginManager && (
                <Suspense fallback={null}>
                  <LazyPluginManagerView
                    deepLinkIntent={pluginDeepLink.intent}
                    onDeepLinkConsumed={pluginDeepLink.clear}
                  />
                </Suspense>
              )}
            </ErrorBoundary>

            <ErrorBoundary
              variant="component"
              componentName="TerminalInfoDialogHost"
              resetKeys={[terminalInfoResetKey]}
            >
              <TerminalInfoDialogHost />
            </ErrorBoundary>
            {isStateLoaded && (
              <ErrorBoundary
                variant="component"
                componentName="McpConfirmDialog"
                resetKeys={[mcpConfirmResetKey]}
              >
                <Suspense fallback={null}>
                  <LazyMcpConfirmDialog />
                </Suspense>
              </ErrorBoundary>
            )}
            {isStateLoaded && (
              <ErrorBoundary
                variant="component"
                componentName="PluginConfirmDialog"
                resetKeys={[pluginConfirmResetKey]}
              >
                <Suspense fallback={null}>
                  <LazyPluginConfirmDialog />
                </Suspense>
              </ErrorBoundary>
            )}
            {isStateLoaded && (
              <ErrorBoundary
                variant="component"
                componentName="PluginMcpConfirmDialog"
                resetKeys={[pluginMcpConfirmResetKey]}
              >
                <Suspense fallback={null}>
                  <LazyPluginMcpConfirmDialog />
                </Suspense>
              </ErrorBoundary>
            )}
            {isStateLoaded && (
              <ErrorBoundary variant="component" componentName="PluginQuickPickDialog">
                <Suspense fallback={null}>
                  <LazyPluginQuickPickDialog />
                </Suspense>
              </ErrorBoundary>
            )}
            {isStateLoaded && (
              <ErrorBoundary variant="component" componentName="PluginInputBoxDialog">
                <Suspense fallback={null}>
                  <LazyPluginInputBoxDialog />
                </Suspense>
              </ErrorBoundary>
            )}
            {isStateLoaded && (
              <ErrorBoundary variant="component" componentName="PluginConfirmPromptDialog">
                <Suspense fallback={null}>
                  <LazyPluginConfirmPromptDialog />
                </Suspense>
              </ErrorBoundary>
            )}
            {isStateLoaded && (
              <ErrorBoundary
                variant="component"
                componentName="PluginCapabilityConfirmDialog"
                resetKeys={[pluginCapabilityConfirmResetKey]}
              >
                <Suspense fallback={null}>
                  <LazyPluginCapabilityConfirmDialog />
                </Suspense>
              </ErrorBoundary>
            )}
            {isStateLoaded && (
              <ErrorBoundary
                variant="component"
                componentName="FileViewerModalHost"
                resetKeys={[fileViewerResetKey]}
              >
                <Suspense fallback={null}>
                  <LazyFileViewerModalHost />
                </Suspense>
              </ErrorBoundary>
            )}
            {isStateLoaded && (
              <ErrorBoundary
                variant="component"
                componentName="DiffViewerModalHost"
                resetKeys={[diffViewerResetKey]}
              >
                <Suspense fallback={null}>
                  <LazyDiffViewerModalHost />
                </Suspense>
              </ErrorBoundary>
            )}

            <ErrorBoundary
              variant="component"
              componentName="GitInitDialog"
              resetKeys={[Number(gitInitDialogOpen)]}
            >
              {shouldMountGitInitDialog && effectiveGitInitPath && (
                <Suspense fallback={null}>
                  <LazyGitInitDialog
                    isOpen={gitInitDialogOpen}
                    directoryPath={effectiveGitInitPath}
                    onSuccess={handleGitInitSuccess}
                    onCancel={closeGitInitDialog}
                  />
                </Suspense>
              )}
            </ErrorBoundary>

            <ErrorBoundary
              variant="component"
              componentName="CreateProjectFolderDialog"
              resetKeys={[Number(createFolderDialogOpen)]}
            >
              {shouldMountCreateFolderDialog && (
                <Suspense fallback={null}>
                  <LazyCreateProjectFolderDialog
                    isOpen={createFolderDialogOpen}
                    onClose={closeCreateFolderDialog}
                  />
                </Suspense>
              )}
            </ErrorBoundary>

            <ErrorBoundary
              variant="component"
              componentName="CloneRepoDialog"
              resetKeys={[Number(cloneRepoDialogOpen)]}
            >
              {shouldMountCloneRepoDialog && (
                <Suspense fallback={null}>
                  <LazyCloneRepoDialog
                    isOpen={cloneRepoDialogOpen}
                    onSuccess={handleCloneSuccess}
                    onCancel={closeCloneRepoDialog}
                  />
                </Suspense>
              )}
            </ErrorBoundary>

            <PanelTransitionOverlay />
            {isStateLoaded && (
              <ErrorBoundary
                variant="component"
                componentName="PanelLimitConfirmDialog"
                resetKeys={[panelLimitResetKey]}
              >
                <Suspense fallback={null}>
                  <LazyPanelLimitConfirmDialog />
                </Suspense>
              </ErrorBoundary>
            )}

            {isStateLoaded && (
              <ErrorBoundary
                variant="component"
                componentName="DiagnosticsReviewDialogHost"
                resetKeys={[diagnosticsReviewResetKey]}
              >
                <Suspense fallback={null}>
                  <LazyDiagnosticsReviewDialogHost />
                </Suspense>
              </ErrorBoundary>
            )}

            {isStateLoaded && (
              <ErrorBoundary
                variant="component"
                componentName="GitPushConfirmDialog"
                resetKeys={[gitPushResetKey]}
              >
                <Suspense fallback={null}>
                  <LazyGitPushConfirmDialog />
                </Suspense>
              </ErrorBoundary>
            )}

            {isStateLoaded && (
              <ErrorBoundary
                variant="component"
                componentName="GitPullRebaseConfirmDialog"
                resetKeys={[gitPullRebaseResetKey]}
              >
                <Suspense fallback={null}>
                  <LazyGitPullRebaseConfirmDialog />
                </Suspense>
              </ErrorBoundary>
            )}

            {isStateLoaded && (
              <ErrorBoundary
                variant="component"
                componentName="RecipeConflictDialog"
                resetKeys={[recipeConflictResetKey]}
              >
                <Suspense fallback={null}>
                  <LazyRecipeConflictDialog />
                </Suspense>
              </ErrorBoundary>
            )}

            <Toaster />
            <ShortcutHint />
            <ReEntrySummary state={reEntrySummary} />
            {/* Listener hooks deferred out of the first commit flush — mount once
                hydration settles so their effects stay off the first effect flush (#9769). */}
            {isStateLoaded && <PostHydrationListeners />}
            {isStateLoaded && (
              <ErrorBoundary
                variant="component"
                componentName="OnboardingFlow"
                resetKeys={[Number(isStateLoaded)]}
              >
                <Suspense fallback={null}>
                  <LazyOnboardingFlow
                    availability={availability}
                    onRefreshSettings={refreshSettings}
                    onComplete={gettingStarted.notifyOnboardingComplete}
                  />
                </Suspense>
              </ErrorBoundary>
            )}
            {currentProject !== null && gettingStarted.visible && gettingStarted.checklist && (
              <ErrorBoundary
                variant="component"
                componentName="GettingStartedChecklist"
                resetKeys={[Number(gettingStarted.visible)]}
              >
                <Suspense fallback={null}>
                  <LazyGettingStartedChecklist
                    checklist={gettingStarted.checklist}
                    collapsed={gettingStarted.collapsed}
                    onDismiss={gettingStarted.dismiss}
                    onToggleCollapse={gettingStarted.toggleCollapse}
                    onMarkItem={gettingStarted.markItem}
                  />
                </Suspense>
              </ErrorBoundary>
            )}
            <ErrorBoundary
              variant="component"
              componentName="CelebrationConfetti"
              resetKeys={[Number(gettingStarted.showCelebration)]}
            >
              {gettingStarted.showCelebration && (
                <Suspense fallback={null}>
                  <LazyCelebrationConfetti />
                </Suspense>
              )}
            </ErrorBoundary>
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
