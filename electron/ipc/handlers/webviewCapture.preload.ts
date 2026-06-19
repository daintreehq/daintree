import type { IpcInvokeMap } from "../../types/index.js";

export const WEBVIEW_CAPTURE_METHOD_CHANNELS = {
  captureScreenshot: "webview:capture-screenshot",
} as const satisfies Record<string, keyof IpcInvokeMap>;

type Methods = typeof WEBVIEW_CAPTURE_METHOD_CHANNELS;

export type WebviewCapturePreloadBindings = {
  [M in keyof Methods]: (
    ...args: IpcInvokeMap[Methods[M]]["args"]
  ) => Promise<IpcInvokeMap[Methods[M]]["result"]>;
};

type Invoker = (channel: string, ...args: unknown[]) => Promise<unknown>;

export function buildWebviewCapturePreloadBindings(invoke: Invoker): WebviewCapturePreloadBindings {
  const out: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  for (const method of Object.keys(WEBVIEW_CAPTURE_METHOD_CHANNELS) as Array<keyof Methods>) {
    const channel = WEBVIEW_CAPTURE_METHOD_CHANNELS[method];
    out[method as string] = (...args) => invoke(channel, ...args);
  }
  return out as unknown as WebviewCapturePreloadBindings;
}
