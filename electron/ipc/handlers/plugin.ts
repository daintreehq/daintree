import { ipcMain } from "electron";
import { CHANNELS } from "../channels.js";
import { defineIpcNamespace, op } from "../define.js";
import { AppError } from "../../utils/errorTypes.js";
import { PLUGIN_METHOD_CHANNELS } from "./plugin.preload.js";
import { scrubSecrets } from "../../../shared/utils/secretScrubber.js";
import { isTrustedRendererUrl } from "../../../shared/utils/trustedRenderer.js";
import { assertIpcSecurityReady } from "../ipcGuard.js";
import { isPluginPayloadTooLargeError } from "../../services/plugin/pluginPayloadLimits.js";
import { observeIpcEnvelopeRejections } from "../envelopeRejections.js";
import { getIpcDispatcher } from "../dispatcher.js";
import { getLocalEndpoint } from "../localEndpoint.js";
import {
  isPluginFrontendRoutingEnabled,
  runInPluginInvocation,
} from "../../services/plugin/pluginFrontendRouting.js";
import { resolveActiveWorktreeIdForProject } from "../../services/plugin/pluginInvokeContext.js";
import {
  getProjectForWebContents,
  isCachedViewWebContents,
  getWindowForWebContents,
} from "../../window/webContentsRegistry.js";
import {
  handleList,
  handleInstall,
  handleSetEnabled,
  handleInstallFromFile,
  handleInstallFromPathOp,
  handleInstallFromUrlOp,
  handleCancelInstall,
  handleUninstall,
  handleCheckForUpdate,
  handleGetBackgroundUpdateCheckSettings,
  handleSetBackgroundUpdateCheckSettings,
  handleGetLatestBackgroundUpdateCheck,
} from "./plugin/install.js";
import {
  handleToolbarButtons,
  handleLaunchEntries,
  handleLayouts,
  handleHiddenLaunchGroupsGet,
  handleLaunchGroupHiddenSet,
  handleNotificationSilencesGet,
  handleNotificationSilenceSet,
  handleSearchProvidersGet,
  handleSearchProvidersQuery,
  handleSearchProvidersCancel,
  handleSearchProviderShownSet,
  handleContextProvidersGet,
  handleContextProvidersSearch,
  handleContextProvidersResolve,
  handleContextProvidersEnabledSet,
  handleKeybindings,
  handleContextMenuItems,
  handleValidateActionIds,
  handleActionsGet,
  handleActionsRegister,
  handleActionsUnregister,
  handlePanelKindsGet,
  handleFileEditorChoicesGet,
  handleFileEditorChoiceSet,
} from "./plugin/contributions.js";
import {
  handleValidateManifest,
  handleGetAuditRecords,
  handleGetAuditConfig,
  handleClearAuditLog,
  handleSetAuditEnabled,
  handleSetAuditMaxRecords,
  handleExportAuditLog,
  handleGetDiagnosticsSnapshot,
  handleBackupDatabases,
} from "./plugin/diagnostics.js";
import {
  handleProjectSurfacesGet,
  handleProjectSurfaceChoiceSet,
  handleProjectSurfaceChoicesSet,
  handleProjectLayoutSeedGet,
  handleProjectLayoutSeedAdvance,
  handleProjectWelcomeGet,
  handleProjectWelcomeSet,
} from "./plugin/projectSurfaces.js";
import {
  handleProjectPluginsList,
  handleProjectPluginsSetTrust,
  handleProjectPluginsActivateStaged,
  handleProjectPluginsReload,
  handleProjectPluginsSetMuted,
  handleProjectPluginVisibilityGet,
  handleProjectPluginVisibilitySet,
  handleProjectInstanceEnabledSet,
  handlePluginVisibilityDefaultSet,
} from "./plugin/projectInstances.js";
import {
  handleActivateForView,
  handleReportPanelLifecycle,
  handleReportPanelInventory,
  handleReportUnsavedPanels,
  handleGetUnsavedPanels,
  handleRuntimeStatusesGet,
  handleRestartWorker,
  handleTaskCancel,
  handleTaskDismiss,
  handleArtifactsImport,
  handleArtifactSource,
  handleArtifactSourceRelease,
} from "./plugin/runtime.js";
import {
  handleAgentsGet,
  handleRecipesGet,
  handleToursGet,
  handleProjectTemplatesGet,
  handleProjectTemplatePreview,
  handleHostedViewsGet,
  handleIconsGet,
  handleThemesGet,
  handleRecipeRecordUse,
  handleRecipeMetadataUpdate,
  handleForgeProvidersGet,
} from "./plugin/catalog.js";
import {
  handleFileDecorationsGet,
  handleWorktreeDeleteNoteSourcesGet,
  handleWorktreeDeleteNotesGet,
  handleWorktreeStatusGet,
} from "./plugin/worktreeContributions.js";
import {
  handleSettingsGetValues,
  handleSettingsSetValue,
  handleSettingsDeleteValue,
  handleSettingsRevealSecret,
  handleSettingsRequiredStatus,
  handleSetupStatus,
  handleSetupStepSkippedSet,
  handleAccountStatus,
  handleAccountConnect,
  handleAccountCancelConnect,
  handleAccountSetToken,
  handleAccountDisconnect,
  handleAccountList,
  handleAccountTest,
  handleAccountBindingGet,
  handleAccountBindingSet,
  handlePickPath,
  handlePathExists,
} from "./plugin/settings.js";
import { meterOversizeInvokeArgs, runPluginInvoke } from "./plugin/invoke.js";
import { UNTRUSTED_URL_MAX_CHARS, safeAppend } from "./plugin/auditAppend.js";
import { getPluginService } from "./plugin/service.js";
import { remoteUnsupportedError } from "./plugin/senderScope.js";

