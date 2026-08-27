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
  // Captured from a live `agy` 1.1.22 session (see
  // `scripts/pattern-discovery/corpus/antigravity_sample.jsonl`), not inferred.
  //
  // Scope check before you tune these: for agent terminals (which all run
  // `simpleOutputState`) the working banks carry far less weight than they
  // look like they do. `ActivityMonitor` skips `detectPatternsFromData` for
  // any chunk `isStatusLineRewrite` accepts — which is every braille spinner
  // repaint — and the simple-output polling branch returns before
  // `detectFromLines`. Spinner liveness is already carried by the indicator
  // path (`lastStatusRewriteAt` → the temperature model). Replaying a real
  // capture with these banks emptied produces the same FSM transitions within
  // ~1.5s. They are here because they are correct and verified — an empty
  // array silently means "universal fallthrough", not "opt out" — and because
  // boot/prompt/hint detection below genuinely is load-bearing. Do not expect
  // the working banks alone to move agent state.
  //
  // Working is keyed on the braille status line — `<glyph>  <text>`, cycling
  // ⣷⣯⣟⡿⢿⣻⣽⣾ — and deliberately NOT on the `esc to cancel` footer. Antigravity
  // keeps that footer up while it blocks on an approval prompt, so a footer-
  // keyed working signal would pin a terminal that is actually waiting on the
  // user in `working` forever. The spinner is the honest discriminator: it is
  // absent in every approval frame and every idle frame.
  //
  // Why the universal set misses this agent: its glyph+hint primary wants the
  // interrupt hint on the SAME line as the status glyph (Gemini's
  // `⠼ Thinking (esc to cancel, 14s)`), and Antigravity puts the hint in a
  // separate footer bar. The other two universal primaries key on the hint
  // alone, but require it near end-of-line or closing a paren — Antigravity's
  // footer pads `esc to cancel` out to a right-aligned `Gemini 3.7 Flash · high`
  // with no paren, so the tail shape misses too. That leaves only the universal
  // fallback, which matches solely when the status text starts with a known
  // verb; the text is usually a live thought summary (`⣟  Initial
  // interpretation suggests …`), so it usually did not.
  detection: {
    primaryPatterns: [
      // Observed spinner cycle + the literal two-space gap agy renders before
      // the status text. Spaces are literal, not `\s`: `\s` matches newlines
      // and tabs, and `detectFromLines` rescans visible rows joined with no
      // separator, so a `\s`-gap could be manufactured across a row boundary.
      "[⣷⣯⣟⡿⢿⣻⣽⣾] {2}\\S",
    ],
    fallbackPatterns: [
      // Any non-blank braille glyph in the same shape, so a spinner reskin
      // between releases still reads as working. U+2800 (BRAILLE PATTERN
      // BLANK) is excluded — it renders as whitespace and would match padding.
      "[⠁-⣿] {2}\\S",
    ],
    // `? for shortcuts` is the idle footer, absent during boot and during the
    // folder-trust prompt, so it marks genuinely-ready-for-input. It is not the
    // only way boot can exit — a trust prompt trips the prompt-hint path first,
    // which is the desirable outcome (the agent really is awaiting input).
    //
    // Footer-derived patterns are the softest part of this config: `/statusline`
    // lets a user replace the built-in footer entirely ("Statusline off. Run
    // /statusline to re-enable"). Such a terminal loses `? for shortcuts` and
    // falls back to the boot timeout and the silence path, which is a graceful
    // degradation rather than a wrong state.
    bootCompletePatterns: ["\\?\\s+for\\s+shortcuts"],
    // The bare `>` input line. Anchored empty on purpose: `>` also prefixes the
    // selected row of every menu (`> 1. Yes`) and the echoed user turn (`> hi`),
    // and neither of those means the agent is waiting for a new prompt.
    promptPatterns: ["^\\s*>\\s*$", "\\?\\s+for\\s+shortcuts"],
    // Approval shapes. `↑/↓ Navigate` is common to all three (folder trust,
    // command permission, file edit); the rest name the specific question so
    // `waitingReason` can distinguish approval from ordinary prompt waiting.
    promptHintPatterns: [
      "↑/↓\\s+Navigate",
      "Do you want to proceed\\?",
      "Accept this file edit\\?",
      "Do you trust the contents of this project\\?",
      "Requesting permission for:",
      "shift\\+tab to auto-approve",
    ],
    // Intentionally empty, and empty here means "no such output exists" rather
    // than "not yet tuned": agy prints no completion banner. A turn ends by the
    // spinner clearing and the prompt box plus `? for shortcuts` returning, so
    // the agent settles into `waiting` and never into `completed`. That is the
    // accurate FSM result, and `waiting` is already a terminal state for
    // `terminal.awaitAll` and `terminal.extract`.
    completionPatterns: [],
    scanLineCount: 10,
    primaryConfidence: 0.95,
    fallbackConfidence: 0.7,
    promptConfidence: 0.85,
    // No `titleStatePatterns`: across both captures agy emitted only OSC 8
    // hyperlinks and no OSC 0/1/2 title sequence, so there is no title glyph to
    // key state on. "By default" is the honest qualifier — the binary carries a
    // `/title` toggle ("Toggle custom terminal window title"), off unless the
    // user turns it on. If that ever ships on by default, revisit this.
  },
  // `sessionIdPattern` restored from real captured output. #11851 recorded 0
  // captures in 6 teardowns because the old pattern separated the flag and the
  // id with a SPACE; agy actually prints an equals sign. A live 1.1.22 teardown
  // ends with:
  //
  //   Resume with -c (or command below):
  //   agy --conversation=b0bced34-800c-4859-aaae-81d5f961c0f7
  //
  // The `=` is what the old pattern could never match. `args` keeps the space
  // form because the CLI accepts both, and `-c` remains the latest-restore path.
  resume: {
    kind: "session-id",
    args: (sessionId: string) => ["--conversation", sessionId],
    quitCommand: "/quit",
    resumeLatestArgs: ["-c"],
    sessionIdPattern: "agy --conversation=([\\w-]+)",
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
