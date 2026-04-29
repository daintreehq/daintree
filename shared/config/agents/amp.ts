import type { AgentConfig } from "../agentRegistry.js";

export const config: AgentConfig = {
  id: "amp",
  name: "Amp",
  command: "amp",
  color: "#F34E3F",
  iconId: "amp",
  supportsContextInjection: true,
  tooltip: "Sourcegraph's agentic coding tool",
  usageUrl: "https://ampcode.com/",
  packages: {
    npm: "@sourcegraph/amp",
  },
  // The native installer drops the binary at ~/.amp/bin/amp and symlinks
  // ~/.local/bin/amp. Probe both — the symlink may not be on PATH for
  // GUI-launched Electron processes.
  nativePaths: ["~/.amp/bin/amp", "~/.local/bin/amp"],
  // Amp has no native Windows binary today. Setting supportsWsl makes WSL
  // installations surface in availability diagnostics; npm install also works
  // on Windows directly.
  supportsWsl: true,
  version: {
    args: ["--version"],
    npmPackage: "@sourcegraph/amp",
  },
  update: {
    curl: "curl -fsSL https://ampcode.com/install.sh | bash",
    npm: "npm install -g @sourcegraph/amp@latest",
  },
  install: {
    docsUrl: "https://ampcode.com/manual",
    byOs: {
      macos: [
        {
          label: "curl",
          commands: ["curl -fsSL https://ampcode.com/install.sh | bash"],
        },
        {
          label: "npm",
          commands: ["npm install -g @sourcegraph/amp"],
        },
      ],
      linux: [
        {
          label: "curl",
          commands: ["curl -fsSL https://ampcode.com/install.sh | bash"],
        },
        {
          label: "npm",
          commands: ["npm install -g @sourcegraph/amp"],
        },
      ],
      windows: [
        {
          label: "npm",
          commands: ["npm install -g @sourcegraph/amp"],
          notes: ["Native Windows binary is not published — npm or WSL is required"],
        },
      ],
    },
    troubleshooting: [
      "Restart Daintree after installation to update PATH",
      "Verify installation with: amp --version",
      "Run 'amp login' to authenticate, or set AMP_API_KEY for headless use",
      "Amp is a paid product — an active ampcode.com account is required",
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
    // Amp ships with empty primary/fallback patterns until on-device PTY
    // capture confirms the actual spinner glyphs and working strings emitted
    // by the Ink TUI. Speculative patterns risk wrong-Unicode regressions
    // (see #3941). Boot/prompt patterns are conservative and self-validating.
    primaryPatterns: [
      // @generated:amp:primaryPatterns:start
      // @generated:amp:primaryPatterns:end
    ],
    fallbackPatterns: [
      // @generated:amp:fallbackPatterns:start
      // @generated:amp:fallbackPatterns:end
    ],
    bootCompletePatterns: [
      // @generated:amp:bootCompletePatterns:start
      "amp\\s+v?\\d",
      // @generated:amp:bootCompletePatterns:end
    ],
    // Anchor-bound to avoid matching `> npm test` or other tool-result
    // chevrons; mirrors Copilot, the closest-prompt analog.
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
      "debugging",
      "refactoring",
      "code-review",
      "architecture",
      "general-purpose",
    ],
    domains: {
      frontend: 0.85,
      backend: 0.85,
      testing: 0.8,
      refactoring: 0.9,
      debugging: 0.9,
      architecture: 0.85,
    },
    maxConcurrent: 2,
    enabled: true,
  },
  // Amp resumes a thread by ID via `amp threads continue <id>`. There's no
  // session-ID emission on quit and no slash-quit command — Ctrl+C is the
  // graceful exit signal.
  resume: {
    kind: "named-target",
    argsForTarget: (target: string) => ["threads", "continue", target],
    shutdownKeySequence: "\x03",
  },
  help: {
    args: [],
  },
  authCheck: {
    // `amp login` writes OAuth tokens to ~/.amp/oauth/. Keychain-only
    // installs leave that directory absent — those users get
    // `authConfirmed: false` but remain launchable.
    configPathsAll: [".amp/oauth"],
    envVar: "AMP_API_KEY",
  },
  prerequisites: [
    {
      tool: "amp",
      label: "Amp CLI",
      versionArgs: ["--version"],
      severity: "fatal",
      installUrl: "https://ampcode.com/manual",
    },
  ],
  envSuggestions: [
    { key: "AMP_API_KEY", hint: "Amp API key for headless / CI authentication" },
    { key: "AMP_HOME", hint: "Override Amp install directory (default: ~/.amp)" },
  ],
};
