import type { IpcInvokeMap } from "../../types/index.js";

export const OPERATIONS_METHOD_CHANNELS = {
  getStatus: "operations:get-status",
  list: "operations:list",
  cancel: "operations:cancel",
} as const satisfies Record<string, keyof IpcInvokeMap>;

type Methods = typeof OPERATIONS_METHOD_CHANNELS;

export type OperationsPreloadBindings = {
  [M in keyof Methods]: (
    ...args: IpcInvokeMap[Methods[M]]["args"]
  ) => Promise<IpcInvokeMap[Methods[M]]["result"]>;
};

type Invoker = (channel: string, ...args: unknown[]) => Promise<unknown>;

export function buildOperationsPreloadBindings(invoke: Invoker): OperationsPreloadBindings {
  const out: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  for (const method of Object.keys(OPERATIONS_METHOD_CHANNELS) as Array<keyof Methods>) {
    const channel = OPERATIONS_METHOD_CHANNELS[method];
    out[method as string] = (...args) => invoke(channel, ...args);
  }
  return out as unknown as OperationsPreloadBindings;
}
