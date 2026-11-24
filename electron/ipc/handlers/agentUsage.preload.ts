import type { IpcInvokeMap } from "../../types/index.js";

export const AGENT_USAGE_METHOD_CHANNELS = {
  setFollowing: "agent-usage:set-following",
  getTracking: "agent-usage:get-tracking",
  setTracking: "agent-usage:set-tracking",
} as const satisfies Record<string, keyof IpcInvokeMap>;

type Methods = typeof AGENT_USAGE_METHOD_CHANNELS;

export type AgentUsagePreloadBindings = {
  [M in keyof Methods]: (
    ...args: IpcInvokeMap[Methods[M]]["args"]
  ) => Promise<IpcInvokeMap[Methods[M]]["result"]>;
};

type Invoker = (channel: string, ...args: unknown[]) => Promise<unknown>;

export function buildAgentUsagePreloadBindings(invoke: Invoker): AgentUsagePreloadBindings {
  const out: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  for (const method of Object.keys(AGENT_USAGE_METHOD_CHANNELS) as Array<keyof Methods>) {
    const channel = AGENT_USAGE_METHOD_CHANNELS[method];
    out[method as string] = (...args) => invoke(channel, ...args);
  }
  return out as unknown as AgentUsagePreloadBindings;
}
