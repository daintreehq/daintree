export { useTerminalStore, isAgentReady, getTerminalRefreshTier } from "./terminalStore";
export type { TerminalInstance, AddTerminalOptions, QueuedCommand } from "./terminalStore";
export type { CrashType } from "@shared/types/pty-host";
export { MAX_GRID_TERMINALS } from "./slices/terminalRegistrySlice";

// Panel aliases for new code (gradual migration from terminal naming)
export { useTerminalStore as usePanelStore } from "./terminalStore";
export type { TerminalInstance as PanelInstance } from "./terminalStore";
export type { AddTerminalOptions as AddPanelOptions } from "./terminalStore";

export { useWorktreeSelectionStore } from "./worktreeStore";

export {
  useWorktreeDataStore,
  cleanupWorktreeDataStore,
  forceReinitializeWorktreeDataStore,
} from "./worktreeDataStore";

export { useLogsStore, filterLogs } from "./logsStore";

export { useErrorStore } from "./errorStore";
export type { AppError, ErrorType, RetryAction } from "./errorStore";

export { useEventStore } from "./eventStore";

export { useProjectStore } from "./projectStore";

export { useProjectSettingsStore, cleanupProjectSettingsStore } from "./projectSettingsStore";

export { useFocusStore } from "./focusStore";
export type { PanelState } from "./focusStore";

export { useNotificationStore } from "./notificationStore";
export type { Notification, NotificationType } from "./notificationStore";

export { useDiagnosticsStore } from "./diagnosticsStore";
export type { DiagnosticsTab } from "./diagnosticsStore";
export {
  DIAGNOSTICS_MIN_HEIGHT,
  DIAGNOSTICS_MAX_HEIGHT_RATIO,
  DIAGNOSTICS_DEFAULT_HEIGHT,
} from "./diagnosticsStore";

export { useLayoutConfigStore } from "./layoutConfigStore";

export { useScrollbackStore } from "./scrollbackStore";

export { usePerformanceModeStore } from "./performanceModeStore";

export { useTerminalFontStore } from "./terminalFontStore";

export { useTerminalInputStore } from "./terminalInputStore";

export { useSidecarStore } from "./sidecarStore";

export { useUIStore } from "./uiStore";

export { useGitHubConfigStore, cleanupGitHubConfigStore } from "./githubConfigStore";

export { useAgentSettingsStore, cleanupAgentSettingsStore } from "./agentSettingsStore";

export { usePulseStore } from "./pulseStore";

export { usePreferencesStore } from "./preferencesStore";

export { useToolbarPreferencesStore } from "./toolbarPreferencesStore";

export { useBrowserStateStore } from "./browserStateStore";
export type { BrowserPanelState, BrowserHistory } from "./browserStateStore";

export { useDockStore } from "./dockStore";
