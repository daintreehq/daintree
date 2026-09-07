import type { IpcInvokeMap } from "../../types/index.js";

export const WORKSPACE_METHOD_CHANNELS = {
  list: "workspace:list",
} as const satisfies Record<string, keyof IpcInvokeMap>;

type Methods = typeof WORKSPACE_METHOD_CHANNELS;

export type WorkspacePreloadBindings = {
  [M in keyof Methods]: (
    ...args: IpcInvokeMap[Methods[M]]["args"]
  ) => Promise<IpcInvokeMap[Methods[M]]["result"]>;
};

type Invoker = (channel: string, ...args: unknown[]) => Promise<unknown>;

export function buildWorkspacePreloadBindings(invoke: Invoker): WorkspacePreloadBindings {
  const out: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  for (const method of Object.keys(WORKSPACE_METHOD_CHANNELS) as Array<keyof Methods>) {
    const channel = WORKSPACE_METHOD_CHANNELS[method];
    out[method as string] = (...args) => invoke(channel, ...args);
  }
  return out as unknown as WorkspacePreloadBindings;
}
