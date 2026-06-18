import type { IpcInvokeMap } from "../../types/index.js";

export const MCP_SERVER_METHOD_CHANNELS = {
  getStatus: "mcp-server:get-status",
  setEnabled: "mcp-server:set-enabled",
  setPort: "mcp-server:set-port",
  rotateApiKey: "mcp-server:rotate-api-key",
  getConfigSnippet: "mcp-server:get-config-snippet",
  listActiveClients: "mcp-server:list-active-clients",
  getAuditRecords: "mcp-server:get-audit-records",
  getLogRecords: "mcp-server:get-log-records",
  getAuditConfig: "mcp-server:get-audit-config",
  getAuditStats: "mcp-server:get-audit-stats",
  clearAuditLog: "mcp-server:clear-audit-log",
  getTurnOutcomeRecords: "mcp-server:get-turn-outcome-records",
  clearTurnOutcomeLog: "mcp-server:clear-turn-outcome-log",
  setAuditEnabled: "mcp-server:set-audit-enabled",
  setAuditMaxRecords: "mcp-server:set-audit-max-records",
  getRuntimeState: "mcp-server:get-runtime-state",
  exportAuditLog: "mcp-server:export-audit-log",
  setSessionTier: "mcp-server:set-session-tier",
  issueGrant: "mcp-server:issue-grant",
  revokeSessionGrants: "mcp-server:revoke-session-grants",
  issueNativeGrant: "mcp-server:issue-native-grant",
  revokeNativeGrant: "mcp-server:revoke-native-grant",
  resetDenialCounts: "mcp-server:reset-denial-counts",
  listActiveBearers: "mcp-server:list-active-bearers",
  listHelpSessionBearers: "mcp-server:list-help-session-bearers",
  disconnectBearer: "mcp-server:disconnect-bearer",
} as const satisfies Record<string, keyof IpcInvokeMap>;

type Methods = typeof MCP_SERVER_METHOD_CHANNELS;

export type McpServerPreloadBindings = {
  [M in keyof Methods]: (
    ...args: IpcInvokeMap[Methods[M]]["args"]
  ) => Promise<IpcInvokeMap[Methods[M]]["result"]>;
};

type Invoker = (channel: string, ...args: unknown[]) => Promise<unknown>;

export function buildMcpServerPreloadBindings(invoke: Invoker): McpServerPreloadBindings {
  const out: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  for (const method of Object.keys(MCP_SERVER_METHOD_CHANNELS) as Array<keyof Methods>) {
    const channel = MCP_SERVER_METHOD_CHANNELS[method];
    out[method as string] = (...args) => invoke(channel, ...args);
  }
  return out as unknown as McpServerPreloadBindings;
}
