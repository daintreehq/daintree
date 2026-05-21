import type { IpcInvokeMap } from "../../types/index.js";

export const DEV_PREVIEW_METHOD_CHANNELS = {
  ensure: "dev-preview:ensure",
  restart: "dev-preview:restart",
  restartAndClearCache: "dev-preview:restart-and-clear-cache",
  reinstallAndRestart: "dev-preview:reinstall-and-restart",
  stop: "dev-preview:stop",
  stopByPanel: "dev-preview:stop-by-panel",
  getState: "dev-preview:get-state",
  getByWorktree: "dev-preview:get-by-worktree",
} as const satisfies Record<string, keyof IpcInvokeMap>;

type Methods = typeof DEV_PREVIEW_METHOD_CHANNELS;

export type DevPreviewPreloadBindings = {
  [M in keyof Methods]: (
    ...args: IpcInvokeMap[Methods[M]]["args"]
  ) => Promise<IpcInvokeMap[Methods[M]]["result"]>;
};

type Invoker = (channel: string, ...args: unknown[]) => Promise<unknown>;

export function buildDevPreviewPreloadBindings(invoke: Invoker): DevPreviewPreloadBindings {
  const out: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  for (const method of Object.keys(DEV_PREVIEW_METHOD_CHANNELS) as Array<keyof Methods>) {
    const channel = DEV_PREVIEW_METHOD_CHANNELS[method];
    out[method as string] = (...args) => invoke(channel, ...args);
  }
  return out as unknown as DevPreviewPreloadBindings;
}
