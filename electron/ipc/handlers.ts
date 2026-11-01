import type { HandlerDependencies } from "./types.js";
import { registerWorktreeHandlers } from "./handlers/worktree/index.js";
import { registerTerminalHandlers } from "./handlers/terminal/index.js";
import { registerCopyTreeHandlers } from "./handlers/copyTree.js";
import { registerAiHandlers } from "./handlers/ai.js";
import { registerSystemShellHandlers } from "./handlers/systemShell.js";
import { registerEditorConfigHandlers } from "./handlers/editorConfig.js";
import { registerWindowChromeHandlers } from "./handlers/windowChrome.js";
import { registerPaintFabricSurfaceHandlers } from "./handlers/paintFabricSurface.js";
import { registerAgentCliHandlers } from "./handlers/agentCli.js";
import { registerProjectCrudHandlers } from "./handlers/projectCrud/index.js";
import { registerProjectRelocationHandlers } from "./handlers/projectRelocation.js";
import { registerProjectHistoryHandlers } from "./handlers/projectHistory.js";
import { registerWorkspaceHandlers } from "./handlers/workspace.js";
import { registerProjectSleepHandlers } from "./handlers/projectSleep.js";
import { registerProjectRecipesHandlers } from "./handlers/projectRecipes.js";
import { registerProjectPresetsHandlers } from "./handlers/projectPresets.js";
import { registerGlobalRecipesHandlers } from "./handlers/globalRecipes.js";
import { registerGlobalEnvHandlers } from "./handlers/globalEnv.js";
import { registerTerminalLayoutHandlers } from "./handlers/terminalLayout.js";
import { registerProjectInRepoSettingsHandlers } from "./handlers/projectInRepoSettings.js";
import { registerAppHandlers } from "./handlers/app.js";
import { registerPortalHandlers } from "./handlers/portal.js";
import { registerSessionRestoreHandlers } from "./handlers/sessionRestore.js";
import { registerWindowOpeningHandlers } from "./handlers/windowOpening.js";
import { registerKeepAwakeHandlers } from "./handlers/keepAwake.js";
import { registerIdleTerminalHandlers } from "./handlers/idleTerminals.js";
import { registerIdleBackgroundAutoCloseHandlers } from "./handlers/idleBackgroundAutoClose.js";
import { registerSystemSleepHandlers } from "./handlers/systemSleep.js";
import { registerAppVersionInfoHandlers } from "./handlers/appVersionInfo.js";
import { registerWorkspaceResidencyHandlers } from "./handlers/workspaceResidency.js";
import { registerProcessesHandlers } from "./handlers/processes.js";
import { registerPluginAgentMcpHandlers } from "./handlers/pluginAgentMcp.js";
import { registerOsDndHandlers } from "./handlers/osDnd.js";
import { registerKeybindingHandlers } from "./handlers/keybinding.js";
import { registerWorktreeConfigHandlers } from "./handlers/worktreeConfig.js";
import { registerConfigBundleHandlers } from "./handlers/configBundle.js";
import { registerNotificationHandlers } from "./handlers/notifications.js";
import { registerMenuHandlers } from "./handlers/menu.js";
import { registerFilesHandlers } from "./handlers/files.js";
import { registerFileMutationHandlers } from "./handlers/fileMutation.js";
import { registerFileDocumentHandlers } from "./handlers/fileDocument.js";
import { registerDiffMediaHandlers } from "./handlers/diffMedia.js";
import { registerFileBrowserHandlers } from "./handlers/fileBrowser.js";
import { registerFileWatchHandlers } from "./handlers/fileWatch.js";
import { registerSlashCommandHandlers } from "./handlers/slashCommands.js";
import { registerGeminiHandlers } from "./handlers/gemini.js";
import { registerCodexHandlers } from "./handlers/codex.js";
import { registerClaudeHandlers } from "./handlers/claude.js";
import { registerEventsHandlers } from "./handlers/events.js";
import { registerDevPreviewHandlers } from "./handlers/devPreview.js";
import { registerAppAgentHandlers } from "./handlers/appAgent.js";
import { registerAgentCapabilitiesHandlers } from "./handlers/agentCapabilities.js";
import { registerCliHandlers } from "./handlers/cli.js";
import { registerHelpHandlers } from "./handlers/help.js";
import { registerClipboardHandlers } from "./handlers/clipboard.js";
import { registerGitWriteHandlers } from "./handlers/git-write.js";
import { registerGitFetchHandlers } from "./handlers/gitFetch.js";
import { registerGitReadHandlers } from "./handlers/git-read.js";
import { registerTelemetryHandlers } from "./handlers/telemetry.js";
import { registerPrivacyHandlers } from "./handlers/privacy.js";
import { registerSentryHandlers } from "./handlers/sentry.js";
import { registerOnboardingHandlers } from "./handlers/onboarding.js";
import { registerShortcutHintsHandlers } from "./handlers/shortcutHints.js";
import { registerForgeRecommendationHandlers } from "./handlers/forgeRecommendation.js";
import { registerForgeHandlers } from "./handlers/forge.js";
import { registerForgeDataHandlers } from "./handlers/forgeData.js";
import { registerForgeSettingsHandlers } from "./handlers/forgeSettings.js";
import { registerForgeCredentialImportHandlers } from "./handlers/forgeCredentialImport.js";
import { registerForgeAuditHandlers } from "./handlers/forgeAudit.js";
import { initForgeHealthRelay, disposeForgeHealthRelay } from "../services/forgeHealthRelay.js";
import { installCachedViewFlushListeners } from "../services/cachedViewFlush.js";
import { registerProjectGroupsHandlers } from "./handlers/projectGroups.js";
import { registerRunHistoryHandlers } from "./handlers/runHistory.js";
import { registerCopyTreeHistoryHandlers } from "./handlers/copyTreeHistory.js";
import { registerFleetHandlers } from "./handlers/fleet.js";
import { registerCanopyHandlers } from "./handlers/canopy.js";
import { registerVoiceInputHandlers } from "./handlers/voiceInput.js";
import { registerVoiceDictionaryHandlers } from "./handlers/voiceDictionary.js";
import { registerRecentDictationsHandlers } from "./handlers/recentDictations.js";
import { registerMcpServerHandlers } from "./handlers/mcpServer.js";
import { registerHelpAssistantHandlers } from "./handlers/helpAssistant.js";
import { registerWebviewHandlers } from "./handlers/webview.js";
import { registerWebviewNavigationHandlers } from "./handlers/webviewNavigation.js";
import { registerWebviewCaptureHandlers } from "./handlers/webviewCapture.js";
import { registerRemoteHostsHandlers } from "./handlers/remoteHosts.js";
import { registerHostModeHandlers } from "./handlers/hostMode.js";
import { registerDeviceAnswerHandlers } from "./handlers/deviceAnswer.js";
import { registerDriveLeaseHandlers } from "./handlers/driveLease.js";
import { registerOperationsHandlers } from "./handlers/operations.js";
import { registerHostFilesHandlers } from "./handlers/hostFiles.js";
import { registerFileTransferHandlers } from "./handlers/fileTransfer.js";
import { registerHostSwitchHandlers } from "./handlers/hostSwitch.js";
import { registerProjectMatchHandlers } from "./handlers/projectMatch.js";
import { registerHostMetricsHandlers } from "./handlers/hostMetrics.js";
import { registerCanopyHostHandlers } from "./handlers/canopyHost.js";
import { registerPortForwardsHandlers } from "./handlers/portForwards.js";
import { registerPluginParityHandlers } from "./handlers/pluginParity.js";
import { registerSettingsCopyHandlers } from "./handlers/settingsCopy.js";
import { registerHostSettingsHandlers } from "./handlers/hostSettings.js";
import { isEitherRemoteRoleSupported } from "../remote/buildGate.js";
import { registerSitePreviewHandlers } from "./handlers/sitePreview.js";
import { registerElementPickerHandlers } from "./handlers/elementPicker.js";
import { registerWebviewEmulationHandlers } from "./handlers/webviewEmulation.js";
import { registerDiagnosticsHandlers } from "./handlers/diagnostics.js";
import { registerResourceProfileHandlers } from "./handlers/resourceProfile.js";
import { registerWhySlowHandlers } from "./handlers/whySlow.js";
import { registerMemoryPressureHandlers } from "./handlers/memoryPressure.js";
import { registerPerfHandlers } from "./handlers/perf.js";

