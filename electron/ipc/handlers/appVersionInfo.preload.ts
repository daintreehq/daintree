import type { IpcInvokeMap } from "../../types/index.js";

export const APP_VERSION_INFO_METHOD_CHANNELS = {
  getVersionInfo: "app:get-version-info",
} as const satisfies Record<string, keyof IpcInvokeMap>;

type Methods = typeof APP_VERSION_INFO_METHOD_CHANNELS;

export type AppVersionInfoPreloadBindings = {
  [M in keyof Methods]: (
    ...args: IpcInvokeMap[Methods[M]]["args"]
  ) => Promise<IpcInvokeMap[Methods[M]]["result"]>;
};

type Invoker = (channel: string, ...args: unknown[]) => Promise<unknown>;

export function buildAppVersionInfoPreloadBindings(invoke: Invoker): AppVersionInfoPreloadBindings {
  const out: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  for (const method of Object.keys(APP_VERSION_INFO_METHOD_CHANNELS) as Array<keyof Methods>) {
    const channel = APP_VERSION_INFO_METHOD_CHANNELS[method];
    out[method as string] = (...args) => invoke(channel, ...args);
  }
  return out as unknown as AppVersionInfoPreloadBindings;
}
