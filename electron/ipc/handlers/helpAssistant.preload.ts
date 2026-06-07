import type { IpcInvokeMap } from "../../types/index.js";

export const HELP_ASSISTANT_METHOD_CHANNELS = {
  getSettings: "help-assistant:get-settings",
  setSettings: "help-assistant:set-settings",
  getLiveSessionStatus: "help-assistant:get-live-session-status",
} as const satisfies Record<string, keyof IpcInvokeMap>;

type Methods = typeof HELP_ASSISTANT_METHOD_CHANNELS;

export type HelpAssistantPreloadBindings = {
  [M in keyof Methods]: (
    ...args: IpcInvokeMap[Methods[M]]["args"]
  ) => Promise<IpcInvokeMap[Methods[M]]["result"]>;
};

type Invoker = (channel: string, ...args: unknown[]) => Promise<unknown>;

export function buildHelpAssistantPreloadBindings(invoke: Invoker): HelpAssistantPreloadBindings {
  const out: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  for (const method of Object.keys(HELP_ASSISTANT_METHOD_CHANNELS) as Array<keyof Methods>) {
    const channel = HELP_ASSISTANT_METHOD_CHANNELS[method];
    out[method as string] = (...args) => invoke(channel, ...args);
  }
  return out as unknown as HelpAssistantPreloadBindings;
}
