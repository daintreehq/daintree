import type { IpcInvokeMap } from "../../types/index.js";

export const SAFE_MODE_METHOD_CHANNELS = {
  restartInSafeMode: "app:restart-in-safe-mode",
  reportStartupStuck: "app:report-startup-stuck",
} as const satisfies Record<string, keyof IpcInvokeMap>;

type Methods = typeof SAFE_MODE_METHOD_CHANNELS;

export type SafeModePreloadBindings = {
  [M in keyof Methods]: (
    ...args: IpcInvokeMap[Methods[M]]["args"]
  ) => Promise<IpcInvokeMap[Methods[M]]["result"]>;
};

type Invoker = (channel: string, ...args: unknown[]) => Promise<unknown>;

export function buildSafeModePreloadBindings(invoke: Invoker): SafeModePreloadBindings {
  const out: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  for (const method of Object.keys(SAFE_MODE_METHOD_CHANNELS) as Array<keyof Methods>) {
    const channel = SAFE_MODE_METHOD_CHANNELS[method];
    out[method as string] = (...args) => invoke(channel, ...args);
  }
  return out as unknown as SafeModePreloadBindings;
}
