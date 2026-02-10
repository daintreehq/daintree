import { BrowserWindow } from "electron";
import type { CliAvailabilityService } from "../services/CliAvailabilityService.js";
import type { AgentVersionService } from "../services/AgentVersionService.js";
import type { AgentUpdateHandler } from "../services/AgentUpdateHandler.js";
import type { EventBuffer } from "../services/EventBuffer.js";
import type { SidecarManager } from "../services/SidecarManager.js";
import type { PtyClient } from "../services/PtyClient.js";
import type { WorkspaceClient } from "../services/WorkspaceClient.js";
import type { HandlerDependencies } from "./types.js";
import { registerWorktreeHandlers } from "./handlers/worktree.js";
import { registerTerminalHandlers } from "./handlers/terminal.js";
import { registerCopyTreeHandlers } from "./handlers/copyTree.js";
import { registerAiHandlers } from "./handlers/ai.js";
import { registerProjectHandlers } from "./handlers/project.js";
import { registerGithubHandlers } from "./handlers/github.js";
import { registerAppHandlers } from "./handlers/app.js";
import { registerSidecarHandlers } from "./handlers/sidecar.js";
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
import { registerCommandHandlers } from "./handlers/commands.js";
import { registerAppAgentHandlers } from "./handlers/appAgent.js";
import { registerAssistantHandlers } from "./handlers/assistant.js";
import { registerAgentCapabilitiesHandlers } from "./handlers/agentCapabilities.js";
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

export function registerIpcHandlers(
  mainWindow: BrowserWindow,
  ptyClient: PtyClient,
  worktreeService?: WorkspaceClient,
  eventBuffer?: EventBuffer,
  cliAvailabilityService?: CliAvailabilityService,
  agentVersionService?: AgentVersionService,
  agentUpdateHandler?: AgentUpdateHandler,
  sidecarManager?: SidecarManager
): () => void {
  const deps: HandlerDependencies = {
    mainWindow,
    ptyClient,
    worktreeService,
    eventBuffer,
    cliAvailabilityService,
    agentVersionService,
    agentUpdateHandler,
    sidecarManager,
    events,
  };

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
    register(() => registerProjectHandlers(deps));
    register(() => registerGithubHandlers(deps));
    register(() => registerAppHandlers(deps));
    register(() => registerSidecarHandlers(deps));
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
    register(() => registerCommandHandlers());
    register(() => registerAppAgentHandlers(deps));
    register(() => registerAssistantHandlers(mainWindow));
    register(() => registerAgentCapabilitiesHandlers());
  } catch (error) {
    runCleanups(cleanupFunctions);
    throw error;
  }

  return () => {
    runCleanups(cleanupFunctions);
  };
}
