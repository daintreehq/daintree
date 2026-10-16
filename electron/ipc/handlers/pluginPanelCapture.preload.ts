import type { IpcInvokeMap } from "../../types/index.js";

// Shares the `plugin:` prefix, so codegen folds this into `window.electron.plugin`.
export const PLUGIN_PANEL_CAPTURE_METHOD_CHANNELS = {
  capturePanel: "plugin:capture-panel",
} as const satisfies Record<string, keyof IpcInvokeMap>;

type Methods = typeof PLUGIN_PANEL_CAPTURE_METHOD_CHANNELS;

export type PluginPanelCapturePreloadBindings = {
  [M in keyof Methods]: (
    ...args: IpcInvokeMap[Methods[M]]["args"]
  ) => Promise<IpcInvokeMap[Methods[M]]["result"]>;
};

type Invoker = (channel: string, ...args: unknown[]) => Promise<unknown>;

export function buildPluginPanelCapturePreloadBindings(
  invoke: Invoker
): PluginPanelCapturePreloadBindings {
  const out: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  for (const method of Object.keys(PLUGIN_PANEL_CAPTURE_METHOD_CHANNELS) as Array<keyof Methods>) {
    const channel = PLUGIN_PANEL_CAPTURE_METHOD_CHANNELS[method];
    out[method as string] = (...args) => invoke(channel, ...args);
  }
  return out as unknown as PluginPanelCapturePreloadBindings;
}
