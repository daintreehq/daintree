import { ipcMain } from "electron";
import { CHANNELS } from "../channels.js";
import { mcpServerService } from "../../services/McpServerService.js";

export function registerMcpServerHandlers(): () => void {
  const handlers: Array<() => void> = [];

  ipcMain.handle(CHANNELS.MCP_SERVER_GET_STATUS, () => mcpServerService.getStatus());
  handlers.push(() => ipcMain.removeHandler(CHANNELS.MCP_SERVER_GET_STATUS));

  ipcMain.handle(CHANNELS.MCP_SERVER_SET_ENABLED, async (_event, enabled: boolean) => {
    if (typeof enabled !== "boolean") throw new Error("enabled must be a boolean");
    await mcpServerService.setEnabled(enabled);
    return mcpServerService.getStatus();
  });
  handlers.push(() => ipcMain.removeHandler(CHANNELS.MCP_SERVER_SET_ENABLED));

  ipcMain.handle(CHANNELS.MCP_SERVER_SET_PORT, async (_event, port: number | null) => {
    if (
      port !== null &&
      (typeof port !== "number" || port < 1024 || port > 65535 || !Number.isInteger(port))
    ) {
      throw new Error("port must be null or an integer between 1024 and 65535");
    }
    await mcpServerService.setPort(port);
    return mcpServerService.getStatus();
  });
  handlers.push(() => ipcMain.removeHandler(CHANNELS.MCP_SERVER_SET_PORT));

  ipcMain.handle(CHANNELS.MCP_SERVER_SET_API_KEY, async (_event, apiKey: string) => {
    if (typeof apiKey !== "string") throw new Error("apiKey must be a string");
    await mcpServerService.setApiKey(apiKey);
    return mcpServerService.getStatus();
  });
  handlers.push(() => ipcMain.removeHandler(CHANNELS.MCP_SERVER_SET_API_KEY));

  ipcMain.handle(CHANNELS.MCP_SERVER_GENERATE_API_KEY, async () => {
    return await mcpServerService.generateApiKey();
  });
  handlers.push(() => ipcMain.removeHandler(CHANNELS.MCP_SERVER_GENERATE_API_KEY));

  ipcMain.handle(CHANNELS.MCP_SERVER_GET_CONFIG_SNIPPET, () => mcpServerService.getConfigSnippet());
  handlers.push(() => ipcMain.removeHandler(CHANNELS.MCP_SERVER_GET_CONFIG_SNIPPET));

  return () => handlers.forEach((cleanup) => cleanup());
}
