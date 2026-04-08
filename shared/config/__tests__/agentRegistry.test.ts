import { describe, it, expect, beforeEach } from "vitest";
import {
  getAgentIds,
  getAgentConfig,
  isRegisteredAgent,
  setUserRegistry,
  getEffectiveAgentIds,
  getEffectiveAgentConfig,
  isEffectivelyRegisteredAgent,
  isBuiltInAgent,
  isUserDefinedAgent,
  getAgentModelConfig,
  getAgentDisplayTitle,
  ASSISTANT_FAST_MODELS,
  type AgentConfig,
} from "../agentRegistry.js";
import {
  AgentRoutingConfigSchema,
  AgentDomainWeightsSchema,
  DEFAULT_ROUTING_CONFIG,
} from "../../types/agentSettings.js";

describe("agentRegistry", () => {
  beforeEach(() => {
    setUserRegistry({});
  });

  describe("built-in agents", () => {
    it("has all expected built-in agents", () => {
      const ids = getAgentIds();
      expect(ids).toContain("claude");
      expect(ids).toContain("gemini");
      expect(ids).toContain("codex");
      expect(ids).toContain("opencode");
      expect(ids).toContain("cursor");
      expect(ids).toContain("kiro");
    });

    it("kiro only has macOS and Linux install blocks (no Windows)", () => {
      const config = getAgentConfig("kiro");
      expect(config?.install?.byOs?.macos?.length).toBeGreaterThan(0);
      expect(config?.install?.byOs?.linux?.length).toBeGreaterThan(0);
      expect(config?.install?.byOs?.windows).toBeUndefined();
    });

    it("each built-in agent has a non-empty color", () => {
      const ids = getAgentIds();
      for (const id of ids) {
        const config = getAgentConfig(id);
        expect(config?.color).toBeTruthy();
        expect(config?.color).toMatch(/^#[0-9a-fA-F]{6}$/);
      }
    });

    it("returns agent config for built-in agents", () => {
      const claude = getAgentConfig("claude");
      expect(claude).toBeDefined();
      expect(claude?.name).toBe("Claude");
      expect(claude?.command).toBe("claude");
    });

    it("returns undefined for non-existent agents", () => {
      expect(getAgentConfig("nonexistent")).toBeUndefined();
    });

    it("correctly identifies registered agents", () => {
      expect(isRegisteredAgent("claude")).toBe(true);
      expect(isRegisteredAgent("nonexistent")).toBe(false);
    });
  });

  describe("contextWindow", () => {
    it("claude has 200k context window", () => {
      expect(getAgentConfig("claude")?.contextWindow).toBe(200_000);
    });

    it("gemini has 1M context window", () => {
      expect(getAgentConfig("gemini")?.contextWindow).toBe(1_000_000);
    });

    it("codex has 128k context window", () => {
      expect(getAgentConfig("codex")?.contextWindow).toBe(128_000);
    });

    it("agents without contextWindow return undefined", () => {
      expect(getAgentConfig("cursor")?.contextWindow).toBeUndefined();
    });
  });

  describe("prerequisites", () => {
    it("all built-in agents have prerequisites", () => {
      const ids = getAgentIds();
      for (const id of ids) {
        const config = getAgentConfig(id);
        expect(config?.prerequisites).toBeDefined();
        expect(config?.prerequisites?.length).toBeGreaterThan(0);
      }
    });

    it("each prerequisite has required fields", () => {
      const ids = getAgentIds();
      for (const id of ids) {
        const config = getAgentConfig(id);
        for (const prereq of config?.prerequisites ?? []) {
          expect(prereq.tool).toBeTruthy();
          expect(prereq.label).toBeTruthy();
          expect(prereq.severity).toMatch(/^(fatal|warn|silent)$/);
          expect(prereq.versionArgs).toBeDefined();
        }
      }
    });

    it("each agent declares its own CLI as a fatal prerequisite", () => {
      const ids = getAgentIds();
      for (const id of ids) {
        const config = getAgentConfig(id);
        const cliPrereq = config?.prerequisites?.find((p) => p.tool === config.command);
        expect(cliPrereq).toBeDefined();
        expect(cliPrereq?.severity).toBe("fatal");
      }
    });
  });

  describe("routing configuration", () => {
    it("all built-in agents have routing config", () => {
      const ids = getAgentIds();
      for (const id of ids) {
        const config = getAgentConfig(id);
        expect(config?.routing).toBeDefined();
        expect(config?.routing?.enabled).toBe(true);
      }
    });

    it("all built-in routing configs are valid per schema", () => {
      const ids = getAgentIds();
      for (const id of ids) {
        const config = getAgentConfig(id);
        if (config?.routing) {
          const result = AgentRoutingConfigSchema.safeParse(config.routing);
          expect(result.success).toBe(true);
          if (!result.success) {
            console.error(`Invalid routing config for ${id}:`, result.error);
          }
        }
      }
    });

    it("claude has expected routing capabilities", () => {
      const claude = getAgentConfig("claude");
      expect(claude?.routing?.capabilities).toContain("javascript");
      expect(claude?.routing?.capabilities).toContain("typescript");
      expect(claude?.routing?.capabilities).toContain("debugging");
      expect(claude?.routing?.capabilities).toContain("refactoring");
    });

    it("claude has high refactoring and debugging weights", () => {
      const claude = getAgentConfig("claude");
      expect(claude?.routing?.domains?.refactoring).toBeGreaterThanOrEqual(0.9);
      expect(claude?.routing?.domains?.debugging).toBeGreaterThanOrEqual(0.85);
    });

    it("codex has high frontend and testing weights", () => {
      const codex = getAgentConfig("codex");
      expect(codex?.routing?.domains?.frontend).toBeGreaterThanOrEqual(0.85);
      expect(codex?.routing?.domains?.testing).toBeGreaterThanOrEqual(0.8);
    });

    it("gemini has high architecture weight", () => {
      const gemini = getAgentConfig("gemini");
      expect(gemini?.routing?.domains?.architecture).toBeGreaterThanOrEqual(0.85);
    });

    it("routing config has maxConcurrent set", () => {
      const ids = getAgentIds();
      for (const id of ids) {
        const config = getAgentConfig(id);
        expect(config?.routing?.maxConcurrent).toBeGreaterThanOrEqual(1);
      }
    });
  });

  describe("user registry", () => {
    const customAgent: AgentConfig = {
      id: "custom-agent",
      name: "Custom Agent",
      command: "custom",
      color: "#FF0000",
      iconId: "custom",
      supportsContextInjection: true,
      routing: {
        capabilities: ["custom-task", "specialized"],
        domains: {
          frontend: 0.5,
          backend: 0.8,
        },
        maxConcurrent: 3,
        enabled: true,
      },
    };

    it("user-defined agents appear in effective registry", () => {
      setUserRegistry({ "custom-agent": customAgent });

      expect(getEffectiveAgentIds()).toContain("custom-agent");
      expect(isEffectivelyRegisteredAgent("custom-agent")).toBe(true);
    });

    it("user-defined agents are not built-in", () => {
      setUserRegistry({ "custom-agent": customAgent });

      expect(isBuiltInAgent("custom-agent")).toBe(false);
      expect(isUserDefinedAgent("custom-agent")).toBe(true);
    });

    it("built-in agents are not user-defined", () => {
      expect(isBuiltInAgent("claude")).toBe(true);
      expect(isUserDefinedAgent("claude")).toBe(false);
    });

    it("user-defined agents can have custom routing config", () => {
      setUserRegistry({ "custom-agent": customAgent });

      const config = getEffectiveAgentConfig("custom-agent");
      expect(config?.routing?.capabilities).toContain("custom-task");
      expect(config?.routing?.domains?.backend).toBe(0.8);
      expect(config?.routing?.maxConcurrent).toBe(3);
    });

    it("built-in agents take precedence over user agents with same ID", () => {
      const fakeClaudeConfig: AgentConfig = {
        id: "claude",
        name: "Fake Claude",
        command: "fake-claude",
        color: "#000000",
        iconId: "fake",
        supportsContextInjection: false,
      };

      setUserRegistry({ claude: fakeClaudeConfig });

      const effective = getEffectiveAgentConfig("claude");
      expect(effective?.name).toBe("Claude");
      expect(effective?.command).toBe("claude");
    });
  });
});

describe("AgentRoutingConfigSchema", () => {
  it("validates valid routing config", () => {
    const validConfig = {
      capabilities: ["javascript", "react"],
      domains: {
        frontend: 0.9,
        backend: 0.5,
      },
      maxConcurrent: 2,
      enabled: true,
    };

    const result = AgentRoutingConfigSchema.safeParse(validConfig);
    expect(result.success).toBe(true);
  });

  it("rejects invalid domain weight (> 1)", () => {
    const invalidConfig = {
      capabilities: ["javascript"],
      domains: {
        frontend: 1.5,
      },
      enabled: true,
    };

    const result = AgentRoutingConfigSchema.safeParse(invalidConfig);
    expect(result.success).toBe(false);
  });

  it("rejects invalid domain weight (< 0)", () => {
    const invalidConfig = {
      capabilities: ["javascript"],
      domains: {
        frontend: -0.5,
      },
      enabled: true,
    };

    const result = AgentRoutingConfigSchema.safeParse(invalidConfig);
    expect(result.success).toBe(false);
  });

  it("rejects maxConcurrent < 1", () => {
    const invalidConfig = {
      capabilities: ["javascript"],
      maxConcurrent: 0,
      enabled: true,
    };

    const result = AgentRoutingConfigSchema.safeParse(invalidConfig);
    expect(result.success).toBe(false);
  });

  it("rejects non-integer maxConcurrent", () => {
    const invalidConfig = {
      capabilities: ["javascript"],
      maxConcurrent: 1.5,
      enabled: true,
    };

    const result = AgentRoutingConfigSchema.safeParse(invalidConfig);
    expect(result.success).toBe(false);
  });

  it("provides defaults for missing fields", () => {
    const minimalConfig = {
      enabled: true,
    };

    const result = AgentRoutingConfigSchema.safeParse(minimalConfig);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.capabilities).toEqual([]);
    }
  });

  it("rejects empty capability strings", () => {
    const invalidConfig = {
      capabilities: ["valid", ""],
      enabled: true,
    };

    const result = AgentRoutingConfigSchema.safeParse(invalidConfig);
    expect(result.success).toBe(false);
  });

  it("trims and lowercases capability strings", () => {
    const config = {
      capabilities: ["  JavaScript  ", "REACT", "TypeScript"],
      enabled: true,
    };

    const result = AgentRoutingConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.capabilities).toEqual(["javascript", "react", "typescript"]);
    }
  });

  it("removes duplicate capabilities", () => {
    const config = {
      capabilities: ["javascript", "react", "JavaScript", "REACT"],
      enabled: true,
    };

    const result = AgentRoutingConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.capabilities).toEqual(["javascript", "react"]);
    }
  });

  it("applies maxConcurrent default of 1", () => {
    const config = {
      capabilities: ["javascript"],
      enabled: true,
    };

    const result = AgentRoutingConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.maxConcurrent).toBe(1);
    }
  });

  it("handles enabled: false", () => {
    const config = {
      capabilities: ["javascript"],
      enabled: false,
    };

    const result = AgentRoutingConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.enabled).toBe(false);
    }
  });
});

