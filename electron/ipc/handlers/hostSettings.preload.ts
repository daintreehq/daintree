import type { IpcInvokeMap } from "../../types/index.js";

export const HOST_SETTINGS_METHOD_CHANNELS = {
  read: "host-settings:read",
  update: "host-settings:update",
} as const satisfies Record<string, keyof IpcInvokeMap>;

type Methods = typeof HOST_SETTINGS_METHOD_CHANNELS;

export type HostSettingsPreloadBindings = {
  [M in keyof Methods]: (
    ...args: IpcInvokeMap[Methods[M]]["args"]
  ) => Promise<IpcInvokeMap[Methods[M]]["result"]>;
};

type Invoker = (channel: string, ...args: unknown[]) => Promise<unknown>;

export function buildHostSettingsPreloadBindings(invoke: Invoker): HostSettingsPreloadBindings {
  const out: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  for (const method of Object.keys(HOST_SETTINGS_METHOD_CHANNELS) as Array<keyof Methods>) {
    const channel = HOST_SETTINGS_METHOD_CHANNELS[method];
    out[method as string] = (...args) => invoke(channel, ...args);
  }
  return out as unknown as HostSettingsPreloadBindings;
}
