export interface AgentConfig {
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
    usageUrl: "https://claude.ai/settings/usage",
    capabilities: {
      scrollback: 10000,
      blockAltScreen: false,
      blockMouseReporting: true,
      blockScrollRegion: false,
      blockClearScreen: false,
      blockCursorToTop: false,
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
      blockAltScreen: false,
      blockMouseReporting: true,
      blockScrollRegion: false,
      blockClearScreen: false,
      blockCursorToTop: false,
    },
  },
  codex: {
    id: "codex",
    name: "Codex",
    command: "codex",
    color: "#e4e4e7",
    iconId: "codex",
    supportsContextInjection: true,
    shortcut: "Cmd/Ctrl+Alt+X",
    tooltip: "careful, methodical runs",
    usageUrl: "https://chatgpt.com/codex/settings/usage",
    capabilities: {
      scrollback: 10000,
      blockAltScreen: false,
      blockMouseReporting: true,
      blockScrollRegion: false,
      blockClearScreen: false,
      blockCursorToTop: false,
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
