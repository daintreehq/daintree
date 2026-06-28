import type { AgentConfig, AgentModelConfig } from "../../config/agentRegistry.js";

export type AgentRegistry = Record<string, AgentConfig>;

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
