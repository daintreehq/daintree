import type { IpcInvokeMap } from "../../types/index.js";

export const PLUGIN_PARITY_METHOD_CHANNELS = {
  diff: "plugin-parity:diff",
  installOnHost: "plugin-parity:install-on-host",
  updateOnHost: "plugin-parity:update-on-host",
} as const satisfies Record<string, keyof IpcInvokeMap>;

type Methods = typeof PLUGIN_PARITY_METHOD_CHANNELS;

export type PluginParityPreloadBindings = {
  [M in keyof Methods]: (
    ...args: IpcInvokeMap[Methods[M]]["args"]
  ) => Promise<IpcInvokeMap[Methods[M]]["result"]>;
};

type Invoker = (channel: string, ...args: unknown[]) => Promise<unknown>;

export function buildPluginParityPreloadBindings(invoke: Invoker): PluginParityPreloadBindings {
  const out: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  for (const method of Object.keys(PLUGIN_PARITY_METHOD_CHANNELS) as Array<keyof Methods>) {
    const channel = PLUGIN_PARITY_METHOD_CHANNELS[method];
    out[method as string] = (...args) => invoke(channel, ...args);
  }
  return out as unknown as PluginParityPreloadBindings;
}
