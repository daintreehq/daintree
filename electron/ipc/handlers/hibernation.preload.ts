import type { IpcInvokeMap } from "../../types/index.js";

export const HIBERNATION_METHOD_CHANNELS = {
  getConfig: "hibernation:get-config",
  updateConfig: "hibernation:update-config",
} as const satisfies Record<string, keyof IpcInvokeMap>;

type Methods = typeof HIBERNATION_METHOD_CHANNELS;

export type HibernationPreloadBindings = {
  [M in keyof Methods]: (
    ...args: IpcInvokeMap[Methods[M]]["args"]
  ) => Promise<IpcInvokeMap[Methods[M]]["result"]>;
};

type Invoker = (channel: string, ...args: unknown[]) => Promise<unknown>;

export function buildHibernationPreloadBindings(invoke: Invoker): HibernationPreloadBindings {
  const out: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  for (const method of Object.keys(HIBERNATION_METHOD_CHANNELS) as Array<keyof Methods>) {
    const channel = HIBERNATION_METHOD_CHANNELS[method];
    out[method as string] = (...args) => invoke(channel, ...args);
  }
  return out as unknown as HibernationPreloadBindings;
}
