import type { AgentConfig } from "../agentRegistry.js";

export const config: AgentConfig = {
  id: "opencode",
  name: "OpenCode",
  command: "opencode",
  // OpenCode's curl installer (https://opencode.ai/install) lands the binary
  // under ~/.opencode/bin when ~/.local/bin and XDG_BIN_DIR are unset;
  // otherwise it uses ~/.local/bin (already covered by getUnixFallbackPaths).
  nativePaths: ["~/.opencode/bin/opencode", "~/.local/bin/opencode"],
  color: "#10b981",
  iconId: "opencode",
  supportsContextInjection: true,
  tooltip: "provider-agnostic, open source",
  usageUrl: "https://opencode.ai/",
  version: {
    args: ["--version"],
    githubRepo: "opencode-ai/opencode",
    npmPackage: "opencode-ai",
    releaseNotesUrl: "https://github.com/opencode-ai/opencode/releases",
  },
  update: {
    npm: "npm install -g opencode-ai@latest",
    brew: "brew upgrade opencode",
    curl: "curl -fsSL https://opencode.ai/install | bash",
  },
  install: {
    docsUrl: "https://opencode.ai/docs/",
    byOs: {
      macos: [
        {
          label: "curl",
          commands: ["curl -fsSL https://opencode.ai/install | bash"],
        },
        {
          label: "npm",
          commands: ["npm install -g opencode-ai@latest"],
        },
        {
          label: "Homebrew",
          commands: ["brew install opencode"],
        },
      ],
      windows: [
        {
          label: "npm",
          commands: ["npm install -g opencode-ai@latest"],
        },
        {
          label: "Scoop",
          commands: ["scoop bucket add extras", "scoop install extras/opencode"],
        },
        {
          label: "Chocolatey",
          commands: ["choco install opencode"],
        },
      ],
      linux: [
        {
          label: "curl",
          commands: ["curl -fsSL https://opencode.ai/install | bash"],
        },
        {
          label: "npm",
          commands: ["npm install -g opencode-ai@latest"],
        },
        {
          label: "Homebrew",
          commands: ["brew install opencode"],
        },
        {
          label: "Paru (Arch)",
          commands: ["paru -S opencode-bin"],
        },
      ],
    },
    troubleshooting: [
      "Restart Daintree after installation to update PATH",
      "Ensure Node.js is installed for npm-based installation",
      "Verify installation with: opencode --version",
      "Run '/connect' in OpenCode to configure LLM provider",
      "For provider setup, authenticate at opencode.ai/auth",
    ],
  },
  capabilities: {
    scrollback: 10000,
    blockAltScreen: false,
    supportsBracketedPaste: true,
    softNewlineSequence: "\n",
    ignoredInputSequences: ["\n", "\x1b\r"],
  },
  env: {
    COLORFGBG: "15;0",
  },
  detection: {
    primaryPatterns: [
      // @generated:opencode:primaryPatterns:start
      "[⣾⣽⣻⢿⡿⣟⣯⣷]\\s+[^\\n]{2,80}\\s*\\(.*esc",
      "[·•●]\\s+(Generating|Building tool call|Waiting for tool response)",
      "press\\s+esc\\s+(again\\s+)?to\\s+(interrupt|exit\\s+cancel)",
      "esc\\s*(again\\s+)?to\\s+(interrupt|cancel)",
      // @generated:opencode:primaryPatterns:end
    ],
    fallbackPatterns: [
      // @generated:opencode:fallbackPatterns:start
      "[⣾⣽⣻⢿⡿⣟⣯⣷]\\s+\\w",
      "working[…\\.]+",
      "generating",
      "waiting for tool response",
      "building tool call",
      // @generated:opencode:fallbackPatterns:end
    ],
    bootCompletePatterns: [
      // @generated:opencode:bootCompletePatterns:start
      "Ask anything",
      "Build\\s+OpenCode",
      // @generated:opencode:bootCompletePatterns:end
    ],
    promptPatterns: ["^\\s*[›❯>]\\s*", "Ask anything"],
    promptHintPatterns: ["Ask anything"],
    completionPatterns: [
      // @generated:opencode:completionPatterns:start
      "Task\\s+completed",
      "\\d+\\s+files?\\s+changed",
      // @generated:opencode:completionPatterns:end
    ],
    completionConfidence: 0.9,
    scanLineCount: 10,
    primaryConfidence: 0.95,
    fallbackConfidence: 0.7,
    promptConfidence: 0.85,
    debounceMs: 4000,
  },
  routing: {
    capabilities: [
      "javascript",
      "typescript",
      "python",
      "go",
      "rust",
      "multi-provider",
      "general-purpose",
    ],
    domains: {
      frontend: 0.75,
      backend: 0.75,
      testing: 0.7,
      refactoring: 0.7,
      debugging: 0.7,
      architecture: 0.7,
    },
    maxConcurrent: 1,
    enabled: true,
  },
  resume: {
    kind: "session-id",
    args: (sessionId: string) => ["-s", sessionId],
    quitCommand: "/quit",
    sessionIdPattern: "opencode -s ([\\w-]+)",
  },
  authCheck: {
    // OpenCode v1.4.6+ uses XDG-compliant config paths on all platforms
    configPathsAll: [".config/opencode/opencode.json", ".local/share/opencode/auth.json"],
    // OpenCode is provider-agnostic and accepts provider credentials
    // directly from env vars (ANTHROPIC_API_KEY / OPENAI_API_KEY / GOOGLE_API_KEY),
    // so any of these is a sufficient signal that the CLI is usable.
    envVar: ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_API_KEY"],
  },
  prerequisites: [
    {
      tool: "opencode",
      label: "OpenCode CLI",
      versionArgs: ["--version"],
      severity: "fatal",
      installUrl: "https://opencode.ai/docs/",
    },
  ],
};