// The plugin CLI server routes install/uninstall through the same trust gates.
export { handleInstallFromPath, handleInstallFromUrl, handleUninstall } from "./plugin/install.js";

export const pluginNamespace = defineIpcNamespace({
  name: "plugin",
  ops: {
    list: op(PLUGIN_METHOD_CHANNELS.list, handleList),
    install: op(PLUGIN_METHOD_CHANNELS.install, handleInstall),
    setEnabled: op(PLUGIN_METHOD_CHANNELS.setEnabled, handleSetEnabled),
    installFromFile: op(PLUGIN_METHOD_CHANNELS.installFromFile, handleInstallFromFile, {
      withContext: true,
    }),
    installFromPath: op(PLUGIN_METHOD_CHANNELS.installFromPath, handleInstallFromPathOp, {
      withContext: true,
    }),
    installFromUrl: op(PLUGIN_METHOD_CHANNELS.installFromUrl, handleInstallFromUrlOp, {
      withContext: true,
    }),
    cancelInstall: op(PLUGIN_METHOD_CHANNELS.cancelInstall, handleCancelInstall),
    uninstall: op(PLUGIN_METHOD_CHANNELS.uninstall, handleUninstall),
    checkForUpdate: op(PLUGIN_METHOD_CHANNELS.checkForUpdate, handleCheckForUpdate),
    toolbarButtons: op(PLUGIN_METHOD_CHANNELS.toolbarButtons, handleToolbarButtons, {
      withContext: true,
    }),
    launchEntries: op(PLUGIN_METHOD_CHANNELS.launchEntries, handleLaunchEntries, {
      withContext: true,
    }),
    layouts: op(PLUGIN_METHOD_CHANNELS.layouts, handleLayouts, {
      withContext: true,
    }),
    getHiddenLaunchGroups: op(
      PLUGIN_METHOD_CHANNELS.getHiddenLaunchGroups,
      handleHiddenLaunchGroupsGet,
      { withContext: true }
    ),
    setLaunchGroupHidden: op(
      PLUGIN_METHOD_CHANNELS.setLaunchGroupHidden,
      handleLaunchGroupHiddenSet,
      { withContext: true }
    ),
    getNotificationSilences: op(
      PLUGIN_METHOD_CHANNELS.getNotificationSilences,
      handleNotificationSilencesGet
    ),
    setNotificationSilenced: op(
      PLUGIN_METHOD_CHANNELS.setNotificationSilenced,
      handleNotificationSilenceSet
    ),
    getSearchProviders: op(PLUGIN_METHOD_CHANNELS.getSearchProviders, handleSearchProvidersGet, {
      withContext: true,
    }),
    querySearchProvider: op(
      PLUGIN_METHOD_CHANNELS.querySearchProvider,
      handleSearchProvidersQuery,
      { withContext: true }
    ),
    cancelSearchProviders: op(
      PLUGIN_METHOD_CHANNELS.cancelSearchProviders,
      handleSearchProvidersCancel,
      { withContext: true }
    ),
    setSearchProviderShown: op(
      PLUGIN_METHOD_CHANNELS.setSearchProviderShown,
      handleSearchProviderShownSet,
      { withContext: true }
    ),
    getContextProviders: op(PLUGIN_METHOD_CHANNELS.getContextProviders, handleContextProvidersGet, {
      withContext: true,
    }),
    searchContextProvider: op(
      PLUGIN_METHOD_CHANNELS.searchContextProvider,
      handleContextProvidersSearch,
      { withContext: true }
    ),
    resolveContextReferences: op(
      PLUGIN_METHOD_CHANNELS.resolveContextReferences,
      handleContextProvidersResolve,
      { withContext: true }
    ),
    setContextProvidersEnabled: op(
      PLUGIN_METHOD_CHANNELS.setContextProvidersEnabled,
      handleContextProvidersEnabledSet,
      { withContext: true }
    ),
    keybindings: op(PLUGIN_METHOD_CHANNELS.keybindings, handleKeybindings, { withContext: true }),
    contextMenuItems: op(PLUGIN_METHOD_CHANNELS.contextMenuItems, handleContextMenuItems, {
      withContext: true,
    }),
    validateActionIds: op(PLUGIN_METHOD_CHANNELS.validateActionIds, handleValidateActionIds),
    validateManifest: op(PLUGIN_METHOD_CHANNELS.validateManifest, handleValidateManifest, {
      withContext: true,
    }),
    getActions: op(PLUGIN_METHOD_CHANNELS.getActions, handleActionsGet, { withContext: true }),
    registerAction: op(PLUGIN_METHOD_CHANNELS.registerAction, handleActionsRegister, {
      withContext: true,
    }),
    unregisterAction: op(PLUGIN_METHOD_CHANNELS.unregisterAction, handleActionsUnregister, {
      withContext: true,
    }),
    getPanelKinds: op(PLUGIN_METHOD_CHANNELS.getPanelKinds, handlePanelKindsGet, {
      withContext: true,
    }),
    getProjectSurfaces: op(PLUGIN_METHOD_CHANNELS.getProjectSurfaces, handleProjectSurfacesGet, {
      withContext: true,
    }),
    setProjectSurfaceChoice: op(
      PLUGIN_METHOD_CHANNELS.setProjectSurfaceChoice,
      handleProjectSurfaceChoiceSet,
      { withContext: true }
    ),
    setProjectSurfaceChoices: op(
      PLUGIN_METHOD_CHANNELS.setProjectSurfaceChoices,
      handleProjectSurfaceChoicesSet,
      { withContext: true }
    ),
    getProjectLayoutSeed: op(
      PLUGIN_METHOD_CHANNELS.getProjectLayoutSeed,
      handleProjectLayoutSeedGet,
      { withContext: true }
    ),
    advanceProjectLayoutSeed: op(
      PLUGIN_METHOD_CHANNELS.advanceProjectLayoutSeed,
      handleProjectLayoutSeedAdvance,
      { withContext: true }
    ),
    getProjectWelcome: op(PLUGIN_METHOD_CHANNELS.getProjectWelcome, handleProjectWelcomeGet, {
      withContext: true,
    }),
    setProjectWelcome: op(PLUGIN_METHOD_CHANNELS.setProjectWelcome, handleProjectWelcomeSet, {
      withContext: true,
    }),
    getFileEditorChoices: op(
      PLUGIN_METHOD_CHANNELS.getFileEditorChoices,
      handleFileEditorChoicesGet,
      { withContext: true }
    ),
    setFileEditorChoice: op(PLUGIN_METHOD_CHANNELS.setFileEditorChoice, handleFileEditorChoiceSet, {
      withContext: true,
    }),
    getProjectPlugins: op(PLUGIN_METHOD_CHANNELS.getProjectPlugins, handleProjectPluginsList, {
      withContext: true,
    }),
    setProjectPluginTrust: op(
      PLUGIN_METHOD_CHANNELS.setProjectPluginTrust,
      handleProjectPluginsSetTrust,
      { withContext: true }
    ),
    activateStagedProjectPlugin: op(
      PLUGIN_METHOD_CHANNELS.activateStagedProjectPlugin,
      handleProjectPluginsActivateStaged,
      { withContext: true }
    ),
    reloadProjectPlugins: op(
      PLUGIN_METHOD_CHANNELS.reloadProjectPlugins,
      handleProjectPluginsReload,
      { withContext: true }
    ),
    setProjectPluginMuted: op(
      PLUGIN_METHOD_CHANNELS.setProjectPluginMuted,
      handleProjectPluginsSetMuted,
      { withContext: true }
    ),
    getProjectPluginVisibility: op(
      PLUGIN_METHOD_CHANNELS.getProjectPluginVisibility,
      handleProjectPluginVisibilityGet,
      { withContext: true }
    ),
    setProjectPluginVisibility: op(
      PLUGIN_METHOD_CHANNELS.setProjectPluginVisibility,
      handleProjectPluginVisibilitySet,
      { withContext: true }
    ),
    setProjectInstanceEnabled: op(
      PLUGIN_METHOD_CHANNELS.setProjectInstanceEnabled,
      handleProjectInstanceEnabledSet,
      { withContext: true }
    ),
    setPluginVisibilityDefault: op(
      PLUGIN_METHOD_CHANNELS.setPluginVisibilityDefault,
      handlePluginVisibilityDefaultSet,
      { withContext: true }
    ),
    activateForView: op(PLUGIN_METHOD_CHANNELS.activateForView, handleActivateForView, {
      withContext: true,
    }),
    reportPanelLifecycle: op(
      PLUGIN_METHOD_CHANNELS.reportPanelLifecycle,
      handleReportPanelLifecycle,
      { withContext: true }
    ),
    reportPanelInventory: op(
      PLUGIN_METHOD_CHANNELS.reportPanelInventory,
      handleReportPanelInventory,
      { withContext: true }
    ),
    reportUnsavedPanels: op(PLUGIN_METHOD_CHANNELS.reportUnsavedPanels, handleReportUnsavedPanels, {
      withContext: true,
    }),
    getUnsavedPanels: op(PLUGIN_METHOD_CHANNELS.getUnsavedPanels, handleGetUnsavedPanels),
    getRuntimeStatuses: op(PLUGIN_METHOD_CHANNELS.getRuntimeStatuses, handleRuntimeStatusesGet, {
      withContext: true,
    }),
    restartWorker: op(PLUGIN_METHOD_CHANNELS.restartWorker, handleRestartWorker, {
      withContext: true,
    }),
    cancelTask: op(PLUGIN_METHOD_CHANNELS.cancelTask, handleTaskCancel, { withContext: true }),
    dismissTask: op(PLUGIN_METHOD_CHANNELS.dismissTask, handleTaskDismiss, { withContext: true }),
    importArtifacts: op(PLUGIN_METHOD_CHANNELS.importArtifacts, handleArtifactsImport, {
      withContext: true,
    }),
    getArtifactSource: op(PLUGIN_METHOD_CHANNELS.getArtifactSource, handleArtifactSource, {
      withContext: true,
    }),
    releaseArtifactSource: op(
      PLUGIN_METHOD_CHANNELS.releaseArtifactSource,
      handleArtifactSourceRelease,
      { withContext: true }
    ),
    getAgents: op(PLUGIN_METHOD_CHANNELS.getAgents, handleAgentsGet),
    getRecipes: op(PLUGIN_METHOD_CHANNELS.getRecipes, handleRecipesGet, { withContext: true }),
    getTours: op(PLUGIN_METHOD_CHANNELS.getTours, handleToursGet, { withContext: true }),
    getProjectTemplates: op(PLUGIN_METHOD_CHANNELS.getProjectTemplates, handleProjectTemplatesGet),
    previewProjectTemplate: op(
      PLUGIN_METHOD_CHANNELS.previewProjectTemplate,
      handleProjectTemplatePreview
    ),
    getHostedViews: op(PLUGIN_METHOD_CHANNELS.getHostedViews, handleHostedViewsGet, {
      withContext: true,
    }),
    getIcons: op(PLUGIN_METHOD_CHANNELS.getIcons, handleIconsGet, { withContext: true }),
    getThemes: op(PLUGIN_METHOD_CHANNELS.getThemes, handleThemesGet),
    recordRecipeUse: op(PLUGIN_METHOD_CHANNELS.recordRecipeUse, handleRecipeRecordUse, {
      withContext: true,
    }),
    updateRecipeMetadata: op(
      PLUGIN_METHOD_CHANNELS.updateRecipeMetadata,
      handleRecipeMetadataUpdate,
      { withContext: true }
    ),
    getForgeProviders: op(PLUGIN_METHOD_CHANNELS.getForgeProviders, handleForgeProvidersGet),
    getDecorations: op(PLUGIN_METHOD_CHANNELS.getDecorations, handleFileDecorationsGet, {
      withContext: true,
    }),
    getWorktreeDeleteNoteSources: op(
      PLUGIN_METHOD_CHANNELS.getWorktreeDeleteNoteSources,
      handleWorktreeDeleteNoteSourcesGet,
      { withContext: true }
    ),
    getWorktreeDeleteNotes: op(
      PLUGIN_METHOD_CHANNELS.getWorktreeDeleteNotes,
      handleWorktreeDeleteNotesGet,
      { withContext: true }
    ),
    getWorktreeStatus: op(PLUGIN_METHOD_CHANNELS.getWorktreeStatus, handleWorktreeStatusGet),
    getAuditRecords: op(PLUGIN_METHOD_CHANNELS.getAuditRecords, handleGetAuditRecords),
    getAuditConfig: op(PLUGIN_METHOD_CHANNELS.getAuditConfig, handleGetAuditConfig),
    clearAuditLog: op(PLUGIN_METHOD_CHANNELS.clearAuditLog, handleClearAuditLog, {
      withContext: true,
    }),
    setAuditEnabled: op(PLUGIN_METHOD_CHANNELS.setAuditEnabled, handleSetAuditEnabled),
    setAuditMaxRecords: op(PLUGIN_METHOD_CHANNELS.setAuditMaxRecords, handleSetAuditMaxRecords),
    exportAuditLog: op(PLUGIN_METHOD_CHANNELS.exportAuditLog, handleExportAuditLog),
    getDiagnosticsSnapshot: op(
      PLUGIN_METHOD_CHANNELS.getDiagnosticsSnapshot,
      handleGetDiagnosticsSnapshot
    ),
    getSettingValues: op(PLUGIN_METHOD_CHANNELS.getSettingValues, handleSettingsGetValues, {
      withContext: true,
    }),
    setSettingValue: op(PLUGIN_METHOD_CHANNELS.setSettingValue, handleSettingsSetValue, {
      withContext: true,
    }),
    deleteSettingValue: op(PLUGIN_METHOD_CHANNELS.deleteSettingValue, handleSettingsDeleteValue, {
      withContext: true,
    }),
    revealSecretSetting: op(
      PLUGIN_METHOD_CHANNELS.revealSecretSetting,
      handleSettingsRevealSecret,
      { withContext: true }
    ),
    getRequiredSettingsStatus: op(
      PLUGIN_METHOD_CHANNELS.getRequiredSettingsStatus,
      handleSettingsRequiredStatus,
      { withContext: true }
    ),
    getSetupStatus: op(PLUGIN_METHOD_CHANNELS.getSetupStatus, handleSetupStatus, {
      withContext: true,
    }),
    setSetupStepSkipped: op(PLUGIN_METHOD_CHANNELS.setSetupStepSkipped, handleSetupStepSkippedSet, {
      withContext: true,
    }),
    getAccountStatus: op(PLUGIN_METHOD_CHANNELS.getAccountStatus, handleAccountStatus, {
      withContext: true,
    }),
    connectAccount: op(PLUGIN_METHOD_CHANNELS.connectAccount, handleAccountConnect, {
      withContext: true,
    }),
    cancelAccountConnect: op(
      PLUGIN_METHOD_CHANNELS.cancelAccountConnect,
      handleAccountCancelConnect,
      { withContext: true }
    ),
    setAccountToken: op(PLUGIN_METHOD_CHANNELS.setAccountToken, handleAccountSetToken, {
      withContext: true,
    }),
    disconnectAccount: op(PLUGIN_METHOD_CHANNELS.disconnectAccount, handleAccountDisconnect, {
      withContext: true,
    }),
    listAccountConnections: op(PLUGIN_METHOD_CHANNELS.listAccountConnections, handleAccountList, {
      withContext: true,
    }),
    testAccountConnection: op(PLUGIN_METHOD_CHANNELS.testAccountConnection, handleAccountTest, {
      withContext: true,
    }),
    getAccountBinding: op(PLUGIN_METHOD_CHANNELS.getAccountBinding, handleAccountBindingGet, {
      withContext: true,
    }),
    setAccountBinding: op(PLUGIN_METHOD_CHANNELS.setAccountBinding, handleAccountBindingSet, {
      withContext: true,
    }),
    pickPath: op(PLUGIN_METHOD_CHANNELS.pickPath, handlePickPath, { withContext: true }),
    pathExists: op(PLUGIN_METHOD_CHANNELS.pathExists, handlePathExists),
    backupDatabases: op(PLUGIN_METHOD_CHANNELS.backupDatabases, handleBackupDatabases, {
      withContext: true,
    }),
    getBackgroundUpdateCheckSettings: op(
      PLUGIN_METHOD_CHANNELS.getBackgroundUpdateCheckSettings,
      handleGetBackgroundUpdateCheckSettings
    ),
    setBackgroundUpdateCheckSettings: op(
      PLUGIN_METHOD_CHANNELS.setBackgroundUpdateCheckSettings,
      handleSetBackgroundUpdateCheckSettings
    ),
    getLatestBackgroundUpdateCheck: op(
      PLUGIN_METHOD_CHANNELS.getLatestBackgroundUpdateCheck,
      handleGetLatestBackgroundUpdateCheck
    ),
  },
});

