// Module-scope lazy()/preload() declarations for App.tsx's modal, palette,
// and dialog hosts. These must stay outside any component body — raw import()
// expressions inside a component effect bail React Compiler memoization — and
// this module is imported statically (never via its own lazy()/import()) so its
// code stays in the App.tsx chunk that the V8 compile hint targets by facade path.
import { lazy } from "react";

export const loadE2ENotificationBackdoor = () => import("./lib/e2eNotificationBackdoor");

export function preloadModalHostLayer() {
  return import("./ModalHostLayer");
}
export const LazyModalHostLayer = lazy(() =>
  preloadModalHostLayer().then((m) => ({ default: m.ModalHostLayer }))
);

// Direct file import (not the Project barrel) so the lazy chunk doesn't pull
// in barrel siblings. Renders only when no project is open, so it stays off
// the returning-user first-paint path.
export function preloadWelcomeScreen() {
  return import("./components/Project/WelcomeScreen");
}
export const LazyWelcomeScreen = lazy(() =>
  preloadWelcomeScreen().then((m) => ({ default: m.WelcomeScreen }))
);

export function preloadSettingsDialog() {
  return import("./components/Settings/SettingsDialog");
}
export const LazySettingsDialog = lazy(() =>
  preloadSettingsDialog().then((m) => ({ default: m.SettingsDialog }))
);

export function preloadWorktreePalette() {
  return import("./components/Worktree/WorktreePalette");
}
export const LazyWorktreePalette = lazy(() =>
  preloadWorktreePalette().then((m) => ({ default: m.WorktreePalette }))
);

export function preloadWorktreeOverviewModal() {
  return import("./components/Worktree/WorktreeOverviewModal");
}
export const LazyWorktreeOverviewModal = lazy(() =>
  preloadWorktreeOverviewModal().then((m) => ({ default: m.WorktreeOverviewModal }))
);

export function preloadPilotView() {
  return import("./components/Pilot/PilotView");
}
export const LazyPilotView = lazy(() => preloadPilotView().then((m) => ({ default: m.PilotView })));

export function preloadQuickCreatePalette() {
  return import("./components/Worktree/QuickCreatePalette");
}
export const LazyQuickCreatePalette = lazy(() =>
  preloadQuickCreatePalette().then((m) => ({ default: m.QuickCreatePalette }))
);

export function preloadCrossWorktreeDiff() {
  return import("./components/Worktree/CrossWorktreeDiff");
}
export const LazyCrossWorktreeDiff = lazy(() =>
  preloadCrossWorktreeDiff().then((m) => ({ default: m.CrossWorktreeDiff }))
);

export function preloadNewTerminalPalette() {
  return import("./components/TerminalPalette/NewTerminalPalette");
}
export const LazyNewTerminalPalette = lazy(() =>
  preloadNewTerminalPalette().then((m) => ({ default: m.NewTerminalPalette }))
);

export function preloadSendToAgentPalette() {
  return import("./components/Terminal/SendToAgentPalette");
}
export const LazySendToAgentPalette = lazy(() =>
  preloadSendToAgentPalette().then((m) => ({ default: m.SendToAgentPalette }))
);

export function preloadPanelPalette() {
  return import("./components/PanelPalette/PanelPalette");
}
export const LazyPanelPalette = lazy(() =>
  preloadPanelPalette().then((m) => ({ default: m.PanelPalette }))
);

export function preloadActionPalette() {
  return import("./components/ActionPalette/ActionPalette");
}
export const LazyActionPalette = lazy(() =>
  preloadActionPalette().then((m) => ({ default: m.ActionPalette }))
);

export function preloadQuickSwitcher() {
  return import("./components/QuickSwitcher/QuickSwitcher");
}
export const LazyQuickSwitcher = lazy(() =>
  preloadQuickSwitcher().then((m) => ({ default: m.QuickSwitcher }))
);

export function preloadProjectSwitcherPalette() {
  return import("./components/Project/ProjectSwitcherPalette");
}
export const LazyProjectSwitcherPalette = lazy(() =>
  preloadProjectSwitcherPalette().then((m) => ({ default: m.ProjectSwitcherPalette }))
);

export function preloadGitInitDialog() {
  return import("./components/Project/NonGitFolderDialog");
}
export const LazyGitInitDialog = lazy(() =>
  preloadGitInitDialog().then((m) => ({ default: m.NonGitFolderDialog }))
);

export function preloadCloneRepoDialog() {
  return import("./components/Project/CloneRepoDialog");
}
export const LazyCloneRepoDialog = lazy(() =>
  preloadCloneRepoDialog().then((m) => ({ default: m.CloneRepoDialog }))
);

export function preloadCreateProjectFolderDialog() {
  return import("./components/Project/CreateProjectFolderDialog");
}
export const LazyCreateProjectFolderDialog = lazy(() =>
  preloadCreateProjectFolderDialog().then((m) => ({ default: m.CreateProjectFolderDialog }))
);

export function preloadThemePalette() {
  return import("./components/ThemePalette/ThemePalette");
}
export const LazyThemePalette = lazy(() =>
  preloadThemePalette().then((m) => ({ default: m.ThemePalette }))
);
export const LazyResumeSessionsPalette = lazy(() =>
  import("./components/Terminal/ResumeSessionsPalette").then((m) => ({
    default: m.ResumeSessionsPalette,
  }))
);

export function preloadLogLevelPalette() {
  return import("./components/LogLevelPalette/LogLevelPalette");
}
export const LazyLogLevelPalette = lazy(() =>
  preloadLogLevelPalette().then((m) => ({ default: m.LogLevelPalette }))
);

