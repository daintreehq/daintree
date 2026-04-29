import type { AgentConfig } from "../agentRegistry.js";

export const config: AgentConfig = {
  id: "crush",
  name: "Crush",
  command: "crush",
  // `go install github.com/charmbracelet/crush@latest` lands the binary at
  // ~/go/bin/crush, which is not on PATH for sandboxed Electron processes.
  // Homebrew (charmbracelet/tap/crush) installs to a brew-managed prefix
  // already covered by getUnixFallbackPaths. No native Windows installer.
  nativePaths: ["~/go/bin/crush"],
  color: "#E864A4",
  iconId: "crush",
  supportsContextInjection: true,
  tooltip: "Charm's Bubble Tea TUI agent",
  usageUrl: "https://github.com/charmbracelet/crush",
  version: {
    args: ["--version"],
    githubRepo: "charmbracelet/crush",
    releaseNotesUrl: "https://github.com/charmbracelet/crush/releases",
  },
  update: {
    go: "go install github.com/charmbracelet/crush@latest",
    brew: "brew upgrade crush",
  },
  install: {
    docsUrl: "https://github.com/charmbracelet/crush#readme",
    byOs: {
      macos: [
        {
          label: "Homebrew",
          commands: ["brew install charmbracelet/tap/crush"],
        },
        {
          label: "Go",
          commands: ["go install github.com/charmbracelet/crush@latest"],
        },
      ],
      linux: [
        {
          label: "Homebrew",
          commands: ["brew install charmbracelet/tap/crush"],
        },
        {
          label: "Go",
          commands: ["go install github.com/charmbracelet/crush@latest"],
        },
      ],
    },
    troubleshooting: [
      "Restart Daintree after installation to update PATH",
      "Verify installation with: crush --version",
      "If installed via `go install`, ensure ~/go/bin is on PATH",
      "Crush is currently distributed for macOS and Linux only",
      "Configure providers via the Catwalk catalog inside Crush",
    ],
  },
  packages: {
    go: "github.com/charmbracelet/crush",
    brew: "charmbracelet/tap/crush",
  },
  capabilities: {
    scrollback: 10000,
    // Crush is a Bubble Tea full-screen TUI — alt-screen MUST stay enabled
    // for the UI to render. Do NOT set `blockAltScreen: true` (see
    // shared/config/__tests__/agentRegistry.test.ts:636 for the opencode
    // precedent and lessons #3417 on Bubble Tea agents).
    blockMouseReporting: true,
    resizeStrategy: "settled",
    supportsBracketedPaste: true,
    softNewlineSequence: "\n",
    ignoredInputSequences: ["\n", "\x1b\r"],
  },
  env: {
    // Suppress Crush's startup provider-catalog auto-update so launches stay
    // deterministic across worktrees and don't race against network state.
    CRUSH_DISABLE_PROVIDER_AUTO_UPDATE: "1",
  },
  envSuggestions: [
    {
      key: "CRUSH_DISABLE_PROVIDER_AUTO_UPDATE",
      hint: "Set to 1 to skip Catwalk provider catalog auto-updates on launch.",
    },
    {
      key: "CRUSH_DISABLE_METRICS",
      hint: "Set to 1 to disable Charm telemetry reporting.",
    },
    {
      key: "CRUSH_SKILLS_DIR",
      hint: "Override the directory Crush loads custom skills from.",
    },
  ],
  detection: {
    primaryPatterns: [
      // Bubble Tea Mini spinner frames followed by a status string
      "[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\\s+\\w",
      // Generic working hints that may appear without a spinner frame
      "thinking[…\\.]+",
      "generating",
      "running tool",
    ],
    fallbackPatterns: ["[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\\s", "working[…\\.]+"],
    bootCompletePatterns: ["Remember your first Crush\\?", "Type a message"],
    promptPatterns: ["^\\s*❯\\s*", "^\\s*>\\s*"],
    promptHintPatterns: ["^\\s*❯\\s*$"],
    completionPatterns: ["Task\\s+completed", "\\$\\d+\\.\\d+\\s+·\\s+\\d+\\s+tokens"],
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
    maxConcurrent: 2,
    enabled: true,
  },
  // Crush has no `/quit` command and Ctrl+C triggers a confirmation dialog,
  // so we omit `resume` and let the PTY host kill the process on shutdown.
  // The `--continue` flag is not part of Crush's stable CLI surface; if/when
  // it ships, switch to `kind: "project-scoped"` with `args: () => ["--continue"]`.
  authCheck: {
    // Crush stores provider credentials under the standard XDG config tree.
    // Catwalk-managed providers also accept env vars (ANTHROPIC_API_KEY etc.)
    // as a sufficient auth signal, mirroring opencode.
    configPathsAll: [".config/crush/crush.json"],
    envVar: ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_API_KEY"],
  },
  prerequisites: [
    {
      tool: "crush",
      label: "Crush CLI",
      versionArgs: ["--version"],
      severity: "fatal",
      installUrl: "https://github.com/charmbracelet/crush",
    },
  ],
};
