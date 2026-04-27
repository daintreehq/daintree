import type { IpcInvokeMap } from "../../types/index.js";

export const ACCESSIBILITY_METHOD_CHANNELS = {
  getEnabled: "accessibility:get-enabled",
} as const satisfies Record<string, keyof IpcInvokeMap>;

type Methods = typeof ACCESSIBILITY_METHOD_CHANNELS;

export type AccessibilityPreloadBindings = {
  [M in keyof Methods]: (
    ...args: IpcInvokeMap[Methods[M]]["args"]
  ) => Promise<IpcInvokeMap[Methods[M]]["result"]>;
};

type Invoker = (channel: string, ...args: unknown[]) => Promise<unknown>;

export function buildAccessibilityPreloadBindings(invoke: Invoker): AccessibilityPreloadBindings {
  const out: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  for (const method of Object.keys(ACCESSIBILITY_METHOD_CHANNELS) as Array<keyof Methods>) {
    const channel = ACCESSIBILITY_METHOD_CHANNELS[method];
    out[method as string] = (...args) => invoke(channel, ...args);
  }
  return out as unknown as AccessibilityPreloadBindings;
}
