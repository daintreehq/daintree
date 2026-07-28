import type { AgentConfig } from "../agentRegistry.js";

export const config: AgentConfig = {
  id: "kiro",
  name: "Kiro",
  command: "kiro-cli",
  color: "#7C3AED",
  iconId: "kiro",
  supportsContextInjection: true,
  // #11282 phase 5: `chat --resume` is project-SCOPED, not project-LOCAL. Kiro
  // keeps conversations in a global home-dir SQLite store (macOS
  // ~/Library/Application Support/kiro-cli/data.sqlite3, Linux
  // ~/.local/share/kiro-cli/data.sqlite3; table `conversations_v2` keyed by the
  // ABSOLUTE workspace path). Nothing conversation-bearing lives in the project
  // folder, so a move leaves the row stranded under the old path and
  // `chat --resume` at the new cwd starts fresh. The history is still on disk —
  // recovery is `kiro-cli chat --resume-id <uuid>` or `--resume-picker`, both
  // manual: our `resume` block is `kind: "project-scoped"` and captures no
  // session id, and reaching into Kiro's private store is off-limits (#4100).
  continuity: {
    tier: "provider-migration",
    detail:
      "Kiro looks up conversations by folder path — recover with kiro-cli chat --resume-picker",
  },
  tooltip: "Amazon's CLI",
  usageUrl: "https://kiro.dev/",
  externalLinks: [{ label: "View docs", url: "https://kiro.dev/docs/" }],
  version: {
    args: ["--version"],
  },
  update: {
    curl: "curl -fsSL https://cli.kiro.dev/install | bash",
  },
  install: {
    docsUrl: "https://kiro.dev/cli/",
    byOs: {
      macos: [
        {
          label: "curl",
          commands: ["curl -fsSL https://cli.kiro.dev/install | bash"],
        },
      ],
      linux: [
        {
          label: "curl",
          commands: ["curl -fsSL https://cli.kiro.dev/install | bash"],
        },
      ],
    },
    troubleshooting: [
      "Restart Daintree after installation to update PATH",
      "Verify installation with: kiro-cli --version",
      "Kiro CLI is only supported on macOS and Linux",
      "Authenticate after installing via Kiro's login flow",
    ],
  },
  capabilities: {
    scrollback: 10000,
    resizeStrategy: "default",
    supportsBracketedPaste: true,
    softNewlineSequence: "\x1b\r",
    ignoredInputSequences: ["\x1b\r"],
  },
  detection: {
    primaryPatterns: [
      // @generated:kiro:primaryPatterns:start
      "[·*✢✳✶✻✽●✼✾⟡◇◆○⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\\s+[^()\\n]{2,80}\\s*\\(esc to interrupt",
      "esc to interrupt(?:[^)\\n]{0,20}\\)?|[^)\\n]{0,60}\\))$",
      "\\(\\d+s\\s*[·•]\\s*esc to interrupt",
      "[·*✢✳✶✻✽●✼✾⟡◇◆○⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\\s+Thinking",
      // @generated:kiro:primaryPatterns:end
    ],
    fallbackPatterns: [
      // @generated:kiro:fallbackPatterns:start
      "[·•●⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\\s+Thinking",
      "[·•●]\\s+\\w+",
      // @generated:kiro:fallbackPatterns:end
    ],
    bootCompletePatterns: [
      // @generated:kiro:bootCompletePatterns:start
      "Jump into building with Kiro",
      "Use /help for more information and happy coding",
      "Model: auto",
      // @generated:kiro:bootCompletePatterns:end
    ],
    promptPatterns: ["^\\s*>\\s*"],
    promptHintPatterns: ["^\\s*>\\s*$"],
    completionPatterns: [
      // @generated:kiro:completionPatterns:start
      "Task\\s+completed",
      "\\d+\\s+files?\\s+changed",
      // @generated:kiro:completionPatterns:end
    ],
    completionConfidence: 0.9,
    scanLineCount: 10,
    primaryConfidence: 0.95,
    fallbackConfidence: 0.75,
    promptConfidence: 0.85,
  },
  // Kiro uses directory-based sessions: no session ID is emitted on quit
  // and `--resume` takes no argument. `project-scoped` skips the PTY host's
  // session-ID capture loop while still firing the graceful `/quit`.
  // `--resume` is documented on the `chat` subcommand, not as a global flag,
  // so use the explicit `chat --resume` form rather than the implicit-chat
  // default.
  resume: {
    kind: "project-scoped",
    args: () => ["chat", "--resume"],
    quitCommand: "/quit",
  },
  help: {
    args: [],
  },
  authCheck: {
    // AWS SSO users authenticate via `kiro-cli login` (optionally with
    // --use-device-flow for headless/SSH), which writes a Kiro-specific
    // token cache to ~/.aws/sso/cache/kiro-auth-token.json. Probe that
    // file so SSO-authenticated users get `authConfirmed: true`.
    // Non-SSO Kiro auth is managed via the OS keychain and internal state
    // directories (e.g. ~/Library/Application Support/kiro-cli/ on macOS,
    // ~/.local/share/kiro-cli/ on Linux), which we cannot reliably probe —
    // those users get `authConfirmed: false` but remain launchable.
    configPathsAll: [".aws/sso/cache/kiro-auth-token.json"],
  },
  prerequisites: [
    {
      tool: "kiro-cli",
      label: "Kiro CLI",
      versionArgs: ["--version"],
      severity: "fatal",
      installUrl: "https://kiro.dev/cli/",
    },
  ],
};
