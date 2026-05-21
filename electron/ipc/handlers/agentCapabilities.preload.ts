import type { IpcInvokeMap } from "../../types/index.js";

export const AGENT_CAPABILITIES_METHOD_CHANNELS = {
  getRegistry: "agent-capabilities:get-registry",
  getAgentIds: "agent-capabilities:get-agent-ids",
  getAgentMetadata: "agent-capabilities:get-agent-metadata",
  isAgentEnabled: "agent-capabilities:is-agent-enabled",
  getCcrPresets: "agent-capabilities:get-ccr-presets",
  getResolvedModelList: "agent-capabilities:get-resolved-model-list",
} as const satisfies Record<string, keyof IpcInvokeMap>;

type Methods = typeof AGENT_CAPABILITIES_METHOD_CHANNELS;

export type AgentCapabilitiesPreloadBindings = {
  [M in keyof Methods]: (
    ...args: IpcInvokeMap[Methods[M]]["args"]
  ) => Promise<IpcInvokeMap[Methods[M]]["result"]>;
};

type Invoker = (channel: string, ...args: unknown[]) => Promise<unknown>;

export function buildAgentCapabilitiesPreloadBindings(
  invoke: Invoker
): AgentCapabilitiesPreloadBindings {
  const out: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  for (const method of Object.keys(AGENT_CAPABILITIES_METHOD_CHANNELS) as Array<keyof Methods>) {
    const channel = AGENT_CAPABILITIES_METHOD_CHANNELS[method];
    out[method as string] = (...args) => invoke(channel, ...args);
  }
  return out as unknown as AgentCapabilitiesPreloadBindings;
}
