import { describe, it, expect, beforeEach, afterEach } from "vitest";
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
  getAgentPreset,
  setAgentPresets,
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
      expect(ids).toContain("copilot");
      expect(ids).toContain("goose");
      expect(ids).toContain("crush");
      expect(ids).toContain("qwen");
      expect(ids).toContain("interpreter");
      expect(ids).toContain("mistral");
      expect(ids).toContain("kimi");
      expect(ids).toContain("amp");
      expect(ids).toContain("aider");
    });

    it("kiro only has macOS and Linux install blocks (no Windows)", () => {
      const config = getAgentConfig("kiro");
      expect(config?.install?.byOs?.macos?.length).toBeGreaterThan(0);
      expect(config?.install?.byOs?.linux?.length).toBeGreaterThan(0);
      expect(config?.install?.byOs?.windows).toBeUndefined();
    });

    it("crush only has macOS and Linux install blocks (no Windows)", () => {
      const config = getAgentConfig("crush");
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

describe("mistral configuration", () => {
  it("uses 'vibe' as the binary command", () => {
    expect(getAgentConfig("mistral")?.command).toBe("vibe");
  });

  it("passes --trust by default to skip the trust-folder prompt", () => {
    expect(getAgentConfig("mistral")?.args).toContain("--trust");
  });

  it("blocks alt-screen and mouse reporting for the Textual TUI", () => {
    const config = getAgentConfig("mistral");
    expect(config?.capabilities?.blockAltScreen).toBe(true);
    expect(config?.capabilities?.blockMouseReporting).toBe(true);
    expect(config?.capabilities?.resizeStrategy).toBe("settled");
  });

  it("uses /exit as the quitCommand (Vibe has no /quit alias)", () => {
    const resume = getAgentConfig("mistral")?.resume;
    expect(resume?.kind).toBe("session-id");
    if (resume?.kind === "session-id") {
      expect(resume.quitCommand).toBe("/exit");
      expect(resume.args("abc-123-def-456")).toEqual(["--resume", "abc-123-def-456"]);
    }
  });

  it("captures session IDs from 'vibe --resume {id}' output", () => {
    const resume = getAgentConfig("mistral")?.resume;
    if (resume?.kind === "session-id") {
      const re = new RegExp(resume.sessionIdPattern);
      const match = "Or: vibe --resume abc-123-def-456".match(re);
      expect(match?.[1]).toBe("abc-123-def-456");
      expect("vibe --continue".match(re)).toBeNull();
    }
  });

  it("relies on prompt fast-path with no completion patterns", () => {
    const detection = getAgentConfig("mistral")?.detection;
    expect(detection?.completionPatterns).toBeUndefined();
    expect(detection?.promptFastPathMinQuietMs).toBe(700);
  });

  it("declares the PyPI package for path synthesis", () => {
    expect(getAgentConfig("mistral")?.packages?.pypi).toBe("mistral-vibe");
  });

  it("ships the local-llamacpp preset as a labeled placeholder", () => {
    const preset = getAgentConfig("mistral")?.presets?.find((p) => p.id === "local-llamacpp");
    expect(preset).toBeDefined();
    expect(preset?.name).toBe("Local (llama.cpp)");
  });
});

describe("copilot configuration", () => {
  it("has 160k context window", () => {
    expect(getAgentConfig("copilot")?.contextWindow).toBe(160_000);
  });

  it("has models with claude-sonnet-4.6 as first (default)", () => {
    const config = getAgentConfig("copilot");
    expect(config?.models).toBeDefined();
    expect(config!.models![0]!.id).toBe("claude-sonnet-4.6");
    const modelIds = config!.models!.map((m) => m.id);
    expect(modelIds).toContain("gpt-5.4");
    expect(modelIds).toContain("gemini-2.5-pro");
  });

  it("produces --resume=id args (equals concatenation)", () => {
    const config = getAgentConfig("copilot");
    expect(config?.resume?.kind).toBe("session-id");
    if (config?.resume?.kind === "session-id") {
      expect(config.resume.args("abc-def-123")).toEqual(["--resume=abc-def-123"]);
    }
  });

  it("has npm install for all platforms including Windows", () => {
    const config = getAgentConfig("copilot");
    for (const os of ["macos", "linux", "windows"] as const) {
      const commands = config?.install?.byOs?.[os]?.[0]?.commands;
      expect(commands).toContain("npm install -g @github/copilot");
    }
  });

  it("uses blockMouseReporting and settled resize for alt-screen TUI", () => {
    const config = getAgentConfig("copilot");
    expect(config?.capabilities?.blockMouseReporting).toBe(true);
    expect(config?.capabilities?.resizeStrategy).toBe("settled");
    expect(config?.capabilities?.blockAltScreen).toBeUndefined();
  });

  it("has correct npm package and GitHub repo", () => {
    const config = getAgentConfig("copilot");
    expect(config?.version?.npmPackage).toBe("@github/copilot");
    expect(config?.version?.githubRepo).toBe("github/copilot-cli");
  });
});

describe("kimi configuration", () => {
  it("has display name 'Kimi Code'", () => {
    expect(getAgentConfig("kimi")?.name).toBe("Kimi Code");
  });

  it("has command 'kimi' (matching the binary name)", () => {
    expect(getAgentConfig("kimi")?.command).toBe("kimi");
  });

  it("declares kimi-cli as the PyPI package", () => {
    expect(getAgentConfig("kimi")?.packages?.pypi).toBe("kimi-cli");
  });

  it("does not use the deprecated npmGlobalPackage field", () => {
    expect(getAgentConfig("kimi")?.npmGlobalPackage).toBeUndefined();
  });

  it("spawns with no subcommand (args is empty)", () => {
    expect(getAgentConfig("kimi")?.args).toEqual([]);
  });

  it("does not block alt screen (inline rendering via prompt_toolkit)", () => {
    expect(getAgentConfig("kimi")?.capabilities?.blockAltScreen).toBeUndefined();
  });

  it("has uv install for all platforms including Windows", () => {
    const config = getAgentConfig("kimi");
    for (const os of ["macos", "linux", "windows"] as const) {
      const commands = config?.install?.byOs?.[os]?.[0]?.commands;
      expect(commands).toContain("uv tool install kimi-cli");
    }
  });

  it("has authCheck for KIMI_API_KEY and OAuth credential file", () => {
    const config = getAgentConfig("kimi");
    expect(config?.authCheck?.envVar).toContain("KIMI_API_KEY");
    expect(config?.authCheck?.configPathsAll).toContain(".kimi/config.toml");
    expect(config?.authCheck?.configPathsAll).toContain(".kimi/credentials/kimi-code.json");
  });
});

describe("kimi detection patterns", () => {
  function compilePatterns(key: string): RegExp[] {
    const config = getAgentConfig("kimi");
    const patterns = config?.detection?.[key as keyof typeof config.detection] as
      | string[]
      | undefined;
    return (patterns ?? []).map((p: string) => new RegExp(p, "im"));
  }

  it.each(["✨", "💫", "📋", "$"])("matches prompt glyph %s", (glyph) => {
    const patterns = compilePatterns("promptPatterns");
    expect(patterns.some((p) => p.test(`${glyph} `))).toBe(true);
  });

  it("matches braille spinner with task description (primary)", () => {
    const patterns = compilePatterns("primaryPatterns");
    expect(patterns.some((p) => p.test("⠋ Thinking about the request"))).toBe(true);
  });

  it("matches braille spinner with single word (fallback)", () => {
    const patterns = compilePatterns("fallbackPatterns");
    expect(patterns.some((p) => p.test("⠹ Working"))).toBe(true);
  });
});

describe("amp configuration", () => {
  it("has the verified Sourcegraph brand color", () => {
    expect(getAgentConfig("amp")?.color).toBe("#F34E3F");
  });

  it("uses the amp command and Amp display name", () => {
    const config = getAgentConfig("amp");
    expect(config?.command).toBe("amp");
    expect(config?.name).toBe("Amp");
  });

  it("declares the @sourcegraph/amp npm package", () => {
    expect(getAgentConfig("amp")?.packages?.npm).toBe("@sourcegraph/amp");
  });

  it("probes ~/.amp/bin/amp as a native install path", () => {
    expect(getAgentConfig("amp")?.nativePaths).toContain("~/.amp/bin/amp");
  });

  it("declares supportsWsl for Windows diagnostics", () => {
    expect(getAgentConfig("amp")?.supportsWsl).toBe(true);
  });

  it("has install blocks for all three platforms", () => {
    const config = getAgentConfig("amp");
    for (const os of ["macos", "linux", "windows"] as const) {
      expect(config?.install?.byOs?.[os]).toBeDefined();
      expect(config?.install?.byOs?.[os]!.length).toBeGreaterThan(0);
    }
  });

  it("offers both curl and npm install on macOS and Linux", () => {
    const config = getAgentConfig("amp");
    for (const os of ["macos", "linux"] as const) {
      const labels = config?.install?.byOs?.[os]?.map((b) => b.label);
      expect(labels).toContain("curl");
      expect(labels).toContain("npm");
    }
  });

  it("uses settled resize and blocks mouse reporting for the Ink TUI", () => {
    const caps = getAgentConfig("amp")?.capabilities;
    expect(caps?.blockMouseReporting).toBe(true);
    expect(caps?.resizeStrategy).toBe("settled");
    expect(caps?.blockAltScreen).toBeUndefined();
  });

  it("ships empty primary and fallback patterns pending on-device capture", () => {
    const detection = getAgentConfig("amp")?.detection;
    expect(detection?.primaryPatterns).toEqual([]);
    expect(detection?.fallbackPatterns).toEqual([]);
  });

  it("compiles all detection regex strings without throwing", () => {
    const detection = getAgentConfig("amp")?.detection;
    const buckets: Array<string[] | undefined> = [
      detection?.primaryPatterns,
      detection?.fallbackPatterns,
      detection?.bootCompletePatterns,
      detection?.promptPatterns,
      detection?.promptHintPatterns,
      detection?.completionPatterns,
    ];
    for (const bucket of buckets) {
      for (const pattern of bucket ?? []) {
        expect(() => new RegExp(pattern, "im")).not.toThrow();
      }
    }
  });

  it("anchored promptHintPatterns reject chevrons embedded in tool output", () => {
    const patterns = (getAgentConfig("amp")?.detection?.promptHintPatterns ?? []).map(
      (p) => new RegExp(p, "im")
    );
    // The empty-prompt hint is the load-bearing signal — it must NOT match
    // citation chevrons or shell-style hints inside tool results.
    expect(patterns.some((p) => p.test("> "))).toBe(true);
    expect(patterns.some((p) => p.test("> npm test"))).toBe(false);
    expect(patterns.some((p) => p.test("> ls -la"))).toBe(false);
  });

  it("omits models — Amp mode-switching is TUI-internal", () => {
    expect(getAgentConfig("amp")?.models).toBeUndefined();
  });

  it("omits providerTemplates — Amp uses a single managed backend", () => {
    expect(getAgentConfig("amp")?.providerTemplates).toBeUndefined();
  });

  it("omits contextWindow — no published limit", () => {
    expect(getAgentConfig("amp")?.contextWindow).toBeUndefined();
  });

  it("resumes via `threads continue <id>` and exits on Ctrl+C", () => {
    const resume = getAgentConfig("amp")?.resume;
    expect(resume?.kind).toBe("named-target");
    if (resume?.kind === "named-target") {
      expect(resume.argsForTarget("T-abc123")).toEqual(["threads", "continue", "T-abc123"]);
      expect(resume.shutdownKeySequence).toBe("\x03");
      expect(resume.quitCommand).toBeUndefined();
    }
  });

  it("probes ~/.amp/oauth and AMP_API_KEY for auth discovery", () => {
    const auth = getAgentConfig("amp")?.authCheck;
    expect(auth?.configPathsAll).toContain(".amp/oauth");
    expect(auth?.envVar).toBe("AMP_API_KEY");
  });

  it("declares amp as a fatal CLI prerequisite with the install URL", () => {
    const prereq = getAgentConfig("amp")?.prerequisites?.find((p) => p.tool === "amp");
    expect(prereq?.severity).toBe("fatal");
    expect(prereq?.installUrl).toBe("https://ampcode.com/manual");
  });

  it("surfaces AMP_API_KEY and AMP_HOME env suggestions", () => {
    const keys = getAgentConfig("amp")?.envSuggestions?.map((s) => s.key) ?? [];
    expect(keys).toContain("AMP_API_KEY");
    expect(keys).toContain("AMP_HOME");
  });
});

describe("copilot detection patterns", () => {
  function compilePatterns(key: string): RegExp[] {
    const config = getAgentConfig("copilot");
    const patterns = config?.detection?.[key as keyof typeof config.detection] as
      | string[]
      | undefined;
    return (patterns ?? []).map((p: string) => new RegExp(p, "im"));
  }

  it("matches (Esc to cancel) primary pattern", () => {
    const patterns = compilePatterns("primaryPatterns");
    expect(patterns.some((p) => p.test("Thinking (Esc to cancel)"))).toBe(true);
    expect(patterns.some((p) => p.test("(Esc to cancel)"))).toBe(true);
  });

  it("matches spinner with Esc to cancel", () => {
    const patterns = compilePatterns("primaryPatterns");
    expect(patterns.some((p) => p.test("◉ Analyzing code (Esc to cancel)"))).toBe(true);
    expect(patterns.some((p) => p.test("∙ Reading files (Esc to cancel)"))).toBe(true);
  });

  it("matches fallback spinner patterns", () => {
    const patterns = compilePatterns("fallbackPatterns");
    expect(patterns.some((p) => p.test("◎ Processing"))).toBe(true);
    expect(patterns.some((p) => p.test("∘ Working"))).toBe(true);
  });

  it("matches prompt patterns", () => {
    const patterns = compilePatterns("promptPatterns");
    expect(patterns.some((p) => p.test("> "))).toBe(true);
    expect(patterns.some((p) => p.test(">"))).toBe(true);
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

describe("getAgentPreset", () => {
  afterEach(() => {
    setAgentPresets("claude", []);
  });

  it("returns undefined when agent has no presets", () => {
    expect(getAgentPreset("claude")).toBeUndefined();
  });

  it("returns first preset when no presetId specified", () => {
    setAgentPresets("claude", [
      { id: "default", name: "Default" },
      { id: "ccr-deep", name: "CCR DeepSeek" },
    ]);
    const preset = getAgentPreset("claude");
    expect(preset?.id).toBe("default");
  });

  it("returns preset matching presetId", () => {
    setAgentPresets("claude", [
      { id: "default", name: "Default" },
      { id: "ccr-deep", name: "CCR DeepSeek" },
    ]);
    const preset = getAgentPreset("claude", "ccr-deep");
    expect(preset?.name).toBe("CCR DeepSeek");
  });

  it("returns defaultPresetId preset when set", () => {
    setAgentPresets("claude", [
      { id: "default", name: "Default" },
      { id: "ccr-deep", name: "CCR DeepSeek" },
    ]);
    const config = getEffectiveAgentConfig("claude");
    config!.defaultPresetId = "ccr-deep";
    const preset = getAgentPreset("claude");
    expect(preset?.id).toBe("ccr-deep");
    delete config!.defaultPresetId;
  });

  it("returns undefined for unknown agent", () => {
    expect(getAgentPreset("nonexistent-agent")).toBeUndefined();
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
  it("session-id agents have a quitCommand and a sessionIdPattern", () => {
    const ids = getAgentIds();
    for (const id of ids) {
      const resume = getAgentConfig(id)?.resume;
      if (resume?.kind === "session-id") {
        expect(typeof resume.args).toBe("function");
        expect(resume.quitCommand).toBeTruthy();
        expect(resume.sessionIdPattern).toBeTruthy();
      }
    }
  });

  it("claude is session-id and produces --resume flag args", () => {
    const resume = getAgentConfig("claude")?.resume;
    expect(resume?.kind).toBe("session-id");
    if (resume?.kind === "session-id") {
      expect(resume.args("abc-123")).toEqual(["--resume", "abc-123"]);
    }
  });

  it("gemini is session-id and produces --resume flag args", () => {
    const resume = getAgentConfig("gemini")?.resume;
    expect(resume?.kind).toBe("session-id");
    if (resume?.kind === "session-id") {
      expect(resume.args("abc-123")).toEqual(["--resume", "abc-123"]);
    }
  });

  it("qwen is session-id and produces --resume flag args", () => {
    const resume = getAgentConfig("qwen")?.resume;
    expect(resume?.kind).toBe("session-id");
    if (resume?.kind === "session-id") {
      expect(resume.args("abc-123")).toEqual(["--resume", "abc-123"]);
      expect(resume.quitCommand).toBe("/quit");
      expect(resume.sessionIdPattern).toBe("qwen --resume ([\\w-]+)");
    }
  });

  it("codex is session-id and produces resume subcommand args (no leading dash)", () => {
    const resume = getAgentConfig("codex")?.resume;
    expect(resume?.kind).toBe("session-id");
    if (resume?.kind === "session-id") {
      const args = resume.args("abc-123");
      expect(args).toEqual(["resume", "abc-123"]);
      expect(args[0]).not.toMatch(/^-/);
    }
  });

  it("copilot is session-id and produces --resume= flag args (equals concatenation)", () => {
    const resume = getAgentConfig("copilot")?.resume;
    expect(resume?.kind).toBe("session-id");
    if (resume?.kind === "session-id") {
      expect(resume.args("abc-123")).toEqual(["--resume=abc-123"]);
    }
  });

  it("opencode is session-id and produces -s flag args", () => {
    const resume = getAgentConfig("opencode")?.resume;
    expect(resume?.kind).toBe("session-id");
    if (resume?.kind === "session-id") {
      expect(resume.args("ses_abc")).toEqual(["-s", "ses_abc"]);
    }
  });

  it("kiro is project-scoped and produces --resume args without an ID", () => {
    const resume = getAgentConfig("kiro")?.resume;
    expect(resume?.kind).toBe("project-scoped");
    if (resume?.kind === "project-scoped") {
      expect(resume.args()).toEqual(["--resume"]);
      expect(resume.quitCommand).toBe("/quit");
    }
  });

  it("kimi is rolling-history and produces --continue args", () => {
    const resume = getAgentConfig("kimi")?.resume;
    expect(resume?.kind).toBe("rolling-history");
    if (resume?.kind === "rolling-history") {
      expect(resume.args()).toEqual(["--continue"]);
      expect(resume.quitCommand).toBe("/exit");
    }
  });

  it("cursor has no resume config (no session resume model)", () => {
    expect(getAgentConfig("cursor")?.resume).toBeUndefined();
  });

  it("goose is session-id and produces session subcommand resume args", () => {
    const resume = getAgentConfig("goose")?.resume;
    expect(resume?.kind).toBe("session-id");
    if (resume?.kind === "session-id") {
      expect(resume.args("20260429_1")).toEqual([
        "session",
        "--resume",
        "--session-id",
        "20260429_1",
      ]);
      expect(resume.quitCommand).toBe("/exit");
    }
  });

  it("goose sessionIdPattern extracts the id from the session-closed line", () => {
    const resume = getAgentConfig("goose")?.resume;
    expect(resume?.kind).toBe("session-id");
    if (resume?.kind === "session-id") {
      const re = new RegExp(resume.sessionIdPattern);
      const match = re.exec("● session closed · 20260429_1");
      expect(match?.[1]).toBe("20260429_1");
    }
  });
});

describe("titleStatePatterns", () => {
  it("gemini has titleStatePatterns with working and waiting arrays", () => {
    const config = getAgentConfig("gemini");
    expect(config?.detection?.titleStatePatterns).toBeDefined();
    expect(config!.detection!.titleStatePatterns!.working).toEqual(["\u2726"]);
    expect(config!.detection!.titleStatePatterns!.waiting).toEqual(["\u25C7", "\u270B"]);
  });

  it("qwen inherits Gemini's Ink TUI title-state glyphs", () => {
    const config = getAgentConfig("qwen");
    expect(config?.detection?.titleStatePatterns).toBeDefined();
    expect(config!.detection!.titleStatePatterns!.working).toEqual(["\u2726"]);
    expect(config!.detection!.titleStatePatterns!.waiting).toEqual(["\u25C7", "\u270B"]);
  });

  it("agents without an Ink TUI do not have titleStatePatterns", () => {
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
    expect(windows![0]!.label).toBe("PowerShell");
    expect(windows![0]!.commands).toEqual(["irm 'https://cursor.com/install?win32=true' | iex"]);
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
  it.each([
    "claude",
    "gemini",
    "codex",
    "opencode",
    "cursor",
    "copilot",
    "goose",
    "qwen",
    "interpreter",
    "mistral",
    "kimi",
    "amp",
    "aider",
  ])("%s has windows or generic install block", (agentId) => {
    const config = getAgentConfig(agentId);
    const hasWindows = (config?.install?.byOs?.windows?.length ?? 0) > 0;
    const hasGeneric = (config?.install?.byOs?.generic?.length ?? 0) > 0;
    expect(hasWindows || hasGeneric).toBe(true);
  });
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

describe("claude providerTemplates descriptions", () => {
  const expected: Record<string, { name: string; description: string }> = {
    "anthropic-native": {
      name: "Anthropic (native)",
      description: "Direct Anthropic API connection.",
    },
    zai: { name: "Z.AI", description: "Anthropic-compatible via Z.AI." },
    openrouter: { name: "OpenRouter", description: "Model routing via OpenRouter." },
    deepseek: { name: "DeepSeek", description: "OpenAI-compatible via DeepSeek." },
    ollama: {
      name: "Ollama (local)",
      description: "Local models via Ollama — no API key needed.",
    },
    "custom-openai": {
      name: "Custom (OpenAI-compatible)",
      description: "Custom OpenAI-compatible endpoint.",
    },
  };

  it("has all six provider templates with the expected ids", () => {
    const templates = getAgentConfig("claude")?.providerTemplates ?? [];
    const ids = templates.map((t) => t.id);
    expect(ids).toEqual(Object.keys(expected));
  });

  it("all provider template ids are unique", () => {
    const templates = getAgentConfig("claude")?.providerTemplates ?? [];
    const ids = templates.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it.each(Object.entries(expected))("%s has the expected name and short caption", (id, meta) => {
    const template = getAgentConfig("claude")?.providerTemplates?.find((t) => t.id === id);
    expect(template?.name).toBe(meta.name);
    expect(template?.description).toBe(meta.description);
  });

  it("all descriptions fit a short caption (<= 60 chars)", () => {
    const templates = getAgentConfig("claude")?.providerTemplates ?? [];
    for (const template of templates) {
      expect(template.description).toBeTruthy();
      expect(template.description!.length).toBeLessThanOrEqual(60);
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

describe("aider configuration", () => {
  it("uses pypi packaging with aider-chat", () => {
    const config = getAgentConfig("aider");
    expect(config?.packages?.pypi).toBe("aider-chat");
    expect(config?.packages?.brew).toBe("aider");
  });

  it("looks up version from PyPI", () => {
    const config = getAgentConfig("aider");
    expect(config?.version?.pypiPackage).toBe("aider-chat");
    expect(config?.version?.githubRepo).toBe("Aider-AI/aider");
  });

  it("defaults --no-auto-commits to keep worktree commits clean", () => {
    const config = getAgentConfig("aider");
    expect(config?.args).toContain("--no-auto-commits");
  });

  it("does not duplicate ~/.local/bin paths covered by pypi synthesis", () => {
    const config = getAgentConfig("aider");
    const paths = config?.nativePaths ?? [];
    expect(paths.some((p) => p.includes(".local/bin/aider"))).toBe(false);
    expect(paths).toContain("/opt/homebrew/bin/aider");
    expect(paths).toContain("/usr/local/bin/aider");
    expect(paths.some((p) => p.toLowerCase().includes("%userprofile%"))).toBe(true);
  });

  it("uses rolling-history resume with --restore-chat-history", () => {
    const resume = getAgentConfig("aider")?.resume;
    expect(resume?.kind).toBe("rolling-history");
    if (resume?.kind === "rolling-history") {
      expect(resume.args()).toEqual(["--restore-chat-history"]);
      expect(resume.quitCommand).toBe("/exit");
    }
  });

  it("streams to scrollback (no alt-screen block)", () => {
    const config = getAgentConfig("aider");
    expect(config?.capabilities?.blockAltScreen).toBe(false);
  });

  it("accepts any of the major provider env vars for auth", () => {
    const auth = getAgentConfig("aider")?.authCheck;
    expect(auth?.configPathsAll).toContain(".aider.conf.yml");
    const envVars = Array.isArray(auth?.envVar) ? auth?.envVar : [auth?.envVar];
    expect(envVars).toContain("OPENAI_API_KEY");
    expect(envVars).toContain("ANTHROPIC_API_KEY");
    // AIDER_*_API_KEY variants are documented in envSuggestions; auth must
    // recognise them so users who set only the AIDER_-prefixed key don't
    // see a stale "unauthenticated" nudge.
    expect(envVars).toContain("AIDER_OPENAI_API_KEY");
    expect(envVars).toContain("AIDER_ANTHROPIC_API_KEY");
  });
});

describe("goose detection patterns", () => {
  function compileAgentPatterns(agentId: string, key: string): RegExp[] {
    const config = getAgentConfig(agentId);
    const patterns = config?.detection?.[key as keyof typeof config.detection] as
      | string[]
      | undefined;
    return (patterns ?? []).map((p: string) => new RegExp(p, "im"));
  }

  describe("primaryPatterns", () => {
    it.each([
      "Thinking (Ctrl+C to interrupt)",
      "Generating response (Ctrl+C to interrupt)",
      "⠋ Reading files (Ctrl+C to interrupt)",
    ])("matches Ctrl+C interrupt hint: %s", (line) => {
      const patterns = compileAgentPatterns("goose", "primaryPatterns");
      expect(patterns.some((p) => p.test(line))).toBe(true);
    });

    it("does not match plain text without the interrupt hint", () => {
      const patterns = compileAgentPatterns("goose", "primaryPatterns");
      expect(patterns.some((p) => p.test("Thinking about something"))).toBe(false);
    });
  });

  describe("fallbackPatterns", () => {
    it.each([
      "⠋ Working",
      "⠙ Generating",
      "⠹ Reading",
      "⠸ Thinking",
      "⠼ Calling",
      "⠴ Streaming",
      "⠦ Planning",
      "⠧ Analyzing",
      "⠇ Searching",
      "⠏ Editing",
    ])("matches cliclack braille spinner: %s", (line) => {
      const patterns = compileAgentPatterns("goose", "fallbackPatterns");
      expect(patterns.some((p) => p.test(line))).toBe(true);
    });

    it.each(["▸ developer__shell", "▸ developer__text_editor"])(
      "matches tool-call marker: %s",
      (line) => {
        const patterns = compileAgentPatterns("goose", "fallbackPatterns");
        expect(patterns.some((p) => p.test(line))).toBe(true);
      }
    );

    it("does not match Bubble Tea braille spinners (OpenCode set)", () => {
      const patterns = compileAgentPatterns("goose", "fallbackPatterns");
      expect(patterns.some((p) => p.test("⣾ working"))).toBe(false);
      expect(patterns.some((p) => p.test("⣷ processing"))).toBe(false);
    });
  });

  describe("promptPatterns", () => {
    it.each(["🪿 ", "🪿 follow-up question?"])("matches goose emoji prompt: %s", (line) => {
      const patterns = compileAgentPatterns("goose", "promptPatterns");
      expect(patterns.some((p) => p.test(line))).toBe(true);
    });
  });

  describe("bootCompletePatterns", () => {
    it("matches 'goose is ready' boot line", () => {
      const patterns = compileAgentPatterns("goose", "bootCompletePatterns");
      expect(patterns.some((p) => p.test("goose is ready — provider: anthropic"))).toBe(true);
    });
  });

  describe("completionPatterns", () => {
    it.each(["● session closed · 20260429_1", "session closed · abc-123"])(
      "matches session-closed line: %s",
      (line) => {
        const patterns = compileAgentPatterns("goose", "completionPatterns");
        expect(patterns.some((p) => p.test(line))).toBe(true);
      }
    );

    it("does not match unrelated logs that mention 'session closed' mid-sentence", () => {
      const patterns = compileAgentPatterns("goose", "completionPatterns");
      expect(
        patterns.some((p) => p.test("The websocket session closed unexpectedly; retrying..."))
      ).toBe(false);
    });
  });
});

describe("aider detection patterns", () => {
  function compileAgentPatterns(agentId: string, key: string): RegExp[] {
    const config = getAgentConfig(agentId);
    const patterns = config?.detection?.[key as keyof typeof config.detection] as
      | string[]
      | undefined;
    return (patterns ?? []).map((p: string) => new RegExp(p, "im"));
  }

  it("matches Knight-Rider unicode scanner with Waiting for", () => {
    const patterns = compileAgentPatterns("aider", "primaryPatterns");
    expect(patterns.some((p) => p.test("░░░░░░░░░█ Waiting for claude-3-5-sonnet"))).toBe(true);
    expect(patterns.some((p) => p.test("░░██░░░░░░ Waiting for gpt-4o"))).toBe(true);
  });

  it("does not match braille spinners (those belong to other agents)", () => {
    const patterns = compileAgentPatterns("aider", "primaryPatterns");
    expect(patterns.some((p) => p.test("⣾ Waiting for claude"))).toBe(false);
  });

  it("matches ASCII fallback scanner", () => {
    const patterns = compileAgentPatterns("aider", "fallbackPatterns");
    expect(patterns.some((p) => p.test("=====#==== Waiting for gpt-4o"))).toBe(true);
  });

  it("matches token summary completion", () => {
    const patterns = compileAgentPatterns("aider", "completionPatterns");
    expect(
      patterns.some((p) => p.test("Tokens: 1.5k sent, 432 received. Cost: $0.02 message"))
    ).toBe(true);
  });

  it("matches Applied edit and Commit completions", () => {
    const patterns = compileAgentPatterns("aider", "completionPatterns");
    expect(patterns.some((p) => p.test("Applied edit to src/foo.ts"))).toBe(true);
    expect(patterns.some((p) => p.test("Commit a1b2c3d feat: add foo"))).toBe(true);
  });

  it("matches the version banner as boot complete", () => {
    const patterns = compileAgentPatterns("aider", "bootCompletePatterns");
    expect(patterns.some((p) => p.test("Aider v0.86.0"))).toBe(true);
    expect(patterns.some((p) => p.test("Use /help for help"))).toBe(true);
  });

  it("matches default and architect prompt forms", () => {
    const patterns = compileAgentPatterns("aider", "promptPatterns");
    expect(patterns.some((p) => p.test("> "))).toBe(true);
    expect(patterns.some((p) => p.test("architect> "))).toBe(true);
    expect(patterns.some((p) => p.test("ask> "))).toBe(true);
  });
});
