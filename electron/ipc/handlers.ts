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
import { events } from "../services/events.js";
import { typedHandle, typedSend, sendToRenderer } from "./utils.js";

export { typedHandle, typedSend, sendToRenderer };

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

  const cleanupFunctions = [
    registerWorktreeHandlers(deps),
    registerTerminalHandlers(deps),
    registerFilesHandlers(),
    registerCopyTreeHandlers(deps),
    registerAiHandlers(deps),
    registerSlashCommandHandlers(),
    registerProjectHandlers(deps),
    registerGithubHandlers(deps),
    registerAppHandlers(deps),
    registerSidecarHandlers(deps),
    registerMenuHandlers(deps),
    registerHibernationHandlers(deps),
    registerSystemSleepHandlers(deps),
    registerKeybindingHandlers(deps),
    registerWorktreeConfigHandlers(deps),
    registerNotificationHandlers(deps),
    registerGeminiHandlers(),
    registerEventsHandlers(deps),
    registerNotesHandlers(deps),
    registerDevPreviewHandlers(deps),
    registerCommandHandlers(),
    registerAppAgentHandlers(deps),
    registerAssistantHandlers(mainWindow),
  ];

  return () => {
    cleanupFunctions.forEach((cleanup) => cleanup());
  };
}
