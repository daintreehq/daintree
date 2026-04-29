import type { AgentConfig } from "../agentRegistry.js";

export const config: AgentConfig = {
  id: "qwen",
  name: "Qwen Code",
  command: "qwen",
  npmGlobalPackage: "@qwen-code/qwen-code",
  color: "#615CED",
  iconId: "qwen",
  supportsContextInjection: true,
  tooltip: "Alibaba's Qwen3-Coder agent",
  version: {
    args: ["--version"],
    githubRepo: "QwenLM/qwen-code",
    npmPackage: "@qwen-code/qwen-code",
    releaseNotesUrl: "https://github.com/QwenLM/qwen-code/releases",
  },
  update: {
    npm: "npm install -g @qwen-code/qwen-code@latest",
  },
  install: {
    docsUrl: "https://github.com/QwenLM/qwen-code#readme",
    byOs: {
      macos: [
        {
          label: "npm",
          commands: ["npm install -g @qwen-code/qwen-code"],
        },
      ],
      windows: [
        {
          label: "npm",
          commands: ["npm install -g @qwen-code/qwen-code"],
        },
      ],
      linux: [
        {
          label: "npm",
          commands: ["npm install -g @qwen-code/qwen-code"],
        },
      ],
    },
    troubleshooting: [
      "Restart Daintree after installation to update PATH",
      "Verify installation with: qwen --version",
      "Set DASHSCOPE_API_KEY (Alibaba ModelStudio) or BAILIAN_CODING_PLAN_API_KEY before launch",
      "DashScope account signup at https://dashscope.console.aliyun.com may require region-specific access",
    ],
  },
  nativePaths: ["~/.local/bin/qwen", "~/.qwen/bin/qwen"],
  models: [
    { id: "qwen3-coder-plus", name: "Qwen3 Coder Plus", shortLabel: "Coder Plus" },
    { id: "qwen3-coder-flash", name: "Qwen3 Coder Flash", shortLabel: "Coder Flash" },
  ],
  contextWindow: 1_000_000,
  capabilities: {
    scrollback: 10000,
    blockAltScreen: true,
    blockMouseReporting: true,
    resizeStrategy: "settled",
    supportsBracketedPaste: false,
    softNewlineSequence: "\x1b\r",
    ignoredInputSequences: ["\x1b\r"],
  },
  detection: {
    primaryPatterns: [
      // @generated:qwen:primaryPatterns:start
      "[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\\s+[^()\\n]{2,80}\\s*\\(esc to cancel",
      "esc to cancel[^)\\n]*\\)?$",
      "\\(\\d+s,?\\s*esc to cancel",
      // @generated:qwen:primaryPatterns:end
    ],
    fallbackPatterns: [
      // @generated:qwen:fallbackPatterns:start
      "[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\\s+\\w",
      // @generated:qwen:fallbackPatterns:end
    ],
    bootCompletePatterns: [
      // @generated:qwen:bootCompletePatterns:start
      "qwen\\s+code\\s+\\(v",
      "Tips for getting started",
      "type\\s+your\\s+message",
      // @generated:qwen:bootCompletePatterns:end
    ],
    promptPatterns: ["^\\s*>\\s*", "type\\s+your\\s+message"],
    promptHintPatterns: ["type\\s+your\\s+message", "Tips for getting started"],
    completionPatterns: [
      // @generated:qwen:completionPatterns:start
      "Response\\s+complete",
      "Finished\\s+processing",
      // @generated:qwen:completionPatterns:end
    ],
    completionConfidence: 0.9,
    scanLineCount: 10,
    primaryConfidence: 0.95,
    fallbackConfidence: 0.7,
    promptConfidence: 0.85,
    debounceMs: 4000,
    titleStatePatterns: {
      working: ["✦"],
      waiting: ["◇", "✋"],
    },
  },
  routing: {
    capabilities: [
      "javascript",
      "typescript",
      "python",
      "go",
      "java",
      "kotlin",
      "system-design",
      "architecture",
      "exploration",
    ],
    domains: {
      frontend: 0.7,
      backend: 0.85,
      testing: 0.7,
      refactoring: 0.75,
      debugging: 0.75,
      architecture: 0.9,
    },
    maxConcurrent: 2,
    enabled: true,
  },
  resume: {
    kind: "session-id",
    args: (sessionId: string) => ["--resume", sessionId],
    quitCommand: "/quit",
    sessionIdPattern: "qwen --resume ([\\w-]+)",
  },
  env: {
    QWEN_CLI_ALT_SCREEN: "false",
  },
  help: {
    args: [],
  },
  authCheck: {
    // Qwen Code persists OAuth creds to ~/.qwen/oauth_creds.json (mirrors
    // Gemini-CLI's storage pattern, since Qwen Code is a Gemini-CLI fork).
    // OAuth free tier was discontinued April 15, 2026 — most users now rely
    // on DASHSCOPE_API_KEY, hence its leading position in the env array.
    configPathsAll: [".qwen/oauth_creds.json", ".qwen/settings.json"],
    envVar: ["DASHSCOPE_API_KEY", "BAILIAN_CODING_PLAN_API_KEY", "OPENAI_API_KEY"],
  },
  prerequisites: [
    {
      tool: "qwen",
      label: "Qwen Code CLI",
      versionArgs: ["--version"],
      severity: "fatal",
      installUrl: "https://github.com/QwenLM/qwen-code#readme",
    },
  ],
};
