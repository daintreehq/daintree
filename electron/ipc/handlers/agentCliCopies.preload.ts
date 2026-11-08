import type { IpcInvokeMap } from "../../types/index.js";

export const AGENT_CLI_COPIES_METHOD_CHANNELS = {
  list: "agent-cli-copies:list",
} as const satisfies Record<string, keyof IpcInvokeMap>;

type Methods = typeof AGENT_CLI_COPIES_METHOD_CHANNELS;

export type AgentCliCopiesPreloadBindings = {
  [M in keyof Methods]: (
    ...args: IpcInvokeMap[Methods[M]]["args"]
  ) => Promise<IpcInvokeMap[Methods[M]]["result"]>;
};

type Invoker = (channel: string, ...args: unknown[]) => Promise<unknown>;

export function buildAgentCliCopiesPreloadBindings(invoke: Invoker): AgentCliCopiesPreloadBindings {
  const out: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  for (const method of Object.keys(AGENT_CLI_COPIES_METHOD_CHANNELS) as Array<keyof Methods>) {
    const channel = AGENT_CLI_COPIES_METHOD_CHANNELS[method];
    out[method as string] = (...args) => invoke(channel, ...args);
  }
  return out as unknown as AgentCliCopiesPreloadBindings;
}
