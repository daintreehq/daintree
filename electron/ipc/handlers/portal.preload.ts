import type { IpcInvokeMap } from "../../types/index.js";

export const PORTAL_METHOD_CHANNELS = {
  create: "portal:create",
  show: "portal:show",
  hide: "portal:hide",
  resize: "portal:resize",
  closeTab: "portal:close-tab",
  navigate: "portal:navigate",
  goBack: "portal:go-back",
  goForward: "portal:go-forward",
  reload: "portal:reload",
} as const satisfies Record<string, keyof IpcInvokeMap>;

type Methods = typeof PORTAL_METHOD_CHANNELS;

export type PortalPreloadBindings = {
  [M in keyof Methods]: (
    ...args: IpcInvokeMap[Methods[M]]["args"]
  ) => Promise<IpcInvokeMap[Methods[M]]["result"]>;
};

type Invoker = (channel: string, ...args: unknown[]) => Promise<unknown>;

export function buildPortalPreloadBindings(invoke: Invoker): PortalPreloadBindings {
  const out: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  for (const method of Object.keys(PORTAL_METHOD_CHANNELS) as Array<keyof Methods>) {
    const channel = PORTAL_METHOD_CHANNELS[method];
    out[method as string] = (...args) => invoke(channel, ...args);
  }
  return out as unknown as PortalPreloadBindings;
}
