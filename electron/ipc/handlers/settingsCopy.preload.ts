import type { IpcInvokeMap } from "../../types/index.js";

export const SETTINGS_COPY_METHOD_CHANNELS = {
  preview: "settings-copy:preview",
  apply: "settings-copy:apply",
} as const satisfies Record<string, keyof IpcInvokeMap>;

type Methods = typeof SETTINGS_COPY_METHOD_CHANNELS;

export type SettingsCopyPreloadBindings = {
  [M in keyof Methods]: (
    ...args: IpcInvokeMap[Methods[M]]["args"]
  ) => Promise<IpcInvokeMap[Methods[M]]["result"]>;
};

type Invoker = (channel: string, ...args: unknown[]) => Promise<unknown>;

export function buildSettingsCopyPreloadBindings(invoke: Invoker): SettingsCopyPreloadBindings {
  const out: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  for (const method of Object.keys(SETTINGS_COPY_METHOD_CHANNELS) as Array<keyof Methods>) {
    const channel = SETTINGS_COPY_METHOD_CHANNELS[method];
    out[method as string] = (...args) => invoke(channel, ...args);
  }
  return out as unknown as SettingsCopyPreloadBindings;
}
