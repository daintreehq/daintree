import { BrowserWindow } from "electron";
import type { DevServerManager } from "../services/DevServerManager.js";
import type { CliAvailabilityService } from "../services/CliAvailabilityService.js";
import type { EventBuffer } from "../services/EventBuffer.js";
import type { SidecarManager } from "../services/SidecarManager.js";
import { HandlerDependencies, TerminalManager, WorkspaceManager } from "./types.js";
import { registerWorktreeHandlers } from "./handlers/worktree.js";
import { registerTerminalHandlers } from "./handlers/terminal.js";
import { registerDevServerHandlers } from "./handlers/devServer.js";
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
import { typedHandle, typedSend, sendToRenderer } from "./utils.js";

export { typedHandle, typedSend, sendToRenderer };

export function registerIpcHandlers(
  mainWindow: BrowserWindow,
  ptyManager: TerminalManager,
  devServerManager?: DevServerManager,
  worktreeService?: WorkspaceManager,
  eventBuffer?: EventBuffer,
  cliAvailabilityService?: CliAvailabilityService,
  sidecarManager?: SidecarManager
): () => void {
  const deps: HandlerDependencies = {
    mainWindow,
    ptyManager,
    devServerManager,
    worktreeService,
    eventBuffer,
    cliAvailabilityService,
    sidecarManager,
  };

  const cleanupFunctions = [
    registerWorktreeHandlers(deps),
    registerTerminalHandlers(deps),
    registerDevServerHandlers(deps),
    registerCopyTreeHandlers(deps),
    registerAiHandlers(deps),
    registerProjectHandlers(deps),
    registerGithubHandlers(deps),
    registerAppHandlers(deps),
    registerSidecarHandlers(deps),
    registerHibernationHandlers(deps),
    registerSystemSleepHandlers(deps),
    registerKeybindingHandlers(deps),
    registerWorktreeConfigHandlers(deps),
  ];

  return () => {
    cleanupFunctions.forEach((cleanup) => cleanup());
  };
}
