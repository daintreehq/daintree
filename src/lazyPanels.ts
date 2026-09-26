// Module-scope lazy()/preload() declarations for App.tsx's modal, palette,
// and dialog hosts. These must stay outside any component body — raw import()
// expressions inside a component effect bail React Compiler memoization — and
// this module is imported statically (never via its own lazy()/import()) so its
// code stays in the App.tsx chunk that the V8 compile hint targets by facade path.
import { lazy } from "react";
import { lazyWithPreload } from "./lib/lazyWithPreload";

export const loadE2ENotificationBackdoor = () => import("./lib/e2eNotificationBackdoor");

export const LazyModalHostLayer = lazyWithPreload(
  () => import("./ModalHostLayer"),
  (m) => m.ModalHostLayer
);
export const preloadModalHostLayer = LazyModalHostLayer.preload;

// Direct file import (not the Project barrel) so the lazy chunk doesn't pull
// in barrel siblings. Renders only when no project is open, so it stays off
// the returning-user first-paint path.
export const LazyWelcomeScreen = lazyWithPreload(
  () => import("./components/Project/WelcomeScreen"),
  (m) => m.WelcomeScreen
);
export const preloadWelcomeScreen = LazyWelcomeScreen.preload;

export const LazySettingsDialog = lazyWithPreload(
  () => import("./components/Settings/SettingsDialog"),
  (m) => m.SettingsDialog
);
export const preloadSettingsDialog = LazySettingsDialog.preload;

export const LazyWorktreePalette = lazyWithPreload(
  () => import("./components/Worktree/WorktreePalette"),
  (m) => m.WorktreePalette
);
export const preloadWorktreePalette = LazyWorktreePalette.preload;

export const LazyWorktreeOverviewModal = lazyWithPreload(
  () => import("./components/Worktree/WorktreeOverviewModal"),
  (m) => m.WorktreeOverviewModal
);
export const preloadWorktreeOverviewModal = LazyWorktreeOverviewModal.preload;

export const LazyPilotView = lazyWithPreload(
  () => import("./components/Pilot/PilotView"),
  (m) => m.PilotView
);
export const preloadPilotView = LazyPilotView.preload;

export const LazyQuickCreatePalette = lazyWithPreload(
  () => import("./components/Worktree/QuickCreatePalette"),
  (m) => m.QuickCreatePalette
);
export const preloadQuickCreatePalette = LazyQuickCreatePalette.preload;

export const LazyCrossWorktreeDiff = lazyWithPreload(
  () => import("./components/Worktree/CrossWorktreeDiff"),
  (m) => m.CrossWorktreeDiff
);
export const preloadCrossWorktreeDiff = LazyCrossWorktreeDiff.preload;

export const LazyNewTerminalPalette = lazyWithPreload(
  () => import("./components/TerminalPalette/NewTerminalPalette"),
  (m) => m.NewTerminalPalette
);
export const preloadNewTerminalPalette = LazyNewTerminalPalette.preload;

export const LazySendToAgentPalette = lazyWithPreload(
  () => import("./components/Terminal/SendToAgentPalette"),
  (m) => m.SendToAgentPalette
);
export const preloadSendToAgentPalette = LazySendToAgentPalette.preload;

export const LazyPanelPalette = lazyWithPreload(
  () => import("./components/PanelPalette/PanelPalette"),
  (m) => m.PanelPalette
);
export const preloadPanelPalette = LazyPanelPalette.preload;

export const LazyActionPalette = lazyWithPreload(
  () => import("./components/ActionPalette/ActionPalette"),
  (m) => m.ActionPalette
);
export const preloadActionPalette = LazyActionPalette.preload;

export const LazyQuickSwitcher = lazyWithPreload(
  () => import("./components/QuickSwitcher/QuickSwitcher"),
  (m) => m.QuickSwitcher
);
export const preloadQuickSwitcher = LazyQuickSwitcher.preload;

