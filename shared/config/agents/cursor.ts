import type { AgentConfig } from "../agentRegistry.js";

export const config: AgentConfig = {
  id: "cursor",
  name: "Cursor",
  command: "cursor-agent",
  // Cursor's curl installer (https://cursor.com/install) places the binary
  // at ~/.local/bin/cursor-agent on macOS/Linux. macOS users who have only
  // the Cursor.app GUI get the CLI sidecar inside the app bundle.
  nativePaths: [
    "~/.local/bin/cursor-agent",
    "/Applications/Cursor.app/Contents/Resources/app/bin/cursor-agent",
  ],
  color: "#3ee6eb",
  iconId: "cursor",
  supportsContextInjection: true,
  tooltip: "Cursor's agentic CLI",
  version: {
    args: ["-v"],
  },
  update: {
    curl: "curl https://cursor.com/install -fsS | bash",
  },
  install: {
    docsUrl: "https://cursor.com/features/cursor-agent",
    byOs: {
      macos: [
        {
          label: "curl",
          commands: ["curl https://cursor.com/install -fsS | bash"],
        },
      ],
      linux: [
        {
          label: "curl",
          commands: ["curl https://cursor.com/install -fsS | bash"],
        },
      ],
      windows: [
        {
          label: "PowerShell",
          commands: ["irm 'https://cursor.com/install?win32=true' | iex"],
        },
      ],
    },
    troubleshooting: [
      "Restart Daintree after installation to update PATH",
      "Verify installation with: cursor-agent -v",
      "Run 'cursor-agent login' to authenticate after installing",
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
    primaryPatterns: [
      "⬢\\s*(Thinking|Reading|Planning|Searching|Running|Executing|Grepping|Editing|Listing)",
      "esc to stop",
    ],
    fallbackPatterns: ["⬢\\s*\\w"],
    bootCompletePatterns: ["Cursor Agent", "Welcome to Cursor Agent"],
    promptPatterns: ["^→\\s*$", "^→\\s"],
    promptHintPatterns: ["→\\s+Add a follow-up"],
    completionPatterns: [
      "⬢\\s*(Thought|Read|Planned|Searched|Ran|Edited|Grepped|Listed)(?=[^a-zA-Z]|$)",
    ],
    completionConfidence: 0.9,
    scanLineCount: 10,
    primaryConfidence: 0.95,
    fallbackConfidence: 0.7,
    promptConfidence: 0.85,
    debounceMs: 4000,
    promptFastPathMinQuietMs: 700,
  },
  routing: {
    capabilities: ["javascript", "typescript", "python", "react", "node", "general-purpose"],
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
  authCheck: {
    // Cursor may store tokens in OS Keychain on newer versions; file check
    // is best-effort. Misses leave `authConfirmed: false` so the Settings
    // auth nudge surfaces, but do not block launch.
    configPaths: {
      darwin: ["Library/Application Support/Cursor/User/globalStorage/storage.json"],
      linux: [".config/Cursor/User/globalStorage/storage.json"],
      win32: ["AppData/Roaming/Cursor/User/globalStorage/storage.json"],
    },
  },
  prerequisites: [
    {
      tool: "cursor-agent",
      label: "Cursor Agent CLI",
      versionArgs: ["-v"],
      severity: "fatal",
      installUrl: "https://cursor.com/install",
    },
  ],
};
