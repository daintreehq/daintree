import type { IpcInvokeMap } from "../../types/index.js";

export const HOST_MODE_METHOD_CHANNELS = {
  getStatus: "host-mode:get-status",
  setEnabled: "host-mode:set-enabled",
  runKeychainPreflight: "host-mode:run-keychain-preflight",
} as const satisfies Record<string, keyof IpcInvokeMap>;

type Methods = typeof HOST_MODE_METHOD_CHANNELS;

export type HostModePreloadBindings = {
  [M in keyof Methods]: (
    ...args: IpcInvokeMap[Methods[M]]["args"]
  ) => Promise<IpcInvokeMap[Methods[M]]["result"]>;
};

type Invoker = (channel: string, ...args: unknown[]) => Promise<unknown>;

export function buildHostModePreloadBindings(invoke: Invoker): HostModePreloadBindings {
  const out: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  for (const method of Object.keys(HOST_MODE_METHOD_CHANNELS) as Array<keyof Methods>) {
    const channel = HOST_MODE_METHOD_CHANNELS[method];
    out[method as string] = (...args) => invoke(channel, ...args);
  }
  return out as unknown as HostModePreloadBindings;
}
