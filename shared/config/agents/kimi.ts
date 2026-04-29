import type { AgentConfig } from "../agentRegistry.js";

export const config: AgentConfig = {
  id: "kimi",
  name: "Kimi Code",
  command: "kimi",
  args: [],
  color: "#1E90FF",
  iconId: "kimi",
  supportsContextInjection: true,
  tooltip: "Moonshot AI's coding agent",
  usageUrl: "https://github.com/MoonshotAI/kimi-cli",
  packages: {
    pypi: "kimi-cli",
  },
  version: {
    args: ["--version"],
    pypiPackage: "kimi-cli",
    githubRepo: "MoonshotAI/kimi-cli",
    releaseNotesUrl: "https://github.com/MoonshotAI/kimi-cli/releases",
  },
  update: {
    pypi: "uv tool install kimi-cli --upgrade",
  },
  install: {
    docsUrl: "https://github.com/MoonshotAI/kimi-cli",
    byOs: {
      macos: [
        {
          label: "uv",
          commands: ["uv tool install kimi-cli"],
        },
      ],
      linux: [
        {
          label: "uv",
          commands: ["uv tool install kimi-cli"],
        },
      ],
      windows: [
        {
          label: "uv",
          commands: ["uv tool install kimi-cli"],
        },
      ],
    },
    troubleshooting: [
      "Requires Python 3.12 or later",
      "Restart Daintree after installation to update PATH",
      "Verify installation with: kimi --version",
      "Set KIMI_API_KEY to authenticate, or run kimi and use the OAuth flow",
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
    primaryPatterns: ["[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\\s+[^\\n]{2,80}"],
    fallbackPatterns: ["[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\\s+\\w"],
    promptPatterns: ["^\\s*(?:✨|💫|📋|\\$)\\s+"],
    promptHintPatterns: ["^\\s*(?:✨|💫|📋|\\$)\\s*$"],
    scanLineCount: 10,
    primaryConfidence: 0.95,
    fallbackConfidence: 0.75,
    promptConfidence: 0.85,
    debounceMs: 4000,
  },
  routing: {
    capabilities: ["javascript", "typescript", "python", "general-purpose"],
    domains: {
      frontend: 0.7,
      backend: 0.75,
      testing: 0.7,
      refactoring: 0.7,
      debugging: 0.7,
      architecture: 0.65,
    },
    maxConcurrent: 1,
    enabled: true,
  },
  resume: {
    kind: "rolling-history",
    args: () => ["--continue"],
    quitCommand: "/exit",
  },
  authCheck: {
    configPathsAll: [".kimi/config.toml", ".kimi/credentials/kimi-code.json"],
    // Only KIMI_API_KEY is a positive signal of Kimi-specific auth. Kimi can
    // also be pointed at OpenAI-compatible providers, but checking
    // OPENAI_API_KEY would incorrectly flag Codex-only users as Kimi-ready.
    envVar: "KIMI_API_KEY",
  },
  prerequisites: [
    {
      tool: "kimi",
      label: "Kimi Code CLI",
      versionArgs: ["--version"],
      severity: "fatal",
      installUrl: "https://github.com/MoonshotAI/kimi-cli",
    },
  ],
};