export const LazyProjectSwitcherPalette = lazyWithPreload(
  () => import("./components/Project/ProjectSwitcherPalette"),
  (m) => m.ProjectSwitcherPalette
);
export const preloadProjectSwitcherPalette = LazyProjectSwitcherPalette.preload;

export const LazyGitInitDialog = lazyWithPreload(
  () => import("./components/Project/NonGitFolderDialog"),
  (m) => m.NonGitFolderDialog
);
export const preloadGitInitDialog = LazyGitInitDialog.preload;

export const LazyCloneRepoDialog = lazyWithPreload(
  () => import("./components/Project/CloneRepoDialog"),
  (m) => m.CloneRepoDialog
);
export const preloadCloneRepoDialog = LazyCloneRepoDialog.preload;

export const LazyCreateProjectFolderDialog = lazyWithPreload(
  () => import("./components/Project/CreateProjectFolderDialog"),
  (m) => m.CreateProjectFolderDialog
);
export const preloadCreateProjectFolderDialog = LazyCreateProjectFolderDialog.preload;

export const LazyThemePalette = lazyWithPreload(
  () => import("./components/ThemePalette/ThemePalette"),
  (m) => m.ThemePalette
);
export const preloadThemePalette = LazyThemePalette.preload;
export const LazyResumeSessionsPalette = lazy(() =>
  import("./components/Terminal/ResumeSessionsPalette").then((m) => ({
    default: m.ResumeSessionsPalette,
  }))
);

export const LazyLogLevelPalette = lazyWithPreload(
  () => import("./components/LogLevelPalette/LogLevelPalette"),
  (m) => m.LogLevelPalette
);
export const preloadLogLevelPalette = LazyLogLevelPalette.preload;

export const LazyShortcutReferenceDialog = lazyWithPreload(
  () => import("./components/KeyboardShortcuts/ShortcutReferenceDialog"),
  (m) => m.ShortcutReferenceDialog
);
export const preloadShortcutReferenceDialog = LazyShortcutReferenceDialog.preload;

export const LazyPluginManagerView = lazyWithPreload(
  () => import("./components/Plugin/PluginManagerView"),
  (m) => m.PluginManagerView
);
export const preloadPluginManagerView = LazyPluginManagerView.preload;

export const LazyOnboardingFlow = lazyWithPreload(
  () => import("./components/Onboarding/OnboardingFlow"),
  (m) => m.OnboardingFlow
);
export const preloadOnboardingFlow = LazyOnboardingFlow.preload;

export const LazyGettingStartedChecklist = lazyWithPreload(
  () => import("./components/Onboarding/GettingStartedChecklist"),
  (m) => m.GettingStartedChecklist
);
export const preloadGettingStartedChecklist = LazyGettingStartedChecklist.preload;

export const LazyPanelDialogHost = lazyWithPreload(
  () => import("./components/Panel/PanelDialogHost"),
  (m) => m.PanelDialogHost
);
export const preloadPanelDialogHost = LazyPanelDialogHost.preload;

export const LazyMcpConfirmDialog = lazyWithPreload(
  () => import("./components/McpConfirmDialog"),
  (m) => m.McpConfirmDialog
);
export const preloadMcpConfirmDialog = LazyMcpConfirmDialog.preload;

export const LazyPluginConfirmDialog = lazyWithPreload(
  () => import("./components/Plugin/PluginConfirmDialog"),
  (m) => m.PluginConfirmDialog
);
export const preloadPluginConfirmDialog = LazyPluginConfirmDialog.preload;

export const LazyPluginArchiveInstallConfirmDialog = lazy(() =>
  import("./components/Plugin/PluginArchiveInstallConfirmDialog").then((m) => ({
    default: m.PluginArchiveInstallConfirmDialog,
  }))
);

