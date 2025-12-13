export { useTerminalStore, isAgentReady, getTerminalRefreshTier } from "./terminalStore";
export type { TerminalInstance, AddTerminalOptions, QueuedCommand } from "./terminalStore";
export { MAX_GRID_TERMINALS } from "./slices/terminalRegistrySlice";

export { useWorktreeSelectionStore } from "./worktreeStore";

export { useWorktreeDataStore, cleanupWorktreeDataStore } from "./worktreeDataStore";

export { useLogsStore, filterLogs } from "./logsStore";

export { useErrorStore } from "./errorStore";
export type { AppError, ErrorType, RetryAction } from "./errorStore";

export { useEventStore } from "./eventStore";

export { useProjectStore } from "./projectStore";

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

export { useSidecarStore } from "./sidecarStore";

export { useUIStore } from "./uiStore";

export { useGitHubConfigStore, cleanupGitHubConfigStore } from "./githubConfigStore";

export { useAgentSettingsStore, cleanupAgentSettingsStore } from "./agentSettingsStore";

export { usePulseStore } from "./pulseStore";

export { usePreferencesStore } from "./preferencesStore";
