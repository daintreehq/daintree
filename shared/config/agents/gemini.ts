import type { AgentConfig } from "../agentRegistry.js";

export const config: AgentConfig = {
  id: "gemini",
  name: "Gemini",
  command: "gemini",
  npmGlobalPackage: "@google/gemini-cli",
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
      "Restart Daintree after installation to update PATH",
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
      working: ["✦"],
      waiting: ["◇", "✋"],
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
  resume: {
    kind: "session-id",
    args: (sessionId: string) => ["--resume", sessionId],
    quitCommand: "/quit",
    sessionIdPattern: "gemini --resume ([\\w-]+)",
  },
  env: {
    GEMINI_CLI_ALT_SCREEN: "false",
  },
  help: {
    args: [],
  },
  authCheck: {
    // Gemini CLI persists OAuth creds to ~/.gemini/oauth_creds.json on all
    // platforms (Node CLI using os.homedir()). GEMINI_API_KEY is also a
    // first-class auth signal supported directly by the CLI.
    configPathsAll: [".gemini/oauth_creds.json", ".gemini/google_accounts.json"],
    envVar: "GEMINI_API_KEY",
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
};
