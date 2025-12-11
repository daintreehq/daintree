export interface AgentConfig {
  id: string;
  name: string;
  command: string;
  color: string;
  iconId: string;
  supportsContextInjection: boolean;
  shortcut?: string | null;
  tooltip?: string;
  capabilities?: {
    blockAltScreen?: boolean;
    blockMouseReporting?: boolean;
    scrollback?: number;
  };
}

export const AGENT_REGISTRY: Record<string, AgentConfig> = {
  claude: {
    id: "claude",
    name: "Claude",
    command: "claude",
    color: "#CC785C",
    iconId: "claude",
    supportsContextInjection: true,
    shortcut: "Cmd/Ctrl+Alt+C",
    tooltip: "deep, focused work",
    capabilities: {
      blockAltScreen: true,
      blockMouseReporting: true,
      scrollback: 10000,
    },
  },
  gemini: {
    id: "gemini",
    name: "Gemini",
    command: "gemini",
    color: "#4285F4",
    iconId: "gemini",
    supportsContextInjection: true,
    shortcut: "Cmd/Ctrl+Alt+G",
    tooltip: "quick exploration",
    capabilities: {
      scrollback: 10000,
    },
  },
  codex: {
    id: "codex",
    name: "Codex",
    command: "codex",
    color: "#FFFFFF",
    iconId: "codex",
    supportsContextInjection: true,
    shortcut: "Cmd/Ctrl+Alt+X",
    tooltip: "careful, methodical runs",
    capabilities: {
      scrollback: 10000,
    },
  },
};

export function getAgentIds(): string[] {
  return Object.keys(AGENT_REGISTRY);
}

export function getAgentConfig(agentId: string): AgentConfig | undefined {
  return AGENT_REGISTRY[agentId];
}

export function isRegisteredAgent(agentId: string): boolean {
  return agentId in AGENT_REGISTRY;
}