import { registerAccessibilityHandlers } from "./handlers/accessibility.js";
import { registerDemoHandlers } from "./handlers/demo.js";
import { registerRecoveryHandlers } from "./handlers/recovery.js";
import { registerRosettaHandlers } from "./handlers/rosetta.js";
import { registerSafeModeHandlers } from "./handlers/safeMode.js";
import { registerWatchdogHandlers } from "./handlers/watchdog.js";
import { registerPluginHandlers } from "./handlers/plugin.js";
import { registerPluginMcpHandlers } from "./handlers/pluginMcp.js";
import { registerPluginCapabilityHandlers } from "./handlers/pluginCapability.js";
import { registerPluginProcessHandlers } from "./handlers/pluginProcess.js";
import { registerPluginMetricsHandlers } from "./handlers/pluginMetrics.js";
import { registerPluginPanelCaptureHandlers } from "./handlers/pluginPanelCapture.js";
import { registerPluginPushListenerHandlers } from "./handlers/pluginPushListeners.js";
import { registerPluginFocusedPanelHandlers } from "./handlers/pluginFocusedPanel.js";
import { registerPluginProjectPresenceHandlers } from "./handlers/pluginProjectPresence.js";
import { registerConnectivityHandlers } from "./handlers/connectivity.js";
import { registerAgentDefaultsHandlers } from "./handlers/agentDefaults.js";
import { registerAgentToolbarPinsHandlers } from "./handlers/agentToolbarPins.js";
import { registerProjectPresenceHandlers } from "./handlers/projectPresence.js";
import { registerProjectPresentationHandlers } from "./handlers/projectPresentation.js";
import { registerProjectThemeHandlers } from "./handlers/projectTheme.js";
import { registerWorktreeTitlesHandlers } from "./handlers/worktreeTitles.js";
import { registerReviewMarksHandlers } from "./handlers/reviewMarks.js";
import { registerSchedulesHandlers } from "./handlers/schedules.js";
import { registerScratchHandlers } from "./handlers/scratch/index.js";
import { events } from "../services/events.js";
import {
  typedHandle,
  typedSend,
  typedBroadcast,
  sendToRenderer,
  broadcastToRenderer,
  sendToRendererContext,
} from "./utils.js";

