import type { IpcInvokeMap } from "../../types/index.js";

export const SENTRY_METHOD_CHANNELS = {
  getConsentState: "sentry:get-consent-state",
} as const satisfies Record<string, keyof IpcInvokeMap>;

type Methods = typeof SENTRY_METHOD_CHANNELS;

export type SentryPreloadBindings = {
  [M in keyof Methods]: (
    ...args: IpcInvokeMap[Methods[M]]["args"]
  ) => Promise<IpcInvokeMap[Methods[M]]["result"]>;
};

type Invoker = (channel: string, ...args: unknown[]) => Promise<unknown>;

export function buildSentryPreloadBindings(invoke: Invoker): SentryPreloadBindings {
  const out: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  for (const method of Object.keys(SENTRY_METHOD_CHANNELS) as Array<keyof Methods>) {
    const channel = SENTRY_METHOD_CHANNELS[method];
    out[method as string] = (...args) => invoke(channel, ...args);
  }
  return out as unknown as SentryPreloadBindings;
}
