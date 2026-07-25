import type { IpcInvokeMap } from "../../types/index.js";

export const PROJECT_HISTORY_METHOD_CHANNELS = {
  peek: "project-history:peek",
} as const satisfies Record<string, keyof IpcInvokeMap>;

type Methods = typeof PROJECT_HISTORY_METHOD_CHANNELS;

export type ProjectHistoryPreloadBindings = {
  [M in keyof Methods]: (
    ...args: IpcInvokeMap[Methods[M]]["args"]
  ) => Promise<IpcInvokeMap[Methods[M]]["result"]>;
};

type Invoker = (channel: string, ...args: unknown[]) => Promise<unknown>;

export function buildProjectHistoryPreloadBindings(invoke: Invoker): ProjectHistoryPreloadBindings {
  const out: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  for (const method of Object.keys(PROJECT_HISTORY_METHOD_CHANNELS) as Array<keyof Methods>) {
    const channel = PROJECT_HISTORY_METHOD_CHANNELS[method];
    out[method as string] = (...args) => invoke(channel, ...args);
  }
  return out as unknown as ProjectHistoryPreloadBindings;
}
