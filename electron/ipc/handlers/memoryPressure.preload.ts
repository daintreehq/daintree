import type { IpcInvokeMap } from "../../types/index.js";

export const MEMORY_PRESSURE_METHOD_CHANNELS = {
  isMemoryPressureCritical: "system:is-memory-pressure-critical",
} as const satisfies Record<string, keyof IpcInvokeMap>;

type Methods = typeof MEMORY_PRESSURE_METHOD_CHANNELS;

export type MemoryPressurePreloadBindings = {
  [M in keyof Methods]: (
    ...args: IpcInvokeMap[Methods[M]]["args"]
  ) => Promise<IpcInvokeMap[Methods[M]]["result"]>;
};

type Invoker = (channel: string, ...args: unknown[]) => Promise<unknown>;

export function buildMemoryPressurePreloadBindings(invoke: Invoker): MemoryPressurePreloadBindings {
  const out: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  for (const method of Object.keys(MEMORY_PRESSURE_METHOD_CHANNELS) as Array<keyof Methods>) {
    const channel = MEMORY_PRESSURE_METHOD_CHANNELS[method];
    out[method as string] = (...args) => invoke(channel, ...args);
  }
  return out as unknown as MemoryPressurePreloadBindings;
}
