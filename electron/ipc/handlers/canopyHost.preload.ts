import type { IpcInvokeMap } from "../../types/index.js";

export const CANOPY_HOST_METHOD_CHANNELS = {
  invoke: "canopy-host:invoke",
  release: "canopy-host:release",
  listAssistants: "canopy-host:list-assistants",
  watchAssistant: "canopy-host:watch-assistant",
  resolveAssistant: "canopy-host:resolve-assistant",
  assistantInvoke: "canopy-host:assistant-invoke",
  releaseAssistant: "canopy-host:release-assistant",
} as const satisfies Record<string, keyof IpcInvokeMap>;

type Methods = typeof CANOPY_HOST_METHOD_CHANNELS;

export type CanopyHostPreloadBindings = {
  [M in keyof Methods]: (
    ...args: IpcInvokeMap[Methods[M]]["args"]
  ) => Promise<IpcInvokeMap[Methods[M]]["result"]>;
};

type Invoker = (channel: string, ...args: unknown[]) => Promise<unknown>;

export function buildCanopyHostPreloadBindings(invoke: Invoker): CanopyHostPreloadBindings {
  const out: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  for (const method of Object.keys(CANOPY_HOST_METHOD_CHANNELS) as Array<keyof Methods>) {
    const channel = CANOPY_HOST_METHOD_CHANNELS[method];
    out[method as string] = (...args) => invoke(channel, ...args);
  }
  return out as unknown as CanopyHostPreloadBindings;
}
