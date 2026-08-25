import type { IpcInvokeMap } from "../../types/index.js";

/**
 * Opt out of the renderer-API generator. The command surface is a discriminated union
 * (`AssistantHostCommand`) rather than a positional argument list, so the hand-typed
 * shape in `preload.cts` is the useful one — a generated signature would erase the
 * discriminant and let a malformed command through the type system.
 */
export const RENDERER_API_SKIP = true as const;

export const ASSISTANT_HOST_METHOD_CHANNELS = {
  start: "assistant-host:start",
  send: "assistant-host:send",
  stop: "assistant-host:stop",
  diagnostics: "assistant-host:diagnostics",
} as const satisfies Record<string, keyof IpcInvokeMap>;

type Methods = typeof ASSISTANT_HOST_METHOD_CHANNELS;

export type AssistantHostPreloadBindings = {
  [M in keyof Methods]: (
    ...args: IpcInvokeMap[Methods[M]]["args"]
  ) => Promise<IpcInvokeMap[Methods[M]]["result"]>;
};

type Invoker = (channel: string, ...args: unknown[]) => Promise<unknown>;

export function buildAssistantHostPreloadBindings(invoke: Invoker): AssistantHostPreloadBindings {
  const out: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  for (const method of Object.keys(ASSISTANT_HOST_METHOD_CHANNELS) as Array<keyof Methods>) {
    const channel = ASSISTANT_HOST_METHOD_CHANNELS[method];
    out[method as string] = (...args) => invoke(channel, ...args);
  }
  return out as unknown as AssistantHostPreloadBindings;
}
