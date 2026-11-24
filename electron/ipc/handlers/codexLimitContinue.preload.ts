import type { IpcInvokeMap } from "../../types/index.js";

export const CODEX_LIMIT_CONTINUE_METHOD_CHANNELS = {
  set: "codex-limit-continue:set",
  list: "codex-limit-continue:list",
} as const satisfies Record<string, keyof IpcInvokeMap>;

type Methods = typeof CODEX_LIMIT_CONTINUE_METHOD_CHANNELS;

export type CodexLimitContinuePreloadBindings = {
  [M in keyof Methods]: (
    ...args: IpcInvokeMap[Methods[M]]["args"]
  ) => Promise<IpcInvokeMap[Methods[M]]["result"]>;
};

type Invoker = (channel: string, ...args: unknown[]) => Promise<unknown>;

export function buildCodexLimitContinuePreloadBindings(
  invoke: Invoker
): CodexLimitContinuePreloadBindings {
  const out: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  for (const method of Object.keys(CODEX_LIMIT_CONTINUE_METHOD_CHANNELS) as Array<keyof Methods>) {
    const channel = CODEX_LIMIT_CONTINUE_METHOD_CHANNELS[method];
    out[method as string] = (...args) => invoke(channel, ...args);
  }
  return out as unknown as CodexLimitContinuePreloadBindings;
}
