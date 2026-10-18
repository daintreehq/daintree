import type { ComponentType, CSSProperties } from "react";
import {
  AGENT_REGISTRY as BASE_AGENT_REGISTRY,
  type AgentConfig as BaseAgentConfig,
  type AgentPreset,
  type AgentProviderTemplate,
  getEffectiveAgentConfig,
  getEffectiveAgentIds,
  isEffectivelyRegisteredAgent,
  getAgentDisplayTitle,
  getAssistantSupportedAgentIds,
} from "../../shared/config/agentRegistry";

export { getAgentDisplayTitle, getAssistantSupportedAgentIds };
export type { AgentPreset, AgentProviderTemplate };
import { resolveAgentIcon } from "./agentIcons";

export interface AgentIconProps {
  className?: string;
  size?: number;
  /** Set by `BrandMark`, which publishes the resolved rest/hover inks here. */
  style?: CSSProperties;
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

export const AGENT_DESCRIPTIONS: Record<string, string> = {
  claude: "Anthropic's CLI",
  gemini: "Google's CLI",
  antigravity: "Google's CLI",
  codex: "OpenAI's CLI",
  grok: "xAI's CLI",
  opencode: "Open-source CLI",
  cursor: "Cursor's CLI",
  kiro: "Amazon's CLI",
  copilot: "GitHub's CLI",
  crush: "Charm's CLI",
  interpreter: "Open Interpreter's CLI",
  mistral: "Mistral's CLI",
  kimi: "Moonshot AI's CLI",
  "daintree-assistant": "Daintree's built-in assistant",
};

export {
  sanitizeAgentEnv,
  sanitizeDisplayTitle,
  getMergedPresets,
  getMergedPresetIdentities,
  getMergedPreset,
  PRESET_DESCRIPTION_MAX_CHARS,
} from "../../shared/utils/agentPresets";
export type { AgentPresetSource, AgentPresetIdentity } from "../../shared/utils/agentPresets";
