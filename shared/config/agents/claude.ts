import type { AgentConfig } from "../agentRegistry.js";

export const config: AgentConfig = {
  id: "claude",
  name: "Claude",
  command: "claude",
  // Anthropic's native installer places the symlink at ~/.local/bin/claude
  // on macOS/Linux and a versioned binary under ~/.local/share/claude.
  // Windows native installer places the binary under
  // %LOCALAPPDATA%\claude-code\bin\claude.exe. Detect both so users who
  // install via the native installer are not mis-reported as "missing"
  // when ~/.local/bin isn't inherited by the Electron process PATH.
  nativePaths: ["~/.local/bin/claude", "%LOCALAPPDATA%\\claude-code\\bin\\claude.exe"],
  npmGlobalPackage: "@anthropic-ai/claude-code",
  color: "#CC785C",
  iconId: "claude",
  supportsContextInjection: true,
  supportsAssistant: true,
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
      "Restart Daintree after installation to update PATH",
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
  resume: {
    kind: "session-id",
    args: (sessionId: string) => ["--resume", sessionId],
    quitCommand: "/quit",
    sessionIdPattern: "claude --resume ([\\w-]+)",
  },
  env: {
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  },
  help: {
    args: [],
  },
  authCheck: {
    // Claude Code CLI persists auth/session state in ~/.claude.json (the
    // single file), not ~/.claude/config.json. ANTHROPIC_API_KEY is also a
    // first-class auth signal supported directly by the CLI.
    configPathsAll: [".claude.json", ".claude/config.json"],
    envVar: "ANTHROPIC_API_KEY",
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
  envSuggestions: [
    { key: "ANTHROPIC_AUTH_TOKEN", hint: "API key or auth token" },
    {
      key: "ANTHROPIC_BASE_URL",
      hint: "Override API base URL (e.g. https://api.z.ai/api/anthropic)",
    },
    { key: "ANTHROPIC_DEFAULT_OPUS_MODEL", hint: "Override Opus model ID" },
    { key: "ANTHROPIC_DEFAULT_SONNET_MODEL", hint: "Override Sonnet model ID" },
    { key: "ANTHROPIC_DEFAULT_HAIKU_MODEL", hint: "Override Haiku model ID" },
    { key: "API_TIMEOUT_MS", hint: "Request timeout in ms (e.g. 3000000)" },
    { key: "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", hint: "1 to disable telemetry" },
  ],
  providerTemplates: [
    {
      id: "anthropic-native",
      name: "Anthropic (native)",
      description: "Direct Anthropic API connection.",
      env: {
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      },
    },
    {
      id: "zai",
      name: "Z.AI",
      description: "Anthropic-compatible via Z.AI.",
      env: {
        ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic",
        ANTHROPIC_DEFAULT_OPUS_MODEL: "glm-5.1",
        ANTHROPIC_DEFAULT_SONNET_MODEL: "glm-4.7",
        ANTHROPIC_DEFAULT_HAIKU_MODEL: "glm-4.5-air",
        API_TIMEOUT_MS: "3000000",
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      },
    },
    {
      id: "openrouter",
      name: "OpenRouter",
      description: "Model routing via OpenRouter.",
      env: {
        ANTHROPIC_BASE_URL: "https://openrouter.ai/api/v1",
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      },
    },
    {
      id: "deepseek",
      name: "DeepSeek",
      description: "OpenAI-compatible via DeepSeek.",
      env: {
        ANTHROPIC_BASE_URL: "https://api.deepseek.com/v1",
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      },
    },
    {
      id: "ollama",
      name: "Ollama (local)",
      description: "Local models via Ollama — no API key needed.",
      env: {
        ANTHROPIC_BASE_URL: "http://localhost:11434/v1",
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      },
    },
    {
      id: "custom-openai",
      name: "Custom (OpenAI-compatible)",
      description: "Custom OpenAI-compatible endpoint.",
      env: {
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      },
    },
  ],
};
