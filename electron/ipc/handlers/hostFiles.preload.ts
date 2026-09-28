import type { IpcInvokeMap } from "../../types/index.js";

export const HOST_FILES_METHOD_CHANNELS = {
  listDirectory: "host-files:list-directory",
  getPickerRoots: "host-files:get-picker-roots",
} as const satisfies Record<string, keyof IpcInvokeMap>;

type Methods = typeof HOST_FILES_METHOD_CHANNELS;

export type HostFilesPreloadBindings = {
  [M in keyof Methods]: (
    ...args: IpcInvokeMap[Methods[M]]["args"]
  ) => Promise<IpcInvokeMap[Methods[M]]["result"]>;
};

type Invoker = (channel: string, ...args: unknown[]) => Promise<unknown>;

export function buildHostFilesPreloadBindings(invoke: Invoker): HostFilesPreloadBindings {
  const out: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  for (const method of Object.keys(HOST_FILES_METHOD_CHANNELS) as Array<keyof Methods>) {
    const channel = HOST_FILES_METHOD_CHANNELS[method];
    out[method as string] = (...args) => invoke(channel, ...args);
  }
  return out as unknown as HostFilesPreloadBindings;
}
