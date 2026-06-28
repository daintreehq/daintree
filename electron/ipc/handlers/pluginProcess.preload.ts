import type { IpcInvokeMap } from "../../types/index.js";

export const PLUGIN_PROCESS_METHOD_CHANNELS = {
  list: "plugin-process:list",
} as const satisfies Record<string, keyof IpcInvokeMap>;

type Methods = typeof PLUGIN_PROCESS_METHOD_CHANNELS;

export type PluginProcessPreloadBindings = {
  [M in keyof Methods]: (
    ...args: IpcInvokeMap[Methods[M]]["args"]
  ) => Promise<IpcInvokeMap[Methods[M]]["result"]>;
};

type Invoker = (channel: string, ...args: unknown[]) => Promise<unknown>;

export function buildPluginProcessPreloadBindings(invoke: Invoker): PluginProcessPreloadBindings {
  const out: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  for (const method of Object.keys(PLUGIN_PROCESS_METHOD_CHANNELS) as Array<keyof Methods>) {
    const channel = PLUGIN_PROCESS_METHOD_CHANNELS[method];
    out[method as string] = (...args) => invoke(channel, ...args);
  }
  return out as unknown as PluginProcessPreloadBindings;
}
