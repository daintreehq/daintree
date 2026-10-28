import type { IpcInvokeMap } from "../../types/index.js";

// Shares the `plugin:` prefix, so codegen folds this into `window.electron.plugin`.
export const PLUGIN_PROJECT_PRESENCE_METHOD_CHANNELS = {
  getProjectPresence: "plugin:project-presence-get",
} as const satisfies Record<string, keyof IpcInvokeMap>;

type Methods = typeof PLUGIN_PROJECT_PRESENCE_METHOD_CHANNELS;

export type PluginProjectPresencePreloadBindings = {
  [M in keyof Methods]: (
    ...args: IpcInvokeMap[Methods[M]]["args"]
  ) => Promise<IpcInvokeMap[Methods[M]]["result"]>;
};

type Invoker = (channel: string, ...args: unknown[]) => Promise<unknown>;

export function buildPluginProjectPresencePreloadBindings(
  invoke: Invoker
): PluginProjectPresencePreloadBindings {
  const out: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  for (const method of Object.keys(PLUGIN_PROJECT_PRESENCE_METHOD_CHANNELS) as Array<
    keyof Methods
  >) {
    const channel = PLUGIN_PROJECT_PRESENCE_METHOD_CHANNELS[method];
    out[method as string] = (...args) => invoke(channel, ...args);
  }
  return out as unknown as PluginProjectPresencePreloadBindings;
}
