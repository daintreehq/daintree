import type { IpcInvokeMap } from "../../types/index.js";

export const AGENT_ACCOUNTS_METHOD_CHANNELS = {
  add: "agent-accounts:add",
  remove: "agent-accounts:remove",
} as const satisfies Record<string, keyof IpcInvokeMap>;

type Methods = typeof AGENT_ACCOUNTS_METHOD_CHANNELS;

export type AgentAccountsPreloadBindings = {
  [M in keyof Methods]: (
    ...args: IpcInvokeMap[Methods[M]]["args"]
  ) => Promise<IpcInvokeMap[Methods[M]]["result"]>;
};

type Invoker = (channel: string, ...args: unknown[]) => Promise<unknown>;

export function buildAgentAccountsPreloadBindings(invoke: Invoker): AgentAccountsPreloadBindings {
  const out: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  for (const method of Object.keys(AGENT_ACCOUNTS_METHOD_CHANNELS) as Array<keyof Methods>) {
    const channel = AGENT_ACCOUNTS_METHOD_CHANNELS[method];
    out[method as string] = (...args) => invoke(channel, ...args);
  }
  return out as unknown as AgentAccountsPreloadBindings;
}
