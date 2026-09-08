import type { IpcInvokeMap } from "../../types/index.js";

export const WORKSPACE_RESIDENCY_METHOD_CHANNELS = {
  get: "workspace-residency:get",
  set: "workspace-residency:set",
} as const satisfies Record<string, keyof IpcInvokeMap>;

type Methods = typeof WORKSPACE_RESIDENCY_METHOD_CHANNELS;

export type WorkspaceResidencyPreloadBindings = {
  [M in keyof Methods]: (
    ...args: IpcInvokeMap[Methods[M]]["args"]
  ) => Promise<IpcInvokeMap[Methods[M]]["result"]>;
};

type Invoker = (channel: string, ...args: unknown[]) => Promise<unknown>;

export function buildWorkspaceResidencyPreloadBindings(
  invoke: Invoker
): WorkspaceResidencyPreloadBindings {
  const out: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  for (const method of Object.keys(WORKSPACE_RESIDENCY_METHOD_CHANNELS) as Array<keyof Methods>) {
    const channel = WORKSPACE_RESIDENCY_METHOD_CHANNELS[method];
    out[method as string] = (...args) => invoke(channel, ...args);
  }
  return out as unknown as WorkspaceResidencyPreloadBindings;
}
