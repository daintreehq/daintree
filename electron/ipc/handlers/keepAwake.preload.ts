import type { IpcInvokeMap } from "../../types/index.js";

export const KEEP_AWAKE_METHOD_CHANNELS = {
  getState: "keep-awake:get-state",
  updateConfig: "keep-awake:update-config",
} as const satisfies Record<string, keyof IpcInvokeMap>;

type Methods = typeof KEEP_AWAKE_METHOD_CHANNELS;

export type KeepAwakePreloadBindings = {
  [M in keyof Methods]: (
    ...args: IpcInvokeMap[Methods[M]]["args"]
  ) => Promise<IpcInvokeMap[Methods[M]]["result"]>;
};

type Invoker = (channel: string, ...args: unknown[]) => Promise<unknown>;

export function buildKeepAwakePreloadBindings(invoke: Invoker): KeepAwakePreloadBindings {
  const out: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  for (const method of Object.keys(KEEP_AWAKE_METHOD_CHANNELS) as Array<keyof Methods>) {
    const channel = KEEP_AWAKE_METHOD_CHANNELS[method];
    out[method as string] = (...args) => invoke(channel, ...args);
  }
  return out as unknown as KeepAwakePreloadBindings;
}
