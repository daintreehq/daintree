import type { IpcInvokeMap } from "../../types/index.js";

export const WEBVIEW_NAVIGATION_METHOD_CHANNELS = {
  getNavigationHistory: "webview:get-navigation-history",
  goToHistoryIndex: "webview:go-to-history-index",
} as const satisfies Record<string, keyof IpcInvokeMap>;

type Methods = typeof WEBVIEW_NAVIGATION_METHOD_CHANNELS;

export type WebviewNavigationPreloadBindings = {
  [M in keyof Methods]: (
    ...args: IpcInvokeMap[Methods[M]]["args"]
  ) => Promise<IpcInvokeMap[Methods[M]]["result"]>;
};

type Invoker = (channel: string, ...args: unknown[]) => Promise<unknown>;

export function buildWebviewNavigationPreloadBindings(
  invoke: Invoker
): WebviewNavigationPreloadBindings {
  const out: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  for (const method of Object.keys(WEBVIEW_NAVIGATION_METHOD_CHANNELS) as Array<keyof Methods>) {
    const channel = WEBVIEW_NAVIGATION_METHOD_CHANNELS[method];
    out[method as string] = (...args) => invoke(channel, ...args);
  }
  return out as unknown as WebviewNavigationPreloadBindings;
}
