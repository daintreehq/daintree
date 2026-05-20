import type { IpcInvokeMap } from "../../types/index.js";

export const GEMINI_METHOD_CHANNELS = {
  getStatus: "gemini:get-status",
  enableAlternateBuffer: "gemini:enable-alternate-buffer",
} as const satisfies Record<string, keyof IpcInvokeMap>;

type Methods = typeof GEMINI_METHOD_CHANNELS;

export type GeminiPreloadBindings = {
  [M in keyof Methods]: (
    ...args: IpcInvokeMap[Methods[M]]["args"]
  ) => Promise<IpcInvokeMap[Methods[M]]["result"]>;
};

type Invoker = (channel: string, ...args: unknown[]) => Promise<unknown>;

export function buildGeminiPreloadBindings(invoke: Invoker): GeminiPreloadBindings {
  const out: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  for (const method of Object.keys(GEMINI_METHOD_CHANNELS) as Array<keyof Methods>) {
    const channel = GEMINI_METHOD_CHANNELS[method];
    out[method as string] = (...args) => invoke(channel, ...args);
  }
  return out as unknown as GeminiPreloadBindings;
}