describe("AgentDomainWeightsSchema", () => {
  it("validates all domain fields", () => {
    const validWeights = {
      frontend: 0.9,
      backend: 0.8,
      testing: 0.7,
      refactoring: 0.85,
      debugging: 0.95,
      architecture: 0.6,
      devops: 0.5,
    };

    const result = AgentDomainWeightsSchema.safeParse(validWeights);
    expect(result.success).toBe(true);
  });

  it("allows partial domain weights", () => {
    const partialWeights = {
      frontend: 0.9,
    };

    const result = AgentDomainWeightsSchema.safeParse(partialWeights);
    expect(result.success).toBe(true);
  });

  it("allows empty domain weights", () => {
    const emptyWeights = {};

    const result = AgentDomainWeightsSchema.safeParse(emptyWeights);
    expect(result.success).toBe(true);
  });
});

describe("opencode TUI environment", () => {
  it("sets COLORFGBG to bypass termenv OSC 11 background color query", () => {
    const config = getAgentConfig("opencode");
    expect(config?.env?.COLORFGBG).toBe("15;0");
  });
});

describe("model configuration", () => {
  it("claude has models with expected IDs", () => {
    const config = getAgentConfig("claude");
    expect(config?.models).toBeDefined();
    expect(config!.models!.length).toBeGreaterThanOrEqual(3);
    const modelIds = config!.models!.map((m) => m.id);
    expect(modelIds).toContain("claude-sonnet-4-6");
    expect(modelIds).toContain("claude-opus-4-6");
    expect(modelIds).toContain("claude-haiku-4-5-20251001");
  });

  it("gemini has models", () => {
    const config = getAgentConfig("gemini");
    expect(config?.models).toBeDefined();
    expect(config!.models!.length).toBeGreaterThanOrEqual(2);
    const modelIds = config!.models!.map((m) => m.id);
    expect(modelIds).toContain("gemini-2.5-pro");
    expect(modelIds).toContain("gemini-2.5-flash");
  });

  it("codex has models", () => {
    const config = getAgentConfig("codex");
    expect(config?.models).toBeDefined();
    expect(config!.models!.length).toBeGreaterThanOrEqual(1);
    const modelIds = config!.models!.map((m) => m.id);
    expect(modelIds).toContain("gpt-5.4");
    expect(modelIds).toContain("gpt-5.3-codex-spark");
  });

  it("each model has id, name, and shortLabel", () => {
    for (const id of getAgentIds()) {
      const config = getAgentConfig(id);
      if (config?.models) {
        for (const model of config.models) {
          expect(model.id).toBeTruthy();
          expect(model.name).toBeTruthy();
          expect(model.shortLabel).toBeTruthy();
        }
      }
    }
  });

  it("agents without models have undefined models field", () => {
    const config = getAgentConfig("cursor");
    expect(config?.models).toBeUndefined();
  });
});

