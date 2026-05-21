import type { IpcInvokeMap } from "../../types/index.js";

export const CONNECTIVITY_METHOD_CHANNELS = {
  getState: "connectivity:get-state",
} as const satisfies Record<string, keyof IpcInvokeMap>;

type Methods = typeof CONNECTIVITY_METHOD_CHANNELS;

export type ConnectivityPreloadBindings = {
  [M in keyof Methods]: (
    ...args: IpcInvokeMap[Methods[M]]["args"]
  ) => Promise<IpcInvokeMap[Methods[M]]["result"]>;
};

type Invoker = (channel: string, ...args: unknown[]) => Promise<unknown>;

export function buildConnectivityPreloadBindings(invoke: Invoker): ConnectivityPreloadBindings {
  const out: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  for (const method of Object.keys(CONNECTIVITY_METHOD_CHANNELS) as Array<keyof Methods>) {
    const channel = CONNECTIVITY_METHOD_CHANNELS[method];
    out[method as string] = (...args) => invoke(channel, ...args);
  }
  return out as unknown as ConnectivityPreloadBindings;
}
