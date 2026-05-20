import type { IpcInvokeMap } from "../../types/index.js";

export const MILESTONES_METHOD_CHANNELS = {
  get: "milestones:get",
  markShown: "milestones:mark-shown",
} as const satisfies Record<string, keyof IpcInvokeMap>;

type Methods = typeof MILESTONES_METHOD_CHANNELS;

export type MilestonesPreloadBindings = {
  [M in keyof Methods]: (
    ...args: IpcInvokeMap[Methods[M]]["args"]
  ) => Promise<IpcInvokeMap[Methods[M]]["result"]>;
};

type Invoker = (channel: string, ...args: unknown[]) => Promise<unknown>;

export function buildMilestonesPreloadBindings(invoke: Invoker): MilestonesPreloadBindings {
  const out: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  for (const method of Object.keys(MILESTONES_METHOD_CHANNELS) as Array<keyof Methods>) {
    const channel = MILESTONES_METHOD_CHANNELS[method];
    out[method as string] = (...args) => invoke(channel, ...args);
  }
  return out as unknown as MilestonesPreloadBindings;
}
