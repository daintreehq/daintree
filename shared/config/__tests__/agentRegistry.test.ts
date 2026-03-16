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
