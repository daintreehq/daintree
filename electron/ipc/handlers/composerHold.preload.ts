import type { IpcInvokeMap } from "../../types/index.js";

export const COMPOSER_HOLD_METHOD_CHANNELS = {
  hold: "composer-hold:hold",
  withdraw: "composer-hold:withdraw",
  sendNow: "composer-hold:send-now",
  list: "composer-hold:list",
} as const satisfies Record<string, keyof IpcInvokeMap>;

type Methods = typeof COMPOSER_HOLD_METHOD_CHANNELS;

export type ComposerHoldPreloadBindings = {
  [M in keyof Methods]: (
    ...args: IpcInvokeMap[Methods[M]]["args"]
  ) => Promise<IpcInvokeMap[Methods[M]]["result"]>;
};

type Invoker = (channel: string, ...args: unknown[]) => Promise<unknown>;

export function buildComposerHoldPreloadBindings(invoke: Invoker): ComposerHoldPreloadBindings {
  const out: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  for (const method of Object.keys(COMPOSER_HOLD_METHOD_CHANNELS) as Array<keyof Methods>) {
    const channel = COMPOSER_HOLD_METHOD_CHANNELS[method];
    out[method as string] = (...args) => invoke(channel, ...args);
  }
  return out as unknown as ComposerHoldPreloadBindings;
}
