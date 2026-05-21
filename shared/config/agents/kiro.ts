import type { AgentConfig } from "../agentRegistry.js";

export const config: AgentConfig = {
  id: "kiro",
  name: "Kiro",
  command: "kiro-cli",
  color: "#7C3AED",
  iconId: "kiro",
  supportsContextInjection: true,
  tooltip: "Amazon's AI coding agent",
  usageUrl: "https://kiro.dev/",
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
    supportsBracketedPaste: true,
    softNewlineSequence: "\x1b\r",
    ignoredInputSequences: ["\x1b\r"],
  },
  detection: {
    primaryPatterns: [
      // @generated:kiro:primaryPatterns:start
      "[·*✢✳✶✻✽●✼✾⟡◇◆○⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\\s+[^()\\n]{2,80}\\s*\\(esc to interrupt",
      "esc to interrupt[^)\\n]*\\)?$",
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
    debounceMs: 6000,
  },
  // Kiro uses directory-based sessions: no session ID is emitted on quit
  // and `--resume` takes no argument. `project-scoped` skips the PTY host's
  // session-ID capture loop while still firing the graceful `/quit`.
  resume: {
    kind: "project-scoped",
    args: () => ["--resume"],
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
