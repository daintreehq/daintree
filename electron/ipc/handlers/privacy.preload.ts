import type { IpcInvokeMap } from "../../types/index.js";

export const PRIVACY_METHOD_CHANNELS = {
  getSettings: "privacy:get-settings",
  setTelemetryLevel: "privacy:set-telemetry-level",
  setLogRetention: "privacy:set-log-retention",
  openDataFolder: "privacy:open-data-folder",
  clearCache: "privacy:clear-cache",
  resetAllData: "privacy:reset-all-data",
  getDataFolderPath: "privacy:get-data-folder-path",
} as const satisfies Record<string, keyof IpcInvokeMap>;

type Methods = typeof PRIVACY_METHOD_CHANNELS;

export type PrivacyPreloadBindings = {
  [M in keyof Methods]: (
    ...args: IpcInvokeMap[Methods[M]]["args"]
  ) => Promise<IpcInvokeMap[Methods[M]]["result"]>;
};

type Invoker = (channel: string, ...args: unknown[]) => Promise<unknown>;

export function buildPrivacyPreloadBindings(invoke: Invoker): PrivacyPreloadBindings {
  const out: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  for (const method of Object.keys(PRIVACY_METHOD_CHANNELS) as Array<keyof Methods>) {
    const channel = PRIVACY_METHOD_CHANNELS[method];
    out[method as string] = (...args) => invoke(channel, ...args);
  }
  return out as unknown as PrivacyPreloadBindings;
}
