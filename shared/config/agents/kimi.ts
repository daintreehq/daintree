import type { AgentConfig } from "../agentRegistry.js";

export const config: AgentConfig = {
  id: "kimi",
  name: "Kimi Code",
  command: "kimi",
  args: [],
  color: "#1E90FF",
  iconId: "kimi",
  supportsContextInjection: true,
  tooltip: "Moonshot AI's CLI",
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
    // kimi-cli renders Rich's "moon" spinner (8 moon-phase frames) with empty
    // text during long model-latency stretches; this is the dominant working
    // indicator before any tool or content block renders. See
    // src/kimi_cli/ui/shell/visualize/_live_view.py upstream. The
    // end-of-line alternative handles renderers that drop the trailing space
    // when no text follows the spinner.
    primaryPatterns: ["[🌑🌒🌓🌔🌕🌖🌗🌘](?:\\s|$)"],
    fallbackPatterns: [
      // Rich "dots" braille spinner, used with descriptive text
      // ("Compacting...", "Connecting to MCP servers...", "Thinking...") in
      // _blocks.py. Identical Unicode to the cliclack spinner goose uses —
      // copy-pasting the glyph set between agents is a known footgun (#3941),
      // so this stays fallback-only at 0.75, never primary.
      "[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\\s+[^\\n]{2,80}",
      "[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\\s+\\w",
    ],
    // _print_welcome_info (src/kimi_cli/ui/shell/__init__.py) prints this
    // banner line in a Rich Panel before the first spinner frame, so it
    // always precedes the moon spinner. Literal substring — unique in the
    // rendered output and resilient to the ASCII art and version-notice
    // lines that follow. Without this slot, BootDetector falls back to the
    // hardcoded Claude/Codex/Gemini banners and Kimi terminals wait the
    // full POLLING_MAX_BOOT_MS (15s) timeout on every launch.
    bootCompletePatterns: ["Welcome to Kimi Code CLI!"],
    promptPatterns: ["^\\s*(?:✨|💫|📋|\\$)\\s+"],
    promptHintPatterns: ["^\\s*(?:✨|💫|📋|\\$)\\s*$"],
    scanLineCount: 10,
    primaryConfidence: 0.95,
    fallbackConfidence: 0.75,
    promptConfidence: 0.85,
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
