import type { IpcInvokeMap } from "../../types/index.js";

export const RUN_HISTORY_METHOD_CHANNELS = {
  getRecords: "run-history:get-records",
  append: "run-history:append",
  clear: "run-history:clear",
} as const satisfies Record<string, keyof IpcInvokeMap>;

type Methods = typeof RUN_HISTORY_METHOD_CHANNELS;

export type RunHistoryPreloadBindings = {
  [M in keyof Methods]: (
    ...args: IpcInvokeMap[Methods[M]]["args"]
  ) => Promise<IpcInvokeMap[Methods[M]]["result"]>;
};

type Invoker = (channel: string, ...args: unknown[]) => Promise<unknown>;

export function buildRunHistoryPreloadBindings(invoke: Invoker): RunHistoryPreloadBindings {
  const out: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  for (const method of Object.keys(RUN_HISTORY_METHOD_CHANNELS) as Array<keyof Methods>) {
    const channel = RUN_HISTORY_METHOD_CHANNELS[method];
    out[method as string] = (...args) => invoke(channel, ...args);
  }
  return out as unknown as RunHistoryPreloadBindings;
}
