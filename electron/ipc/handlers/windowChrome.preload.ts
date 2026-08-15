import type { IpcInvokeMap } from "../../types/index.js";

// Literal channel names, matching every other namespace: the renderer-API
// generator reads this object from source and cannot resolve an identifier.
// `channelDrift.test.ts` holds these against the CHANNELS registry.
export const WINDOW_CHROME_METHOD_CHANNELS = {
  setBannerSeverity: "window-chrome:set-banner-severity",
} as const satisfies Record<string, keyof IpcInvokeMap>;

type Methods = typeof WINDOW_CHROME_METHOD_CHANNELS;

export type WindowChromePreloadBindings = {
  [M in keyof Methods]: (
    ...args: IpcInvokeMap[Methods[M]]["args"]
  ) => Promise<IpcInvokeMap[Methods[M]]["result"]>;
};

type Invoker = (channel: string, ...args: unknown[]) => Promise<unknown>;

export function buildWindowChromePreloadBindings(invoke: Invoker): WindowChromePreloadBindings {
  const out: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  for (const method of Object.keys(WINDOW_CHROME_METHOD_CHANNELS) as Array<keyof Methods>) {
    const channel = WINDOW_CHROME_METHOD_CHANNELS[method];
    out[method as string] = (...args) => invoke(channel, ...args);
  }
  return out as unknown as WindowChromePreloadBindings;
}
