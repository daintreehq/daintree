import type { ComponentType } from "react";
import { ClaudeIcon, GeminiIcon, CodexIcon } from "@/components/icons";

export interface AgentIconProps {
  className?: string;
  size?: number;
  brandColor?: string;
}

export interface AgentConfig {
  id: string;
  name: string;
  command: string;
  icon: ComponentType<AgentIconProps>;
  color: string;
  supportsContextInjection: boolean;
  shortcut?: string | null;
  tooltip?: string;
}

export const AGENT_REGISTRY: Record<string, AgentConfig> = {
  claude: {
    id: "claude",
    name: "Claude",
    command: "claude",
    icon: ClaudeIcon,
    color: "#CC785C",
    supportsContextInjection: true,
    shortcut: "Cmd/Ctrl+Alt+C",
    tooltip: "deep, focused work",
  },
  gemini: {
    id: "gemini",
    name: "Gemini",
    command: "gemini",
    icon: GeminiIcon,
    color: "#4285F4",
    supportsContextInjection: true,
    shortcut: "Cmd/Ctrl+Alt+G",
    tooltip: "quick exploration",
  },
  codex: {
    id: "codex",
    name: "Codex",
    command: "codex",
    icon: CodexIcon,
    color: "#10A37F",
    supportsContextInjection: true,
    shortcut: "Cmd/Ctrl+Alt+X",
    tooltip: "careful, methodical runs",
  },
};

export const AGENT_IDS = Object.keys(AGENT_REGISTRY) as string[];

export function getAgentConfig(agentId: string): AgentConfig | undefined {
  return AGENT_REGISTRY[agentId];
}

export function isRegisteredAgent(agentId: string): boolean {
  return agentId in AGENT_REGISTRY;
}

export function getAgentIds(): string[] {
  return AGENT_IDS;
}
