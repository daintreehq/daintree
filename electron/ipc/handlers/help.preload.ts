import type { IpcInvokeMap } from "../../types/index.js";

export const HELP_METHOD_CHANNELS = {
  getFolderPath: "help:get-folder-path",
  markTerminal: "help:mark-terminal",
  unmarkTerminal: "help:unmark-terminal",
  provisionSession: "help:provision-session",
  revokeSession: "help:revoke-session",
} as const satisfies Record<string, keyof IpcInvokeMap>;

type Methods = typeof HELP_METHOD_CHANNELS;

export type HelpPreloadBindings = {
  [M in keyof Methods]: (
    ...args: IpcInvokeMap[Methods[M]]["args"]
  ) => Promise<IpcInvokeMap[Methods[M]]["result"]>;
};

type Invoker = (channel: string, ...args: unknown[]) => Promise<unknown>;

export function buildHelpPreloadBindings(invoke: Invoker): HelpPreloadBindings {
  const out: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  for (const method of Object.keys(HELP_METHOD_CHANNELS) as Array<keyof Methods>) {
    const channel = HELP_METHOD_CHANNELS[method];
    out[method as string] = (...args) => invoke(channel, ...args);
  }
  return out as unknown as HelpPreloadBindings;
}
