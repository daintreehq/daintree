import type { IpcInvokeMap } from "../../types/index.js";

export const RESOURCE_PROFILE_METHOD_CHANNELS = {
  getResourceProfile: "system:get-resource-profile",
  getResourceProfileSnapshot: "system:get-resource-profile-snapshot",
} as const satisfies Record<string, keyof IpcInvokeMap>;

type Methods = typeof RESOURCE_PROFILE_METHOD_CHANNELS;

export type ResourceProfilePreloadBindings = {
  [M in keyof Methods]: (
    ...args: IpcInvokeMap[Methods[M]]["args"]
  ) => Promise<IpcInvokeMap[Methods[M]]["result"]>;
};

type Invoker = (channel: string, ...args: unknown[]) => Promise<unknown>;

export function buildResourceProfilePreloadBindings(
  invoke: Invoker
): ResourceProfilePreloadBindings {
  const out: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  for (const method of Object.keys(RESOURCE_PROFILE_METHOD_CHANNELS) as Array<keyof Methods>) {
    const channel = RESOURCE_PROFILE_METHOD_CHANNELS[method];
    out[method as string] = (...args) => invoke(channel, ...args);
  }
  return out as unknown as ResourceProfilePreloadBindings;
}