describe("getAgentModelConfig", () => {
  it("returns model config for valid agent and model ID", () => {
    const model = getAgentModelConfig("claude", "claude-opus-4-6");
    expect(model).toBeDefined();
    expect(model!.name).toBe("Opus 4.6");
    expect(model!.shortLabel).toBe("Opus");
  });

  it("returns undefined for invalid model ID", () => {
    expect(getAgentModelConfig("claude", "nonexistent-model")).toBeUndefined();
  });

  it("returns undefined for agent without models", () => {
    expect(getAgentModelConfig("cursor", "some-model")).toBeUndefined();
  });
});

describe("getAgentDisplayTitle", () => {
  it("returns agent name with model shortLabel when modelId matches", () => {
    expect(getAgentDisplayTitle("claude", "claude-opus-4-6")).toBe("Claude (Opus)");
  });

  it("returns plain agent name when no modelId provided", () => {
    expect(getAgentDisplayTitle("claude")).toBe("Claude");
  });

  it("returns plain agent name when modelId does not match", () => {
    expect(getAgentDisplayTitle("claude", "nonexistent")).toBe("Claude");
  });

  it("returns plain agent name for agent without models", () => {
    expect(getAgentDisplayTitle("cursor", "some-model")).toBe("Cursor");
  });
});

