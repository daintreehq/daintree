import type { IpcInvokeMap } from "../../types/index.js";

export const SYSTEM_SLEEP_METHOD_CHANNELS = {
  getMetrics: "system-sleep:get-metrics",
  getAwakeTime: "system-sleep:get-awake-time",
  reset: "system-sleep:reset",
} as const satisfies Record<string, keyof IpcInvokeMap>;

type Methods = typeof SYSTEM_SLEEP_METHOD_CHANNELS;

export type SystemSleepPreloadBindings = {
  [M in keyof Methods]: (
    ...args: IpcInvokeMap[Methods[M]]["args"]
  ) => Promise<IpcInvokeMap[Methods[M]]["result"]>;
};

type Invoker = (channel: string, ...args: unknown[]) => Promise<unknown>;

export function buildSystemSleepPreloadBindings(invoke: Invoker): SystemSleepPreloadBindings {
  const out: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  for (const method of Object.keys(SYSTEM_SLEEP_METHOD_CHANNELS) as Array<keyof Methods>) {
    const channel = SYSTEM_SLEEP_METHOD_CHANNELS[method];
    out[method as string] = (...args) => invoke(channel, ...args);
  }
  return out as unknown as SystemSleepPreloadBindings;
}
