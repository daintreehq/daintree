import type { AgentConfig } from "../agentRegistry.js";
import { standardConfigLocations } from "./completionSourceHelpers.js";

export const config: AgentConfig = {
  id: "gemini",
  name: "Gemini",
  command: "gemini",
  npmGlobalPackage: "@google/gemini-cli",
  color: "#4285F4",
  iconId: "gemini",
  supportsContextInjection: true,
  // Marked `"deprecated"`: Gemini is excluded from the assistant overlay
  // (picker and help-session launch path) following the Antigravity
  // migration (#8808, #8811), but still launches normally from the main
  // toolbar. The wiring shape below is retained for historical reference —
  // the help-session overlay that consumed it (`.gemini/settings.json` MCP
  // injection, `--approval-mode=plan`) has been removed from
  // `HelpSessionService`.
  supports: {
    mcpInjection: "project-config",
    settingsOverlay: true,
    permissionBypass: false,
    trustDialog: true,
    versionProbe: true,
    tier: "deprecated",
  },
  shortcut: "Cmd/Ctrl+Alt+G",
  // Gemini CLI for consumer accounts (free, AI Pro, AI Ultra) is being
  // discontinued on 2026-06-18 in favour of Antigravity (`agy`). Enterprise
  // Gemini Code Assist keeps Gemini CLI. See issue #8808 and the
  // `antigravity` entry for the consumer successor.
  tooltip: "Google's CLI",
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
      "[⠀-⣿]\\s+[^()\\n]{2,80}\\s*\\(esc to cancel",
      "esc to cancel(?:[^)\\n]{0,20}\\)?|[^)\\n]{0,60}\\))$",
      "\\(\\d+s,?\\s*esc to cancel",
      // @generated:gemini:primaryPatterns:end
    ],
    fallbackPatterns: [
      // @generated:gemini:fallbackPatterns:start
      "[⠀-⣿]\\s+\\w",
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
    titleStatePatterns: {
      working: ["✦"],
      waiting: ["◇", "✋"],
    },
  },
  resume: {
    kind: "session-id",
    args: (sessionId: string) => ["--resume", sessionId],
    quitCommand: "/quit",
    sessionIdPattern: "gemini --resume ([\\w-]+)",
    // `latest` is required — bare `-r` opens an interactive picker that blocks the PTY.
    resumeLatestArgs: ["-r", "latest"],
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
  completionSources: [
    {
      id: "builtin",
      trigger: "/",
      sourcePrecedence: 0,
      discovery: { method: "static", catalog: "builtin-slash-commands" },
    },
    {
      id: "commands",
      trigger: "/",
      sourcePrecedence: 10,
      discovery: {
        method: "directory",
        parser: "toml",
        derive: { labelPrefix: "/", kind: "command", fallbackDescription: "Custom command" },
        locations: standardConfigLocations({
          dotDir: ".gemini",
          sub: "commands",
          configDirEnv: "GEMINI_CONFIG_DIR",
          lowerName: "gemini",
          appName: "Gemini",
        }),
      },
    },
  ],
};
