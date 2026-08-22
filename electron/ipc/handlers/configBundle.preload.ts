import type { IpcInvokeMap } from "../../types/index.js";

export const CONFIG_BUNDLE_METHOD_CHANNELS = {
  export: "config-bundle:export",
  previewImport: "config-bundle:preview-import",
  applyImport: "config-bundle:apply-import",
} as const satisfies Record<string, keyof IpcInvokeMap>;

type Methods = typeof CONFIG_BUNDLE_METHOD_CHANNELS;

export type ConfigBundlePreloadBindings = {
  [M in keyof Methods]: (
    ...args: IpcInvokeMap[Methods[M]]["args"]
  ) => Promise<IpcInvokeMap[Methods[M]]["result"]>;
};

type Invoker = (channel: string, ...args: unknown[]) => Promise<unknown>;

export function buildConfigBundlePreloadBindings(invoke: Invoker): ConfigBundlePreloadBindings {
  const out: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  for (const method of Object.keys(CONFIG_BUNDLE_METHOD_CHANNELS) as Array<keyof Methods>) {
    const channel = CONFIG_BUNDLE_METHOD_CHANNELS[method];
    out[method as string] = (...args) => invoke(channel, ...args);
  }
  return out as unknown as ConfigBundlePreloadBindings;
}
