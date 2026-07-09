import type { HandlerDependencies } from "./types.js";
import { registerWorktreeHandlers } from "./handlers/worktree/index.js";
import { registerTerminalHandlers } from "./handlers/terminal/index.js";
import { registerCopyTreeHandlers } from "./handlers/copyTree.js";
import { registerAiHandlers } from "./handlers/ai.js";
import { registerSystemShellHandlers } from "./handlers/systemShell.js";
import { registerEditorConfigHandlers } from "./handlers/editorConfig.js";
import { registerPaintFabricSurfaceHandlers } from "./handlers/paintFabricSurface.js";
import { registerAgentCliHandlers } from "./handlers/agentCli.js";
import { registerProjectCrudHandlers } from "./handlers/projectCrud/index.js";
import { registerProjectFreeMemoryHandlers } from "./handlers/projectFreeMemory.js";
import { registerProjectRecipesHandlers } from "./handlers/projectRecipes.js";
import { registerProjectPresetsHandlers } from "./handlers/projectPresets.js";
import { registerGlobalRecipesHandlers } from "./handlers/globalRecipes.js";
import { registerGlobalEnvHandlers } from "./handlers/globalEnv.js";
import { registerTerminalLayoutHandlers } from "./handlers/terminalLayout.js";
import { registerProjectInRepoSettingsHandlers } from "./handlers/projectInRepoSettings.js";
import { registerAppHandlers } from "./handlers/app.js";
import { registerPortalHandlers } from "./handlers/portal.js";
import { registerHibernationHandlers } from "./handlers/hibernation.js";
import { registerIdleTerminalHandlers } from "./handlers/idleTerminals.js";
import { registerIdleBackgroundAutoCloseHandlers } from "./handlers/idleBackgroundAutoClose.js";
import { registerSystemSleepHandlers } from "./handlers/systemSleep.js";
import { registerAppVersionInfoHandlers } from "./handlers/appVersionInfo.js";
import { registerOsDndHandlers } from "./handlers/osDnd.js";
import { registerKeybindingHandlers } from "./handlers/keybinding.js";
import { registerWorktreeConfigHandlers } from "./handlers/worktreeConfig.js";
import { registerNotificationHandlers } from "./handlers/notifications.js";
import { registerMenuHandlers } from "./handlers/menu.js";
import { registerFilesHandlers } from "./handlers/files.js";
import { registerDiffMediaHandlers } from "./handlers/diffMedia.js";
import { registerSlashCommandHandlers } from "./handlers/slashCommands.js";
import { registerGeminiHandlers } from "./handlers/gemini.js";
import { registerEventsHandlers } from "./handlers/events.js";
import { registerDevPreviewHandlers } from "./handlers/devPreview.js";
import { registerCommandHandlers } from "./handlers/commands.js";
import { registerAppAgentHandlers } from "./handlers/appAgent.js";
import { registerAgentCapabilitiesHandlers } from "./handlers/agentCapabilities.js";
import { registerCliHandlers } from "./handlers/cli.js";
import { registerHelpHandlers } from "./handlers/help.js";
import { registerClipboardHandlers } from "./handlers/clipboard.js";
import { registerGitWriteHandlers } from "./handlers/git-write.js";
import { registerGitReadHandlers } from "./handlers/git-read.js";
import { registerTelemetryHandlers } from "./handlers/telemetry.js";
import { registerPrivacyHandlers } from "./handlers/privacy.js";
import { registerSentryHandlers } from "./handlers/sentry.js";
import { registerOnboardingHandlers } from "./handlers/onboarding.js";
import { registerMilestonesHandlers } from "./handlers/milestones.js";
import { registerShortcutHintsHandlers } from "./handlers/shortcutHints.js";
import { registerForgeRecommendationHandlers } from "./handlers/forgeRecommendation.js";
import { registerForgeHandlers } from "./handlers/forge.js";
import { registerForgeDataHandlers } from "./handlers/forgeData.js";
import { registerForgeSettingsHandlers } from "./handlers/forgeSettings.js";
import { registerForgeAuditHandlers } from "./handlers/forgeAudit.js";
import { initForgeHealthRelay, disposeForgeHealthRelay } from "../services/forgeHealthRelay.js";
import { registerRunHistoryHandlers } from "./handlers/runHistory.js";
import { registerVoiceInputHandlers } from "./handlers/voiceInput.js";
import { registerMcpServerHandlers } from "./handlers/mcpServer.js";
import { registerHelpAssistantHandlers } from "./handlers/helpAssistant.js";
import { registerWebviewHandlers } from "./handlers/webview.js";
import { registerWebviewNavigationHandlers } from "./handlers/webviewNavigation.js";
import { registerWebviewCaptureHandlers } from "./handlers/webviewCapture.js";
import { registerDiagnosticsHandlers } from "./handlers/diagnostics.js";
import { registerResourceProfileHandlers } from "./handlers/resourceProfile.js";
import { registerWhySlowHandlers } from "./handlers/whySlow.js";
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
import { registerConnectivityHandlers } from "./handlers/connectivity.js";
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
    register(() => registerDiffMediaHandlers());
    register(() => registerCopyTreeHandlers(deps));
    register(() => registerAiHandlers(deps));
    register(() => registerSlashCommandHandlers());
    register(() => registerSystemShellHandlers(deps));
    register(() => registerEditorConfigHandlers(deps));
    register(() => registerPaintFabricSurfaceHandlers(deps));
    register(() => registerAgentCliHandlers(deps));
    register(() => registerProjectCrudHandlers(deps));
    register(() => registerProjectFreeMemoryHandlers(deps));
    register(() => registerProjectRecipesHandlers(deps));
    register(() => registerProjectPresetsHandlers(deps));
    register(() => registerGlobalRecipesHandlers());
    register(() => registerGlobalEnvHandlers());
    register(() => registerTerminalLayoutHandlers(deps));
    register(() => registerProjectInRepoSettingsHandlers(deps));
    register(() => registerAppHandlers(deps));
    register(() => registerPortalHandlers(deps));
    register(() => registerMenuHandlers(deps));
    register(() => registerHibernationHandlers(deps));
    register(() => registerIdleTerminalHandlers(deps));
    register(() => registerIdleBackgroundAutoCloseHandlers(deps));
    register(() => registerSystemSleepHandlers(deps));
    register(() => registerAppVersionInfoHandlers());
    register(() => registerOsDndHandlers(deps));
    register(() => registerKeybindingHandlers(deps));
    register(() => registerWorktreeConfigHandlers(deps));
    register(() => registerNotificationHandlers(deps));
    register(() => registerGeminiHandlers());
    register(() => registerEventsHandlers(deps));
    register(() => registerDevPreviewHandlers(deps));
    register(() => registerCommandHandlers());
    register(() => registerAppAgentHandlers(deps));
    register(() => registerAgentCapabilitiesHandlers());
    register(() => registerCliHandlers());
    register(() => registerHelpHandlers());
    register(() => registerClipboardHandlers());
    register(() => registerGitWriteHandlers(deps));
    register(() => registerGitReadHandlers(deps));
    register(() => registerTelemetryHandlers());
    register(() => registerPrivacyHandlers());
    register(() => registerSentryHandlers());
    register(() => registerOnboardingHandlers());
    register(() => registerMilestonesHandlers());
    register(() => registerShortcutHintsHandlers());
    register(() => registerForgeRecommendationHandlers());
    register(() => registerForgeSettingsHandlers());
    register(() => registerForgeHandlers());
    register(() => registerForgeDataHandlers());
    register(() => {
      initForgeHealthRelay();
      return disposeForgeHealthRelay;
    });
    register(() => registerForgeAuditHandlers());
    register(() => registerRunHistoryHandlers());
    register(() => registerVoiceInputHandlers(deps));
    register(() => registerMcpServerHandlers());
    register(() => registerHelpAssistantHandlers());
    register(() => registerWebviewHandlers(deps));
    register(() => registerWebviewNavigationHandlers(deps));
    register(() => registerWebviewCaptureHandlers(deps));
    register(() => registerDiagnosticsHandlers(deps));
    register(() => registerResourceProfileHandlers(deps));
    register(() => registerWhySlowHandlers(deps));

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
    register(() => registerPerfHandlers(deps));
    register(() => registerConnectivityHandlers());
    register(() => registerScratchHandlers(deps));
  } catch (error) {
    runCleanups(cleanupFunctions);
    throw error;
  }

  return () => {
    runCleanups(cleanupFunctions);
  };
}
