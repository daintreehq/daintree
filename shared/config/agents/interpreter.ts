import type { AgentConfig } from "../agentRegistry.js";

export const config: AgentConfig = {
  id: "interpreter",
  name: "Open Interpreter",
  command: "interpreter",
  color: "#111111",
  iconId: "interpreter",
  supportsContextInjection: true,
  // Not offered to the Daintree assistant. The current product does speak MCP,
  // but that alone isn't a reason to enable it, and no injection path has been
  // verified against it.
  supports: false,
  continuity: {
    tier: "unverified",
    detail: "Open Interpreter resumes by session ID; resuming after a move isn't confirmed",
  },
  tooltip: "Open Interpreter's CLI",
  usageUrl: "https://www.openinterpreter.com/docs/terminal",
  externalLinks: [{ label: "View docs", url: "https://www.openinterpreter.com/docs/terminal" }],
  // The standalone installers drop the binary here; Electron's PATH often
  // misses ~/.local/bin, and the Windows directory is a junction the installer
  // adds to the user PATH only for new shells.
  nativePaths: [
    "~/.local/bin/interpreter",
    "%LOCALAPPDATA%\\Programs\\Open Interpreter\\bin\\interpreter.exe",
  ],
  version: {
    args: ["--version"],
    githubRepo: "openinterpreter/openinterpreter",
    releaseNotesUrl: "https://github.com/openinterpreter/openinterpreter/releases/tag/rust-v{version}",
  },
  install: {
    docsUrl: "https://www.openinterpreter.com/docs/terminal/install",
    byOs: {
      macos: [
        {
          label: "Install script",
          commands: ["curl -fsSL https://www.openinterpreter.com/install | sh"],
        },
      ],
      linux: [
        {
          label: "Install script",
          commands: ["curl -fsSL https://www.openinterpreter.com/install | sh"],
        },
      ],
      windows: [
        {
          label: "PowerShell",
          commands: ["irm https://www.openinterpreter.com/install.ps1 | iex"],
        },
      ],
    },
    troubleshooting: [
      "Restart Daintree after installation to update PATH",
      "Verify installation with: interpreter --version",
      "Run 'interpreter' once to sign in or choose a model provider",
      "Credentials live in ~/.openinterpreter, or in INTERPRETER_HOME when it's set",
      "A 0.4.x version is the legacy Python package, a different program: install the current release with the command above",
    ],
  },
  // `interpreter update` re-runs the standalone installer for this platform
  // (the curl script on macOS and Linux, the PowerShell one on Windows), so one
  // method covers both install routes.
  update: {
    curl: "interpreter update",
  },
  capabilities: {
    scrollback: 10000,
    blockAltScreen: false,
    blockMouseReporting: false,
    resizeStrategy: "default",
    supportsBracketedPaste: false,
    softNewlineSequence: "\n",
    ignoredInputSequences: ["\n", "\x1b\r"],
    // The working line advertises "esc to interrupt" (status_indicator_widget.rs).
    interrupt: "double-escape",
  },
  // Unverified against live PTY output: derived from the upstream source
  // (openinterpreter/openinterpreter a8385667, 0.0.57), not captured. The TUI is
  // a Codex fork, so these are the Codex shapes with Open Interpreter's name.
  detection: {
    // `<spinner> Working (1m 05s • esc to interrupt)`. The header text changes
    // with the turn's reasoning summary and a ` · <note>` can follow, so only
    // the elapsed-time and hint part is matched.
    primaryPatterns: ["\\(\\d+[hms](?: \\d+[ms])*\\s*[•·]\\s*esc to interrupt\\)"],
    // The session header card's title row, `>_ Open Interpreter (v0.0.57)`.
    // "Welcome to Open Interpreter" is onboarding-only, so it isn't used.
    bootCompletePatterns: ["Open Interpreter \\(v\\d+\\.\\d+\\.\\d+"],
    // The composer row, `› Ask Codex to do anything` when empty (the placeholder
    // is inherited unchanged from Codex).
    promptPatterns: ["^\\s*›(?:\\s|$)"],
    scanLineCount: 10,
    primaryConfidence: 0.95,
    promptConfidence: 0.85,
  },
  resume: {
    kind: "session-id",
    args: (sessionId: string) => ["resume", sessionId],
    // On exit it prints "To continue this session, run:" then the command. The
    // exit summary still hardcodes `codex resume <id>` (tui/src/app/exit_summary.rs)
    // even though the binary is `interpreter`, so both names are accepted. A UUID
    // capture keeps the follow-up "Or run codex resume and select <name>." out.
    sessionIdPattern:
      "(?:codex|interpreter) resume ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})",
    // Scoped to the launch directory, and starts fresh when it holds no session
    // (tui/src/lib.rs, `latest_session_cwd_filter`).
    resumeLatestArgs: ["resume", "--last"],
    // No automated quit: Codex's gated Ctrl-C was measured on Codex only, and a
    // slash command typed into a busy composer becomes chat text. The id is
    // still captured when the user quits, and a restore without one falls back
    // to the latest session.
    quitCommand: "",
  },
  authCheck: {
    // Everything lives under ~/.openinterpreter, or INTERPRETER_HOME when set;
    // CODEX_HOME is deliberately ignored (utils/home-dir). `auth.json` is the
    // default file store for a ChatGPT sign-in or a saved API key; the keyring
    // backend keeps an encrypted copy in `secrets/codex_auth.age`, and provider
    // OAuth sign-ins land in `secrets/gateway_oauth.age`. A keyring-only login
    // leaves no file to observe.
    configHome: {
      envVar: "INTERPRETER_HOME",
      defaultDir: ".openinterpreter",
      paths: ["auth.json", "secrets/codex_auth.age", "secrets/gateway_oauth.age"],
    },
    // OpenAI is the built-in default provider. The bundled provider catalog
    // reads around a hundred other keys; these are the common ones.
    envVar: [
      "OPENAI_API_KEY",
      "ANTHROPIC_API_KEY",
      "GEMINI_API_KEY",
      "OPENROUTER_API_KEY",
      "DEEPSEEK_API_KEY",
      "MOONSHOT_API_KEY",
      "ZAI_API_KEY",
      "GROQ_API_KEY",
    ],
  },
  prerequisites: [
    {
      tool: "interpreter",
      label: "Open Interpreter CLI",
      versionArgs: ["--version"],
      severity: "fatal",
      installUrl: "https://www.openinterpreter.com/docs/terminal/install",
    },
  ],
};
