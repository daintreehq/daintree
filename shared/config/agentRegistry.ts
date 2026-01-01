export interface AgentHelpConfig {
  args: string[];
  title?: string;
}

export type AgentInstallOS = "macos" | "windows" | "linux" | "generic";

export interface AgentInstallBlock {
  label?: string;
  steps?: string[];
  commands?: string[];
  notes?: string[];
}

export interface AgentInstallHelp {
  docsUrl?: string;
  byOs?: Partial<Record<AgentInstallOS, AgentInstallBlock[]>>;
  troubleshooting?: string[];
}

/**
 * Configuration for pattern-based working state detection.
 * Patterns are matched against terminal output to detect when an agent is actively working.
 */
export interface AgentDetectionConfig {
  /**
   * Primary patterns that indicate working state (high confidence).
   * Patterns are matched against the last N lines of terminal output.
   * Use strings that will be converted to RegExp with case-insensitive flag.
   */
  primaryPatterns: string[];

  /**
   * Fallback patterns for early-stage output (medium confidence).
   * Checked when primary patterns don't match.
   */
  fallbackPatterns?: string[];

  /**
   * Patterns that indicate the agent has completed boot and is ready.
   * Use strings that will be converted to RegExp with case-insensitive flag.
   */
  bootCompletePatterns?: string[];

  /**
   * Number of lines from end of output to scan (default: 10).
   */
  scanLineCount?: number;

  /**
   * Activity debounce period in ms (default: 1500).
   * Time to wait after last activity before transitioning to idle.
   */
  debounceMs?: number;

  /**
   * Confidence level when primary pattern matches (default: 0.95).
   */
  primaryConfidence?: number;

