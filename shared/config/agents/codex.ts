import type { AgentConfig } from "../agentRegistry.js";

export const config: AgentConfig = {
  id: "codex",
  name: "Codex",
  command: "codex",
  npmGlobalPackage: "@openai/codex",
  // Codex Windows packaging lags behind Linux — Windows users commonly
  // install via WSL. WSL probing surfaces the availability in diagnostics
  // even when no native Windows binary exists.
  supportsWsl: true,
  color: "#10a37f",
  iconId: "codex",
  supportsContextInjection: true,
  // #11282 phase 5: Codex sessions are UUID-keyed rollout files, resumable from
  // any folder via `codex resume <id>` — a move preserves the conversation.
  continuity: {
    tier: "preserved",
    detail: "Codex can resume this conversation by session ID from any folder",
  },
  supports: {
    mcpInjection: "cli-flags",
    settingsOverlay: false,
    permissionBypass: true,
    trustDialog: false,
    versionProbe: true,
    tier: "stable",
  },
  shortcut: "Cmd/Ctrl+Alt+X",
  tooltip: "OpenAI's CLI",
  usageUrl: "https://chatgpt.com/codex/settings/usage",
  externalLinks: [{ label: "View usage", url: "https://chatgpt.com/codex/settings/usage" }],
  version: {
    args: ["--version"],
    githubRepo: "openai/codex",
    npmPackage: "@openai/codex",
    releaseNotesUrl: "https://github.com/openai/codex/releases/tag/v{version}",
  },
  update: {
    npm: "npm install -g @openai/codex@latest",
  },
  install: {
    docsUrl: "https://github.com/openai/codex",
    byOs: {
      macos: [
        {
          label: "npm",
          commands: ["npm install -g @openai/codex"],
        },
      ],
      windows: [
        {
          label: "npm",
          commands: ["npm install -g @openai/codex"],
        },
      ],
      linux: [
        {
          label: "npm",
          commands: ["npm install -g @openai/codex"],
        },
      ],
    },
    troubleshooting: [
      "Restart Daintree after installation to update PATH",
      "Verify installation with: codex --version",
      "Run 'codex auth login' after installing to authenticate",
    ],
  },
  // Offline fallback for when `codex debug models --bundled` can't be probed.
  // Ordered to match the CLI's own `priority`. Explicit tier slugs, not the
  // bare `gpt-5.6` family alias: the CLI doesn't validate `--model` against an
  // allowlist, so an unlisted slug silently falls back to generic metadata
  // instead of failing loudly.
  models: [
    { id: "gpt-5.6-sol", name: "GPT-5.6 Sol", shortLabel: "Sol" },
    { id: "gpt-5.6-terra", name: "GPT-5.6 Terra", shortLabel: "Terra" },
    { id: "gpt-5.6-luna", name: "GPT-5.6 Luna", shortLabel: "Luna" },
    { id: "gpt-5.5", name: "GPT-5.5", shortLabel: "GPT-5.5" },
  ],
  curatedModels: true,
  contextWindow: 128_000,
  capabilities: {
    scrollback: 10000,
    blockAltScreen: true,
    blockMouseReporting: true,
    resizeStrategy: "settled",
    inlineModeFlag: "--no-alt-screen",
    supportsBracketedPaste: true,
    softNewlineSequence: "\n",
    ignoredInputSequences: ["\n", "\x1b\r"],
  },
  detection: {
    primaryPatterns: [
      // @generated:codex:primaryPatterns:start
      "[•·]\\s+[^()\\n]{2,80}\\s+\\([^)]*esc to interrupt",
      "esc to interrupt(?:[^)\\n]{0,20}\\)?|[^)\\n]{0,60}\\))$",
      "\\(\\d+s\\s*[·•]\\s*esc to interrupt",
      // @generated:codex:primaryPatterns:end
    ],
    fallbackPatterns: [
      // @generated:codex:fallbackPatterns:start
      "[•·]\\s+Working",
      // @generated:codex:fallbackPatterns:end
    ],
    bootCompletePatterns: [
      // @generated:codex:bootCompletePatterns:start
      "openai[-\\s]+codex",
      "codex\\s+v",
      // @generated:codex:bootCompletePatterns:end
    ],
    promptPatterns: ["^\\s*[›❯>]\\s*", "^\\s*codex\\s*>\\s*"],
    promptHintPatterns: ["context\\s+left"],
    completionPatterns: [
      // @generated:codex:completionPatterns:start
      "Task\\s+completed\\s+successfully",
      "\\d+\\s+files?\\s+changed",
      "Created\\s+\\d+\\s+files?",
      // @generated:codex:completionPatterns:end
    ],
    completionConfidence: 0.9,
    scanLineCount: 10,
    primaryConfidence: 0.95,
    fallbackConfidence: 0.75,
    promptConfidence: 0.85,
  },
  resume: {
    kind: "session-id",
    args: (sessionId: string) => ["resume", sessionId],
    sessionIdPattern: "codex resume ([\\w-]+)",
    resumeLatestArgs: ["resume", "--last"],
    // Codex takes a gated Ctrl-C instead of `/quit` (#11851). Writing the slash
    // command left `/quit` sitting in the user's own transcript and in Codex's
    // `/resume` picker: mid-turn the composer queues it as a chat message the
    // model then answers, burning tokens and capturing no id at all (38% over
    // 26 measured teardowns). A modal or the directory-trust prompt swallowed
    // it outright, and every launch is busy for its first 10-30s booting MCP
    // servers. Ctrl-C survives all three because it is not composer text.
    //
    // The footer substring is harvested from the real `codex-cli 0.147.0`
    // binary — deliberately a short fragment rather than the full sentence, so
    // a wording tweak upstream doesn't silently stop matching. 750ms is
    // generous for a footer that redraws within a frame.
    //
    // TWO presses, not three. Two sufficed in every measured state and three
    // produced nothing at all after 12s, so a third can only ever lose. The cap
    // has to carry that on its own because the gate cannot: Ratatui repaints
    // the whole frame, so a repaint emitted while press two is already tearing
    // the TUI down looks identical to a genuine re-arm, and the substring can
    // in principle be satisfied by conversation text too. Raise this only with
    // a measured state where two presses demonstrably fail.
    shutdownSignal: {
      kind: "gated-key-escalation",
      keySequence: "\x03",
      gateText: "again to quit",
      maxPresses: 2,
      perPressTimeoutMs: 750,
    },
  },
  help: {
    args: [],
  },
  authCheck: {
    // Codex CLI persists auth to ~/.codex/auth.json on all platforms.
    // OPENAI_API_KEY is also a first-class auth signal for the CLI.
    configPathsAll: [".codex/auth.json"],
    envVar: "OPENAI_API_KEY",
  },
  prerequisites: [
    {
      tool: "codex",
      label: "Codex CLI",
      versionArgs: ["--version"],
      severity: "fatal",
      installUrl: "https://github.com/openai/codex",
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
      // Codex Plugins, invoked as `$name` (e.g. `$github`). Discovered from the
      // local registry: enabled `[plugins."name@market"]` tables in
      // `config.toml` intersected with the manifests under `plugins/cache/*`.
      // Lower precedence than `skills` so a user's own `$name` skill wins a
      // label collision. Plugin-BUNDLED skills (`$github:gh-fix-ci`) and Apps
      // are out of scope: bundled skills are a separate namespace-qualified
      // surface, and Apps are resolved server-side with no local manifest.
      id: "plugins",
      trigger: "$",
      sourcePrecedence: 10,
      discovery: {
        method: "registry",
        parser: "codex-plugin-registry",
        derive: {
          labelPrefix: "$",
          kind: "plugin",
          idNamespace: "plugin",
          fallbackDescription: "Plugin",
        },
        locations: [
          {
            id: "user:codex-plugins",
            scope: "user",
            base: {
              type: "env",
              name: "CODEX_HOME",
              fallback: { type: "homeRelative", segments: [".codex"] },
            },
            segments: [],
            locationPrecedence: 0,
          },
        ],
      },
    },
    {
      // Codex Skills, invoked as `$name`. Custom prompts (`~/.codex/prompts`,
      // `/prompts:`) and `.codex/commands` were retired — neither exists in
      // current Codex.
      id: "skills",
      trigger: "$",
      sourcePrecedence: 20,
      discovery: {
        method: "directory",
        parser: "skill-dir",
        derive: {
          labelPrefix: "$",
          kind: "skill",
          idNamespace: "skill",
          fallbackDescription: "Skill",
        },
        locations: [
          {
            id: "builtin:system-skills",
            scope: "built-in",
            base: {
              type: "env",
              name: "CODEX_HOME",
              fallback: { type: "homeRelative", segments: [".codex"] },
            },
            segments: ["skills", ".system"],
            locationPrecedence: 0,
          },
          {
            id: "user:codex-skills",
            scope: "user",
            base: {
              type: "env",
              name: "CODEX_HOME",
              fallback: { type: "homeRelative", segments: [".codex"] },
            },
            segments: ["skills"],
            locationPrecedence: 0,
          },
          {
            id: "project:agents-skills",
            scope: "project",
            base: { type: "projectRoot" },
            segments: [".agents", "skills"],
            locationPrecedence: 0,
          },
        ],
      },
    },
  ],
};
