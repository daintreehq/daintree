import type { IpcInvokeMap } from "../../types/index.js";

export const CLAUDE_METHOD_CHANNELS = {
  listSubagents: "claude:list-subagents",
  readSubagentTranscript: "claude:read-subagent-transcript",
} as const satisfies Record<string, keyof IpcInvokeMap>;

type Methods = typeof CLAUDE_METHOD_CHANNELS;

export type ClaudePreloadBindings = {
  [M in keyof Methods]: (
    ...args: IpcInvokeMap[Methods[M]]["args"]
  ) => Promise<IpcInvokeMap[Methods[M]]["result"]>;
};

type Invoker = (channel: string, ...args: unknown[]) => Promise<unknown>;

export function buildClaudePreloadBindings(invoke: Invoker): ClaudePreloadBindings {
  const out: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  for (const method of Object.keys(CLAUDE_METHOD_CHANNELS) as Array<keyof Methods>) {
    const channel = CLAUDE_METHOD_CHANNELS[method];
    out[method as string] = (...args) => invoke(channel, ...args);
  }
  return out as unknown as ClaudePreloadBindings;
}
