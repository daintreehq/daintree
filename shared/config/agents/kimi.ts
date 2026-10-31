import type { AgentConfig } from "../agentRegistry.js";

// Kimi Code CLI, the TypeScript client in MoonshotAI/kimi-code. The Python
// `kimi-cli` it replaced (same `kimi` command, same product name) is archived;
// nothing here describes it. Its PyPI names, `kimi-cli` and `kimi-code`, are
// both the legacy client.
const INSTALL_SCRIPT = "curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash";
const NPM_INSTALL = "npm install -g @moonshot-ai/kimi-code";
const NPM_NOTE = "Requires Node.js 22.19 or later";

export const config: AgentConfig = {
  id: "kimi",
  name: "Kimi Code",
  command: "kimi",
  args: [],
  color: "#1E90FF",
  iconId: "kimi",
  supportsContextInjection: true,
  // #11282 phase 5: Kimi is rolling-history (`--continue`, no session id
  // captured), so whether "continue" lands on the right conversation after a
  // move isn't confirmed.
  continuity: {
    tier: "unverified",
    detail: "Kimi continues its most recent session; resuming after a move isn't confirmed",
  },
  tooltip: "Moonshot AI's CLI",
  usageUrl: "https://github.com/MoonshotAI/kimi-code",
  packages: {
    npm: "@moonshot-ai/kimi-code",
  },
  // The install script puts the binary in `$KIMI_INSTALL_DIR/bin` (default
  // ~/.kimi-code/bin) and adds that to PATH through shell rc files, which a
  // GUI-launched Electron process may not have sourced.
  nativePaths: ["~/.kimi-code/bin/kimi", "%USERPROFILE%\\.kimi-code\\bin\\kimi.exe"],
  version: {
    args: ["--version"],
    // npm only: GitHub releases on the monorepo are tagged
    // `@moonshot-ai/kimi-code@<version>` beside canaries and other apps, so
    // `releases/latest` is not this package's stream.
    npmPackage: "@moonshot-ai/kimi-code",
    releaseNotesUrl: "https://github.com/MoonshotAI/kimi-code/releases",
  },
  update: {
    npm: `${NPM_INSTALL}@latest`,
    curl: INSTALL_SCRIPT,
  },
  install: {
    docsUrl: "https://moonshotai.github.io/kimi-code/en/guides/getting-started",
    byOs: {
      macos: [
        { label: "Install script", commands: [INSTALL_SCRIPT] },
        { label: "npm", commands: [NPM_INSTALL], notes: [NPM_NOTE] },
      ],
      linux: [
        { label: "Install script", commands: [INSTALL_SCRIPT] },
        { label: "npm", commands: [NPM_INSTALL], notes: [NPM_NOTE] },
      ],
      windows: [
        {
          label: "PowerShell",
          commands: ["irm https://code.kimi.com/kimi-code/install.ps1 | iex"],
          notes: ["Requires Git for Windows: Kimi Code runs its shell commands in Git Bash"],
        },
        {
          label: "npm",
          commands: [NPM_INSTALL],
          notes: [NPM_NOTE, "Requires Git for Windows"],
        },
      ],
    },
    troubleshooting: [
      "Restart Daintree after installation to update PATH",
      "Verify installation with: kimi --version",
      "Run kimi and enter /login to sign in with Kimi Code OAuth or a Kimi Platform API key",
      "Keys for other providers go in ~/.kimi-code/config.toml; exporting KIMI_API_KEY in your shell has no effect",
      "If Git Bash is installed in a custom location on Windows, set KIMI_SHELL_PATH to its bash.exe",
    ],
  },
  capabilities: {
    scrollback: 10000,
    blockMouseReporting: true,
    resizeStrategy: "settled",
    supportsBracketedPaste: true,
    softNewlineSequence: "\x1b\r",
    ignoredInputSequences: ["\x1b\r"],
  },
  detection: {
    // MoonLoader's "moon" style (8 moon-phase frames, MOON_SPINNER_FRAMES in
    // apps/kimi-code/src/tui/constant/rendering.ts upstream) is the activity
    // spinner while waiting on the model or running a tool, drawn bare or with
    // a label after a space. The end-of-line alternative handles renderers
    // that drop the trailing space when no text follows the spinner.
    primaryPatterns: ["[🌑🌒🌓🌔🌕🌖🌗🌘](?:\\s|$)"],
    fallbackPatterns: [
      // MoonLoader's "braille" style, drawn with a label for progress such as
      // login. Identical Unicode to the cliclack spinner goose uses —
      // copy-pasting the glyph set between agents is a known footgun (#3941),
      // so this stays fallback-only at 0.75, never primary.
      "[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\\s+[^\\n]{2,80}",
      "[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\\s+\\w",
    ],
    // The title row of the welcome panel (components/chrome/welcome.ts),
    // printed before the first prompt whether or not the user is signed in.
    // Without this slot BootDetector falls back to the hardcoded
    // Claude/Codex/Gemini banners and Kimi terminals wait the full
    // POLLING_MAX_BOOT_MS (15s) timeout on every launch.
    bootCompletePatterns: ["Welcome to Kimi Code!"],
    // Unverified against live PTY output: derived from the upstream editor
    // source (components/editor/custom-editor.ts), not captured. The input box
    // draws `│`, a space, then `>` (or `!` in shell mode) on its first row. No
    // hint pattern: the box stays on screen while Kimi works, so an empty-box
    // hint would read as a prompt mid-turn.
    promptPatterns: ["^\\s*│ [>!]\\s"],
    scanLineCount: 10,
    primaryConfidence: 0.95,
    fallbackConfidence: 0.75,
    promptConfidence: 0.85,
  },
  resume: {
    kind: "rolling-history",
    args: () => ["--continue"],
    quitCommand: "/exit",
  },
  authCheck: {
    // Kimi Code keeps everything under ~/.kimi-code, or KIMI_CODE_HOME when
    // set. `credentials/kimi-code.json` is the Kimi Code OAuth login.
    // `config.toml` is created on first run, so it only says Kimi has been
    // launched, but it is the only place an API-key or third-party provider
    // setup lives and its contents are not ours to read. No envVar: the CLI
    // ignores credentials exported in the shell.
    configHome: {
      envVar: "KIMI_CODE_HOME",
      defaultDir: ".kimi-code",
      paths: ["credentials/kimi-code.json", "config.toml"],
    },
  },
  prerequisites: [
    {
      tool: "kimi",
      label: "Kimi Code CLI",
      versionArgs: ["--version"],
      severity: "fatal",
      installUrl: "https://moonshotai.github.io/kimi-code/en/guides/getting-started",
    },
  ],
};