export function registerPluginHandlers(): () => void {
  const cleanups: Array<() => void> = [pluginNamespace.register()];

  // The security wrapper's coarse envelope cap refuses a payload far past the
  // args cap before the handler below runs; meter those as oversized too. The
  // wrapper has already required a trusted sender.
  cleanups.push(
    observeIpcEnvelopeRejections(CHANNELS.PLUGIN_INVOKE, (event, args, error) => {
      if (!isPluginPayloadTooLargeError(error)) return;
      meterOversizeInvokeArgs(args[0], getProjectForWebContents(event.sender.id), 0);
    })
  );

  // plugin:invoke intentionally stays on raw ipcMain.handle for local views:
  // its variadic `...args: unknown[]` signature and senderFrame.url trust check
  // can't be expressed through IpcInvokeMap without widening types to
  // `unknown[]`, which would silently defeat the compile-time safety the
  // migration is for. Calls from a window on another machine arrive over the
  // link instead, through the dispatcher registration below.
  assertIpcSecurityReady(CHANNELS.PLUGIN_INVOKE);
  ipcMain.handle(
    CHANNELS.PLUGIN_INVOKE,
    async (event, pluginId: string, channel: string, ...args: unknown[]) => {
      const start = Date.now();
      // Pin the sender's scope synchronously, before any await: a project view
      // can be evicted (LRU, under memory pressure) or rebound to another
      // project while the dispatch is in flight, taking its registry binding
      // with it. Resolved here, the context always describes the renderer that
      // actually made the call.
      const senderWebContentsId = event.sender.id;
      const senderProjectId = getProjectForWebContents(senderWebContentsId);
      // The worktree lookup is keyed by window, but a window's workspace binding
      // tracks its *visible* project — so it only speaks for this sender when
      // this sender is the visible view. A cached (deactivated) view stays
      // registered to its own project while its window shows another, and an
      // unregistered sender has no project to speak for at all; in both cases a
      // window-keyed answer would pair one project's id with another project's
      // worktree, which is the mismatch #11297 is about. Leave the window
      // unresolved and take the null.
      const senderWindowId =
        senderProjectId !== null && !isCachedViewWebContents(senderWebContentsId)
          ? getWindowForWebContents(event.sender)?.id
          : undefined;
      const senderUrl = event.senderFrame?.url;
      if (!senderUrl || !isTrustedRendererUrl(senderUrl)) {
        // Trust check rejected — args are attacker-controlled and unvalidated,
        // so we record the rejection without hashing the payload (#8442:
        // audit-even-when-silenced; the security-relevant signal is "an
        // untrusted frame attempted to invoke this plugin"). Cap the URL
        // before it lands in the persistent log so a hostile frame can't
        // stuff arbitrary content into the audit by sending a giant URL.
        const safeUrl = senderUrl
          ? scrubSecrets(senderUrl.slice(0, UNTRUSTED_URL_MAX_CHARS))
          : "unknown";
        safeAppend({
          pluginId,
          actionId: channel,
          recordType: "ipc-invoke",
          channel: CHANNELS.PLUGIN_INVOKE,
          result: "restricted",
          errorMessage: `untrusted sender (url=${safeUrl})`,
          argsHash: "",
          durationMs: Date.now() - start,
        });
        throw new Error(`plugin:invoke rejected: untrusted sender (url=${senderUrl ?? "unknown"})`);
      }
      const invoke = () =>
        runPluginInvoke(
          {
            projectId: senderProjectId,
            webContentsId: senderWebContentsId,
            start,
            resolveWorktreeId: async (service) => {
              // No trustworthy window means no worktree — short-circuit rather
              // than query, so the invariant holds here regardless of what the
              // service would answer.
              if (senderWindowId === undefined) return null;
              // Resolving the worktree needs a round-trip to the workspace host,
              // so it can't be pinned synchronously like the ids above.
              // `getActiveWorktreeIdForWindow` swallows its own failures — a
              // wedged workspace host degrades the context rather than failing
              // the invocation it sits in front of.
              const worktreeId = await service.getActiveWorktreeIdForWindow(senderWindowId);
              // The window id survives a project switch, so a rebind during the
              // await would pair the sender's projectId with the *replacement*
              // project's worktree. Snapshots carry no project id to filter on, so
              // re-check the binding instead and drop to null on a mismatch: a null
              // worktree is honest, a cross-project one is the bug this fixes.
              return getProjectForWebContents(senderWebContentsId) !== senderProjectId
                ? null
                : worktreeId;
            },
          },
          pluginId,
          channel,
          args
        );
      // With Host-mode routing on, the call carries who made it, so an
      // app-global plugin's prompt finds this person. Off, no endpoint is
      // ever built here.
      return isPluginFrontendRoutingEnabled()
        ? runInPluginInvocation(pluginId, getLocalEndpoint(event.sender), invoke)
        : invoke();
    }
  );
  cleanups.push(() => ipcMain.removeHandler(CHANNELS.PLUGIN_INVOKE));

  // A window on another machine calls a plugin running here over the link.
  // Its project comes from the endpoint the host itself bound, never from the
  // call; its worktree is the project's current one on this host.
  cleanups.push(
    getIpcDispatcher().registerInvoke(CHANNELS.PLUGIN_INVOKE, async (ctx, ...raw) => {
      const start = Date.now();
      const [pluginId, channel, ...args] = raw;
      if (typeof pluginId !== "string" || typeof channel !== "string") {
        throw new AppError({
          code: "VALIDATION",
          message: "plugin:invoke rejected: plugin id and channel must be strings",
        });
      }
      const projectId = ctx.projectId;
      const endpoint = ctx.endpoint;
      const remote = endpoint.kind === "remote-view";
      if (remote) {
        const service = await getPluginService();
        if (service.isRemoteUnsupported(pluginId)) {
          console.warn(
            `[Plugin] Refused a call to "${pluginId}" from a window on another machine: the plugin declares "remote": "unsupported"`
          );
          safeAppend({
            pluginId,
            actionId: channel,
            recordType: "ipc-invoke",
            channel: CHANNELS.PLUGIN_INVOKE,
            result: "restricted",
            errorMessage: "plugin does not support windows on another machine",
            argsHash: "",
            durationMs: Date.now() - start,
          });
          throw remoteUnsupportedError(pluginId);
        }
      }
      return runInPluginInvocation(pluginId, endpoint, () =>
        runPluginInvoke(
          {
            projectId,
            webContentsId: ctx.webContentsId,
            start,
            origin: {
              kind: remote ? "remote" : "local",
              clientId: endpoint.clientId,
              endpointId: endpoint.endpointId,
            },
            resolveWorktreeId: async () => {
              if (projectId === null) return null;
              const worktreeId = await resolveActiveWorktreeIdForProject(projectId);
              // The endpoint may have been rebound to another project meanwhile.
              return endpoint.projectId === projectId ? worktreeId : null;
            },
          },
          pluginId,
          channel,
          args
        )
      );
    })
  );

  return () => cleanups.forEach((cleanup) => cleanup());
}
