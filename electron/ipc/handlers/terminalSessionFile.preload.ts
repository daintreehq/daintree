import type { IpcInvokeMap } from "../../types/index.js";

export const TERMINAL_SESSION_FILE_METHOD_CHANNELS = {
  get: "terminal-session-file:get",
} as const satisfies Record<string, keyof IpcInvokeMap>;

type Methods = typeof TERMINAL_SESSION_FILE_METHOD_CHANNELS;

export type TerminalSessionFilePreloadBindings = {
  [M in keyof Methods]: (
    ...args: IpcInvokeMap[Methods[M]]["args"]
  ) => Promise<IpcInvokeMap[Methods[M]]["result"]>;
};

type Invoker = (channel: string, ...args: unknown[]) => Promise<unknown>;

export function buildTerminalSessionFilePreloadBindings(
  invoke: Invoker
): TerminalSessionFilePreloadBindings {
  const out: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  for (const method of Object.keys(TERMINAL_SESSION_FILE_METHOD_CHANNELS) as Array<keyof Methods>) {
    const channel = TERMINAL_SESSION_FILE_METHOD_CHANNELS[method];
    out[method as string] = (...args) => invoke(channel, ...args);
  }
  return out as unknown as TerminalSessionFilePreloadBindings;
}
