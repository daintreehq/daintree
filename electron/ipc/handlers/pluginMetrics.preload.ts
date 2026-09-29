import type { IpcInvokeMap } from "../../types/index.js";

// Shares the `plugin:` prefix, so codegen folds these into `window.electron.plugin`.
export const PLUGIN_METRICS_METHOD_CHANNELS = {
  getPerfSnapshots: "plugin:perf-snapshots-get",
} as const satisfies Record<string, keyof IpcInvokeMap>;

type Methods = typeof PLUGIN_METRICS_METHOD_CHANNELS;

export type PluginMetricsPreloadBindings = {
  [M in keyof Methods]: (
    ...args: IpcInvokeMap[Methods[M]]["args"]
  ) => Promise<IpcInvokeMap[Methods[M]]["result"]>;
};

type Invoker = (channel: string, ...args: unknown[]) => Promise<unknown>;

export function buildPluginMetricsPreloadBindings(invoke: Invoker): PluginMetricsPreloadBindings {
  const out: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  for (const method of Object.keys(PLUGIN_METRICS_METHOD_CHANNELS) as Array<keyof Methods>) {
    const channel = PLUGIN_METRICS_METHOD_CHANNELS[method];
    out[method as string] = (...args) => invoke(channel, ...args);
  }
  return out as unknown as PluginMetricsPreloadBindings;
}
