import type { IpcInvokeMap } from "../../types/index.js";

export const OS_DND_METHOD_CHANNELS = {
  getState: "os-dnd:get-state",
} as const satisfies Record<string, keyof IpcInvokeMap>;

type Methods = typeof OS_DND_METHOD_CHANNELS;

export type OsDndPreloadBindings = {
  [M in keyof Methods]: (
    ...args: IpcInvokeMap[Methods[M]]["args"]
  ) => Promise<IpcInvokeMap[Methods[M]]["result"]>;
};

type Invoker = (channel: string, ...args: unknown[]) => Promise<unknown>;

export function buildOsDndPreloadBindings(invoke: Invoker): OsDndPreloadBindings {
  const out: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  for (const method of Object.keys(OS_DND_METHOD_CHANNELS) as Array<keyof Methods>) {
    const channel = OS_DND_METHOD_CHANNELS[method];
    out[method as string] = (...args) => invoke(channel, ...args);
  }
  return out as unknown as OsDndPreloadBindings;
}