describe("blockAltScreen capabilities", () => {
  it("opencode allows alt screen for Bubble Tea TUI", () => {
    const config = getAgentConfig("opencode");
    expect(config?.capabilities?.blockAltScreen).toBe(false);
  });

  it("codex blocks alt screen (uses inline mode)", () => {
    const config = getAgentConfig("codex");
    expect(config?.capabilities?.blockAltScreen).toBe(true);
  });

  it("claude does not explicitly set blockAltScreen (defaults to false)", () => {
    const config = getAgentConfig("claude");
    expect(config?.capabilities?.blockAltScreen).toBeUndefined();
  });

  it("gemini blocks alt screen", () => {
    const config = getAgentConfig("gemini");
    expect(config?.capabilities?.blockAltScreen).toBe(true);
  });
});

describe("resume configuration", () => {
  it("all built-in agents with shutdown config also have resume config", () => {
    const ids = getAgentIds();
    for (const id of ids) {
      const config = getAgentConfig(id);
      if (config?.shutdown) {
        expect(config.resume).toBeDefined();
        expect(typeof config.resume?.args).toBe("function");
      }
    }
  });

  it("claude produces --resume flag args", () => {
    const config = getAgentConfig("claude");
    expect(config?.resume?.args("abc-123")).toEqual(["--resume", "abc-123"]);
  });

  it("gemini produces --resume flag args", () => {
    const config = getAgentConfig("gemini");
    expect(config?.resume?.args("abc-123")).toEqual(["--resume", "abc-123"]);
  });

  it("codex produces resume subcommand args (no leading dash)", () => {
    const config = getAgentConfig("codex");
    const args = config?.resume?.args("abc-123");
    expect(args).toEqual(["resume", "abc-123"]);
    expect(args?.[0]).not.toMatch(/^-/);
  });

  it("opencode produces -s flag args", () => {
    const config = getAgentConfig("opencode");
    expect(config?.resume?.args("ses_abc")).toEqual(["-s", "ses_abc"]);
  });
});

