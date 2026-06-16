import type { IpcInvokeMap } from "../../types/index.js";

export const PLUGIN_CAPABILITY_METHOD_CHANNELS = {
  resolveConsent: "plugin-capability:resolve-consent",
} as const satisfies Record<string, keyof IpcInvokeMap>;

type Methods = typeof PLUGIN_CAPABILITY_METHOD_CHANNELS;

export type PluginCapabilityPreloadBindings = {
  [M in keyof Methods]: (
    ...args: IpcInvokeMap[Methods[M]]["args"]
  ) => Promise<IpcInvokeMap[Methods[M]]["result"]>;
};

type Invoker = (channel: string, ...args: unknown[]) => Promise<unknown>;

export function buildPluginCapabilityPreloadBindings(
  invoke: Invoker
): PluginCapabilityPreloadBindings {
  const out: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  for (const method of Object.keys(PLUGIN_CAPABILITY_METHOD_CHANNELS) as Array<keyof Methods>) {
    const channel = PLUGIN_CAPABILITY_METHOD_CHANNELS[method];
    out[method as string] = (...args) => invoke(channel, ...args);
  }
  return out as unknown as PluginCapabilityPreloadBindings;
}
