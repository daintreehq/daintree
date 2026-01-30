import type { AgentRoutingConfig } from "../types/agentSettings.js";

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
   * Patterns that indicate the agent is waiting for user input (prompt visible).
   * Use strings that will be converted to RegExp with case-insensitive flag.
   */
  promptPatterns?: string[];

  /**
   * Patterns that indicate an empty input prompt is visible.
   * Safe to scan from visible lines even when the cursor line is active output.
   */
  promptHintPatterns?: string[];

  /**
   * Number of lines from end of output to scan (default: 10).
   */
  scanLineCount?: number;

  /**
   * Number of lines from end of output to scan for prompt detection (default: 6).
   */
  promptScanLineCount?: number;

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

  /**
   * Confidence level when prompt pattern matches (default: 0.85).
   */
  promptConfidence?: number;
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
  /**
   * Version detection configuration.
   */
  version?: {
    /** Command arguments to get version (e.g., ["--version"]) */
    args: string[];
    /** npm package name for version lookup (e.g., "@anthropic-ai/claude-code") */
    npmPackage?: string;
    /** GitHub repository for version lookup (e.g., "owner/repo") */
    githubRepo?: string;
    /** Release notes URL template (use {version} placeholder) */
    releaseNotesUrl?: string;
  };
  /**
   * Update command configuration.
   */
  update?: {
    /** Update command for npm-based installs */
    npm?: string;
    /** Update command for Homebrew */
    brew?: string;
    /** Update command for other package managers or scripts */
    other?: Record<string, string>;
  };
  /**
   * Routing configuration for intelligent agent dispatch.
   * Used by orchestrators to select the best agent for a given task.
   */
  routing?: AgentRoutingConfig;
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
    version: {
      args: ["--version"],
      githubRepo: "anthropics/claude-code",
      npmPackage: "@anthropic-ai/claude-code",
      releaseNotesUrl: "https://github.com/anthropics/claude-code/releases/tag/v{version}",
    },
    update: {
      npm: "npm install -g @anthropic-ai/claude-code@latest",
    },
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
      promptPatterns: ["^\\s*>\\s*", "^\\s*❯\\s*"],
      promptHintPatterns: ["bypass permissions", "^\\s*>\\s+Try\\b"],
      scanLineCount: 10,
      primaryConfidence: 0.95,
      fallbackConfidence: 0.75,
      promptConfidence: 0.85,
      debounceMs: 2000,
    },
    routing: {
      capabilities: [
        "javascript",
        "typescript",
        "python",
        "rust",
        "go",
        "react",
        "node",
        "debugging",
        "refactoring",
        "code-review",
      ],
      domains: {
        frontend: 0.85,
        backend: 0.85,
        testing: 0.8,
        refactoring: 0.95,
        debugging: 0.9,
        architecture: 0.8,
      },
      maxConcurrent: 2,
      enabled: true,
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
    version: {
      args: ["--version"],
      githubRepo: "google/generative-ai-cli",
      npmPackage: "@google/generative-ai-cli",
      releaseNotesUrl: "https://github.com/google/generative-ai-cli/releases",
    },
    update: {
      npm: "npm install -g @google/generative-ai-cli@latest",
    },
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
      blockAltScreen: true,
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
      promptPatterns: ["^\\s*>\\s*", "type\\s+your\\s+message"],
      promptHintPatterns: ["type\\s+your\\s+message"],
      scanLineCount: 10,
      primaryConfidence: 0.95,
      fallbackConfidence: 0.7,
      promptConfidence: 0.85,
      debounceMs: 2000,
    },
    routing: {
      capabilities: [
        "javascript",
        "typescript",
        "python",
        "go",
        "java",
        "kotlin",
        "system-design",
        "architecture",
        "exploration",
      ],
      domains: {
        frontend: 0.7,
        backend: 0.85,
        testing: 0.7,
        refactoring: 0.75,
        debugging: 0.75,
        architecture: 0.9,
      },
      maxConcurrent: 2,
      enabled: true,
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
    version: {
      args: ["--version"],
      githubRepo: "openai/codex",
      npmPackage: "@openai/codex",
      releaseNotesUrl: "https://github.com/openai/codex/releases/tag/v{version}",
    },
    update: {
      npm: "npm install -g @openai/codex@latest",
    },
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
      promptPatterns: ["^\\s*[›❯>]\\s*", "^\\s*codex\\s*>\\s*"],
      promptHintPatterns: ["context\\s+left"],
      scanLineCount: 10,
      primaryConfidence: 0.95,
      fallbackConfidence: 0.75,
      promptConfidence: 0.85,
      debounceMs: 2000,
    },
    routing: {
      capabilities: [
        "javascript",
        "typescript",
        "react",
        "node",
        "testing",
        "frontend",
        "css",
        "html",
      ],
      domains: {
        frontend: 0.9,
        backend: 0.7,
        testing: 0.85,
        refactoring: 0.8,
        debugging: 0.75,
        architecture: 0.65,
      },
      maxConcurrent: 2,
      enabled: true,
    },
  },
  opencode: {
    id: "opencode",
    name: "OpenCode",
    command: "opencode",
    color: "#10b981",
    iconId: "opencode",
    supportsContextInjection: true,
    shortcut: "Cmd/Ctrl+Alt+O",
    tooltip: "provider-agnostic, open source",
    usageUrl: "https://opencode.ai/",
    version: {
      args: ["--version"],
      githubRepo: "opencode-ai/opencode",
      npmPackage: "opencode-ai",
      releaseNotesUrl: "https://github.com/opencode-ai/opencode/releases",
    },
    update: {
      npm: "npm install -g opencode-ai@latest",
      brew: "brew upgrade opencode",
      other: {
        curl: "curl -fsSL https://opencode.ai/install | bash",
      },
    },
    install: {
      docsUrl: "https://opencode.ai/docs/",
      byOs: {
        macos: [
          {
            label: "curl",
            commands: ["curl -fsSL https://opencode.ai/install | bash"],
          },
          {
            label: "npm",
            commands: ["npm install -g opencode-ai@latest"],
          },
          {
            label: "Homebrew",
            commands: ["brew install opencode"],
          },
        ],
        windows: [
          {
            label: "npm",
            commands: ["npm install -g opencode-ai@latest"],
          },
          {
            label: "Scoop",
            commands: ["scoop bucket add extras", "scoop install extras/opencode"],
          },
          {
            label: "Chocolatey",
            commands: ["choco install opencode"],
          },
        ],
        linux: [
          {
            label: "curl",
            commands: ["curl -fsSL https://opencode.ai/install | bash"],
          },
          {
            label: "npm",
            commands: ["npm install -g opencode-ai@latest"],
          },
          {
            label: "Homebrew",
            commands: ["brew install opencode"],
          },
          {
            label: "Paru (Arch)",
            commands: ["paru -S opencode-bin"],
          },
        ],
      },
      troubleshooting: [
        "Restart Canopy after installation to update PATH",
        "Ensure Node.js is installed for npm-based installation",
        "Verify installation with: opencode --version",
        "Run '/connect' in OpenCode to configure LLM provider",
        "For provider setup, authenticate at opencode.ai/auth",
      ],
    },
    capabilities: {
      scrollback: 10000,
      blockAltScreen: true,
      blockMouseReporting: false,
      blockScrollRegion: false,
      blockClearScreen: false,
      blockCursorToTop: false,
    },
    detection: {
      primaryPatterns: [
        "[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\\s+[^\\n]{2,80}\\s*\\(.*esc",
        "esc\\s*(again\\s+)?interrupt",
        "Press again to interrupt",
      ],
      fallbackPatterns: ["[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\\s+\\w", "working[…\\.]+", "generating"],
      bootCompletePatterns: ["Ask anything", "Build\\s+OpenCode"],
      promptPatterns: ["^\\s*[›❯>]\\s*", "Ask anything"],
      promptHintPatterns: ["Ask anything"],
      scanLineCount: 10,
      primaryConfidence: 0.95,
      fallbackConfidence: 0.7,
      promptConfidence: 0.85,
      debounceMs: 2000,
    },
    routing: {
      capabilities: [
        "javascript",
        "typescript",
        "python",
        "go",
        "rust",
        "multi-provider",
        "general-purpose",
      ],
      domains: {
        frontend: 0.75,
        backend: 0.75,
        testing: 0.7,
        refactoring: 0.7,
        debugging: 0.7,
        architecture: 0.7,
      },
      maxConcurrent: 1,
      enabled: true,
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
