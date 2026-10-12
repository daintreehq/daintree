import { BrowserWindow } from "electron";
import type { PtyClient } from "../services/PtyClient.js";
import type { WorkspaceClient } from "../services/WorkspaceClient.js";
import type { EventBuffer } from "../services/EventBuffer.js";
import type { CliAvailabilityService } from "../services/CliAvailabilityService.js";
import type { PortalManager } from "../services/PortalManager.js";
import type { TypedEventBus } from "../services/events.js";
import type { AgentVersionService } from "../services/AgentVersionService.js";
import type { AgentUpdateHandler } from "../services/AgentUpdateHandler.js";
import type { ProjectSwitchService } from "../services/ProjectSwitchService.js";
import type { WindowRegistry } from "../window/WindowRegistry.js";
import type { ProjectViewManager } from "../window/ProjectViewManager.js";
import type { WorktreePortBroker } from "../services/WorktreePortBroker.js";
import type { ClientEndpoint, ClientRef } from "./endpoint.js";

/**
 * Per-request context. A local view's call carries its real `event` and
 * `senderWindow`; a call that arrived over a link has neither (both null) and
 * a negative `webContentsId` (the endpoint handle), so replies and pushes must
 * go through `endpoint` (see `sendToRendererContext`). `senderWindow` is a
 * Shell concept and is never set for a remote endpoint.
 */
export interface IpcContext {
  event: Electron.IpcMainInvokeEvent | null;
  webContentsId: number;
  senderWindow: BrowserWindow | null;
  projectId: string | null;
  endpoint: ClientEndpoint;
  client: ClientRef;
}

export interface HandlerDependencies {
  mainWindow?: BrowserWindow;
  ptyClient?: PtyClient;
  worktreeService?: WorkspaceClient;
  eventBuffer?: EventBuffer;
  cliAvailabilityService?: CliAvailabilityService;
  portalManager?: PortalManager;
  events?: TypedEventBus;
  agentVersionService?: AgentVersionService;
  agentUpdateHandler?: AgentUpdateHandler;
  projectSwitchService?: ProjectSwitchService;
  isDemoMode?: boolean;
  windowRegistry?: WindowRegistry;
  projectViewManager?: ProjectViewManager;
  worktreePortBroker?: WorktreePortBroker;
}
