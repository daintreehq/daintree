import type { AgentRoutingConfig } from "../types/agentSettings.js";
import type { PrerequisiteSpec } from "../types/ipc/system.js";

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
   * Activity debounce period in ms (default: 4000).
   * Time to wait after last activity before transitioning to idle.
   */
  debounceMs?: number;

  /**
   * Minimum quiet-output ms before the prompt fast-path can fire (default: 3000).
   * Lower values make the busy→idle transition snappier when a prompt is detected.
   * Agents with deterministic completion markers (e.g. Cursor) can use shorter
   * values; agents with silent inter-tool-call gaps (Claude/Codex) need the
   * default to avoid working↔waiting jitter (Issue #3606).
   */
  promptFastPathMinQuietMs?: number;

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

  /**
   * Patterns that indicate the agent successfully completed a task.
   * When detected, briefly transition to "completed" state before settling to "waiting".
   * Use strings that will be converted to RegExp with case-insensitive flag.
   */
  completionPatterns?: string[];

  /**
   * Confidence level when completion pattern matches (default: 0.90).
   */
  completionConfidence?: number;

  /**
   * Patterns matched against terminal window title (OSC 0/2) for state detection.
   * Substrings checked via includes() against the title string.
   */
  titleStatePatterns?: {
    working: string[];
    waiting: string[];
  };
}

export interface AgentModelConfig {
  id: string;
  name: string;
  shortLabel: string;
}

export interface AgentConfig {
  id: string;
  name: string;
  command: string;
  /** Default CLI arguments to pass at spawn (before user flags) */
  args?: string[];
  color: string;
  iconId: string;
  /** Available models for per-panel model selection at launch time */
  models?: AgentModelConfig[];
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
    resizeStrategy?: "default" | "settled";
    /** CLI flag to disable alt-screen and use inline rendering (e.g., "--no-alt-screen") */
    inlineModeFlag?: string;
    /** Whether the agent CLI supports bracketed paste input (default: true) */
    supportsBracketedPaste?: boolean;
    /** Escape sequence sent for Shift+Enter / soft newline (default: "\x1b\r") */
    softNewlineSequence?: string;
    /** Input sequences the activity monitor should ignore (default: ["\x1b\r"]) */
    ignoredInputSequences?: string[];
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
  /**
   * Graceful shutdown configuration for capturing session IDs.
   * When present, the PTY host will send the quit command before killing,
   * then scan output for the session ID pattern.
   */
  shutdown?: {
    /** Command to send to trigger graceful exit (e.g., "/quit") */
    quitCommand: string;
    /** Regex pattern string with a capture group for the session ID */
    sessionIdPattern: string;
  };
  /**
   * Environment variables to set for this agent at spawn time.
   *
   * Precedence order (lowest to highest):
   * 1. process.env (system environment)
   * 2. options.env (passed to spawn)
   * 3. buildNonInteractiveEnv defaults (CI=1, FORCE_COLOR=3, etc.)
   * 4. agentConfig.env (this field - highest priority)
   *
   * Note: Agent-specific exclusions (e.g., CI/NONINTERACTIVE for Gemini)
   * are enforced and cannot be overridden by this field.
   */
  /**
   * Approximate context window size in tokens for this agent's model.
   * Used to warn when context usage is high.
   */
  contextWindow?: number;
  env?: Record<string, string>;
  /**
   * Resume configuration for restoring a previous agent session.
   * When present, Canopy can resume a prior session using the stored session ID
   * instead of starting fresh.
   */
  resume?: {
    /** Returns CLI args for resuming a session (e.g. ["--resume", id] or ["resume", id]) */
    args: (sessionId: string) => string[];
  };
  /**
   * Prerequisites required for this agent to function.
   * Merged with baseline prerequisites during health checks.
   */
  prerequisites?: PrerequisiteSpec[];
}

