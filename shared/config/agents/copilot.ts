import type { AgentConfig } from "../agentRegistry.js";

export const config: AgentConfig = {
  id: "copilot",
  name: "GitHub Copilot",
  command: "copilot",
  color: "#8957e5",
  iconId: "copilot",
  supportsContextInjection: true,
  tooltip: "GitHub's AI coding agent",
  usageUrl: "https://github.com/features/copilot",
  contextWindow: 160_000,
  models: [
    { id: "claude-sonnet-4.6", name: "Claude Sonnet 4.6", shortLabel: "Sonnet 4.6" },
    { id: "claude-opus-4.6", name: "Claude Opus 4.6", shortLabel: "Opus 4.6" },
    { id: "claude-haiku-4.5", name: "Claude Haiku 4.5", shortLabel: "Haiku 4.5" },
    { id: "claude-sonnet-4.5", name: "Claude Sonnet 4.5", shortLabel: "Sonnet 4.5" },
    { id: "claude-opus-4.5", name: "Claude Opus 4.5", shortLabel: "Opus 4.5" },
    { id: "gpt-5.4", name: "GPT-5.4", shortLabel: "GPT-5.4" },
    { id: "gpt-5.3-codex", name: "GPT-5.3 Codex", shortLabel: "GPT-5.3" },
    { id: "gpt-5.2", name: "GPT-5.2", shortLabel: "GPT-5.2" },
    { id: "gpt-5.4-mini", name: "GPT-5.4 Mini", shortLabel: "5.4 Mini" },
    { id: "gpt-5-mini", name: "GPT-5 Mini", shortLabel: "5 Mini" },
    { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", shortLabel: "Gem 2.5 Pro" },
    { id: "gemini-3-pro-preview", name: "Gemini 3 Pro", shortLabel: "Gem 3 Pro" },
    { id: "gemini-3.1-pro-preview", name: "Gemini 3.1 Pro", shortLabel: "Gem 3.1 Pro" },
  ],
  version: {
    args: ["--version"],
    npmPackage: "@github/copilot",
    githubRepo: "github/copilot-cli",
    releaseNotesUrl: "https://github.com/github/copilot-cli/releases",
  },
  update: {
    npm: "npm install -g @github/copilot@latest",
  },
  install: {
    docsUrl: "https://github.com/github/copilot-cli#readme",
    byOs: {
      macos: [
        {
          label: "npm",
          commands: ["npm install -g @github/copilot"],
        },
      ],
      linux: [
        {
          label: "npm",
          commands: ["npm install -g @github/copilot"],
        },
      ],
      windows: [
        {
          label: "npm",
          commands: ["npm install -g @github/copilot"],
        },
      ],
    },
    troubleshooting: [
      "Restart Daintree after installation to update PATH",
      "Verify installation with: copilot --version",
      "Run 'copilot login' to authenticate after installing",
    ],
  },
  capabilities: {
    scrollback: 10000,
    blockMouseReporting: true,
    resizeStrategy: "settled",
    supportsBracketedPaste: true,
    submitEnterDelayMs: 0,
  },
  detection: {
    primaryPatterns: ["\\(Esc to cancel\\)", "[∙∘○◎◉]\\s+.+\\(Esc to cancel\\)"],
    fallbackPatterns: ["[∙∘○◎◉]\\s+\\w"],
    bootCompletePatterns: ["Loading environment:"],
    promptPatterns: ["^\\s*>\\s*$", "^\\s*>\\s"],
    promptHintPatterns: ["^\\s*>\\s*$"],
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
      "go",
      "rust",
      "react",
      "node",
      "github",
      "general-purpose",
    ],
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
  resume: {
    kind: "session-id",
    args: (sessionId: string) => ["--resume=" + sessionId],
    quitCommand: "/exit",
    sessionIdPattern: "copilot --resume=([\\w-]+)",
  },
  authCheck: {
    // GitHub Copilot CLI primarily stores auth in the OS keychain
    // (macOS Keychain under "copilot-cli", Linux libsecret/GNOME Keyring).
    // ~/.copilot/config.json is written as a fallback when the keychain
    // is unavailable (headless Linux, CI). We intentionally do NOT probe
    // ~/.config/gh/hosts.yml — that file is populated by any `gh auth login`
    // for general GitHub CLI use, not specifically Copilot, so presence
    // does not imply a Copilot subscription or active auth. Keychain-auth
    // users get `authConfirmed: false` but remain launchable.
    configPathsAll: [".copilot/config.json"],
  },
  prerequisites: [
    {
      tool: "copilot",
      label: "GitHub Copilot CLI",
      versionArgs: ["--version"],
      severity: "fatal",
      installUrl: "https://github.com/github/copilot-cli",
    },
  ],
};
