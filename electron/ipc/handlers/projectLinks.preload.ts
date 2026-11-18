import type { IpcInvokeMap } from "../../types/index.js";

export const PROJECT_LINKS_METHOD_CHANNELS = {
  change: "project-links:change",
  getDeclared: "project-links:get-declared",
} as const satisfies Record<string, keyof IpcInvokeMap>;

type Methods = typeof PROJECT_LINKS_METHOD_CHANNELS;

export type ProjectLinksPreloadBindings = {
  [M in keyof Methods]: (
    ...args: IpcInvokeMap[Methods[M]]["args"]
  ) => Promise<IpcInvokeMap[Methods[M]]["result"]>;
};

type Invoker = (channel: string, ...args: unknown[]) => Promise<unknown>;

export function buildProjectLinksPreloadBindings(invoke: Invoker): ProjectLinksPreloadBindings {
  const out: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  for (const method of Object.keys(PROJECT_LINKS_METHOD_CHANNELS) as Array<keyof Methods>) {
    const channel = PROJECT_LINKS_METHOD_CHANNELS[method];
    out[method as string] = (...args) => invoke(channel, ...args);
  }
  return out as unknown as ProjectLinksPreloadBindings;
}
