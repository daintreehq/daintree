import type { AgentConfig } from "../agentRegistry.js";

export const config: AgentConfig = {
  id: "mistral",
  name: "Mistral Vibe",
  command: "vibe",
  // Pass --trust by default so the first-launch trust-folder prompt doesn't
  // block the agent state machine.
  args: ["--trust"],
  color: "#FA500F",
  iconId: "mistral",
  supportsContextInjection: true,
  tooltip: "Mistral's official terminal coding agent (Textual TUI)",
  usageUrl: "https://github.com/mistralai/mistral-vibe",
  packages: { pypi: "mistral-vibe" },
  version: {
    args: ["--version"],
    pypiPackage: "mistral-vibe",
    githubRepo: "mistralai/mistral-vibe",
    releaseNotesUrl: "https://github.com/mistralai/mistral-vibe/releases/tag/v{version}",
  },
  update: {
    curl: "curl -LsSf https://mistral.ai/vibe/install.sh | bash",
    pypi: "uv tool upgrade mistral-vibe",
  },
  install: {
    docsUrl: "https://github.com/mistralai/mistral-vibe#readme",
    byOs: {
      macos: [
        {
          label: "curl",
          commands: ["curl -LsSf https://mistral.ai/vibe/install.sh | bash"],
        },
        {
          label: "uv",
          commands: ["uv tool install mistral-vibe"],
        },
      ],
      linux: [
        {
          label: "curl",
          commands: ["curl -LsSf https://mistral.ai/vibe/install.sh | bash"],
        },
        {
          label: "uv",
          commands: ["uv tool install mistral-vibe"],
        },
      ],
      windows: [
        {
          label: "uv",
          commands: ["uv tool install mistral-vibe"],
          notes: [
            "Windows is best-effort — Mistral officially supports UNIX environments.",
            "The curl installer rejects Windows; use uv-direct instead.",
          ],
        },
      ],
    },
    troubleshooting: [
      "Restart Daintree after installation to update PATH",
      "Verify installation with: vibe --version",
      "Run 'vibe --setup' to configure MISTRAL_API_KEY or a local provider",
      "Requires Python >= 3.12 (the curl installer bootstraps uv-managed Python automatically)",
    ],
  },
  models: [
    { id: "devstral-2", name: "Devstral 2", shortLabel: "Devstral" },
    { id: "devstral-small", name: "Devstral Small", shortLabel: "Small" },
    { id: "local", name: "Local (llama.cpp)", shortLabel: "Local" },
  ],
  capabilities: {
    scrollback: 10000,
    blockAltScreen: true,
    blockMouseReporting: true,
    resizeStrategy: "settled",
    supportsBracketedPaste: true,
    softNewlineSequence: "\x1b\r",
    ignoredInputSequences: ["\x1b\r"],
  },
  detection: {
    primaryPatterns: [
      // @generated:mistral:primaryPatterns:start
      "[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\\s+[^\\n]{2,80}\\s*\\(\\d+s\\s+Esc",
      "Esc/Ctrl\\+C\\s+to\\s+interrupt",
      "\\(\\d+s\\s+Esc/Ctrl\\+C\\s+to\\s+interrupt",
      // @generated:mistral:primaryPatterns:end
    ],
    fallbackPatterns: [
      // @generated:mistral:fallbackPatterns:start
      "[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\\s+\\w",
      // @generated:mistral:fallbackPatterns:end
    ],
    bootCompletePatterns: [
      // @generated:mistral:bootCompletePatterns:start
      "Mistral\\s+Vibe",
      "Type\\s+/help",
      // @generated:mistral:bootCompletePatterns:end
    ],
    promptPatterns: ["^\\s*>\\s*$", "^\\s*>\\s"],
    promptHintPatterns: ["^\\s*>\\s*$"],
    scanLineCount: 10,
    primaryConfidence: 0.95,
    fallbackConfidence: 0.75,
    promptConfidence: 0.85,
    debounceMs: 4000,
    promptFastPathMinQuietMs: 700,
  },
  routing: {
    capabilities: ["javascript", "typescript", "python", "rust", "go", "general-purpose"],
    domains: {
      frontend: 0.7,
      backend: 0.8,
      testing: 0.7,
      refactoring: 0.75,
      debugging: 0.75,
      architecture: 0.7,
    },
    maxConcurrent: 2,
    enabled: true,
  },
  // Vibe emits "vibe --resume {session_id}" on exit (session_exit.py:21).
  // Critical: Vibe has NO `/quit` slash command — only `/exit`.
  resume: {
    kind: "session-id",
    args: (sessionId: string) => ["--resume", sessionId],
    quitCommand: "/exit",
    sessionIdPattern: "vibe --resume ([\\w-]+)",
  },
  help: {
    args: [],
  },
  authCheck: {
    // Vibe writes credentials via `--setup` to ~/.vibe/.env and stores main
    // config in ~/.vibe/config.toml. MISTRAL_API_KEY is the canonical env var
    // (DEFAULT_MISTRAL_API_ENV_KEY in vibe/core/config/_settings.py).
    configPathsAll: [".vibe/.env", ".vibe/config.toml"],
    envVar: "MISTRAL_API_KEY",
  },
  prerequisites: [
    {
      tool: "vibe",
      label: "Mistral Vibe",
      versionArgs: ["--version"],
      severity: "fatal",
      installUrl: "https://github.com/mistralai/mistral-vibe",
    },
  ],
  presets: [
    { id: "default", name: "Default" },
    {
      id: "plan",
      name: "Plan",
      args: ["--agent", "plan"],
      description: "Read-only exploration",
    },
    {
      id: "accept-edits",
      name: "Accept edits",
      args: ["--agent", "accept-edits"],
      description: "Auto-approve file edits",
    },
    {
      id: "auto-approve",
      name: "Auto-approve",
      args: ["--agent", "auto-approve"],
      description: "Auto-approve all tools (YOLO)",
      dangerousEnabled: true,
    },
    {
      id: "local-llamacpp",
      name: "Local (llama.cpp)",
      description: "Local Devstral via llama.cpp — configure provider in ~/.vibe/config.toml",
    },
  ],
};
