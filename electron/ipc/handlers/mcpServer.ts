import { CHANNELS } from "../channels.js";
import type * as McpServerServiceModule from "../../services/McpServerService.js";
import { typedHandle } from "../utils.js";

type McpServerSingleton = typeof McpServerServiceModule.mcpServerService;

let cachedMcpServerService: McpServerSingleton | null = null;
async function getMcpServerService(): Promise<McpServerSingleton> {
  if (!cachedMcpServerService) {
    const mod = await import("../../services/McpServerService.js");
    cachedMcpServerService = mod.mcpServerService;
  }
  return cachedMcpServerService;
}

export function registerMcpServerHandlers(): () => void {
  const handlers: Array<() => void> = [];

  handlers.push(
    typedHandle(CHANNELS.MCP_SERVER_GET_STATUS, async () => {
      const svc = await getMcpServerService();
      return svc.getStatus();
    })
  );

  handlers.push(
    typedHandle(CHANNELS.MCP_SERVER_SET_ENABLED, async (enabled: boolean) => {
      if (typeof enabled !== "boolean") throw new Error("enabled must be a boolean");
      const svc = await getMcpServerService();
      await svc.setEnabled(enabled);
      return svc.getStatus();
    })
  );

  handlers.push(
    typedHandle(CHANNELS.MCP_SERVER_SET_PORT, async (port: number | null) => {
      if (
        port !== null &&
        (typeof port !== "number" || port < 1024 || port > 65535 || !Number.isInteger(port))
      ) {
        throw new Error("port must be null or an integer between 1024 and 65535");
      }
      const svc = await getMcpServerService();
      await svc.setPort(port);
      return svc.getStatus();
    })
  );

  handlers.push(
    typedHandle(CHANNELS.MCP_SERVER_SET_API_KEY, async (apiKey: string) => {
      if (typeof apiKey !== "string") throw new Error("apiKey must be a string");
      const svc = await getMcpServerService();
      await svc.setApiKey(apiKey);
      return svc.getStatus();
    })
  );

  handlers.push(
    typedHandle(CHANNELS.MCP_SERVER_GENERATE_API_KEY, async () => {
      const svc = await getMcpServerService();
      return await svc.generateApiKey();
    })
  );

  handlers.push(
    typedHandle(CHANNELS.MCP_SERVER_GET_CONFIG_SNIPPET, async () => {
      const svc = await getMcpServerService();
      return svc.getConfigSnippet();
    })
  );

  return () => handlers.forEach((cleanup) => cleanup());
}
