import type { IpcInvokeMap } from "../../types/index.js";

export const ONLINE_ONLY_FILES_METHOD_CHANNELS = {
  watch: "online-only-files:watch",
  unwatch: "online-only-files:unwatch",
} as const satisfies Record<string, keyof IpcInvokeMap>;

type Methods = typeof ONLINE_ONLY_FILES_METHOD_CHANNELS;

export type OnlineOnlyFilesPreloadBindings = {
  [M in keyof Methods]: (
    ...args: IpcInvokeMap[Methods[M]]["args"]
  ) => Promise<IpcInvokeMap[Methods[M]]["result"]>;
};

type Invoker = (channel: string, ...args: unknown[]) => Promise<unknown>;

export function buildOnlineOnlyFilesPreloadBindings(
  invoke: Invoker
): OnlineOnlyFilesPreloadBindings {
  const out: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  for (const method of Object.keys(ONLINE_ONLY_FILES_METHOD_CHANNELS) as Array<keyof Methods>) {
    const channel = ONLINE_ONLY_FILES_METHOD_CHANNELS[method];
    out[method as string] = (...args) => invoke(channel, ...args);
  }
  return out as unknown as OnlineOnlyFilesPreloadBindings;
}
