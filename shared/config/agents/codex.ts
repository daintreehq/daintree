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
  usageUrl: "https://chatgpt.com/settings/usage?tab=overview",
  externalLinks: [{ label: "View usage", url: "https://chatgpt.com/settings/usage?tab=overview" }],
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
        // OpenAI's standalone installer (a POSIX sh script): the binary goes to
        // ~/.local/bin without npm or root.
        {
          label: "curl",
          commands: ["curl -fsSL https://chatgpt.com/codex/install.sh | sh"],
        },
      ],
    },
    troubleshooting: [
      "Restart Daintree after installation to update PATH",
      "Verify installation with: codex --version",
      "Run 'codex auth login' after installing to authenticate",
    ],
  },
  // No bundled model list: the installed CLI's `codex debug models --bundled`
  // is the only source of Codex models (see `AgentModelCatalogService`), so a
  // new release reaches the picker without a version written down here, and a
  // retired one leaves it when the CLI points it at a successor.
  contextWindow: 128_000,
  capabilities: {
    scrollback: 10000,
    launchMcp: { format: "codex-config-overrides" },
    // Mid-turn the composer queues a submitted message (see the quit note
    // below), so a terminal notice need not wait for this pane to settle.
    queuesInputWhileWorking: true,
    blockAltScreen: true,
    blockMouseReporting: true,
    resizeStrategy: "settled",
    inlineModeFlag: "--no-alt-screen",
    // 0.154 added an ambient particle field behind the composer (`[tui]
    // whimsy`), animating at ~15 fps whether or not the agent is working. A
    // `-c` override is a global option, so it also lands ahead of `resume`.
    // `--disable` cannot do this: it only toggles `features.*` entries.
    decorations: {
      offArgs: ["-c", "tui.whimsy=false"],
      label: "Composer sparkles",
      description:
        "Codex's ambient animation behind the prompt. Off keeps idle panes from repainting continuously.",
    },
    supportsBracketedPaste: true,
    // "Update now" on the startup prompt runs the installer and exits without
    // relaunching, dropping a resumed pane back to its shell (#13226). Verified
    // against `codex-cli 0.162.1`.
    selfUpdateSuccessPattern: "Update ran successfully! Please restart Codex\\.",
    // Composer shows `[Image #N]` for a lone bracketed-pasted image path (#12792).
    imageInput: "bracketed-path",
    softNewlineSequence: "\n",
    ignoredInputSequences: ["\n", "\x1b\r"],
    // Advertises "esc to interrupt" while working. Distinct from the Ctrl-C
    // escalation in `resume.shutdownSignal`: that one quits the CLI, this one
    // cancels the turn and leaves the session up.
    interrupt: "double-escape",
    // No dedicated flag: `developer_instructions` is a config key that adds to
    // the built-in instructions, set through the same global `-c` override.
    appendSystemPrompt: { flag: "-c", configKey: "developer_instructions" },
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
    // `-C .` pins the conversation to the directory the pane launches in. A
    // resume from anywhere else stops on Codex's interactive "Choose working
    // directory" prompt — or, under `tui.resume_cwd = "session"`, silently runs
    // in the folder the conversation began in (#12434). Verified against
    // `codex-cli 0.154.0`; a no-op when the two directories match. Trailing, so
    // the echoed command still reads `codex resume <id>` for the scrape below.
    args: (sessionId: string) => ["resume", sessionId, "-C", "."],
    crossDirectoryResume: true,
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
    // Mid-turn, the first press interrupts the turn and the only thing Codex
    // prints for it is the interrupt notice ("■ Conversation interrupted - ...",
    // same prefix in 0.147.0 and 0.165.0); the second press quits (#15267). An
    // idle press quits outright and prints neither gate. "again to quit" is the
    // double-press footer, compiled out of every release from 0.100.0 through
    // 0.165.0 and kept only for a CLI that still draws it. The notice comes back
    // from Codex's core rather than being drawn with the key press, so the
    // per-press window allows for a loaded machine on app quit.
    //
    // TWO presses, not three. Three ungated presses produced nothing at all
    // after 12s, and the cap has to carry that on its own because the gate
    // cannot: a gate string can in principle be satisfied by conversation text
    // too. A press that only clears a draft prints nothing safe to gate on, so
    // a draft in the composer, or a queued follow-up the interrupt restores
    // into it (measured on `codex-cli 0.165.0`), still ends the escalation
    // early.
    //
    // "› Shutting down..." replaces the composer the moment a press starts the
    // quit (0.165.0), so a stale interrupt notice delivered beside it can't
    // release a press into the teardown. The prompt glyph is part of the
    // marker: the interrupt also stops whatever command the turn was running,
    // and that command's last output can say "Shutting down..." itself. The
    // dots are left off only because copy rules ban three-dot literals.
    shutdownSignal: {
      kind: "gated-key-escalation",
      keySequence: "\x03",
      gateTexts: ["■ Conversation interrupted", "again to quit"],
      quittingTexts: ["› Shutting down"],
      maxPresses: 2,
      perPressTimeoutMs: 1500,
    },
  },
  // `codex resume <id>` typed into the pane's shell (#15994). Options as
  // `codex-cli 0.166.0` lists them, global and on `resume` alike. `--last`
  // turns the positional into a prompt, and `-i` takes several files, so it
  // can swallow the id: both read as no id. The UUID shape keeps out a
  // session name, which the CLI also accepts there.
  resumeArgv: {
    subcommand: "resume",
    sessionIdPattern: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$",
    optionsWithValue: [
      "-c",
      "--config",
      "--enable",
      "--disable",
      "--remote",
      "--remote-auth-token-env",
      "-m",
      "--model",
      "--local-provider",
      "-p",
      "--profile",
      "-s",
      "--sandbox",
      "-C",
      "--cd",
      "--add-dir",
      "-a",
      "--ask-for-approval",
    ],
    excludedFlags: ["--last", "-i", "--image"],
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
            // Codex's documented personal skill location. Not moved by
            // CODEX_HOME, and outranks `$CODEX_HOME/skills` on a name clash.
            id: "user:agents-skills",
            scope: "user",
            base: { type: "homeRelative", segments: [".agents"] },
            segments: ["skills"],
            locationPrecedence: 1,
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