export {
  typedHandle,
  typedSend,
  typedBroadcast,
  sendToRenderer,
  broadcastToRenderer,
  sendToRendererContext,
};

type CleanupFn = () => void;

function runCleanups(cleanupFunctions: CleanupFn[]): void {
  for (const cleanup of [...cleanupFunctions].reverse()) {
    try {
      cleanup();
    } catch (error) {
      console.error("[IPC] Handler cleanup failed:", error);
    }
  }
}

export function registerIpcHandlers(deps: HandlerDependencies): () => void {
  if (!deps.events) {
    deps.events = events;
  }

  const cleanupFunctions: CleanupFn[] = [];

  const register = (registerFn: () => CleanupFn): void => {
    cleanupFunctions.push(registerFn());
  };

  try {
    register(() => registerWorktreeHandlers(deps));
    register(() => registerTerminalHandlers(deps));
    register(() => registerFilesHandlers());
    register(() => registerFileMutationHandlers());
    register(() => registerFileDocumentHandlers());
    register(() => registerDiffMediaHandlers());
    register(() => registerFileBrowserHandlers(deps));
    register(() => registerFileWatchHandlers());
    register(() => registerCopyTreeHandlers(deps));
    register(() => registerAiHandlers(deps));
    register(() => registerSlashCommandHandlers());
    register(() => registerSystemShellHandlers(deps));
    register(() => registerEditorConfigHandlers(deps));
    register(() => registerWindowChromeHandlers(deps));
    register(() => registerPaintFabricSurfaceHandlers(deps));
    register(() => registerAgentCliHandlers(deps));
    register(() => registerProjectCrudHandlers(deps));
    register(() => registerProjectRelocationHandlers(deps));
    register(() => registerProjectHistoryHandlers(deps));
    register(() => registerWorkspaceHandlers());
    register(() => registerProjectSleepHandlers(deps));
    register(() => registerProjectRecipesHandlers(deps));
    register(() => registerProjectPresetsHandlers(deps));
    register(() => registerGlobalRecipesHandlers());
    register(() => registerGlobalEnvHandlers());
    register(() => registerTerminalLayoutHandlers(deps));
    register(() => registerProjectInRepoSettingsHandlers(deps));
    register(() => registerAppHandlers(deps));
    register(() => installCachedViewFlushListeners());
    register(() => registerPortalHandlers(deps));
    register(() => registerMenuHandlers(deps));
    register(() => registerSessionRestoreHandlers(deps));
    register(() => registerWindowOpeningHandlers(deps));
    register(() => registerKeepAwakeHandlers(deps));
    register(() => registerIdleTerminalHandlers(deps));
    register(() => registerIdleBackgroundAutoCloseHandlers(deps));
    register(() => registerSystemSleepHandlers(deps));
    register(() => registerAppVersionInfoHandlers());
    register(() => registerWorkspaceResidencyHandlers());
    register(() => registerProcessesHandlers(deps));
    register(() => registerPluginAgentMcpHandlers());
    register(() => registerOsDndHandlers(deps));
    register(() => registerKeybindingHandlers(deps));
    register(() => registerWorktreeConfigHandlers(deps));
    register(() => registerConfigBundleHandlers(deps));
    register(() => registerNotificationHandlers(deps));
    register(() => registerGeminiHandlers());
    register(() => registerCodexHandlers());
    register(() => registerClaudeHandlers());
    register(() => registerEventsHandlers(deps));
    register(() => registerDevPreviewHandlers(deps));
    register(() => registerAppAgentHandlers(deps));
    register(() => registerAgentCapabilitiesHandlers());
    register(() => registerCliHandlers());
    register(() => registerHelpHandlers());
    register(() => registerClipboardHandlers());
    register(() => registerGitWriteHandlers(deps));
    register(() => registerGitFetchHandlers(deps));
    register(() => registerGitReadHandlers(deps));
    register(() => registerTelemetryHandlers());
    register(() => registerPrivacyHandlers());
    register(() => registerSentryHandlers());
    register(() => registerOnboardingHandlers());
    register(() => registerShortcutHintsHandlers());
    register(() => registerForgeRecommendationHandlers());
    register(() => registerForgeSettingsHandlers());
    register(() => registerForgeCredentialImportHandlers());
    register(() => registerForgeHandlers());
    register(() => registerForgeDataHandlers());
    register(() => {
      initForgeHealthRelay();
      return disposeForgeHealthRelay;
    });
    register(() => registerForgeAuditHandlers());
    register(() => registerProjectGroupsHandlers());
    register(() => registerRunHistoryHandlers());
    register(() => registerCopyTreeHistoryHandlers(deps));
    register(() => registerFleetHandlers());
    register(() => registerCanopyHandlers());
    register(() => registerVoiceInputHandlers(deps));
    register(() => registerVoiceDictionaryHandlers());
    register(() => registerRecentDictationsHandlers());
    register(() => registerMcpServerHandlers());
    register(() => registerHelpAssistantHandlers());
    register(() => registerWebviewHandlers(deps));
    register(() => registerWebviewNavigationHandlers(deps));
    register(() => registerWebviewCaptureHandlers(deps));
    register(() => registerSitePreviewHandlers(deps));
    register(() => registerElementPickerHandlers());
    register(() => registerWebviewEmulationHandlers(deps));
    register(() => registerDiagnosticsHandlers(deps));
    register(() => registerResourceProfileHandlers(deps));
    register(() => registerWhySlowHandlers(deps));
    register(() => registerMemoryPressureHandlers(deps));

    register(() => registerAccessibilityHandlers());
    register(() => registerDemoHandlers(deps));
    register(() => registerRecoveryHandlers(deps));
    register(() => registerRosettaHandlers());
    register(() => registerSafeModeHandlers());
    register(() => registerWatchdogHandlers(deps));
    register(() => registerPluginHandlers());
    register(() => registerPluginMcpHandlers());
    register(() => registerPluginCapabilityHandlers());
    register(() => registerPluginProcessHandlers());
    register(() => registerPluginMetricsHandlers());
    register(() => registerPluginPanelCaptureHandlers(deps));
    register(() => registerPluginPushListenerHandlers());
    register(() => registerPluginFocusedPanelHandlers());
    register(() => registerPluginProjectPresenceHandlers());
    register(() => registerPerfHandlers(deps));
    register(() => registerConnectivityHandlers());
    register(() => registerAgentDefaultsHandlers());
    register(() => registerAgentToolbarPinsHandlers());
    register(() => registerProjectPresenceHandlers(deps));
    register(() => registerProjectPresentationHandlers());
    register(() => registerProjectThemeHandlers());
    register(() => registerWorktreeTitlesHandlers());
    register(() => registerReviewMarksHandlers(deps));
    register(() => registerSchedulesHandlers());
    register(() => registerScratchHandlers(deps));

    // Remote Hosts: macOS and Linux only. Windows builds register none of it.
    if (isEitherRemoteRoleSupported()) {
      register(() => registerRemoteHostsHandlers());
      register(() => registerHostModeHandlers());
      register(() => registerDeviceAnswerHandlers());
      register(() => registerDriveLeaseHandlers());
      register(() => registerOperationsHandlers());
      register(() => registerHostFilesHandlers());
      register(() => registerFileTransferHandlers());
      register(() => registerHostSwitchHandlers());
      register(() => registerProjectMatchHandlers());
      register(() => registerHostMetricsHandlers());
      register(() => registerCanopyHostHandlers());
      register(() => registerPortForwardsHandlers());
      register(() => registerPluginParityHandlers());
      register(() => registerSettingsCopyHandlers());
      register(() => registerHostSettingsHandlers());
    }
  } catch (error) {
    runCleanups(cleanupFunctions);
    throw error;
  }

  return () => {
    runCleanups(cleanupFunctions);
  };
}
