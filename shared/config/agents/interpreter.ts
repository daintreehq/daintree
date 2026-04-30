import type { AgentConfig } from "../agentRegistry.js";

export const config: AgentConfig = {
  id: "interpreter",
  name: "Open Interpreter",
  command: "interpreter",
  color: "#111111",
  iconId: "interpreter",
  supportsContextInjection: true,
  tooltip: "general code execution — runs Python, shell, and JS on the host",
  usageUrl: "https://docs.openinterpreter.com/",
  packages: {
    pypi: "open-interpreter",
  },
  version: {
    args: ["--version"],
    pypiPackage: "open-interpreter",
    githubRepo: "openinterpreter/open-interpreter",
    releaseNotesUrl: "https://github.com/openinterpreter/open-interpreter/releases",
  },
  update: {
    pip: "pip install --upgrade open-interpreter",
    pipx: "pipx upgrade open-interpreter",
  },
  install: {
    docsUrl: "https://docs.openinterpreter.com/getting-started/setup",
    byOs: {
      macos: [
        {
          label: "pipx (recommended)",
          commands: ["pipx install open-interpreter"],
        },
        {
          label: "pip",
          commands: ["pip install open-interpreter"],
        },
        {
          label: "uv",
          commands: ["uv tool install open-interpreter"],
        },
      ],
      linux: [
        {
          label: "pipx (recommended)",
          commands: ["pipx install open-interpreter"],
        },
        {
          label: "pip",
          commands: ["pip install open-interpreter"],
        },
        {
          label: "uv",
          commands: ["uv tool install open-interpreter"],
        },
      ],
      windows: [
        {
          label: "pipx (recommended)",
          commands: ["pipx install open-interpreter"],
        },
        {
          label: "pip",
          commands: ["pip install open-interpreter"],
        },
        {
          label: "uv",
          commands: ["uv tool install open-interpreter"],
        },
      ],
    },
    troubleshooting: [
      "Restart Daintree after installation to update PATH",
      "Requires Python 3.10 or newer",
      "Verify installation with: interpreter --version",
      "Set OPENAI_API_KEY (or ANTHROPIC_API_KEY / GOOGLE_API_KEY) before launch, or run 'interpreter' once to be prompted",
      "Code runs locally — keep auto-run mode disabled unless you trust the prompt source",
    ],
  },
  capabilities: {
    scrollback: 10000,
    blockAltScreen: false,
    blockMouseReporting: false,
    resizeStrategy: "default",
    supportsBracketedPaste: false,
    softNewlineSequence: "\n",
    ignoredInputSequences: ["\n", "\x1b\r"],
  },
  detection: {
    primaryPatterns: ["[•·]\\s+(Running|Executing|Generating)"],
    fallbackPatterns: ["```(python|shell|javascript|applescript|html|r)\\b"],
    bootCompletePatterns: ["Welcome to.*Open Interpreter", "Model set to"],
    promptPatterns: ["^\\s*>\\s*$"],
    promptHintPatterns: ["Would you like to run this code"],
    scanLineCount: 10,
    primaryConfidence: 0.95,
    fallbackConfidence: 0.7,
    promptConfidence: 0.85,
    debounceMs: 4000,
  },
  routing: {
    capabilities: ["python", "shell", "javascript", "code-execution", "general-purpose"],
    domains: {
      backend: 0.7,
      debugging: 0.65,
    },
    maxConcurrent: 1,
    enabled: true,
  },
  resume: {
    kind: "rolling-history",
    args: () => [],
    shutdownKeySequence: "\x04",
  },
  authCheck: {
    configPaths: {
      darwin: ["Library/Application Support/open-interpreter/profiles/default.yaml"],
      win32: ["AppData/Roaming/Open Interpreter/profiles/default.yaml"],
    },
    configPathsAll: [".config/open-interpreter/profiles/default.yaml"],
    envVar: ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GOOGLE_API_KEY"],
  },
  prerequisites: [
    {
      tool: "interpreter",
      label: "Open Interpreter CLI",
      versionArgs: ["--version"],
      severity: "fatal",
      installUrl: "https://docs.openinterpreter.com/getting-started/setup",
    },
  ],
};
