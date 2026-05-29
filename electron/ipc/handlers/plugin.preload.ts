import type { IpcInvokeMap } from "../../types/index.js";

// `plugin:invoke` is intentionally NOT in this map. Its variadic
// `(pluginId, channel, ...args)` signature and senderFrame trust check
// can't be expressed through `IpcInvokeMap` without widening types to
// `unknown[]`, so the raw `ipcMain.handle` route in `plugin.ts` is kept
// (allowlisted in `ipcHandleCoverage.test.ts`).
export const PLUGIN_METHOD_CHANNELS = {
  list: "plugin:list",
  install: "plugin:install",
  setEnabled: "plugin:set-enabled",
  toolbarButtons: "plugin:toolbar-buttons",
  menuItems: "plugin:menu-items",
  keybindings: "plugin:keybindings",
  contextMenuItems: "plugin:context-menu-items",
  validateActionIds: "plugin:validate-action-ids",
  getActions: "plugin:actions-get",
  registerAction: "plugin:actions-register",
  unregisterAction: "plugin:actions-unregister",
  getPanelKinds: "plugin:panel-kinds-get",
  getForgeProviders: "plugin:forge-providers-get",
  getDecorations: "plugin:file-decorations-get",
  getAuditRecords: "plugin:get-audit-records",
  getAuditConfig: "plugin:get-audit-config",
  clearAuditLog: "plugin:clear-audit-log",
  setAuditEnabled: "plugin:set-audit-enabled",
  setAuditMaxRecords: "plugin:set-audit-max-records",
  exportAuditLog: "plugin:export-audit-log",
  getDiagnosticsSnapshot: "plugin:get-diagnostics-snapshot",
} as const satisfies Record<string, keyof IpcInvokeMap>;

type Methods = typeof PLUGIN_METHOD_CHANNELS;

export type PluginPreloadBindings = {
  [M in keyof Methods]: (
    ...args: IpcInvokeMap[Methods[M]]["args"]
  ) => Promise<IpcInvokeMap[Methods[M]]["result"]>;
};

type Invoker = (channel: string, ...args: unknown[]) => Promise<unknown>;

export function buildPluginPreloadBindings(invoke: Invoker): PluginPreloadBindings {
  const out: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  for (const method of Object.keys(PLUGIN_METHOD_CHANNELS) as Array<keyof Methods>) {
    const channel = PLUGIN_METHOD_CHANNELS[method];
    out[method as string] = (...args) => invoke(channel, ...args);
  }
  return out as unknown as PluginPreloadBindings;
}
