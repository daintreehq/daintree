import type { IpcInvokeMap } from "../../types/index.js";

export const PROJECT_PRESENCE_METHOD_CHANNELS = {
  getSnapshot: "project-presence:get-snapshot",
} as const satisfies Record<string, keyof IpcInvokeMap>;

type Methods = typeof PROJECT_PRESENCE_METHOD_CHANNELS;

export type ProjectPresencePreloadBindings = {
  [M in keyof Methods]: (
    ...args: IpcInvokeMap[Methods[M]]["args"]
  ) => Promise<IpcInvokeMap[Methods[M]]["result"]>;
};

type Invoker = (channel: string, ...args: unknown[]) => Promise<unknown>;

export function buildProjectPresencePreloadBindings(
  invoke: Invoker
): ProjectPresencePreloadBindings {
  const out: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  for (const method of Object.keys(PROJECT_PRESENCE_METHOD_CHANNELS) as Array<keyof Methods>) {
    const channel = PROJECT_PRESENCE_METHOD_CHANNELS[method];
    out[method as string] = (...args) => invoke(channel, ...args);
  }
  return out as unknown as ProjectPresencePreloadBindings;
}
