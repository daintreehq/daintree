import type { IpcInvokeMap } from "../../types/index.js";

export const PROJECT_PORTAL_LINKS_METHOD_CHANNELS = {
  change: "project-portal-links:change",
} as const satisfies Record<string, keyof IpcInvokeMap>;

type Methods = typeof PROJECT_PORTAL_LINKS_METHOD_CHANNELS;

export type ProjectPortalLinksPreloadBindings = {
  [M in keyof Methods]: (
    ...args: IpcInvokeMap[Methods[M]]["args"]
  ) => Promise<IpcInvokeMap[Methods[M]]["result"]>;
};

type Invoker = (channel: string, ...args: unknown[]) => Promise<unknown>;

export function buildProjectPortalLinksPreloadBindings(
  invoke: Invoker
): ProjectPortalLinksPreloadBindings {
  const out: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  for (const method of Object.keys(PROJECT_PORTAL_LINKS_METHOD_CHANNELS) as Array<keyof Methods>) {
    const channel = PROJECT_PORTAL_LINKS_METHOD_CHANNELS[method];
    out[method as string] = (...args) => invoke(channel, ...args);
  }
  return out as unknown as ProjectPortalLinksPreloadBindings;
}
