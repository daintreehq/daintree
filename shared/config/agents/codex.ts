import type { AgentConfig } from "../agentRegistry.js";

export const config: AgentConfig = {
  id: "codex",
  name: "Codex",
  command: "codex",
  npmGlobalPackage: "@openai/codex",
  // Codex Windows packaging lags behind Linux — Windows users commonly
  // install via WSL. WSL probing surfaces the availability in diagnostics
  // even when no native Windows binary exists.
  supportsWsl: true,
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
      "Restart Daintree after installation to update PATH",
      "Verify installation with: codex --version",
      "Run 'codex auth login' after installing to authenticate",
    ],
  },
  models: [
    { id: "gpt-5.4", name: "GPT-5.4", shortLabel: "GPT-5.4" },
    { id: "o3", name: "o3", shortLabel: "o3" },
    { id: "gpt-5.3-codex-spark", name: "Codex Spark", shortLabel: "Spark" },
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
  resume: {
    kind: "session-id",
    args: (sessionId: string) => ["resume", sessionId],
    quitCommand: "/quit",
    sessionIdPattern: "codex resume ([\\w-]+)",
  },
  help: {
    args: [],
  },
  authCheck: {
    // Codex CLI persists auth to ~/.codex/auth.json on all platforms.
    // OPENAI_API_KEY is also a first-class auth signal for the CLI.
    configPathsAll: [".codex/auth.json"],
    envVar: "OPENAI_API_KEY",
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
};
