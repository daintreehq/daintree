import type { IpcInvokeMap } from "../../types/index.js";

export const FILE_WATCH_METHOD_CHANNELS = {
  fingerprint: "file-watch:fingerprint",
} as const satisfies Record<string, keyof IpcInvokeMap>;

type Methods = typeof FILE_WATCH_METHOD_CHANNELS;

export type FileWatchPreloadBindings = {
  [M in keyof Methods]: (
    ...args: IpcInvokeMap[Methods[M]]["args"]
  ) => Promise<IpcInvokeMap[Methods[M]]["result"]>;
};

type Invoker = (channel: string, ...args: unknown[]) => Promise<unknown>;

export function buildFileWatchPreloadBindings(invoke: Invoker): FileWatchPreloadBindings {
  const out: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  for (const method of Object.keys(FILE_WATCH_METHOD_CHANNELS) as Array<keyof Methods>) {
    const channel = FILE_WATCH_METHOD_CHANNELS[method];
    out[method as string] = (...args) => invoke(channel, ...args);
  }
  return out as unknown as FileWatchPreloadBindings;
}
