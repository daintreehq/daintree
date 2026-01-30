import type { AgentConfig } from "../../config/agentRegistry.js";
import type { AgentRoutingConfig } from "../agentSettings.js";

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
    blockScrollRegion?: boolean;
    blockClearScreen?: boolean;
    blockCursorToTop?: boolean;
  };
  /** Routing configuration for intelligent agent dispatch */
  routing?: AgentRoutingConfig;
  hasDetection: boolean;
  hasVersionConfig: boolean;
  hasUpdateConfig: boolean;
  hasInstallHelp: boolean;
  /** Whether the agent has routing configuration */
  hasRoutingConfig: boolean;
  isBuiltIn: boolean;
  isUserDefined: boolean;
}
