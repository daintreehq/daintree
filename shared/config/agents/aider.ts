import type { AgentConfig } from "../agentRegistry.js";

export const config: AgentConfig = {
  id: "aider",
  name: "Aider",
  command: "aider",
  // --no-auto-commits is critical: Aider's default --auto-commits would
  // muddy the user's intentional commit history inside a Daintree worktree.
  args: ["--no-auto-commits"],
  color: "#14B014",
  iconId: "aider",
  supportsContextInjection: true,
  tooltip: "Pip-distributed, git-aware coding agent",
  usageUrl: "https://aider.chat/",
  // packages.pypi triggers uv/pipx path synthesis in CliAvailabilityService,
  // which already covers ~/.local/bin/aider on POSIX hosts. nativePaths only
  // adds destinations not synthesized automatically: macOS Homebrew bins and
  // the Windows uv landing.
  packages: { pypi: "aider-chat", brew: "aider" },
  nativePaths: [
    "/opt/homebrew/bin/aider",
    "/usr/local/bin/aider",
    "%USERPROFILE%\\.local\\bin\\aider.exe",
  ],
  models: [
    { id: "sonnet", name: "Claude Sonnet", shortLabel: "Sonnet" },
    { id: "gpt-5", name: "GPT-5", shortLabel: "GPT-5" },
    { id: "deepseek", name: "DeepSeek", shortLabel: "DeepSeek" },
    { id: "gemini/gemini-2.5-pro", name: "Gemini 2.5 Pro", shortLabel: "Gemini" },
    { id: "o3", name: "OpenAI o3", shortLabel: "o3" },
  ],
  version: {
    args: ["--version"],
    pypiPackage: "aider-chat",
    githubRepo: "Aider-AI/aider",
    releaseNotesUrl: "https://github.com/Aider-AI/aider/releases",
  },
  update: {
    brew: "brew upgrade aider",
    pypi: "python -m pip install --upgrade aider-chat",
  },
  install: {
    docsUrl: "https://aider.chat/docs/install.html",
    byOs: {
      macos: [
        {
          label: "pip (recommended)",
          commands: ["python -m pip install aider-install", "aider-install"],
        },
        {
          label: "pipx",
          commands: ["pipx install aider-chat"],
        },
        {
          label: "Homebrew",
          commands: ["brew install aider"],
        },
        {
          label: "curl",
          commands: ["curl -LsSf https://aider.chat/install.sh | sh"],
        },
      ],
      linux: [
        {
          label: "pip (recommended)",
          commands: ["python -m pip install aider-install", "aider-install"],
        },
        {
          label: "pipx",
          commands: ["pipx install aider-chat"],
        },
        {
          label: "curl",
          commands: ["curl -LsSf https://aider.chat/install.sh | sh"],
        },
      ],
      windows: [
        {
          label: "pip (recommended)",
          commands: ["python -m pip install aider-install", "aider-install"],
        },
        {
          label: "pipx",
          commands: ["pipx install aider-chat"],
        },
        {
          label: "PowerShell",
          commands: [
            'powershell -ExecutionPolicy ByPass -c "irm https://aider.chat/install.ps1 | iex"',
          ],
        },
      ],
    },
    troubleshooting: [
      "Restart Daintree after installation to update PATH",
      "Verify installation with: aider --version",
      "Configure a model and API key — see https://aider.chat/docs/config/api-keys.html",
      "On Windows, the uv installer lands aider in %USERPROFILE%\\.local\\bin",
    ],
  },
  capabilities: {
    scrollback: 10000,
    blockAltScreen: false,
    blockMouseReporting: false,
    resizeStrategy: "default",
    supportsBracketedPaste: true,
    softNewlineSequence: "\x1b\r",
    ignoredInputSequences: ["\x1b\r"],
  },
  detection: {
    // Knight-Rider scanner: U+2591 (░) light shade and U+2588 (█) full block
    // sliding back and forth. Source: aider/waiting.py.
    primaryPatterns: ["[░█]{2,}\\s+Waiting for"],
    // ASCII fallback frames use = and # (e.g. [===#===]). Token summary
    // line and bare "Waiting for ..." are weaker signals — fallback only.
    fallbackPatterns: ["[=#]{2}\\s+Waiting for", "Waiting for\\s+\\w", "Tokens:\\s+\\d"],
    // "Aider v\d" is the first banner line — version-stable. The "Use /help"
    // hint appears at the prompt when the agent is ready.
    bootCompletePatterns: ["Aider v\\d", "Use\\s+/help\\b"],
    promptPatterns: ["^(architect|ask|help|code)?\\s*(multi)?>\\s*", "^>\\s*$"],
    promptHintPatterns: ["Use\\s+/help\\b"],
    completionPatterns: [
      "Applied edit to ",
      "Commit\\s+[0-9a-f]{7,}\\s+",
      "Tokens:\\s+\\d.*received\\.",
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
      "git",
      "multi-provider",
      "general-purpose",
    ],
    domains: {
      frontend: 0.7,
      backend: 0.75,
      testing: 0.7,
      refactoring: 0.75,
      debugging: 0.7,
      architecture: 0.65,
    },
    maxConcurrent: 1,
    enabled: true,
  },
  resume: {
    kind: "rolling-history",
    args: () => ["--restore-chat-history"],
    quitCommand: "/exit",
  },
  authCheck: {
    // Aider is provider-agnostic — any of these env vars is enough to launch.
    // .aider.conf.yml and .env are project- or home-relative config files.
    configPathsAll: [".aider.conf.yml", ".env"],
    envVar: [
      "OPENAI_API_KEY",
      "ANTHROPIC_API_KEY",
      "GEMINI_API_KEY",
      "DEEPSEEK_API_KEY",
      "OPENROUTER_API_KEY",
      "AIDER_API_KEY",
      "AIDER_OPENAI_API_KEY",
      "AIDER_ANTHROPIC_API_KEY",
    ],
  },
  envSuggestions: [
    { key: "AIDER_MODEL", hint: "Default model id (e.g. sonnet, gpt-5, deepseek)" },
    { key: "AIDER_OPENAI_API_KEY", hint: "OpenAI key when not using OPENAI_API_KEY" },
    { key: "AIDER_ANTHROPIC_API_KEY", hint: "Anthropic key when not using ANTHROPIC_API_KEY" },
    { key: "OLLAMA_API_BASE", hint: "Local Ollama endpoint (e.g. http://127.0.0.1:11434)" },
  ],
  prerequisites: [
    {
      tool: "aider",
      label: "Aider CLI",
      versionArgs: ["--version"],
      severity: "fatal",
      installUrl: "https://aider.chat/docs/install.html",
    },
  ],
};
