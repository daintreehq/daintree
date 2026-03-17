import type { ComponentType } from "react";
import {
  AGENT_REGISTRY as BASE_AGENT_REGISTRY,
  type AgentConfig as BaseAgentConfig,
  getEffectiveAgentConfig,
  getEffectiveAgentIds,
  isEffectivelyRegisteredAgent,
} from "../../shared/config/agentRegistry";
import { resolveAgentIcon } from "./agentIcons";

export interface AgentIconProps {
  className?: string;
  size?: number;
  brandColor?: string;
}

export interface AgentConfig extends BaseAgentConfig {
  icon: ComponentType<AgentIconProps>;
}

export const AGENT_REGISTRY: Record<string, AgentConfig> = Object.fromEntries(
  Object.entries(BASE_AGENT_REGISTRY).map(([id, config]) => {
    return [id, { ...config, icon: resolveAgentIcon(config.iconId) }];
  })
) as Record<string, AgentConfig>;

export const AGENT_IDS = Object.keys(AGENT_REGISTRY) as string[];

export function getAgentConfig(agentId: string): AgentConfig | undefined {
  const config = getEffectiveAgentConfig(agentId);
  if (!config) return undefined;
  return { ...config, icon: resolveAgentIcon(config.iconId) };
}

export function isRegisteredAgent(agentId: string): boolean {
  return isEffectivelyRegisteredAgent(agentId);
}

export function getAgentIds(): string[] {
  return getEffectiveAgentIds();
}
