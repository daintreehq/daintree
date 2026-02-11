export { useWorktrees, useWorktree } from "./useWorktrees";
export type { UseWorktreesReturn } from "./useWorktrees";

export { useElectron, isElectronAvailable } from "./useElectron";

export { useAgentLauncher } from "./useAgentLauncher";
export type { LaunchAgentOptions, UseAgentLauncherReturn } from "./useAgentLauncher";

export { useContextInjection } from "./useContextInjection";
export type { UseContextInjectionReturn, InjectionStatus } from "./useContextInjection";

export { useErrors } from "./useErrors";

export { useTerminalPalette } from "./useTerminalPalette";
export type { SearchableTerminal, UseTerminalPaletteReturn } from "./useTerminalPalette";
export { useNewTerminalPalette } from "./useNewTerminalPalette";
export { usePanelPalette } from "./usePanelPalette";
export type { PanelKindOption, UsePanelPaletteReturn } from "./usePanelPalette";
export { useProjectSwitcherPalette } from "./useProjectSwitcherPalette";
export type {
  SearchableProject,
  UseProjectSwitcherPaletteReturn,
} from "./useProjectSwitcherPalette";
export { useTerminalConfig } from "./useTerminalConfig";

export { useWorktreeTerminals } from "./useWorktreeTerminals";
export type { WorktreeTerminalCounts, UseWorktreeTerminalsResult } from "./useWorktreeTerminals";

export { useKeybinding, useKeybindingScope, useKeybindingDisplay } from "./useKeybinding";
export type { UseKeybindingOptions } from "./useKeybinding";
export { useGlobalKeybindings, usePendingChord } from "./useGlobalKeybindings";
export { keybindingService } from "../services/KeybindingService";
export type { KeyScope, KeybindingConfig } from "../services/KeybindingService";

export { useProjectSettings } from "./useProjectSettings";
export { useProjectBranding } from "./useProjectBranding";

export { useWaitingTerminalIds, useBackgroundPanelStats } from "./useTerminalSelectors";

export { useLinkDiscovery } from "./useLinkDiscovery";

export { useOverlayState } from "./useOverlayState";

export { useGridNavigation } from "./useGridNavigation";
export type { NavigationDirection } from "./useGridNavigation";

export { useLayoutState } from "./useLayoutState";
export type { LayoutState } from "./useLayoutState";

export { useWindowNotifications } from "./useWindowNotifications";

export { useWorktreeActions } from "./useWorktreeActions";
export type { UseWorktreeActionsOptions, WorktreeActions } from "./useWorktreeActions";

export { useMenuActions } from "./useMenuActions";
export type { UseMenuActionsOptions } from "./useMenuActions";

export { useNativeContextMenu } from "./useNativeContextMenu";

export { useHorizontalScrollControls } from "./useHorizontalScrollControls";
export type { UseHorizontalScrollControlsReturn } from "./useHorizontalScrollControls";

export { useDockRenderState } from "./useDockRenderState";

export { useAppAgentDispatcher } from "./useAppAgentDispatcher";

export { useAssistantStreamProcessor } from "./useAssistantStreamProcessor";

export { useActionPalette } from "./useActionPalette";
export type { ActionPaletteItem, UseActionPaletteReturn } from "./useActionPalette";

export { useDoubleShift } from "./useDoubleShift";

export { useUpdateListener } from "./useUpdateListener";

export { useAnimatedPresence } from "./useAnimatedPresence";
export type { UseAnimatedPresenceOptions, UseAnimatedPresenceReturn } from "./useAnimatedPresence";

export { usePanelLifecycle } from "./usePanelLifecycle";
export type { PanelLifecycle } from "./usePanelLifecycle";

export { usePanelHandlers } from "./usePanelHandlers";
export type { UsePanelHandlersConfig, PanelHandlers } from "./usePanelHandlers";