describe("titleStatePatterns", () => {
  it("gemini has titleStatePatterns with working and waiting arrays", () => {
    const config = getAgentConfig("gemini");
    expect(config?.detection?.titleStatePatterns).toBeDefined();
    expect(config!.detection!.titleStatePatterns!.working).toEqual(["\u2726"]);
    expect(config!.detection!.titleStatePatterns!.waiting).toEqual(["\u25C7", "\u270B"]);
  });

  it("non-gemini agents do not have titleStatePatterns", () => {
    const claude = getAgentConfig("claude");
    expect(claude?.detection?.titleStatePatterns).toBeUndefined();

    const codex = getAgentConfig("codex");
    expect(codex?.detection?.titleStatePatterns).toBeUndefined();
  });

  it("user registry merge does not remove built-in titleStatePatterns", () => {
    setUserRegistry({
      gemini: {
        id: "gemini",
        name: "Gemini Custom",
        command: "gemini",
        args: [],
        iconId: "gemini",
        color: "green",
        supportsContextInjection: false,
      } as AgentConfig,
    });
    const effective = getEffectiveAgentConfig("gemini");
    expect(effective?.detection?.titleStatePatterns).toBeDefined();
    expect(effective!.detection!.titleStatePatterns!.working).toEqual(["\u2726"]);
  });
});

describe("gemini metadata", () => {
  it("has correct npm package name", () => {
    const config = getAgentConfig("gemini");
    expect(config?.version?.npmPackage).toBe("@google/gemini-cli");
  });

  it("has correct GitHub repo", () => {
    const config = getAgentConfig("gemini");
    expect(config?.version?.githubRepo).toBe("google-gemini/gemini-cli");
  });

  it("has correct release notes URL", () => {
    const config = getAgentConfig("gemini");
    expect(config?.version?.releaseNotesUrl).toBe(
      "https://github.com/google-gemini/gemini-cli/releases"
    );
  });

  it("has correct npm update command", () => {
    const config = getAgentConfig("gemini");
    expect(config?.update?.npm).toBe("npm install -g @google/gemini-cli@latest");
  });

  it("has correct install docs URL", () => {
    const config = getAgentConfig("gemini");
    expect(config?.install?.docsUrl).toBe("https://github.com/google-gemini/gemini-cli#readme");
  });

  it("has correct install commands for all platforms", () => {
    const config = getAgentConfig("gemini");
    for (const os of ["macos", "windows", "linux"] as const) {
      const commands = config?.install?.byOs?.[os]?.[0]?.commands;
      expect(commands).toContain("npm install -g @google/gemini-cli");
    }
  });

  it("has correct prerequisite install URL", () => {
    const config = getAgentConfig("gemini");
    const prereq = config?.prerequisites?.find((p) => p.tool === "gemini");
    expect(prereq?.installUrl).toBe("https://github.com/google-gemini/gemini-cli#readme");
  });
});

