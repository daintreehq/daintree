import type { IpcInvokeMap } from "../../types/index.js";

export const PLUGIN_AGENT_MCP_METHOD_CHANNELS = {
  listProjectEndpoints: "plugin-agent-mcp:list-project-endpoints",
  setProjectEndpointEnabled: "plugin-agent-mcp:set-project-endpoint-enabled",
} as const satisfies Record<string, keyof IpcInvokeMap>;

type Methods = typeof PLUGIN_AGENT_MCP_METHOD_CHANNELS;

export type PluginAgentMcpPreloadBindings = {
  [M in keyof Methods]: (
    ...args: IpcInvokeMap[Methods[M]]["args"]
  ) => Promise<IpcInvokeMap[Methods[M]]["result"]>;
};

type Invoker = (channel: string, ...args: unknown[]) => Promise<unknown>;

export function buildPluginAgentMcpPreloadBindings(invoke: Invoker): PluginAgentMcpPreloadBindings {
  const out: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  for (const method of Object.keys(PLUGIN_AGENT_MCP_METHOD_CHANNELS) as Array<keyof Methods>) {
    const channel = PLUGIN_AGENT_MCP_METHOD_CHANNELS[method];
    out[method as string] = (...args) => invoke(channel, ...args);
  }
  return out as unknown as PluginAgentMcpPreloadBindings;
}
