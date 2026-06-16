import type { IpcInvokeMap } from "../../types/index.js";

export const SHORTCUT_HINTS_METHOD_CHANNELS = {
  getCounts: "shortcut-hints:get-counts",
  incrementCount: "shortcut-hints:increment-count",
  getHintedHover: "shortcut-hints:get-hinted-hover",
  setHintedHover: "shortcut-hints:set-hinted-hover",
} as const satisfies Record<string, keyof IpcInvokeMap>;

type Methods = typeof SHORTCUT_HINTS_METHOD_CHANNELS;

export type ShortcutHintsPreloadBindings = {
  [M in keyof Methods]: (
    ...args: IpcInvokeMap[Methods[M]]["args"]
  ) => Promise<IpcInvokeMap[Methods[M]]["result"]>;
};

type Invoker = (channel: string, ...args: unknown[]) => Promise<unknown>;

export function buildShortcutHintsPreloadBindings(invoke: Invoker): ShortcutHintsPreloadBindings {
  const out: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  for (const method of Object.keys(SHORTCUT_HINTS_METHOD_CHANNELS) as Array<keyof Methods>) {
    const channel = SHORTCUT_HINTS_METHOD_CHANNELS[method];
    out[method as string] = (...args) => invoke(channel, ...args);
  }
  return out as unknown as ShortcutHintsPreloadBindings;
}