export const LazyPluginMcpConfirmDialog = lazyWithPreload(
  () => import("./components/Plugin/PluginMcpConfirmDialog"),
  (m) => m.PluginMcpConfirmDialog
);
export const preloadPluginMcpConfirmDialog = LazyPluginMcpConfirmDialog.preload;

export const LazyPluginQuickPickDialog = lazy(() =>
  import("./components/Plugin/PluginQuickPickDialog").then((m) => ({
    default: m.PluginQuickPickDialog,
  }))
);
export const LazyPluginInputBoxDialog = lazy(() =>
  import("./components/Plugin/PluginInputBoxDialog").then((m) => ({
    default: m.PluginInputBoxDialog,
  }))
);
export const LazyPluginConfirmPromptDialog = lazy(() =>
  import("./components/Plugin/PluginConfirmPromptDialog").then((m) => ({
    default: m.PluginConfirmPromptDialog,
  }))
);
export const LazyPluginCapabilityConfirmDialog = lazyWithPreload(
  () => import("./components/Plugin/PluginCapabilityConfirmDialog"),
  (m) => m.PluginCapabilityConfirmDialog
);
export const preloadPluginCapabilityConfirmDialog = LazyPluginCapabilityConfirmDialog.preload;

export const LazyPanelLimitConfirmDialog = lazyWithPreload(
  () => import("./components/Terminal/PanelLimitConfirmDialog"),
  (m) => m.PanelLimitConfirmDialog
);
export const preloadPanelLimitConfirmDialog = LazyPanelLimitConfirmDialog.preload;

export const LazyDiagnosticsReviewDialogHost = lazyWithPreload(
  () => import("./components/Settings/DiagnosticsReviewDialogHost"),
  (m) => m.DiagnosticsReviewDialogHost
);
export const preloadDiagnosticsReviewDialogHost = LazyDiagnosticsReviewDialogHost.preload;

export const LazyGitPushConfirmDialog = lazyWithPreload(
  () => import("./components/Git/GitPushConfirmDialog"),
  (m) => m.GitPushConfirmDialog
);
export const preloadGitPushConfirmDialog = LazyGitPushConfirmDialog.preload;

export const LazyGitPullRebaseConfirmDialog = lazyWithPreload(
  () => import("./components/Git/GitPullRebaseConfirmDialog"),
  (m) => m.GitPullRebaseConfirmDialog
);
export const preloadGitPullRebaseConfirmDialog = LazyGitPullRebaseConfirmDialog.preload;

export const LazyGitWorktreeOperationConfirmDialog = lazyWithPreload(
  () => import("./components/Git/GitWorktreeOperationConfirmDialog"),
  (m) => m.GitWorktreeOperationConfirmDialog
);
export const preloadGitWorktreeOperationConfirmDialog =
  LazyGitWorktreeOperationConfirmDialog.preload;

export const LazyGitForcePushConfirmDialog = lazyWithPreload(
  () => import("./components/Git/GitForcePushConfirmDialog"),
  (m) => m.GitForcePushConfirmDialog
);
export const preloadGitForcePushConfirmDialog = LazyGitForcePushConfirmDialog.preload;

export const LazyRecipeConflictDialog = lazyWithPreload(
  () => import("./components/TerminalRecipe/RecipeConflictDialog"),
  (m) => m.RecipeConflictDialog
);
export const preloadRecipeConflictDialog = LazyRecipeConflictDialog.preload;

export const LazyCrashRecoveryDialog = lazyWithPreload(
  () => import("./components/Recovery/CrashRecoveryDialog"),
  (m) => m.CrashRecoveryDialog
);
export const preloadCrashRecoveryDialog = LazyCrashRecoveryDialog.preload;

export const LazyPortalDock = lazyWithPreload(
  () => import("./components/Portal/PortalDock"),
  (m) => m.PortalDock
);
export const preloadPortalDock = LazyPortalDock.preload;

export const loadMotionFeatures = () => import("./lib/motionFeatures").then((mod) => mod.default);
