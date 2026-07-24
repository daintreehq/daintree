import type { AgentConfig } from "../agentRegistry.js";

export const config: AgentConfig = {
  id: "grok",
  name: "Grok",
  command: "grok",
  // xAI's installer (`curl -fsSL https://x.ai/cli/install.sh | bash`) places the
  // launcher at ~/.local/bin/grok on macOS/Linux. Probe it directly so users
  // who installed via the script aren't mis-reported as "missing" when
  // ~/.local/bin isn't inherited by the Electron process PATH.
  nativePaths: ["~/.local/bin/grok"],
  // xAI's brand mark is monochrome; tint it near-white so it reads on the dark
  // UI like the other agents' accent hues.
  color: "#E8E8E8",
  iconId: "grok",
  supportsContextInjection: true,
  // #11282 phase 5: Grok resumes by session id, but its `sessionIdPattern` is
  // still provisional (see `resume` below), so capture on exit — and thus
  // resume after a move — isn't verified yet.
  continuity: {
    tier: "unverified",
    detail: "Resuming this conversation after a move isn't confirmed for Grok yet",
  },
  // Launch-only for now. Grok Build reads project MCP config + AGENTS.md, so
  // assistant-overlay wiring (`supports: { mcpInjection: "project-config", … }`)
  // is plausible, but the exact injection format needs verification before it's
  // enabled — left unwired so Grok still launches normally from the toolbar.
  tooltip: "xAI's CLI",
  usageUrl: "https://console.x.ai",
  externalLinks: [
    { label: "View docs", url: "https://docs.x.ai/build/overview" },
    { label: "View usage", url: "https://console.x.ai" },
  ],
  version: {
    args: ["--version"],
  },
  // No `update` entry: Grok Build is a self-updating managed binary (`grok
  // update`, with stable/alpha channels), so Daintree doesn't drive its
  // upgrade. The AgentUpdateHandler priority list has no self-update key, so a
  // declared command wouldn't be selectable by the default path anyway.
  install: {
    docsUrl: "https://docs.x.ai/build/overview",
    byOs: {
      macos: [
        {
          label: "Install script",
          commands: ["curl -fsSL https://x.ai/cli/install.sh | bash"],
        },
      ],
      linux: [
        {
          label: "Install script",
          commands: ["curl -fsSL https://x.ai/cli/install.sh | bash"],
        },
      ],
      windows: [
        {
          label: "PowerShell",
          commands: ["irm https://x.ai/cli/install.ps1 | iex"],
        },
      ],
    },
    troubleshooting: [
      "Restart Daintree after installation to update PATH",
      "Verify installation with: grok --version",
      "Sign in on first launch (browser OAuth), or set XAI_API_KEY for headless use",
    ],
  },
  // Model IDs are the CLI's own aliases (from `grok models`), which differ from
  // the public xAI API IDs — these are what the `-m`/`--model` flag accepts.
  models: [
    { id: "grok-build", name: "Grok Build", shortLabel: "Build" },
    { id: "grok-composer-2.5-fast", name: "Composer 2.5 Fast", shortLabel: "Composer" },
  ],
  // The CLI's default model (no `-m`) is grok-composer-2.5-fast at 200k; the
  // larger grok-build (512k) is opt-in via the model picker. Use the
  // conservative value so the high-context-usage warning isn't suppressed on a
  // default launch.
  contextWindow: 200_000,
  capabilities: {
    scrollback: 10000,
    resizeStrategy: "default",
    // Rust TUI that would otherwise take over the alternate screen. Default it
    // inline (`--no-alt-screen`) so output flows into Daintree's own WebGL
    // scrollback and stays selectable with the native text-selection layer
    // instead of grok's mouse-grabbing full-screen TUI. No `defaultInlineMode`
    // override: inline follows the global "Use alt-screen mode by default"
    // switch (off ⇒ inline), so users can still flip back globally or per-agent.
    //
    // Two axes: `--no-alt-screen` / `[terminal] alt_screen` pick the buffer,
    // `--minimal` / `[ui] screen_mode` trim the chrome. Both polarities need an
    // explicit flag here because grok also goes inline on its own whenever
    // `~/.grok/config.toml` or terminal auto-detection says so, which made "Alt
    // screen" a no-op when it merely omitted the inline flag (#11423).
    //
    // `--fullscreen` is the chrome-axis opposite of `--minimal`. Per `grok --help`
    // (0.2.111) it is session-scoped — never writes config — but it overrides only
    // `[ui] screen_mode = "minimal"`; the buffer still follows `[terminal]
    // alt_screen` and auto-detection, so someone who set `alt_screen = false`
    // stays inline even on "Alt screen". Collapsing both axes onto one flag pair
    // is a deliberate simplification; older builds may not accept `--fullscreen`,
    // and only users who actively pick "Alt screen" are exposed.
    inlineModeFlag: "--no-alt-screen",
    altScreenFlag: "--fullscreen",
    supportsBracketedPaste: true,
    // Rust TUI reads the PTY buffer atomically, so the quit-command body and
    // Enter must be sent as separate writes (same rationale as Codex).
    quitSubmitMode: "split-write",
  },
  // `detection` is intentionally omitted. Grok Build's working-state TUI strings
  // haven't been calibrated against live output yet, so it falls back to the
  // broad UNIVERSAL_PATTERN_CONFIG (a superset of every agent's "esc to
  // interrupt"/spinner patterns) plus the universal approval-prompt hints — a
  // safer default than shipping speculative narrow regex. Calibrate later by
  // observing real scrollback (scripts/pattern-discovery has the capture tooling).
  resume: {
    kind: "session-id",
    args: (sessionId: string) => ["--resume", sessionId],
    quitCommand: "/quit",
    // Provisional — confirm against Grok's real on-exit output. `resumeLatestArgs`
    // (`--continue`, scoped to the launch CWD) covers the case where capture misses.
    sessionIdPattern: "grok --resume ([\\w-]+)",
    resumeLatestArgs: ["--continue"],
  },
  help: {
    args: [],
  },
  authCheck: {
    // Grok Build persists OAuth credentials to ~/.grok/auth.json after the
    // first-run browser sign-in; XAI_API_KEY is the headless fallback.
    configPathsAll: [".grok/auth.json"],
    envVar: "XAI_API_KEY",
  },
  prerequisites: [
    {
      tool: "grok",
      label: "Grok Build CLI",
      versionArgs: ["--version"],
      severity: "fatal",
      installUrl: "https://docs.x.ai/build/overview",
    },
  ],
  envSuggestions: [{ key: "XAI_API_KEY", hint: "xAI API key (xai-…) for headless auth" }],
};
