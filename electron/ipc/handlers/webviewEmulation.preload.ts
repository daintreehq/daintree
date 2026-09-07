import type { IpcInvokeMap } from "../../types/index.js";

export const WEBVIEW_EMULATION_METHOD_CHANNELS = {
  setDeviceEmulation: "webview:set-device-emulation",
} as const satisfies Record<string, keyof IpcInvokeMap>;

type Methods = typeof WEBVIEW_EMULATION_METHOD_CHANNELS;

export type WebviewEmulationPreloadBindings = {
  [M in keyof Methods]: (
    ...args: IpcInvokeMap[Methods[M]]["args"]
  ) => Promise<IpcInvokeMap[Methods[M]]["result"]>;
};

type Invoker = (channel: string, ...args: unknown[]) => Promise<unknown>;

export function buildWebviewEmulationPreloadBindings(
  invoke: Invoker
): WebviewEmulationPreloadBindings {
  const out: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  for (const method of Object.keys(WEBVIEW_EMULATION_METHOD_CHANNELS) as Array<keyof Methods>) {
    const channel = WEBVIEW_EMULATION_METHOD_CHANNELS[method];
    out[method as string] = (...args) => invoke(channel, ...args);
  }
  return out as unknown as WebviewEmulationPreloadBindings;
}
