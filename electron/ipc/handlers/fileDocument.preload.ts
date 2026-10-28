import type { IpcInvokeMap } from "../../types/index.js";

export const FILE_DOCUMENT_METHOD_CHANNELS = {
  read: "file-document:read",
  save: "file-document:save",
} as const satisfies Record<string, keyof IpcInvokeMap>;

type Methods = typeof FILE_DOCUMENT_METHOD_CHANNELS;

export type FileDocumentPreloadBindings = {
  [M in keyof Methods]: (
    ...args: IpcInvokeMap[Methods[M]]["args"]
  ) => Promise<IpcInvokeMap[Methods[M]]["result"]>;
};

type Invoker = (channel: string, ...args: unknown[]) => Promise<unknown>;

export function buildFileDocumentPreloadBindings(invoke: Invoker): FileDocumentPreloadBindings {
  const out: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  for (const method of Object.keys(FILE_DOCUMENT_METHOD_CHANNELS) as Array<keyof Methods>) {
    const channel = FILE_DOCUMENT_METHOD_CHANNELS[method];
    out[method as string] = (...args) => invoke(channel, ...args);
  }
  return out as unknown as FileDocumentPreloadBindings;
}
