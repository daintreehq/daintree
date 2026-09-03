import type { IpcInvokeMap } from "../../types/index.js";

export const CODEX_METHOD_CHANNELS = {
  listSubagents: "codex:list-subagents",
  readSubagentTranscript: "codex:read-subagent-transcript",
  resolveResumeLatestSession: "codex:resolve-resume-latest-session",
  findSessions: "codex:find-sessions",
} as const satisfies Record<string, keyof IpcInvokeMap>;

type Methods = typeof CODEX_METHOD_CHANNELS;

export type CodexPreloadBindings = {
  [M in keyof Methods]: (
    ...args: IpcInvokeMap[Methods[M]]["args"]
  ) => Promise<IpcInvokeMap[Methods[M]]["result"]>;
};

type Invoker = (channel: string, ...args: unknown[]) => Promise<unknown>;

export function buildCodexPreloadBindings(invoke: Invoker): CodexPreloadBindings {
  const out: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  for (const method of Object.keys(CODEX_METHOD_CHANNELS) as Array<keyof Methods>) {
    const channel = CODEX_METHOD_CHANNELS[method];
    out[method as string] = (...args) => invoke(channel, ...args);
  }
  return out as unknown as CodexPreloadBindings;
}
