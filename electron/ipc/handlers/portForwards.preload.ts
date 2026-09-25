import type { IpcInvokeMap } from "../../types/index.js";

export const PORT_FORWARDS_METHOD_CHANNELS = {
  list: "port-forwards:list",
  forward: "port-forwards:forward",
  stop: "port-forwards:stop",
  listHostPorts: "port-forwards:list-host-ports",
} as const satisfies Record<string, keyof IpcInvokeMap>;

type Methods = typeof PORT_FORWARDS_METHOD_CHANNELS;

export type PortForwardsPreloadBindings = {
  [M in keyof Methods]: (
    ...args: IpcInvokeMap[Methods[M]]["args"]
  ) => Promise<IpcInvokeMap[Methods[M]]["result"]>;
};

type Invoker = (channel: string, ...args: unknown[]) => Promise<unknown>;

export function buildPortForwardsPreloadBindings(invoke: Invoker): PortForwardsPreloadBindings {
  const out: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  for (const method of Object.keys(PORT_FORWARDS_METHOD_CHANNELS) as Array<keyof Methods>) {
    const channel = PORT_FORWARDS_METHOD_CHANNELS[method];
    out[method as string] = (...args) => invoke(channel, ...args);
  }
  return out as unknown as PortForwardsPreloadBindings;
}
