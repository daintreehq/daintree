import type { IpcInvokeMap } from "../../types/index.js";

export const CLIPBOARD_METHOD_CHANNELS = {
  saveImage: "clipboard:save-image",
  thumbnailFromPath: "clipboard:thumbnail-from-path",
  writeImage: "clipboard:write-image",
  writeText: "clipboard:write-text",
  writeSelection: "clipboard:write-selection",
  readSelection: "clipboard:read-selection",
} as const satisfies Record<string, keyof IpcInvokeMap>;

type Methods = typeof CLIPBOARD_METHOD_CHANNELS;

export type ClipboardPreloadBindings = {
  [M in keyof Methods]: (
    ...args: IpcInvokeMap[Methods[M]]["args"]
  ) => Promise<IpcInvokeMap[Methods[M]]["result"]>;
};

type Invoker = (channel: string, ...args: unknown[]) => Promise<unknown>;

export function buildClipboardPreloadBindings(invoke: Invoker): ClipboardPreloadBindings {
  const out: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  for (const method of Object.keys(CLIPBOARD_METHOD_CHANNELS) as Array<keyof Methods>) {
    const channel = CLIPBOARD_METHOD_CHANNELS[method];
    out[method as string] = (...args) => invoke(channel, ...args);
  }
  return out as unknown as ClipboardPreloadBindings;
}
