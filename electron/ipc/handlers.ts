import type { HandlerDependencies } from "./types.js";
import { registerWorktreeHandlers } from "./handlers/worktree.js";
import { registerTerminalHandlers } from "./handlers/terminal.js";
import { registerCopyTreeHandlers } from "./handlers/copyTree.js";
import { registerAiHandlers } from "./handlers/ai.js";
import { registerSystemShellHandlers } from "./handlers/systemShell.js";
import { registerEditorConfigHandlers } from "./handlers/editorConfig.js";
import { registerAgentCliHandlers } from "./handlers/agentCli.js";
import { registerProjectCrudHandlers } from "./handlers/projectCrud.js";
import { registerProjectRecipesHandlers } from "./handlers/projectRecipes.js";
import { registerTerminalLayoutHandlers } from "./handlers/terminalLayout.js";
import { registerProjectInRepoSettingsHandlers } from "./handlers/projectInRepoSettings.js";
import { registerGithubHandlers } from "./handlers/github.js";
import { registerAppHandlers } from "./handlers/app.js";
import { registerPortalHandlers } from "./handlers/portal.js";
import { registerHibernationHandlers } from "./handlers/hibernation.js";
import { registerSystemSleepHandlers } from "./handlers/systemSleep.js";
import { registerKeybindingHandlers } from "./handlers/keybinding.js";
import { registerWorktreeConfigHandlers } from "./handlers/worktreeConfig.js";
import { registerNotificationHandlers } from "./handlers/notifications.js";
import { registerMenuHandlers } from "./handlers/menu.js";
import { registerFilesHandlers } from "./handlers/files.js";
import { registerSlashCommandHandlers } from "./handlers/slashCommands.js";
import { registerGeminiHandlers } from "./handlers/gemini.js";
import { registerEventsHandlers } from "./handlers/events.js";
import { registerNotesHandlers } from "./handlers/notes.js";
import { registerDevPreviewHandlers } from "./handlers/devPreview.js";
import { registerGlobalDevServersHandlers } from "./handlers/globalDevServers.js";
import { registerCommandHandlers } from "./handlers/commands.js";
import { registerAppAgentHandlers } from "./handlers/appAgent.js";
import { registerAgentCapabilitiesHandlers } from "./handlers/agentCapabilities.js";
import { registerCliHandlers } from "./handlers/cli.js";
import { registerClipboardHandlers } from "./handlers/clipboard.js";
import { registerGitWriteHandlers } from "./handlers/git-write.js";
import { registerTelemetryHandlers } from "./handlers/telemetry.js";
import { registerPrivacyHandlers } from "./handlers/privacy.js";
import { registerOnboardingHandlers } from "./handlers/onboarding.js";
import { registerShortcutHintsHandlers } from "./handlers/shortcutHints.js";
import { registerVoiceInputHandlers } from "./handlers/voiceInput.js";
import { registerMcpServerHandlers } from "./handlers/mcpServer.js";
import { registerWebviewHandlers } from "./handlers/webview.js";
import { registerDiagnosticsHandlers } from "./handlers/diagnostics.js";
import { registerWorkflowHandlers } from "./handlers/workflow.js";
import { registerAccessibilityHandlers } from "./handlers/accessibility.js";
import { registerDemoHandlers } from "./handlers/demo.js";
import { events } from "../services/events.js";
import { typedHandle, typedSend, sendToRenderer } from "./utils.js";

export { typedHandle, typedSend, sendToRenderer };

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
    register(() => registerCopyTreeHandlers(deps));
    register(() => registerAiHandlers(deps));
    register(() => registerSlashCommandHandlers());
    register(() => registerSystemShellHandlers(deps));
    register(() => registerEditorConfigHandlers(deps));
    register(() => registerAgentCliHandlers(deps));
    register(() => registerProjectCrudHandlers(deps));
    register(() => registerProjectRecipesHandlers(deps));
    register(() => registerTerminalLayoutHandlers(deps));
    register(() => registerProjectInRepoSettingsHandlers(deps));
    register(() => registerGithubHandlers(deps));
    register(() => registerAppHandlers(deps));
    register(() => registerPortalHandlers(deps));
    register(() => registerMenuHandlers(deps));
    register(() => registerHibernationHandlers(deps));
    register(() => registerSystemSleepHandlers(deps));
    register(() => registerKeybindingHandlers(deps));
    register(() => registerWorktreeConfigHandlers(deps));
    register(() => registerNotificationHandlers(deps));
    register(() => registerGeminiHandlers());
    register(() => registerEventsHandlers(deps));
    register(() => registerNotesHandlers(deps));
    register(() => registerDevPreviewHandlers(deps));
    register(() => registerGlobalDevServersHandlers(deps));
    register(() => registerCommandHandlers());
    register(() => registerAppAgentHandlers(deps));
    register(() => registerAgentCapabilitiesHandlers());
    register(() => registerCliHandlers());
    register(() => registerClipboardHandlers());
    register(() => registerGitWriteHandlers(deps));
    register(() => registerTelemetryHandlers());
    register(() => registerPrivacyHandlers());
    register(() => registerOnboardingHandlers());
    register(() => registerShortcutHintsHandlers());
    register(() => registerVoiceInputHandlers(deps));
    register(() => registerMcpServerHandlers());
    register(() => registerWebviewHandlers(deps));
    register(() => registerDiagnosticsHandlers(deps));
    register(() => registerWorkflowHandlers(deps));
    register(() => registerAccessibilityHandlers());
    register(() => registerDemoHandlers(deps));
  } catch (error) {
    runCleanups(cleanupFunctions);
    throw error;
  }

  return () => {
    runCleanups(cleanupFunctions);
  };
}
