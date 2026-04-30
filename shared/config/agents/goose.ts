import type { AgentConfig } from "../agentRegistry.js";

export const config: AgentConfig = {
  id: "goose",
  name: "Goose",
  command: "goose",
  args: ["session"],
  // Goose's curl installer drops the binary at ~/.local/bin/goose on POSIX.
  // The PS1 installer (download_cli.ps1) defaults GOOSE_BIN_DIR to
  // $env:USERPROFILE\.local\bin so the binary lands at
  // %USERPROFILE%\.local\bin\goose.exe on Windows.
  nativePaths: ["~/.local/bin/goose", "%USERPROFILE%\\.local\\bin\\goose.exe"],
  color: "#1c1c1c",
  iconId: "goose",
  supportsContextInjection: true,
  tooltip: "provider-agnostic, by Block Inc.",
  usageUrl: "https://block.github.io/goose/",
  version: {
    args: ["--version"],
    githubRepo: "block/goose",
    releaseNotesUrl: "https://github.com/block/goose/releases",
  },
  update: {
    brew: "brew upgrade block-goose-cli",
    curl: "curl -fsSL https://github.com/block/goose/releases/download/stable/download_cli.sh | bash",
  },
  packages: {
    brew: "block-goose-cli",
  },
  install: {
    docsUrl: "https://block.github.io/goose/docs/getting-started/installation",
    byOs: {
      macos: [
        {
          label: "curl",
          commands: [
            "curl -fsSL https://github.com/block/goose/releases/download/stable/download_cli.sh | bash",
          ],
        },
        {
          label: "Homebrew",
          commands: ["brew install block-goose-cli"],
        },
      ],
      linux: [
        {
          label: "curl",
          commands: [
            "curl -fsSL https://github.com/block/goose/releases/download/stable/download_cli.sh | bash",
          ],
        },
        {
          label: "Homebrew",
          commands: ["brew install block-goose-cli"],
        },
      ],
      windows: [
        {
          label: "PowerShell",
          commands: [
            "irm https://raw.githubusercontent.com/block/goose/main/download_cli.ps1 | iex",
          ],
        },
      ],
    },
    troubleshooting: [
      "Restart Daintree after installation to update PATH",
      "Verify installation with: goose --version",
      "Run 'goose configure' to set provider, model, and credentials",
      "Provider env vars (GOOSE_PROVIDER, GOOSE_MODEL, OPENAI_API_KEY, ANTHROPIC_API_KEY, GOOGLE_API_KEY) take precedence over the on-disk config.",
    ],
  },
  capabilities: {
    scrollback: 10000,
    blockAltScreen: false,
    supportsBracketedPaste: true,
    softNewlineSequence: "\n",
    ignoredInputSequences: ["\n", "\x1b\r"],
  },
  detection: {
    primaryPatterns: [
      // Stable hint emitted by goose-cli on every "working" line; see
      // crates/goose-cli/src/session/thinking.rs upstream.
      "\\(Ctrl\\+C to interrupt\\)",
    ],
    fallbackPatterns: [
      // cliclack braille spinner frames — distinct from Bubble Tea (OpenCode)
      // and Ink (Gemini); copy-pasting between agents is a known footgun (#3941).
      "[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\\s+\\w",
      // Tool-call activity marker (U+25B8 BLACK RIGHT-POINTING SMALL TRIANGLE).
      "▸\\s+\\S",
    ],
    bootCompletePatterns: ["goose is ready"],
    promptPatterns: ["^🪿\\s"],
    promptHintPatterns: ["^🪿\\s"],
    // Goose prints "● session closed · <id>" at graceful exit (U+25CF marker);
    // see crates/goose-cli/src/session/output.rs upstream. Anchored to start of
    // line so unrelated logs that mention "session closed" mid-sentence
    // (e.g. "The websocket session closed unexpectedly") don't trigger the
    // brief completion transition.
    completionPatterns: ["^\\s*●?\\s*session closed"],
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
  resume: {
    kind: "session-id",
    args: (sessionId: string) => ["session", "--resume", "--session-id", sessionId],
    quitCommand: "/exit",
    sessionIdPattern: "session closed\\s*·\\s*([\\w-]+)",
  },
  authCheck: {
    configPaths: {
      // macOS uses Application Support, NOT ~/.config (#6132 source-verified).
      darwin: ["Library/Application Support/Block/goose/config.yaml"],
      linux: [".config/goose/config.yaml"],
      win32: ["AppData/Roaming/Block/goose/config/config.yaml"],
    },
    envVar: ["GOOSE_PROVIDER", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_API_KEY"],
  },
  prerequisites: [
    {
      tool: "goose",
      label: "Goose CLI",
      versionArgs: ["--version"],
      severity: "fatal",
      installUrl: "https://block.github.io/goose/docs/getting-started/installation",
    },
  ],
};
