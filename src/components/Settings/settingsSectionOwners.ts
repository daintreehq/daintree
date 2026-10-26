import type { SettingRef } from "@/hooks/useSettingsOwner";

/**
 * What each section of a settings page writes, declared once for the section's
 * heading and for its search result, so the two can't name different machines.
 * Owners come from the settings catalog; nothing here says "host" or "device".
 */
export const SECTION_SETTINGS = {
  systemStatus: ["agentSettings"],
  updates: ["updateChannel"],
  startup: ["sessionRestore"],
  openingFolders: ["windowOpening"],
  keepAwake: ["keepAwake"],
  backgroundProjects: ["idleTerminalNotify", "idleBackgroundAutoClose"],
  interfaceElements: ["storage:daintree-preferences"],
  quickReference: ["keybindingOverrides"],
  privacy: ["privacy"],
  sessionHistory: ["agentSessionHistory"],
  terminalResources: [
    "terminalConfig.resourceMonitoringEnabled",
    "terminalConfig.memoryLeakDetectionEnabled",
    "terminalConfig.memoryLeakAutoRestartThresholdMb",
  ],
  performanceMode: ["terminalConfig.performanceMode"],
  panelLimits: ["storage:daintree-panel-limits"],
  projectViews: ["terminalConfig.cachedProjectViews"],
  agentInput: [
    "terminalConfig.hybridInputEnabled",
    "terminalConfig.hybridInputAutoFocus",
    "remoteHostsPreferences",
  ],
  twoPaneSplit: ["storage:daintree-two-pane-split"],
  gridLayout: ["appState.panelGridConfig"],
  scrollback: ["terminalConfig.scrollbackLines"],
  assistiveTechnology: ["terminalConfig.screenReaderMode"],
  worktreePathPattern: ["worktreeConfig"],
  clientPreferences: ["storage:daintree-preferences"],
  toolbarLayout: ["storage:daintree-toolbar-preferences"],
  pluginSilences: ["pluginNotificationSilences"],
  hardwareAcceleration: ["gpu"],
  logging: ["logLevelOverrides"],
  developerTools: ["appState.developerMode"],
  projectIdentity: ["projectPresentation"],
  projectToolbar: ["projectPresentation"],
  projectTheme: ["appTheme"],
  sidebarDefaultView: ["storage:daintree-sidebar-view:*"],
} as const satisfies Record<string, readonly SettingRef[]>;
