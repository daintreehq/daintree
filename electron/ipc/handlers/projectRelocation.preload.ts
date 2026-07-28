import type { IpcInvokeMap } from "../../types/index.js";

export const PROJECT_RELOCATION_METHOD_CHANNELS = {
  preview: "project-relocation:preview",
  apply: "project-relocation:apply",
} as const satisfies Record<string, keyof IpcInvokeMap>;

type Methods = typeof PROJECT_RELOCATION_METHOD_CHANNELS;

export type ProjectRelocationPreloadBindings = {
  [M in keyof Methods]: (
    ...args: IpcInvokeMap[Methods[M]]["args"]
  ) => Promise<IpcInvokeMap[Methods[M]]["result"]>;
};

type Invoker = (channel: string, ...args: unknown[]) => Promise<unknown>;

export function buildProjectRelocationPreloadBindings(
  invoke: Invoker
): ProjectRelocationPreloadBindings {
  const out: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  for (const method of Object.keys(PROJECT_RELOCATION_METHOD_CHANNELS) as Array<keyof Methods>) {
    const channel = PROJECT_RELOCATION_METHOD_CHANNELS[method];
    out[method as string] = (...args) => invoke(channel, ...args);
  }
  return out as unknown as ProjectRelocationPreloadBindings;
}