describe("DEFAULT_ROUTING_CONFIG", () => {
  it("has empty capabilities", () => {
    expect(DEFAULT_ROUTING_CONFIG.capabilities).toEqual([]);
  });

  it("is enabled by default", () => {
    expect(DEFAULT_ROUTING_CONFIG.enabled).toBe(true);
  });

  it("has maxConcurrent of 1", () => {
    expect(DEFAULT_ROUTING_CONFIG.maxConcurrent).toBe(1);
  });
});

describe("cursor detection patterns", () => {
  function compileAgentPatterns(agentId: string, key: string): RegExp[] {
    const config = getAgentConfig(agentId);
    const patterns = config?.detection?.[key as keyof typeof config.detection] as
      | string[]
      | undefined;
    return (patterns ?? []).map((p: string) => new RegExp(p, "im"));
  }

  describe("primaryPatterns", () => {
    it.each([
      "⬢Thinking about the code",
      "⬢ Reading files",
      "⬢Searching codebase",
      "⬢ Planning approach",
      "⬢Running tests",
      "⬢Executing command",
      "⬢Grepping for pattern",
      "⬢Editing file.ts",
      "⬢ Listing files",
    ])("matches working output: %s", (line) => {
      const patterns = compileAgentPatterns("cursor", "primaryPatterns");
      expect(patterns.some((p) => p.test(line))).toBe(true);
    });

    it("matches 'esc to stop' hint", () => {
      const patterns = compileAgentPatterns("cursor", "primaryPatterns");
      expect(patterns.some((p) => p.test("esc to stop"))).toBe(true);
    });
  });

  describe("completionPatterns", () => {
    it.each([
      "⬢Thought3s",
      "⬢ Thought 3s",
      "⬢Read 2 files, 1 directory1s",
      "⬢ Read App.tsx 1s",
      "⬢Planned approach2s",
      "⬢Searched codebase",
      "⬢Ran tests",
      "⬢Edited foo.ts",
      "⬢Grepped src",
      "⬢Listed files",
    ])("matches completion output: %s", (line) => {
      const patterns = compileAgentPatterns("cursor", "completionPatterns");
      expect(patterns.some((p) => p.test(line))).toBe(true);
    });

    it("does not match present-tense verbs", () => {
      const patterns = compileAgentPatterns("cursor", "completionPatterns");
      expect(patterns.some((p) => p.test("⬢Thinking about code"))).toBe(false);
      expect(patterns.some((p) => p.test("⬢Reading files"))).toBe(false);
    });
  });

  describe("fallbackPatterns", () => {
    it("matches hexagon with zero whitespace", () => {
      const patterns = compileAgentPatterns("cursor", "fallbackPatterns");
      expect(patterns.some((p) => p.test("⬢Processing"))).toBe(true);
    });

    it("matches hexagon with whitespace", () => {
      const patterns = compileAgentPatterns("cursor", "fallbackPatterns");
      expect(patterns.some((p) => p.test("⬢ Processing"))).toBe(true);
    });
  });
});

describe("cursor install metadata", () => {
  it("has Windows install block with correct PowerShell command", () => {
    const config = getAgentConfig("cursor");
    const windows = config?.install?.byOs?.windows;
    expect(windows).toBeDefined();
    expect(windows).toHaveLength(1);
    expect(windows![0].label).toBe("PowerShell");
    expect(windows![0].commands).toEqual(["irm 'https://cursor.com/install?win32=true' | iex"]);
  });

  it("has install blocks for all three platforms", () => {
    const config = getAgentConfig("cursor");
    for (const os of ["macos", "linux", "windows"] as const) {
      expect(config?.install?.byOs?.[os]).toBeDefined();
      expect(config?.install?.byOs?.[os]!.length).toBeGreaterThan(0);
    }
  });
});

