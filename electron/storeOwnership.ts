import type { AuditLogsStoreSchema, StoreSchema, WindowStatesStoreSchema } from "./store.js";

/**
 * Who owns each persisted setting when a window is attached to a remote host.
 *
 * - `host`: everything about the work — agents, accounts, environment, MCP,
 *   plugins, forge, run history, per-project state. A remote window reads and
 *   writes the connected host's value, and its settings page names the host.
 * - `device`: the screen, keyboard and this machine — theme, keybindings,
 *   terminal appearance, window geometry, GPU, voice, privacy, updates, crash
 *   recovery and the host list itself. Always this machine's.
 * - `split`: a key holding both; its fields are classified below.
 *
 * Nothing is synced between hosts. The records are total over their schemas,
 * so a new store key or field that doesn't declare an owner fails typecheck.
 */
export type SettingOwner = "host" | "device";

export const STORE_KEY_OWNERSHIP = {
  // Store-file bookkeeping; each machine's own and never crosses a link.
  _schemaVersion: "device",
  windowState: "device",
  terminalConfig: "split",
  hibernation: "host",
  sessionRestore: "host",
  windowOpening: "device",
  // Each machine holds its own power assertion for its own agents; a remote
  // window's keep-awake split answers from this machine, so it edits this one.
  keepAwake: "device",
  idleTerminalNotify: "host",
  idleTerminalDismissals: "host",
  idleTerminalNotifiedAt: "host",
  parkedRuns: "host",
  snoozedRuns: "host",
  idleBackgroundAutoClose: "host",
  pluginBackgroundUpdateCheck: "host",
  appState: "split",
  legacyWorkspaceStateOwnerId: "host",
  userConfig: "host",
  worktreeConfig: "host",
  agentSettings: "host",
  notificationSettings: "host",
  userAgentRegistry: "host",
  agentUpdateSettings: "host",
  keybindingOverrides: "device",
  projectEnv: "host",
  globalEnvironmentVariables: "host",
  appAgentConfig: "host",
  windowStates: "device",
  worktreeIssueMap: "host",
  wslGitByWorktree: "host",
  rosettaWarningDismissed: "device",
  appTheme: "device",
  privacy: "device",
  agentSessionHistory: "host",
  voiceInput: "device",
  mcpServer: "host",
  helpAssistant: "host",
  pendingErrors: "device",
  errorFingerprints: "device",
  gpu: "device",
  crashRecovery: "device",
  onboarding: "device",
  orchestrationMilestones: "device",
  shortcutHintCounts: "device",
  shortcutHintHoveredKeys: "device",
  forgeEnableDismissedPaths: "host",
  updateChannel: "device",
  dismissedUpdateVersion: "device",
  dismissedUpdateAt: "device",
  lastUpdateCheck: "device",
  pendingUpdateVersion: "device",
  pendingUpdateInstallStage: "device",
  storeUpdateNotificationsEnabled: "device",
  lastNotifiedStoreVersion: "device",
  storeNotifierEtag: "device",
  logLevelOverrides: "device",
  plugins: "host",
  forgeDefaultProviderId: "host",
  forgeCredentials: "host",
  forgeAudit: "host",
  runHistory: "host",
  pluginMcpAudit: "host",
  pluginMcpConsent: "host",
  pluginMcpConfig: "host",
  pluginCapabilityConsent: "host",
  projectPluginTrust: "host",
  projectPluginVisibility: "host",
  projectSurfaceChoices: "host",
  projectAgentMcpEnablement: "host",
  workspaceKeepResident: "host",
  remoteHosts: "device",
  hostMode: "device",
  remoteHostsPreferences: "device",
  // What this machine lets a host's plugins do with its clipboard.
  remoteHostPluginClipboardGrants: "device",
} as const satisfies Record<keyof StoreSchema, SettingOwner | "split">;

/** terminalConfig: behaviour runs where the terminals run; appearance is how this screen draws them. */
export const TERMINAL_CONFIG_FIELD_OWNERSHIP = {
  scrollbackLines: "host",
  performanceMode: "host",
  hybridInputEnabled: "host",
  hybridInputAutoFocus: "host",
  resourceMonitoringEnabled: "host",
  memoryLeakDetectionEnabled: "host",
  memoryLeakAutoRestartThresholdMb: "host",
  screenReaderMode: "device",
  cachedProjectViews: "device",
  fontSize: "device",
  fontFamily: "device",
  colorSchemeId: "device",
  customSchemes: "device",
  recentSchemeIds: "device",
} as const satisfies Record<keyof StoreSchema["terminalConfig"], SettingOwner>;

/**
 * appState: panel layout and the terminal list move with the host; zoom,
 * sidebar and panel sizes, and palette habits stay with the client.
 */
export const APP_STATE_FIELD_OWNERSHIP = {
  activeWorktreeId: "host",
  terminals: "host",
  recipes: "host",
  panelGridConfig: "host",
  mruList: "host",
  focusMode: "host",
  fleetScopeMode: "host",
  sidebarWidth: "device",
  focusPanelState: "device",
  diagnosticsHeight: "device",
  dockedPopoverHeight: "device",
  hasSeenWelcome: "device",
  developerMode: "device",
  actionMruList: "device",
  actionPinnedIds: "device",
  actionHiddenIds: "device",
} as const satisfies Record<keyof StoreSchema["appState"], SettingOwner>;

export const WINDOW_STATES_STORE_OWNERSHIP = {
  windowStates: "device",
} as const satisfies Record<keyof WindowStatesStoreSchema, SettingOwner>;

export const AUDIT_LOGS_STORE_OWNERSHIP = {
  mcpAuditLog: "host",
  mcpTurnOutcomeLog: "host",
  pluginAuditLog: "host",
  forgeAuditLog: "host",
  runHistoryRecords: "host",
  pluginMcpAuditLog: "host",
} as const satisfies Record<keyof AuditLogsStoreSchema, SettingOwner>;

export function ownerOfStoreKey(key: keyof StoreSchema): SettingOwner | "split" {
  return STORE_KEY_OWNERSHIP[key];
}
