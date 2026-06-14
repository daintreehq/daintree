import type { IpcInvokeMap } from "../../types/index.js";

export const PLUGIN_MCP_METHOD_CHANNELS = {
  list: "plugin-mcp:list",
  getStderr: "plugin-mcp:get-stderr",
  restart: "plugin-mcp:restart",
  listTools: "plugin-mcp:list-tools",
  getFullSchema: "plugin-mcp:get-full-schema",
  getConfig: "plugin-mcp:get-config",
  setConfig: "plugin-mcp:set-config",
  callTool: "plugin-mcp:call-tool",
  resolveConsent: "plugin-mcp:resolve-consent",
} as const satisfies Record<string, keyof IpcInvokeMap>;

type Methods = typeof PLUGIN_MCP_METHOD_CHANNELS;

export type PluginMcpPreloadBindings = {
  [M in keyof Methods]: (
    ...args: IpcInvokeMap[Methods[M]]["args"]
  ) => Promise<IpcInvokeMap[Methods[M]]["result"]>;
};

type Invoker = (channel: string, ...args: unknown[]) => Promise<unknown>;

export function buildPluginMcpPreloadBindings(invoke: Invoker): PluginMcpPreloadBindings {
  const out: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  for (const method of Object.keys(PLUGIN_MCP_METHOD_CHANNELS) as Array<keyof Methods>) {
    const channel = PLUGIN_MCP_METHOD_CHANNELS[method];
    out[method as string] = (...args) => invoke(channel, ...args);
  }
  return out as unknown as PluginMcpPreloadBindings;
}
