import { ipcMain } from "electron";
import { z } from "zod";
import { CHANNELS } from "../channels.js";
import type { HandlerDependencies } from "../types.js";
import { appAgentService } from "../../services/AppAgentService.js";
import type { OneShotRunRequest, AppAgentConfig } from "../../../shared/types/appAgent.js";
import { AppAgentConfigSchema } from "../../../shared/types/appAgent.js";
import type { ActionManifestEntry, ActionContext } from "../../../shared/types/actions.js";

const OneShotRunRequestSchema = z.object({
  prompt: z.string().min(1).max(5000),
  clarificationChoice: z.string().max(500).optional(),
});

const ActionManifestEntrySchema = z.object({
  id: z.string(),
  name: z.string(),
  title: z.string(),
  description: z.string(),
  category: z.string(),
  kind: z.string(),
  danger: z.string(),
  inputSchema: z.record(z.string(), z.unknown()).optional(),
  outputSchema: z.record(z.string(), z.unknown()).optional(),
  enabled: z.boolean(),
  disabledReason: z.string().optional(),
});

const ActionContextSchema = z.object({
  projectId: z.string().optional(),
  activeWorktreeId: z.string().optional(),
  focusedWorktreeId: z.string().optional(),
  focusedTerminalId: z.string().optional(),
});

export function registerAppAgentHandlers(_deps: HandlerDependencies): () => void {
  const handlers: Array<() => void> = [];

  const handleRunOneShot = async (
    _event: Electron.IpcMainInvokeEvent,
    payload: {
      request: OneShotRunRequest;
      actions: ActionManifestEntry[];
      context: ActionContext;
    }
  ) => {
    if (!payload || typeof payload !== "object") {
      throw new Error("Invalid payload");
    }
    const { request, actions, context } = payload;
    if (!request || !actions || !context) {
      throw new Error("Missing required fields: request, actions, context");
    }

    const requestResult = OneShotRunRequestSchema.safeParse(request);
    if (!requestResult.success) {
      throw new Error(`Invalid request: ${requestResult.error.message}`);
    }

    const actionsResult = z.array(ActionManifestEntrySchema).safeParse(actions);
    if (!actionsResult.success) {
      throw new Error(`Invalid actions: ${actionsResult.error.message}`);
    }

    const contextResult = ActionContextSchema.safeParse(context);
    if (!contextResult.success) {
      throw new Error(`Invalid context: ${contextResult.error.message}`);
    }

    return appAgentService.runOneShot(
      requestResult.data,
      actionsResult.data as ActionManifestEntry[],
      contextResult.data
    );
  };
  ipcMain.handle(CHANNELS.APP_AGENT_RUN_ONE_SHOT, handleRunOneShot);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.APP_AGENT_RUN_ONE_SHOT));

  const handleGetConfig = async () => {
    return appAgentService.getConfig();
  };
  ipcMain.handle(CHANNELS.APP_AGENT_GET_CONFIG, handleGetConfig);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.APP_AGENT_GET_CONFIG));

  const handleSetConfig = async (
    _event: Electron.IpcMainInvokeEvent,
    config: Partial<AppAgentConfig>
  ) => {
    if (!config || typeof config !== "object") {
      throw new Error("Invalid config");
    }

    const configResult = AppAgentConfigSchema.partial().safeParse(config);
    if (!configResult.success) {
      throw new Error(`Invalid config: ${configResult.error.message}`);
    }

    appAgentService.setConfig(configResult.data);
    return appAgentService.getConfig();
  };
  ipcMain.handle(CHANNELS.APP_AGENT_SET_CONFIG, handleSetConfig);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.APP_AGENT_SET_CONFIG));

  const handleHasApiKey = async () => {
    return appAgentService.hasApiKey();
  };
  ipcMain.handle(CHANNELS.APP_AGENT_HAS_API_KEY, handleHasApiKey);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.APP_AGENT_HAS_API_KEY));

  const handleCancel = async () => {
    appAgentService.cancel();
  };
  ipcMain.handle(CHANNELS.APP_AGENT_CANCEL, handleCancel);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.APP_AGENT_CANCEL));

  return () => handlers.forEach((cleanup) => cleanup());
}
