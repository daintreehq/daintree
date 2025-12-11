import type { ComponentType } from "react";
import { ClaudeIcon, GeminiIcon, CodexIcon } from "@/components/icons";
import {
  AGENT_REGISTRY as BASE_AGENT_REGISTRY,
  type AgentConfig as BaseAgentConfig,
  getAgentConfig as getBaseAgentConfig,
  getAgentIds as getBaseAgentIds,
  isRegisteredAgent as isBaseRegisteredAgent,
} from "../../shared/config/agentRegistry";

export interface AgentIconProps {
  className?: string;
  size?: number;
  brandColor?: string;
}

export interface AgentConfig extends BaseAgentConfig {
  icon: ComponentType<AgentIconProps>;
}

const ICON_MAP: Record<string, ComponentType<AgentIconProps>> = {
  claude: ClaudeIcon,
  gemini: GeminiIcon,
  codex: CodexIcon,
};

export const AGENT_REGISTRY: Record<string, AgentConfig> = Object.fromEntries(
  Object.entries(BASE_AGENT_REGISTRY).map(([id, config]) => {
    return [id, { ...config, icon: ICON_MAP[id] ?? ClaudeIcon }];
  })
) as Record<string, AgentConfig>;

export const AGENT_IDS = Object.keys(AGENT_REGISTRY) as string[];

export function getAgentConfig(agentId: string): AgentConfig | undefined {
  const config = getBaseAgentConfig(agentId);
  if (!config) return undefined;
  const icon = ICON_MAP[agentId] ?? ClaudeIcon;
  return { ...config, icon };
}

export function isRegisteredAgent(agentId: string): boolean {
  return isBaseRegisteredAgent(agentId);
}

export function getAgentIds(): string[] {
  return getBaseAgentIds();
}
