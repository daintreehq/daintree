import { BrowserWindow } from "electron";
import type { PtyClient } from "../services/PtyClient.js";
import type { WorkspaceClient } from "../services/WorkspaceClient.js";
import type { EventBuffer } from "../services/EventBuffer.js";
import type { CliAvailabilityService } from "../services/CliAvailabilityService.js";
import type { SidecarManager } from "../services/SidecarManager.js";
import type { TypedEventBus } from "../services/events.js";
import type { AgentVersionService } from "../services/AgentVersionService.js";
import type { AgentUpdateHandler } from "../services/AgentUpdateHandler.js";

export interface HandlerDependencies {
  mainWindow: BrowserWindow;
  ptyClient: PtyClient;
  worktreeService?: WorkspaceClient;
  eventBuffer?: EventBuffer;
  cliAvailabilityService?: CliAvailabilityService;
  sidecarManager?: SidecarManager;
  events?: TypedEventBus;
  agentVersionService?: AgentVersionService;
  agentUpdateHandler?: AgentUpdateHandler;
}
