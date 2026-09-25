import type { IpcInvokeMap } from "../../types/index.js";

export const HOST_SWITCH_METHOD_CHANNELS = {
  plan: "host-switch:plan",
  prepare: "host-switch:prepare",
  checkDestination: "host-switch:check-destination",
  execute: "host-switch:execute",
  status: "host-switch:status",
  cancel: "host-switch:cancel",
} as const satisfies Record<string, keyof IpcInvokeMap>;

type Methods = typeof HOST_SWITCH_METHOD_CHANNELS;

export type HostSwitchPreloadBindings = {
  [M in keyof Methods]: (
    ...args: IpcInvokeMap[Methods[M]]["args"]
  ) => Promise<IpcInvokeMap[Methods[M]]["result"]>;
};

type Invoker = (channel: string, ...args: unknown[]) => Promise<unknown>;

export function buildHostSwitchPreloadBindings(invoke: Invoker): HostSwitchPreloadBindings {
  const out: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  for (const method of Object.keys(HOST_SWITCH_METHOD_CHANNELS) as Array<keyof Methods>) {
    const channel = HOST_SWITCH_METHOD_CHANNELS[method];
    out[method as string] = (...args) => invoke(channel, ...args);
  }
  return out as unknown as HostSwitchPreloadBindings;
}
