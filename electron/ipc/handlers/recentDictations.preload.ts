import type { IpcInvokeMap } from "../../types/index.js";

export const RECENT_DICTATIONS_METHOD_CHANNELS = {
  record: "recent-dictations:record",
  setCorrectedText: "recent-dictations:set-corrected-text",
  list: "recent-dictations:list",
} as const satisfies Record<string, keyof IpcInvokeMap>;

type Methods = typeof RECENT_DICTATIONS_METHOD_CHANNELS;

export type RecentDictationsPreloadBindings = {
  [M in keyof Methods]: (
    ...args: IpcInvokeMap[Methods[M]]["args"]
  ) => Promise<IpcInvokeMap[Methods[M]]["result"]>;
};

type Invoker = (channel: string, ...args: unknown[]) => Promise<unknown>;

export function buildRecentDictationsPreloadBindings(
  invoke: Invoker
): RecentDictationsPreloadBindings {
  const out: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  for (const method of Object.keys(RECENT_DICTATIONS_METHOD_CHANNELS) as Array<keyof Methods>) {
    const channel = RECENT_DICTATIONS_METHOD_CHANNELS[method];
    out[method as string] = (...args) => invoke(channel, ...args);
  }
  return out as unknown as RecentDictationsPreloadBindings;
}
