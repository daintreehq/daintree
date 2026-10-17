import type { IpcInvokeMap } from "../../types/index.js";

export const ASSISTANT_MESSAGING_METHOD_CHANNELS = {
  getState: "assistant-messaging:get-state",
  setLaneEnrolled: "assistant-messaging:set-lane-enrolled",
  setPaused: "assistant-messaging:set-paused",
} as const satisfies Record<string, keyof IpcInvokeMap>;

type Methods = typeof ASSISTANT_MESSAGING_METHOD_CHANNELS;

export type AssistantMessagingPreloadBindings = {
  [M in keyof Methods]: (
    ...args: IpcInvokeMap[Methods[M]]["args"]
  ) => Promise<IpcInvokeMap[Methods[M]]["result"]>;
};

type Invoker = (channel: string, ...args: unknown[]) => Promise<unknown>;

export function buildAssistantMessagingPreloadBindings(
  invoke: Invoker
): AssistantMessagingPreloadBindings {
  const out: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  for (const method of Object.keys(ASSISTANT_MESSAGING_METHOD_CHANNELS) as Array<keyof Methods>) {
    const channel = ASSISTANT_MESSAGING_METHOD_CHANNELS[method];
    out[method as string] = (...args) => invoke(channel, ...args);
  }
  return out as unknown as AssistantMessagingPreloadBindings;
}