export const AGENT_REGISTRY: Record<string, AgentConfig> = {
  // NOTE: When adding a new agent here, also add its ID to BUILT_IN_AGENT_IDS in agentIds.ts.
  // The _registryCheck below will produce a compile error if they get out of sync.
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
    models: [
      { id: "claude-sonnet-4-6", name: "Sonnet 4.6", shortLabel: "Sonnet" },
      { id: "claude-opus-4-6", name: "Opus 4.6", shortLabel: "Opus" },
      { id: "claude-haiku-4-5-20251001", name: "Haiku 4.5", shortLabel: "Haiku" },
    ],
    contextWindow: 200_000,
    capabilities: {
      scrollback: 10000,
      supportsBracketedPaste: true,
      softNewlineSequence: "\x1b\r",
      ignoredInputSequences: ["\x1b\r"],
    },
    detection: {
      primaryPatterns: [
        // @generated:claude:primaryPatterns:start
        "[·*✢✳✶✻✽●✼✾⟡◇◆○]\\s+[^()\\n]{2,80}\\s*\\(esc to interrupt",
        "esc to interrupt[^)\\n]*\\)?$",
        "\\(\\d+s\\s*[·•]\\s*esc to interrupt",
        // @generated:claude:primaryPatterns:end
      ],
      fallbackPatterns: [
        // @generated:claude:fallbackPatterns:start
        "[✢✳✶✻✽●]\\s+\\w+…",
        // @generated:claude:fallbackPatterns:end
      ],
      bootCompletePatterns: [
        // @generated:claude:bootCompletePatterns:start
        "claude\\s+code\\s+v?\\d",
        // @generated:claude:bootCompletePatterns:end
      ],
      promptPatterns: ["^\\s*>\\s*", "^\\s*❯\\s*"],
      promptHintPatterns: ["bypass permissions", "^\\s*>\\s+Try\\b"],
      completionPatterns: [
        // @generated:claude:completionPatterns:start
        "[✢✳✶✻✽●]\\s+\\w+\\s+for\\s+\\d",
        "Total cost:\\s+\\$\\d",
        "Total duration",
        "\\$\\d+\\.\\d+\\s*·\\s*\\d+\\s*tokens",
        "Task\\s+completed",
        // @generated:claude:completionPatterns:end
      ],
      completionConfidence: 0.9,
      scanLineCount: 10,
      primaryConfidence: 0.95,
      fallbackConfidence: 0.75,
      promptConfidence: 0.85,
      debounceMs: 4000,
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
    shutdown: {
      quitCommand: "/quit",
      sessionIdPattern: "claude --resume ([\\w-]+)",
    },
    resume: {
      args: (sessionId: string) => ["--resume", sessionId],
    },
    env: {
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    },
    help: {
      args: [],
    },
    prerequisites: [
      {
        tool: "claude",
        label: "Claude CLI",
        versionArgs: ["--version"],
        severity: "fatal",
        installUrl: "https://github.com/anthropics/claude-code",
      },
    ],
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
      githubRepo: "google-gemini/gemini-cli",
      npmPackage: "@google/gemini-cli",
      releaseNotesUrl: "https://github.com/google-gemini/gemini-cli/releases",
    },
    update: {
      npm: "npm install -g @google/gemini-cli@latest",
    },
    install: {
      docsUrl: "https://github.com/google-gemini/gemini-cli#readme",
      byOs: {
        macos: [
          {
            label: "npm",
            commands: ["npm install -g @google/gemini-cli"],
          },
        ],
        windows: [
          {
            label: "npm",
            commands: ["npm install -g @google/gemini-cli"],
          },
        ],
        linux: [
          {
            label: "npm",
            commands: ["npm install -g @google/gemini-cli"],
          },
        ],
      },
      troubleshooting: [
        "Restart Canopy after installation to update PATH",
        "Verify installation with: gemini --version",
        "Run 'gemini auth login' after installing to authenticate",
      ],
    },
    models: [
      { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", shortLabel: "2.5 Pro" },
      { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash", shortLabel: "2.5 Flash" },
    ],
    contextWindow: 1_000_000,
    capabilities: {
      scrollback: 10000,
      blockAltScreen: true,
      blockMouseReporting: true,
      resizeStrategy: "settled",
      supportsBracketedPaste: false,
      softNewlineSequence: "\x1b\r",
      ignoredInputSequences: ["\x1b\r"],
    },
    detection: {
      primaryPatterns: [
        // @generated:gemini:primaryPatterns:start
        "[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\\s+[^()\\n]{2,80}\\s*\\(esc to cancel",
        "esc to cancel[^)\\n]*\\)?$",
        "\\(\\d+s,?\\s*esc to cancel",
        // @generated:gemini:primaryPatterns:end
      ],
      fallbackPatterns: [
        // @generated:gemini:fallbackPatterns:start
        "[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\\s+\\w",
        // @generated:gemini:fallbackPatterns:end
      ],
      bootCompletePatterns: [
        // @generated:gemini:bootCompletePatterns:start
        "type\\s+your\\s+message",
        // @generated:gemini:bootCompletePatterns:end
      ],
      promptPatterns: ["^\\s*>\\s*", "type\\s+your\\s+message"],
      promptHintPatterns: ["type\\s+your\\s+message"],
      completionPatterns: [
        // @generated:gemini:completionPatterns:start
        "Response\\s+complete",
        "Finished\\s+processing",
        // @generated:gemini:completionPatterns:end
      ],
      completionConfidence: 0.9,
      scanLineCount: 10,
      primaryConfidence: 0.95,
      fallbackConfidence: 0.7,
      promptConfidence: 0.85,
      debounceMs: 4000,
      titleStatePatterns: {
        working: ["\u2726"],
        waiting: ["\u25C7", "\u270B"],
      },
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
    shutdown: {
      quitCommand: "/quit",
      sessionIdPattern: "gemini --resume ([\\w-]+)",
    },
    resume: {
      args: (sessionId: string) => ["--resume", sessionId],
    },
    env: {
      GEMINI_CLI_ALT_SCREEN: "false",
    },
    help: {
      args: [],
    },
    prerequisites: [
      {
        tool: "gemini",
        label: "Gemini CLI",
        versionArgs: ["--version"],
        severity: "fatal",
        installUrl: "https://github.com/google-gemini/gemini-cli#readme",
      },
    ],
  },
  codex: {
    id: "codex",
    name: "Codex",
    command: "codex",
    color: "#10a37f",
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
    models: [
      { id: "gpt-5.4", name: "GPT-5.4", shortLabel: "GPT-5.4" },
      { id: "o3", name: "o3", shortLabel: "o3" },
    ],
    contextWindow: 128_000,
    capabilities: {
      scrollback: 10000,
      blockAltScreen: true,
      blockMouseReporting: true,
      resizeStrategy: "settled",
      inlineModeFlag: "--no-alt-screen",
      supportsBracketedPaste: true,
      softNewlineSequence: "\n",
      ignoredInputSequences: ["\n", "\x1b\r"],
    },
    detection: {
      primaryPatterns: [
        // @generated:codex:primaryPatterns:start
        "[•·]\\s+[^()\\n]{2,80}\\s+\\([^)]*esc to interrupt",
        "esc to interrupt[^)\\n]*\\)?$",
        "\\(\\d+s\\s*[·•]\\s*esc to interrupt",
        // @generated:codex:primaryPatterns:end
      ],
      fallbackPatterns: [
        // @generated:codex:fallbackPatterns:start
        "[•·]\\s+Working",
        // @generated:codex:fallbackPatterns:end
      ],
      bootCompletePatterns: [
        // @generated:codex:bootCompletePatterns:start
        "openai[-\\s]+codex",
        "codex\\s+v",
        // @generated:codex:bootCompletePatterns:end
      ],
      promptPatterns: ["^\\s*[›❯>]\\s*", "^\\s*codex\\s*>\\s*"],
      promptHintPatterns: ["context\\s+left"],
      completionPatterns: [
        // @generated:codex:completionPatterns:start
        "Task\\s+completed\\s+successfully",
        "\\d+\\s+files?\\s+changed",
        "Created\\s+\\d+\\s+files?",
        // @generated:codex:completionPatterns:end
      ],
      completionConfidence: 0.9,
      scanLineCount: 10,
      primaryConfidence: 0.95,
      fallbackConfidence: 0.75,
      promptConfidence: 0.85,
      debounceMs: 4000,
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
    shutdown: {
      quitCommand: "/quit",
      sessionIdPattern: "codex resume ([\\w-]+)",
    },
    resume: {
      args: (sessionId: string) => ["resume", sessionId],
    },
    help: {
      args: [],
    },
    prerequisites: [
      {
        tool: "codex",
        label: "Codex CLI",
        versionArgs: ["--version"],
        severity: "fatal",
        installUrl: "https://github.com/openai/codex",
      },
    ],
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
      blockAltScreen: false,
      supportsBracketedPaste: true,
      softNewlineSequence: "\n",
      ignoredInputSequences: ["\n", "\x1b\r"],
    },
    env: {
      COLORFGBG: "15;0",
    },
    detection: {
      primaryPatterns: [
        // @generated:opencode:primaryPatterns:start
        "[⣾⣽⣻⢿⡿⣟⣯⣷]\\s+[^\\n]{2,80}\\s*\\(.*esc",
        "[·•●]\\s+(Generating|Building tool call|Waiting for tool response)",
        "press\\s+esc\\s+(again\\s+)?to\\s+(interrupt|exit\\s+cancel)",
        "esc\\s*(again\\s+)?to\\s+(interrupt|cancel)",
        // @generated:opencode:primaryPatterns:end
      ],
      fallbackPatterns: [
        // @generated:opencode:fallbackPatterns:start
        "[⣾⣽⣻⢿⡿⣟⣯⣷]\\s+\\w",
        "working[…\\.]+",
        "generating",
        "waiting for tool response",
        "building tool call",
        // @generated:opencode:fallbackPatterns:end
      ],
      bootCompletePatterns: [
        // @generated:opencode:bootCompletePatterns:start
        "Ask anything",
        "Build\\s+OpenCode",
        // @generated:opencode:bootCompletePatterns:end
      ],
      promptPatterns: ["^\\s*[›❯>]\\s*", "Ask anything"],
      promptHintPatterns: ["Ask anything"],
      completionPatterns: [
        // @generated:opencode:completionPatterns:start
        "Task\\s+completed",
        "\\d+\\s+files?\\s+changed",
        // @generated:opencode:completionPatterns:end
      ],
      completionConfidence: 0.9,
      scanLineCount: 10,
      primaryConfidence: 0.95,
      fallbackConfidence: 0.7,
      promptConfidence: 0.85,
      debounceMs: 4000,
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
    shutdown: {
      quitCommand: "/quit",
      sessionIdPattern: "opencode -s ([\\w-]+)",
    },
    resume: {
      args: (sessionId: string) => ["-s", sessionId],
    },
    prerequisites: [
      {
        tool: "opencode",
        label: "OpenCode CLI",
        versionArgs: ["--version"],
        severity: "fatal",
        installUrl: "https://opencode.ai/docs/",
      },
    ],
  },
  cursor: {
    id: "cursor",
    name: "Cursor",
    command: "cursor-agent",
    color: "#3ee6eb",
    iconId: "cursor",
    supportsContextInjection: true,
    shortcut: "Cmd/Ctrl+Alt+U",
    tooltip: "Cursor's agentic CLI",
    version: {
      args: ["-v"],
    },
    update: {
      other: {
        curl: "curl https://cursor.com/install -fsS | bash",
      },
    },
    install: {
      docsUrl: "https://cursor.com/features/cursor-agent",
      byOs: {
        macos: [
          {
            label: "curl",
            commands: ["curl https://cursor.com/install -fsS | bash"],
          },
        ],
        linux: [
          {
            label: "curl",
            commands: ["curl https://cursor.com/install -fsS | bash"],
          },
        ],
      },
      troubleshooting: [
        "Restart Canopy after installation to update PATH",
        "Verify installation with: cursor-agent -v",
        "Run 'cursor-agent login' to authenticate after installing",
      ],
    },
    capabilities: {
      scrollback: 10000,
      blockMouseReporting: true,
      resizeStrategy: "settled",
      supportsBracketedPaste: true,
      softNewlineSequence: "\x1b\r",
      ignoredInputSequences: ["\x1b\r"],
    },
    detection: {
      primaryPatterns: [
        "\u2B22\\s*(Thinking|Reading|Planning|Searching|Running|Executing|Grepping|Editing|Listing)",
        "esc to stop",
      ],
      fallbackPatterns: ["\u2B22\\s*\\w"],
      bootCompletePatterns: ["Cursor Agent", "Welcome to Cursor Agent"],
      promptPatterns: ["^\u2192\\s*$", "^\u2192\\s"],
      promptHintPatterns: ["\u2192\\s+Add a follow-up"],
      completionPatterns: [
        "\u2B22\\s*(Thought|Read|Planned|Searched|Ran|Edited|Grepped|Listed)(?=[^a-zA-Z]|$)",
      ],
      completionConfidence: 0.9,
      scanLineCount: 10,
      primaryConfidence: 0.95,
      fallbackConfidence: 0.7,
      promptConfidence: 0.85,
      debounceMs: 4000,
      promptFastPathMinQuietMs: 700,
    },
    routing: {
      capabilities: ["javascript", "typescript", "python", "react", "node", "general-purpose"],
      domains: {
        frontend: 0.8,
        backend: 0.8,
        testing: 0.75,
        refactoring: 0.8,
        debugging: 0.8,
        architecture: 0.75,
      },
      maxConcurrent: 2,
      enabled: true,
    },
    prerequisites: [
      {
        tool: "cursor-agent",
        label: "Cursor Agent CLI",
        versionArgs: ["-v"],
        severity: "fatal",
        installUrl: "https://cursor.com/install",
      },
    ],
  },
};

import { BUILT_IN_AGENT_IDS } from "./agentIds.js";

// Runtime check: every BuiltInAgentId must have an entry in the registry.
for (const id of BUILT_IN_AGENT_IDS) {
  if (!(id in AGENT_REGISTRY)) {
    throw new Error(
      `AGENT_REGISTRY is missing entry for built-in agent "${id}". Update AGENT_REGISTRY or BUILT_IN_AGENT_IDS.`
    );
  }
}

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

export function getAgentModelConfig(
  agentId: string,
  modelId: string
): AgentModelConfig | undefined {
  const config = getEffectiveAgentConfig(agentId);
  return config?.models?.find((m) => m.id === modelId);
}

export function getAgentDisplayTitle(agentId: string, modelId?: string): string {
  const config = getEffectiveAgentConfig(agentId);
  const baseName = config?.name ?? agentId;
  if (!modelId) return baseName;
  const model = config?.models?.find((m) => m.id === modelId);
  return model ? `${baseName} (${model.shortLabel})` : baseName;
}
