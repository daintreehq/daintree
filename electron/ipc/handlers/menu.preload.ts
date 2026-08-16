import type { IpcInvokeMap } from "../../types/index.js";

export const MENU_METHOD_CHANNELS = {
  showContext: "menu:show-context",
  showApplication: "menu:show-application",
} as const satisfies Record<string, keyof IpcInvokeMap>;

type Methods = typeof MENU_METHOD_CHANNELS;

export type MenuPreloadBindings = {
  [M in keyof Methods]: (
    ...args: IpcInvokeMap[Methods[M]]["args"]
  ) => Promise<IpcInvokeMap[Methods[M]]["result"]>;
};

type Invoker = (channel: string, ...args: unknown[]) => Promise<unknown>;

export function buildMenuPreloadBindings(invoke: Invoker): MenuPreloadBindings {
  const out: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  for (const method of Object.keys(MENU_METHOD_CHANNELS) as Array<keyof Methods>) {
    const channel = MENU_METHOD_CHANNELS[method];
    out[method as string] = (...args) => invoke(channel, ...args);
  }
  return out as unknown as MenuPreloadBindings;
}