export function preloadShortcutReferenceDialog() {
  return import("./components/KeyboardShortcuts/ShortcutReferenceDialog");
}
export const LazyShortcutReferenceDialog = lazy(() =>
  preloadShortcutReferenceDialog().then((m) => ({ default: m.ShortcutReferenceDialog }))
);

export function preloadPluginManagerView() {
  return import("./components/Plugin/PluginManagerView");
}
export const LazyPluginManagerView = lazy(() =>
  preloadPluginManagerView().then((m) => ({ default: m.PluginManagerView }))
);

export function preloadOnboardingFlow() {
  return import("./components/Onboarding/OnboardingFlow");
}
export const LazyOnboardingFlow = lazy(() =>
  preloadOnboardingFlow().then((m) => ({ default: m.OnboardingFlow }))
);

export function preloadGettingStartedChecklist() {
  return import("./components/Onboarding/GettingStartedChecklist");
}
export const LazyGettingStartedChecklist = lazy(() =>
  preloadGettingStartedChecklist().then((m) => ({ default: m.GettingStartedChecklist }))
);

export function preloadCelebrationConfetti() {
  return import("./components/Onboarding/CelebrationConfetti");
}
export const LazyCelebrationConfetti = lazy(() =>
  preloadCelebrationConfetti().then((m) => ({ default: m.CelebrationConfetti }))
);

export function preloadPanelDialogHost() {
  return import("./components/Panel/PanelDialogHost");
}
export const LazyPanelDialogHost = lazy(() =>
  preloadPanelDialogHost().then((m) => ({ default: m.PanelDialogHost }))
);

export function preloadMcpConfirmDialog() {
  return import("./components/McpConfirmDialog");
}
export const LazyMcpConfirmDialog = lazy(() =>
  preloadMcpConfirmDialog().then((m) => ({ default: m.McpConfirmDialog }))
);

export function preloadPluginConfirmDialog() {
  return import("./components/Plugin/PluginConfirmDialog");
}
export const LazyPluginConfirmDialog = lazy(() =>
  preloadPluginConfirmDialog().then((m) => ({ default: m.PluginConfirmDialog }))
);

export const LazyPluginArchiveInstallConfirmDialog = lazy(() =>
  import("./components/Plugin/PluginArchiveInstallConfirmDialog").then((m) => ({
    default: m.PluginArchiveInstallConfirmDialog,
  }))
);

export function preloadPluginMcpConfirmDialog() {
  return import("./components/Plugin/PluginMcpConfirmDialog");
}
export const LazyPluginMcpConfirmDialog = lazy(() =>
  preloadPluginMcpConfirmDialog().then((m) => ({ default: m.PluginMcpConfirmDialog }))
);

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
export function preloadPluginCapabilityConfirmDialog() {
  return import("./components/Plugin/PluginCapabilityConfirmDialog");
}
export const LazyPluginCapabilityConfirmDialog = lazy(() =>
  preloadPluginCapabilityConfirmDialog().then((m) => ({
    default: m.PluginCapabilityConfirmDialog,
  }))
);
export const LazyProjectPluginTrustDialog = lazy(() =>
  import("./components/Plugin/ProjectPluginTrustDialog").then((m) => ({
    default: m.ProjectPluginTrustDialog,
  }))
);

export function preloadPanelLimitConfirmDialog() {
  return import("./components/Terminal/PanelLimitConfirmDialog");
}
export const LazyPanelLimitConfirmDialog = lazy(() =>
  preloadPanelLimitConfirmDialog().then((m) => ({ default: m.PanelLimitConfirmDialog }))
);

export function preloadDiagnosticsReviewDialogHost() {
  return import("./components/Settings/DiagnosticsReviewDialogHost");
}
export const LazyDiagnosticsReviewDialogHost = lazy(() =>
  preloadDiagnosticsReviewDialogHost().then((m) => ({ default: m.DiagnosticsReviewDialogHost }))
);

export function preloadGitPushConfirmDialog() {
  return import("./components/Git/GitPushConfirmDialog");
}
export const LazyGitPushConfirmDialog = lazy(() =>
  preloadGitPushConfirmDialog().then((m) => ({ default: m.GitPushConfirmDialog }))
);

export function preloadGitPullRebaseConfirmDialog() {
  return import("./components/Git/GitPullRebaseConfirmDialog");
}
export const LazyGitPullRebaseConfirmDialog = lazy(() =>
  preloadGitPullRebaseConfirmDialog().then((m) => ({
    default: m.GitPullRebaseConfirmDialog,
  }))
);

export function preloadGitWorktreeOperationConfirmDialog() {
  return import("./components/Git/GitWorktreeOperationConfirmDialog");
}
export const LazyGitWorktreeOperationConfirmDialog = lazy(() =>
  preloadGitWorktreeOperationConfirmDialog().then((m) => ({
    default: m.GitWorktreeOperationConfirmDialog,
  }))
);

export function preloadGitForcePushConfirmDialog() {
  return import("./components/Git/GitForcePushConfirmDialog");
}
export const LazyGitForcePushConfirmDialog = lazy(() =>
  preloadGitForcePushConfirmDialog().then((m) => ({
    default: m.GitForcePushConfirmDialog,
  }))
);

export function preloadRecipeConflictDialog() {
  return import("./components/TerminalRecipe/RecipeConflictDialog");
}
export const LazyRecipeConflictDialog = lazy(() =>
  preloadRecipeConflictDialog().then((m) => ({ default: m.RecipeConflictDialog }))
);

export function preloadCrashRecoveryDialog() {
  return import("./components/Recovery/CrashRecoveryDialog");
}
export const LazyCrashRecoveryDialog = lazy(() =>
  preloadCrashRecoveryDialog().then((m) => ({ default: m.CrashRecoveryDialog }))
);

export const loadMotionFeatures = () => import("./lib/motionFeatures").then((mod) => mod.default);