describe("all built-in agents have Windows or generic install", () => {
  it.each(["claude", "gemini", "codex", "opencode", "cursor"])(
    "%s has windows or generic install block",
    (agentId) => {
      const config = getAgentConfig(agentId);
      const hasWindows = (config?.install?.byOs?.windows?.length ?? 0) > 0;
      const hasGeneric = (config?.install?.byOs?.generic?.length ?? 0) > 0;
      expect(hasWindows || hasGeneric).toBe(true);
    }
  );
});

describe("ASSISTANT_FAST_MODELS", () => {
  it("has entries for claude, gemini, and codex", () => {
    expect(ASSISTANT_FAST_MODELS).toHaveProperty("claude");
    expect(ASSISTANT_FAST_MODELS).toHaveProperty("gemini");
    expect(ASSISTANT_FAST_MODELS).toHaveProperty("codex");
  });

  it("each fast model ID exists in the agent's models array", () => {
    for (const [agentId, modelId] of Object.entries(ASSISTANT_FAST_MODELS)) {
      const config = getAgentConfig(agentId);
      const modelIds = config?.models?.map((m) => m.id) ?? [];
      expect(modelIds).toContain(modelId);
    }
  });
});

describe("opencode detection patterns", () => {
  function compileAgentPatterns(agentId: string, key: string): RegExp[] {
    const config = getAgentConfig(agentId);
    const patterns = config?.detection?.[key as keyof typeof config.detection] as
      | string[]
      | undefined;
    return (patterns ?? []).map((p: string) => new RegExp(p, "im"));
  }

  describe("primaryPatterns", () => {
    it.each([
      "⣾ Processing files (esc to cancel)",
      "⣽ Reading files (press esc to cancel)",
      "⢿ Analyzing code (esc)",
    ])("matches Dot spinner with esc hint: %s", (line) => {
      const patterns = compileAgentPatterns("opencode", "primaryPatterns");
      expect(patterns.some((p) => p.test(line))).toBe(true);
    });

    it.each(["● Generating", "• Building tool call", "· Waiting for tool response"])(
      "matches Pulse spinner with task string: %s",
      (line) => {
        const patterns = compileAgentPatterns("opencode", "primaryPatterns");
        expect(patterns.some((p) => p.test(line))).toBe(true);
      }
    );

    it("does not match Pulse spinner with generic text", () => {
      const patterns = compileAgentPatterns("opencode", "primaryPatterns");
      expect(patterns.some((p) => p.test("· some random text"))).toBe(false);
      expect(patterns.some((p) => p.test("• loading resources"))).toBe(false);
    });

    it.each(["press esc to exit cancel", "Press Esc again to interrupt", "press esc to cancel"])(
      "matches interrupt/cancel hint: %s",
      (line) => {
        const patterns = compileAgentPatterns("opencode", "primaryPatterns");
        expect(patterns.some((p) => p.test(line))).toBe(true);
      }
    );

    it("does not match old Gemini braille spinners in spinner patterns", () => {
      const config = getAgentConfig("opencode");
      const spinnerPatterns = (config?.detection?.primaryPatterns ?? [])
        .filter((p: string) => p.startsWith("["))
        .map((p: string) => new RegExp(p, "im"));
      expect(spinnerPatterns.some((p) => p.test("⠋ Processing files (esc to cancel)"))).toBe(false);
    });
  });

  describe("fallbackPatterns", () => {
    it.each(["⣾ working", "⣷ processing", "Generating...", "waiting for tool response"])(
      "matches fallback output: %s",
      (line) => {
        const patterns = compileAgentPatterns("opencode", "fallbackPatterns");
        expect(patterns.some((p) => p.test(line))).toBe(true);
      }
    );

    it("does not match old Gemini braille spinners", () => {
      const patterns = compileAgentPatterns("opencode", "fallbackPatterns");
      expect(patterns.some((p) => p.test("⠋ working"))).toBe(false);
    });
  });
});
