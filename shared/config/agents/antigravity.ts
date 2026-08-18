import type { AgentConfig } from "../agentRegistry.js";

export const config: AgentConfig = {
  id: "antigravity",
  name: "Antigravity",
  command: "agy",
  color: "#4285F4",
  iconId: "antigravity",
  supportsContextInjection: true,
  // #11282 phase 5: Daintree resumes Antigravity via `--conversation <id>` (not
  // the path-scoped `-c` shorthand), but whether that id survives a folder move
  // isn't confirmed — stay honest rather than overclaim.
  continuity: {
    tier: "unverified",
    detail: "Resuming this conversation after a move isn't confirmed",
  },
  // Antigravity's HelpSession wiring (workspace settings overlay, MCP
  // injection key, plan/read-only approval flag) requires investigation
  // against a running `agy` install before it can ship. Leave `supports`
  // undefined per the AssistantSupports docs — that excludes the agent
  // from both `getAssistantSupportedAgentIds()` and
  // `getAssistantWiredAgentIds()` until the overlay path is verified.
  shortcut: "Cmd/Ctrl+Alt+A",
  tooltip: "Google's CLI",
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
  // completion strings can't be inferred from code. Note: empty arrays are
  // fallthrough, not opt-out — empty primaryPatterns makes buildPatternConfig
  // return undefined so the universal pattern set applies, and empty
  // bootCompletePatterns falls back to BootDetector's built-in banners.
  // Opt-out semantics are #9873's scope. Track pattern follow-up via a
  // dedicated detection-tuning issue.
  detection: {
    primaryPatterns: [],
    fallbackPatterns: [],
    bootCompletePatterns: [],
    promptPatterns: [],
    promptHintPatterns: [],
    completionPatterns: [],
  },
  // No `sessionIdPattern`: the `agy --conversation <id>` hint this tree used to
  // scrape for has never matched real output — 0 captures in 6 teardowns
  // (#11851) — and there is no public `agy` output to verify a corrected one
  // against. Claiming a pattern that cannot match is worse than claiming none:
  // it spends the whole shutdown budget matching nothing and then reports
  // `exited-no-match`, which reads as a broken regex rather than as an agent
  // whose id was never observable. `--conversation <id>` stays as `args` so a
  // stored id still resumes exactly, and `-c` remains the working restore path.
  // Restore this pattern only alongside real captured `agy` output.
  resume: {
    kind: "session-id",
    args: (sessionId: string) => ["--conversation", sessionId],
    quitCommand: "/quit",
    resumeLatestArgs: ["-c"],
  },
  help: {
    args: [],
  },
  // The `agy` CLI inherits credentials from the parent Gemini CLI: on a
  // signed-in machine the authenticated user file is `~/.gemini/oauth_creds.json`
  // (standard Gemini OAuth JSON), with `~/.gemini/google_accounts.json`
  // alongside as the active-account signal — the same paths Gemini CLI
  // probes. The old `~/.antigravity/oauth_creds.json` guess never existed
  // on disk, so authenticated users always read as unauthenticated. (The
  // Antigravity IDE stores its own OAuth state in a SQLite db under
  // ~/Library/Application Support — secondary, since Daintree launches the
  // CLI, not the IDE, and a `.vscdb` file needs a probe strategy beyond
  // `fs.access`.) The `GOOGLE_API_KEY` env var fallback remains valid.
  authCheck: {
    configPathsAll: [".gemini/oauth_creds.json", ".gemini/google_accounts.json"],
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
