import type { IpcInvokeMap } from "../../types/index.js";

export const CLI_METHOD_CHANNELS = {
  install: "cli:install",
  getStatus: "cli:get-status",
} as const satisfies Record<string, keyof IpcInvokeMap>;

type Methods = typeof CLI_METHOD_CHANNELS;

export type CliPreloadBindings = {
  [M in keyof Methods]: (
    ...args: IpcInvokeMap[Methods[M]]["args"]
  ) => Promise<IpcInvokeMap[Methods[M]]["result"]>;
};

type Invoker = (channel: string, ...args: unknown[]) => Promise<unknown>;

export function buildCliPreloadBindings(invoke: Invoker): CliPreloadBindings {
  const out: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  for (const method of Object.keys(CLI_METHOD_CHANNELS) as Array<keyof Methods>) {
    const channel = CLI_METHOD_CHANNELS[method];
    out[method as string] = (...args) => invoke(channel, ...args);
  }
  return out as unknown as CliPreloadBindings;
}
