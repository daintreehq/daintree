import type { IpcInvokeMap } from "../../types/index.js";

export const HOST_METRICS_METHOD_CHANNELS = {
  getSnapshots: "host-metrics:get-snapshots",
} as const satisfies Record<string, keyof IpcInvokeMap>;

type Methods = typeof HOST_METRICS_METHOD_CHANNELS;

export type HostMetricsPreloadBindings = {
  [M in keyof Methods]: (
    ...args: IpcInvokeMap[Methods[M]]["args"]
  ) => Promise<IpcInvokeMap[Methods[M]]["result"]>;
};

type Invoker = (channel: string, ...args: unknown[]) => Promise<unknown>;

export function buildHostMetricsPreloadBindings(invoke: Invoker): HostMetricsPreloadBindings {
  const out: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  for (const method of Object.keys(HOST_METRICS_METHOD_CHANNELS) as Array<keyof Methods>) {
    const channel = HOST_METRICS_METHOD_CHANNELS[method];
    out[method as string] = (...args) => invoke(channel, ...args);
  }
  return out as unknown as HostMetricsPreloadBindings;
}
