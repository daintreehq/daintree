import type { AgentConfig } from "../../config/agentRegistry.js";

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
  hasDetection: boolean;
  hasVersionConfig: boolean;
  hasUpdateConfig: boolean;
  hasInstallHelp: boolean;
  isBuiltIn: boolean;
  isUserDefined: boolean;
}
