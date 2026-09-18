import type { IpcInvokeMap } from "../../types/index.js";

export const ASSISTANT_TIMERS_METHOD_CHANNELS = {
  list: "assistant-timers:list",
  cancel: "assistant-timers:cancel",
} as const satisfies Record<string, keyof IpcInvokeMap>;

type Methods = typeof ASSISTANT_TIMERS_METHOD_CHANNELS;

export type AssistantTimersPreloadBindings = {
  [M in keyof Methods]: (
    ...args: IpcInvokeMap[Methods[M]]["args"]
  ) => Promise<IpcInvokeMap[Methods[M]]["result"]>;
};

type Invoker = (channel: string, ...args: unknown[]) => Promise<unknown>;

export function buildAssistantTimersPreloadBindings(
  invoke: Invoker
): AssistantTimersPreloadBindings {
  const out: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  for (const method of Object.keys(ASSISTANT_TIMERS_METHOD_CHANNELS) as Array<keyof Methods>) {
    const channel = ASSISTANT_TIMERS_METHOD_CHANNELS[method];
    out[method as string] = (...args) => invoke(channel, ...args);
  }
  return out as unknown as AssistantTimersPreloadBindings;
}
