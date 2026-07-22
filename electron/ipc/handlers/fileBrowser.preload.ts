import type { IpcInvokeMap } from "../../types/index.js";

export const FILE_BROWSER_METHOD_CHANNELS = {
  listDirectory: "file-browser:list-directory",
} as const satisfies Record<string, keyof IpcInvokeMap>;

type Methods = typeof FILE_BROWSER_METHOD_CHANNELS;

export type FileBrowserPreloadBindings = {
  [M in keyof Methods]: (
    ...args: IpcInvokeMap[Methods[M]]["args"]
  ) => Promise<IpcInvokeMap[Methods[M]]["result"]>;
};

type Invoker = (channel: string, ...args: unknown[]) => Promise<unknown>;

export function buildFileBrowserPreloadBindings(invoke: Invoker): FileBrowserPreloadBindings {
  const out: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  for (const method of Object.keys(FILE_BROWSER_METHOD_CHANNELS) as Array<keyof Methods>) {
    const channel = FILE_BROWSER_METHOD_CHANNELS[method];
    out[method as string] = (...args) => invoke(channel, ...args);
  }
  return out as unknown as FileBrowserPreloadBindings;
}
