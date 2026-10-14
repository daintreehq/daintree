import type { IpcInvokeMap } from "../../types/index.js";

export const AGENT_DEFAULTS_METHOD_CHANNELS = {
  get: "agent-defaults:get",
  set: "agent-defaults:set",
  migrateLegacy: "agent-defaults:migrate-legacy",
} as const satisfies Record<string, keyof IpcInvokeMap>;

type Methods = typeof AGENT_DEFAULTS_METHOD_CHANNELS;

export type AgentDefaultsPreloadBindings = {
  [M in keyof Methods]: (
    ...args: IpcInvokeMap[Methods[M]]["args"]
  ) => Promise<IpcInvokeMap[Methods[M]]["result"]>;
};

type Invoker = (channel: string, ...args: unknown[]) => Promise<unknown>;

export function buildAgentDefaultsPreloadBindings(invoke: Invoker): AgentDefaultsPreloadBindings {
  const out: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  for (const method of Object.keys(AGENT_DEFAULTS_METHOD_CHANNELS) as Array<keyof Methods>) {
    const channel = AGENT_DEFAULTS_METHOD_CHANNELS[method];
    out[method as string] = (...args) => invoke(channel, ...args);
  }
  return out as unknown as AgentDefaultsPreloadBindings;
}
