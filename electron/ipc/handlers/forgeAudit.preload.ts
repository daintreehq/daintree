import type { IpcInvokeMap } from "../../types/index.js";

export const FORGE_AUDIT_METHOD_CHANNELS = {
  getRecords: "forge-audit:get-records",
  getConfig: "forge-audit:get-config",
  getStats: "forge-audit:get-stats",
  clearLog: "forge-audit:clear-log",
  exportLog: "forge-audit:export-log",
  setEnabled: "forge-audit:set-enabled",
} as const satisfies Record<string, keyof IpcInvokeMap>;

type Methods = typeof FORGE_AUDIT_METHOD_CHANNELS;

export type ForgeAuditPreloadBindings = {
  [M in keyof Methods]: (
    ...args: IpcInvokeMap[Methods[M]]["args"]
  ) => Promise<IpcInvokeMap[Methods[M]]["result"]>;
};

type Invoker = (channel: string, ...args: unknown[]) => Promise<unknown>;

export function buildForgeAuditPreloadBindings(invoke: Invoker): ForgeAuditPreloadBindings {
  const out: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  for (const method of Object.keys(FORGE_AUDIT_METHOD_CHANNELS) as Array<keyof Methods>) {
    const channel = FORGE_AUDIT_METHOD_CHANNELS[method];
    out[method as string] = (...args) => invoke(channel, ...args);
  }
  return out as unknown as ForgeAuditPreloadBindings;
}
