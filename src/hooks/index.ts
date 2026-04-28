export { useWorktrees, useWorktree } from "./useWorktrees";
export type { UseWorktreesReturn } from "./useWorktrees";

export { useElectron, isElectronAvailable } from "./useElectron";

export { useAgentLauncher } from "./useAgentLauncher";
export type { LaunchAgentOptions, UseAgentLauncherReturn } from "./useAgentLauncher";

export { useContextInjection } from "./useContextInjection";
export type { UseContextInjectionReturn, InjectionStatus } from "./useContextInjection";

export { useErrors } from "./useErrors";
export { useHibernationNotifications } from "./useHibernationNotifications";
export { useDiskSpaceWarnings } from "./useDiskSpaceWarnings";

export { useQuickSwitcher } from "./useQuickSwitcher";
export type { QuickSwitcherItem, UseQuickSwitcherReturn } from "./useQuickSwitcher";
export { useNewTerminalPalette } from "./useNewTerminalPalette";
export { usePanelPalette } from "./usePanelPalette";
export type { PanelKindOption, UsePanelPaletteReturn } from "./usePanelPalette";
export { useProjectSwitcherPalette } from "./useProjectSwitcherPalette";
export type {
  SearchableProject,
  UseProjectSwitcherPaletteReturn,
} from "./useProjectSwitcherPalette";
export { useTerminalConfig } from "./useTerminalConfig";
export { useAppThemeConfig } from "./useAppThemeConfig";

export { useWorktreeTerminals } from "./useWorktreeTerminals";
export type { WorktreeTerminalCounts, UseWorktreeTerminalsResult } from "./useWorktreeTerminals";

export { useKeybinding, useKeybindingScope, useKeybindingDisplay } from "./useKeybinding";
export type { UseKeybindingOptions } from "./useKeybinding";
export { useGlobalKeybindings, usePendingChord } from "./useGlobalKeybindings";
export { keybindingService } from "../services/KeybindingService";
export type { KeyScope, KeybindingConfig } from "../services/KeybindingService";

export { useProjectSettings } from "./useProjectSettings";
export { useProjectSettingsForm } from "./useProjectSettingsForm";
export {
  useProjectBranding,
  invalidateBrandingCache,
  updateBrandingCache,
} from "./useProjectBranding";

export { useWaitingTerminalIds, useBackgroundPanelStats } from "./useTerminalSelectors";

export { useWorktreeColorMap } from "./useWorktreeColorMap";

export { useOverlayClaim, useOverlayState } from "./useOverlayState";

export { useEscapeStack } from "./useEscapeStack";
export { useGlobalEscapeDispatcher } from "./useGlobalEscapeDispatcher";

export { useGridNavigation } from "./useGridNavigation";
export type { NavigationDirection } from "./useGridNavigation";

export { useLayoutState } from "./useLayoutState";
export type { LayoutState } from "./useLayoutState";

export { useWindowNotifications } from "./useWindowNotifications";
export { useWatchedPanelNotifications } from "./useWatchedPanelNotifications";

export { useReEntrySummary } from "./useReEntrySummary";
export type { ReEntrySummaryState, ReEntryCounts } from "./useReEntrySummary";

export { useWorktreeActions } from "./useWorktreeActions";
export type { UseWorktreeActionsOptions, WorktreeActions } from "./useWorktreeActions";

export { useMenuActions } from "./useMenuActions";
export type { UseMenuActionsOptions } from "./useMenuActions";

export { useHorizontalScrollControls } from "./useHorizontalScrollControls";
export type { UseHorizontalScrollControlsReturn } from "./useHorizontalScrollControls";

export { useVerticalScrollShadows } from "./useVerticalScrollShadows";
export type { UseVerticalScrollShadowsReturn } from "./useVerticalScrollShadows";

export { useDockRenderState } from "./useDockRenderState";

export { useActionPalette } from "./useActionPalette";
export type { ActionPaletteItem, UseActionPaletteReturn } from "./useActionPalette";

export { useDoubleShift } from "./useDoubleShift";

export { useProjectMruSwitcher } from "./useProjectMruSwitcher";
export type { UseProjectMruSwitcherReturn } from "./useProjectMruSwitcher";

export { useMainProcessToastListener } from "./useMainProcessToastListener";

export { useAnimatedPresence } from "./useAnimatedPresence";
export type { UseAnimatedPresenceOptions, UseAnimatedPresenceReturn } from "./useAnimatedPresence";

export { usePanelLifecycle } from "./usePanelLifecycle";
export type { PanelLifecycle } from "./usePanelLifecycle";

export { usePanelHandlers } from "./usePanelHandlers";
export type { UsePanelHandlersConfig, PanelHandlers } from "./usePanelHandlers";

export { useUnsavedChanges } from "./useUnsavedChanges";
export type { UseUnsavedChangesOptions } from "./useUnsavedChanges";

export { useDebounce } from "./useDebounce";

export { useShortcutHintHover } from "./useShortcutHintHover";

export { useTruncationDetection, isElementTruncated } from "./useTruncationDetection";
