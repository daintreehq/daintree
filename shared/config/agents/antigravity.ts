import type { AgentConfig } from "../agentRegistry.js";

export const config: AgentConfig = {
  id: "antigravity",
  name: "Antigravity",
  command: "agy",
  color: "#4285F4",
  iconId: "antigravity",
  supportsContextInjection: true,
  // Antigravity's HelpSession wiring (workspace settings overlay, MCP
  // injection key, plan/read-only approval flag) requires investigation
  // against a running `agy` install before it can ship. Leave `supports`
  // undefined per the AssistantSupports docs — that excludes the agent
  // from both `getAssistantSupportedAgentIds()` and
  // `getAssistantWiredAgentIds()` until the overlay path is verified.
  shortcut: "Cmd/Ctrl+Alt+A",
  tooltip: "Google's agy — Gemini CLI successor",
  version: {
    args: ["--version"],
  },
  install: {
    docsUrl:
      "https://developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli/",
    troubleshooting: [
      "Restart Daintree after installation to update PATH",
      "Verify installation with: agy --version",
    ],
  },
  capabilities: {
    scrollback: 10000,
    blockAltScreen: true,
    blockMouseReporting: true,
    resizeStrategy: "settled",
    supportsBracketedPaste: false,
    softNewlineSequence: "\x1b\r",
    ignoredInputSequences: ["\x1b\r"],
  },
  // Detection patterns require live observation of `agy` v1.0.1 — the TUI
  // glyphs (working / waiting), boot ready marker, prompt shape, and
  // completion strings can't be inferred from code. Shipping empty
  // primaryPatterns is safer than copying Gemini's: the state machine
  // simply doesn't mis-classify rather than firing on the wrong glyphs.
  // Track follow-up via a dedicated detection-tuning issue.
  detection: {
    primaryPatterns: [],
    fallbackPatterns: [],
    bootCompletePatterns: [],
    promptPatterns: [],
    promptHintPatterns: [],
    completionPatterns: [],
  },
  resume: {
    kind: "session-id",
    args: (sessionId: string) => ["--conversation", sessionId],
    quitCommand: "/quit",
    sessionIdPattern: "agy --conversation ([\\w-]+)",
    resumeLatestArgs: ["-c"],
  },
  help: {
    args: [],
  },
  // The exact credential filename under `~/.antigravity/` isn't documented
  // yet — `oauth_creds.json` mirrors the Gemini CLI's layout and is the
  // most likely location given `agy` is the Gemini CLI successor. The
  // env var fallback (`GOOGLE_API_KEY`) is a strong signal regardless of
  // file path. Worst case the file probe misses and we rely on the env
  // signal; the auth check never gates launch.
  authCheck: {
    configPathsAll: [".antigravity/oauth_creds.json"],
    envVar: "GOOGLE_API_KEY",
  },
  prerequisites: [
    {
      tool: "agy",
      label: "Antigravity CLI",
      versionArgs: ["--version"],
      severity: "fatal",
      installUrl:
        "https://developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli/",
    },
  ],
};
