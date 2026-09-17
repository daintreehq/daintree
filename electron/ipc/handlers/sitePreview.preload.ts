import type { IpcInvokeMap } from "../../types/index.js";

export const SITE_PREVIEW_METHOD_CHANNELS = {
  listCandidates: "site-preview:list-candidates",
  bind: "site-preview:bind",
  detach: "site-preview:detach",
  setMode: "site-preview:set-mode",
  reselect: "site-preview:reselect",
  getState: "site-preview:get-state",
} as const satisfies Record<string, keyof IpcInvokeMap>;

type Methods = typeof SITE_PREVIEW_METHOD_CHANNELS;

export type SitePreviewPreloadBindings = {
  [M in keyof Methods]: (
    ...args: IpcInvokeMap[Methods[M]]["args"]
  ) => Promise<IpcInvokeMap[Methods[M]]["result"]>;
};

type Invoker = (channel: string, ...args: unknown[]) => Promise<unknown>;

export function buildSitePreviewPreloadBindings(invoke: Invoker): SitePreviewPreloadBindings {
  const out: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  for (const method of Object.keys(SITE_PREVIEW_METHOD_CHANNELS) as Array<keyof Methods>) {
    const channel = SITE_PREVIEW_METHOD_CHANNELS[method];
    out[method as string] = (...args) => invoke(channel, ...args);
  }
  return out as unknown as SitePreviewPreloadBindings;
}
