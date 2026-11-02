import type { IpcInvokeMap } from "../../types/index.js";

export const TERMINAL_WHEN_DONE_METHOD_CHANNELS = {
  set: "terminal-when-done:set",
  list: "terminal-when-done:list",
} as const satisfies Record<string, keyof IpcInvokeMap>;

type Methods = typeof TERMINAL_WHEN_DONE_METHOD_CHANNELS;

export type TerminalWhenDonePreloadBindings = {
  [M in keyof Methods]: (
    ...args: IpcInvokeMap[Methods[M]]["args"]
  ) => Promise<IpcInvokeMap[Methods[M]]["result"]>;
};

type Invoker = (channel: string, ...args: unknown[]) => Promise<unknown>;

export function buildTerminalWhenDonePreloadBindings(
  invoke: Invoker
): TerminalWhenDonePreloadBindings {
  const out: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  for (const method of Object.keys(TERMINAL_WHEN_DONE_METHOD_CHANNELS) as Array<keyof Methods>) {
    const channel = TERMINAL_WHEN_DONE_METHOD_CHANNELS[method];
    out[method as string] = (...args) => invoke(channel, ...args);
  }
  return out as unknown as TerminalWhenDonePreloadBindings;
}
