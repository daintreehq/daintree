import type { AgentConfig } from "../agentRegistry.js";

export const config: AgentConfig = {
  id: "copilot",
  name: "GitHub Copilot",
  command: "copilot",
  color: "#8957e5",
  iconId: "copilot",
  supportsContextInjection: true,
  // Copilot help sessions read MCP from `.mcp.json` written into the
  // per-session cwd (root key `mcpServers`, `type: "http"`, `$VAR` env-var
  // substitution in headers). `--plan` is appended at spawn time via
  // `HelpSessionService.buildCopilotLaunchArgs` to pin the session to
  // read-only mode. Held at `"experimental"` until end-to-end validation
  // lands.
  supports: {
    mcpInjection: "project-config",
    settingsOverlay: false,
    permissionBypass: false,
    trustDialog: false,
    versionProbe: true,
    tier: "experimental",
  },
  // `--plan` flag landed in Copilot CLI v1.0.40; below this floor we'd
  // launch without the read-only guardrail.
  assistantMinVersion: "1.0.40",
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
    // Ink TUI needs a gap between pasted body and the CR submit; see issue #5830.
    submitEnterDelayMs: 200,
    // Same Ink-TUI constraint applies to /exit on shutdown: the body and CR must
    // arrive as one write, or Copilot treats the gap as slow typing and never
    // submits the slash command. Matches Claude (also Ink-based).
    quitSubmitMode: "single-write",
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
    debounceMs: 6000,
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
