import type { IpcInvokeMap } from "../../types/index.js";

// `plugin:invoke` is intentionally NOT in this map. Its variadic
// `(pluginId, channel, ...args)` signature and senderFrame trust check
// can't be expressed through `IpcInvokeMap` without widening types to
// `unknown[]`, so the raw `ipcMain.handle` route in `plugin.ts` is kept
// (allowlisted in `ipcHandleCoverage.test.ts`).
export const PLUGIN_METHOD_CHANNELS = {
  list: "plugin:list",
  install: "plugin:install",
  setEnabled: "plugin:set-enabled",
  installFromFile: "plugin:install-from-file",
  installFromPath: "plugin:install-from-path",
  installFromUrl: "plugin:install-from-url",
  cancelInstall: "plugin:cancel-install",
  uninstall: "plugin:uninstall",
  checkForUpdate: "plugin:check-for-update",
  toolbarButtons: "plugin:toolbar-buttons",
  launchEntries: "plugin:launch-entries",
  layouts: "plugin:layouts",
  getHiddenLaunchGroups: "plugin:launch-groups-hidden-get",
  setLaunchGroupHidden: "plugin:launch-group-hidden-set",
  getNotificationSilences: "plugin:notification-silences-get",
  setNotificationSilenced: "plugin:notification-silence-set",
  getSearchProviders: "plugin:search-providers-get",
  querySearchProvider: "plugin:search-providers-query",
  cancelSearchProviders: "plugin:search-providers-cancel",
  setSearchProviderShown: "plugin:search-provider-shown-set",
  getContextProviders: "plugin:context-providers-get",
  searchContextProvider: "plugin:context-provider-search",
  resolveContextReferences: "plugin:context-references-resolve",
  setContextProvidersEnabled: "plugin:context-providers-enabled-set",
  keybindings: "plugin:keybindings",
  contextMenuItems: "plugin:context-menu-items",
  validateActionIds: "plugin:validate-action-ids",
  validateManifest: "plugin:validate-manifest",
  getActions: "plugin:actions-get",
  registerAction: "plugin:actions-register",
  unregisterAction: "plugin:actions-unregister",
  getPanelKinds: "plugin:panel-kinds-get",
  getProjectSurfaces: "plugin:project-surfaces-get",
  setProjectSurfaceChoice: "plugin:project-surface-choice-set",
  setProjectSurfaceChoices: "plugin:project-surface-choices-set",
  getProjectLayoutSeed: "plugin:project-layout-seed-get",
  advanceProjectLayoutSeed: "plugin:project-layout-seed-advance",
  getProjectWelcome: "plugin:project-welcome-get",
  setProjectWelcome: "plugin:project-welcome-set",
  getFileEditorChoices: "plugin:file-editor-choices-get",
  setFileEditorChoice: "plugin:file-editor-choice-set",
  getProjectPlugins: "plugin:project-list",
  setProjectPluginTrust: "plugin:project-set-trust",
  activateStagedProjectPlugin: "plugin:project-activate-staged",
  reloadProjectPlugins: "plugin:project-reload",
  setProjectPluginMuted: "plugin:project-set-muted",
  getProjectPluginVisibility: "plugin:project-visibility-get",
  setProjectPluginVisibility: "plugin:project-visibility-set",
  setProjectInstanceEnabled: "plugin:project-instance-set-enabled",
  setPluginVisibilityDefault: "plugin:visibility-default-set",
  activateForView: "plugin:activate-for-view",
  reportPanelLifecycle: "plugin:report-panel-lifecycle",
  reportPanelInventory: "plugin:report-panel-inventory",
  getRuntimeStatuses: "plugin:runtime-statuses-get",
  restartWorker: "plugin:restart-worker",
  cancelTask: "plugin:task-cancel",
  dismissTask: "plugin:task-dismiss",
  importArtifacts: "plugin:artifacts-import",
  getArtifactSource: "plugin:artifact-source",
  releaseArtifactSource: "plugin:artifact-source-release",
  getAgents: "plugin:agents-get",
  getRecipes: "plugin:recipes-get",
  getTours: "plugin:tours-get",
  getProjectTemplates: "plugin:project-templates-get",
  previewProjectTemplate: "plugin:project-template-preview",
  getHostedViews: "plugin:hosted-views-get",
  getThemes: "plugin:themes-get",
  getIcons: "plugin:icons-get",
  recordRecipeUse: "plugin:recipe-record-use",
  updateRecipeMetadata: "plugin:recipe-metadata-update",
  getForgeProviders: "plugin:forge-providers-get",
  getDecorations: "plugin:file-decorations-get",
  getWorktreeDeleteNoteSources: "plugin:worktree-delete-note-sources-get",
  getWorktreeDeleteNotes: "plugin:worktree-delete-notes-get",
  getWorktreeStatus: "plugin:worktree-status-get",
  getAuditRecords: "plugin:get-audit-records",
  getAuditConfig: "plugin:get-audit-config",
  clearAuditLog: "plugin:clear-audit-log",
  setAuditEnabled: "plugin:set-audit-enabled",
  setAuditMaxRecords: "plugin:set-audit-max-records",
  exportAuditLog: "plugin:export-audit-log",
  getDiagnosticsSnapshot: "plugin:get-diagnostics-snapshot",
  getSettingValues: "plugin:settings-get-values",
  setSettingValue: "plugin:settings-set-value",
  deleteSettingValue: "plugin:settings-delete-value",
  revealSecretSetting: "plugin:settings-reveal-secret",
  getRequiredSettingsStatus: "plugin:settings-required-status",
  getSetupStatus: "plugin:setup-status",
  setSetupStepSkipped: "plugin:setup-step-skipped-set",
  getAccountStatus: "plugin:account-status",
  connectAccount: "plugin:account-connect",
  cancelAccountConnect: "plugin:account-cancel-connect",
  setAccountToken: "plugin:account-set-token",
  disconnectAccount: "plugin:account-disconnect",
  listAccountConnections: "plugin:account-list",
  testAccountConnection: "plugin:account-test",
  getAccountBinding: "plugin:account-binding-get",
  setAccountBinding: "plugin:account-binding-set",
  pickPath: "plugin:pick-path",
  pathExists: "plugin:path-exists",
  backupDatabases: "plugin:backup-databases",
  getBackgroundUpdateCheckSettings: "plugin:bg-update-check-settings-get",
  setBackgroundUpdateCheckSettings: "plugin:bg-update-check-settings-set",
  getLatestBackgroundUpdateCheck: "plugin:bg-update-check-latest",
} as const satisfies Record<string, keyof IpcInvokeMap>;

type Methods = typeof PLUGIN_METHOD_CHANNELS;

export type PluginPreloadBindings = {
  [M in keyof Methods]: (
    ...args: IpcInvokeMap[Methods[M]]["args"]
  ) => Promise<IpcInvokeMap[Methods[M]]["result"]>;
};

type Invoker = (channel: string, ...args: unknown[]) => Promise<unknown>;

export function buildPluginPreloadBindings(invoke: Invoker): PluginPreloadBindings {
  const out: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  for (const method of Object.keys(PLUGIN_METHOD_CHANNELS) as Array<keyof Methods>) {
    const channel = PLUGIN_METHOD_CHANNELS[method];
    out[method as string] = (...args) => invoke(channel, ...args);
  }
  return out as unknown as PluginPreloadBindings;
}
