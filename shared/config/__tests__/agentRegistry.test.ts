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
