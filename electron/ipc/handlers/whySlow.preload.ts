import type { IpcInvokeMap } from "../../types/index.js";

export const WHY_SLOW_METHOD_CHANNELS = {
  getWhySlowSnapshot: "system:get-why-slow-snapshot",
  reportTerminalRendererDiagnostics: "system:report-terminal-renderer-diagnostics",
} as const satisfies Record<string, keyof IpcInvokeMap>;

type Methods = typeof WHY_SLOW_METHOD_CHANNELS;

export type WhySlowPreloadBindings = {
  [M in keyof Methods]: (
    ...args: IpcInvokeMap[Methods[M]]["args"]
  ) => Promise<IpcInvokeMap[Methods[M]]["result"]>;
};

type Invoker = (channel: string, ...args: unknown[]) => Promise<unknown>;

export function buildWhySlowPreloadBindings(invoke: Invoker): WhySlowPreloadBindings {
  const out: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  for (const method of Object.keys(WHY_SLOW_METHOD_CHANNELS) as Array<keyof Methods>) {
    const channel = WHY_SLOW_METHOD_CHANNELS[method];
    out[method as string] = (...args) => invoke(channel, ...args);
  }
  return out as unknown as WhySlowPreloadBindings;
}