  /**
   * Confidence level when fallback pattern matches (default: 0.75).
   */
  fallbackConfidence?: number;
}

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
  help?: AgentHelpConfig;
  install?: AgentInstallHelp;
  capabilities?: {
    scrollback?: number;
    blockAltScreen?: boolean;
    blockMouseReporting?: boolean;
    blockScrollRegion?: boolean;
    blockClearScreen?: boolean;
    blockCursorToTop?: boolean;
  };
  /**
   * Configuration for pattern-based working state detection.
   * If not specified, built-in patterns for the agent ID are used.
   */
  detection?: AgentDetectionConfig;
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
    usageUrl: "https://claude.ai/settings/usage",
    install: {
      docsUrl: "https://github.com/anthropics/claude-code",
      byOs: {
        macos: [
          {
            label: "npm",
            commands: ["npm install -g @anthropic-ai/claude-code"],
          },
        ],
        windows: [
          {
            label: "npm",
            commands: ["npm install -g @anthropic-ai/claude-code"],
          },
        ],
        linux: [
          {
            label: "npm",
            commands: ["npm install -g @anthropic-ai/claude-code"],
          },
        ],
      },
      troubleshooting: [
        "Restart Canopy after installation to update PATH",
        "Ensure Node.js and npm are installed first",
        "Verify installation with: claude --version",
        "Run 'claude auth login' to authenticate after installing",
      ],
    },
    capabilities: {
      scrollback: 10000,
      blockAltScreen: false,
      blockMouseReporting: false,
      blockScrollRegion: false,
      blockClearScreen: false,
      blockCursorToTop: false,
    },
    detection: {
      primaryPatterns: [
        "[✽✻✼✾⟡◇◆●○]\\s+[^()\\n]{2,80}\\s*\\(esc to interrupt",
        "esc to interrupt[^)\\n]*\\)?$",
        "\\(\\d+s\\s*[·•]\\s*esc to interrupt",
      ],
      fallbackPatterns: [
        "[✽✻✼✾⟡◇◆●○]\\s+(thinking|deliberating|working|reading|writing|searching|executing)",
      ],
      bootCompletePatterns: ["claude\\s+code\\s+v?\\d"],
      scanLineCount: 10,
      primaryConfidence: 0.95,
      fallbackConfidence: 0.75,
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
    install: {
      docsUrl: "https://ai.google.dev/gemini-api/docs/cli",
      byOs: {
        macos: [
          {
            label: "npm",
            commands: ["npm install -g @google/generative-ai-cli"],
          },
        ],
        windows: [
          {
            label: "npm",
            commands: ["npm install -g @google/generative-ai-cli"],
          },
        ],
        linux: [
          {
            label: "npm",
            commands: ["npm install -g @google/generative-ai-cli"],
          },
        ],
      },
      troubleshooting: [
        "Restart Canopy after installation to update PATH",
        "Verify installation with: gemini --version",
        "Run 'gemini auth login' after installing to authenticate",
      ],
    },
    capabilities: {
      scrollback: 10000,
      blockAltScreen: false,
      blockMouseReporting: false,
      blockScrollRegion: false,
      blockClearScreen: false,
      blockCursorToTop: false,
    },
    detection: {
      primaryPatterns: [
        "[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\\s+[^()\\n]{2,80}\\s*\\(esc to cancel",
        "esc to cancel[^)\\n]*\\)?$",
        "\\(\\d+s,?\\s*esc to cancel",
      ],
      fallbackPatterns: ["[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\\s+\\w"],
      bootCompletePatterns: ["type\\s+your\\s+message"],
      scanLineCount: 10,
      primaryConfidence: 0.95,
      fallbackConfidence: 0.7,
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
    install: {
      docsUrl: "https://github.com/openai/codex",
      byOs: {
        macos: [
          {
            label: "npm",
            commands: ["npm install -g @openai/codex"],
          },
        ],
        windows: [
          {
            label: "npm",
            commands: ["npm install -g @openai/codex"],
          },
        ],
        linux: [
          {
            label: "npm",
            commands: ["npm install -g @openai/codex"],
          },
        ],
      },
      troubleshooting: [
        "Restart Canopy after installation to update PATH",
        "Verify installation with: codex --version",
        "Run 'codex auth login' after installing to authenticate",
      ],
    },
    capabilities: {
      scrollback: 10000,
      blockAltScreen: false,
      blockMouseReporting: false,
      blockScrollRegion: false,
      blockClearScreen: false,
      blockCursorToTop: false,
    },
    detection: {
      primaryPatterns: [
        "[•·]\\s+[^()\\n]{2,80}\\s+\\([^)]*esc to interrupt",
        "esc to interrupt[^)\\n]*\\)?$",
        "\\(\\d+s\\s*[·•]\\s*esc to interrupt",
      ],
      fallbackPatterns: ["[•·]\\s+Working"],
      bootCompletePatterns: ["openai[-\\s]+codex", "codex\\s+v"],
      scanLineCount: 10,
      primaryConfidence: 0.95,
      fallbackConfidence: 0.75,
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

let userRegistry: Record<string, AgentConfig> = {};

export function setUserRegistry(registry: Record<string, AgentConfig>): void {
  userRegistry = registry;
}

export function getUserRegistry(): Record<string, AgentConfig> {
  return userRegistry;
}

export function getEffectiveRegistry(): Record<string, AgentConfig> {
  return { ...userRegistry, ...AGENT_REGISTRY };
}

export function getEffectiveAgentIds(): string[] {
  return Object.keys(getEffectiveRegistry());
}

export function getEffectiveAgentConfig(agentId: string): AgentConfig | undefined {
  return getEffectiveRegistry()[agentId];
}

export function isEffectivelyRegisteredAgent(agentId: string): boolean {
  return agentId in getEffectiveRegistry();
}

export function isBuiltInAgent(agentId: string): boolean {
  return agentId in AGENT_REGISTRY;
}

export function isUserDefinedAgent(agentId: string): boolean {
  return agentId in userRegistry && !(agentId in AGENT_REGISTRY);
}
