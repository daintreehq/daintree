import type { AgentModelConfig } from "../../config/agentRegistry.js";

/**
 * One registry entry as it crosses IPC. Deliberately NOT `AgentConfig`: every
 * `AgentResume` variant carries a live function (`args`, `argsForTarget`,
 * `assignSessionIdArgs`), and the structured-clone serializer behind
 * `ipcRenderer.invoke` cannot encode a function — returning raw configs left
 * the caller's promise unsettled rather than rejecting, so `agent.listAvailable`
 * burned the full 30s MCP dispatch timeout on every call (#11795).
 *
 * Only widen this with plain data, and only for a field a caller actually
 * reads: it is the wire contract, not a view of the config.
 */
export interface AgentRegistryEntry {
  name: string;
}

export type AgentRegistry = Record<string, AgentRegistryEntry>;

export interface AgentMetadata {
  id: string;
  name: string;
  command: string;
  color: string;
  iconId: string;
  supportsContextInjection: boolean;
  shortcut?: string | null;
  tooltip?: string;
  usageUrl?: string;
  capabilities?: {
    scrollback?: number;
    blockAltScreen?: boolean;
    blockMouseReporting?: boolean;
  };
  hasVersionConfig: boolean;
  hasUpdateConfig: boolean;
  hasInstallHelp: boolean;
  isBuiltIn: boolean;
  isUserDefined: boolean;
}

/**
 * Resolved model catalog for a single agent. Returned by the runtime
 * catalog resolver (`agentCapabilities.getResolvedModelList`) so the
 * renderer can present an up-to-date model picker without rebuilding
 * the app. `source` is informational only — `"remote"` when at least
 * one entry came from the live catalog fetch, `"bundled"` when the
 * fetch failed or no remote entries matched and the static config
 * was returned as-is.
 */
export interface ResolvedModelCatalog {
  agentId: string;
  models: AgentModelConfig[];
  contextWindow: number | null;
  source: "remote" | "bundled" | "merged";
}
