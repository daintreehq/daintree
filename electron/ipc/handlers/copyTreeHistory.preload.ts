import type { IpcInvokeMap } from "../../types/index.js";

export const COPY_TREE_HISTORY_METHOD_CHANNELS = {
  getRecords: "copy-tree-history:get-records",
} as const satisfies Record<string, keyof IpcInvokeMap>;

type Methods = typeof COPY_TREE_HISTORY_METHOD_CHANNELS;

export type CopyTreeHistoryPreloadBindings = {
  [M in keyof Methods]: (
    ...args: IpcInvokeMap[Methods[M]]["args"]
  ) => Promise<IpcInvokeMap[Methods[M]]["result"]>;
};

type Invoker = (channel: string, ...args: unknown[]) => Promise<unknown>;

export function buildCopyTreeHistoryPreloadBindings(
  invoke: Invoker
): CopyTreeHistoryPreloadBindings {
  const out: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  for (const method of Object.keys(COPY_TREE_HISTORY_METHOD_CHANNELS) as Array<keyof Methods>) {
    const channel = COPY_TREE_HISTORY_METHOD_CHANNELS[method];
    out[method as string] = (...args) => invoke(channel, ...args);
  }
  return out as unknown as CopyTreeHistoryPreloadBindings;
}
