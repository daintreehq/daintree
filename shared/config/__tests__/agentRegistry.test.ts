import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  getAgentIds,
  getAgentConfig,
  setUserRegistry,
  getEffectiveAgentConfig,
  isEffectivelyRegisteredAgent,
  isBuiltInAgent,
  getAgentModelConfig,
  getAgentDisplayTitle,
  getAgentPreset,
  setAgentPresets,
  getAssistantSupportedAgentIds,
  getAssistantWiredAgentIds,
  hasAssistantMcpImplementation,
  invalidateEffectiveRegistryCache,
  AGENT_REGISTRY,
  type AgentConfig,
  type AssistantSupports,
} from "../agentRegistry.js";
import { UserAgentConfigSchema } from "../../types/userAgentRegistry.js";
import { buildResumeCommand, buildResumeLatestCommand } from "../../types/agentSettings.js";
import { BUILT_IN_AGENT_IDS } from "../agentIds.js";

describe("agentRegistry", () => {
  beforeEach(() => {
    setUserRegistry({});
  });

  describe("built-in agents", () => {
    it("each built-in agent has a non-empty color", () => {
      const ids = getAgentIds();
      for (const id of ids) {
        const config = getAgentConfig(id);
        expect(config?.color).toBeTruthy();
        expect(config?.color).toMatch(/^#[0-9a-fA-F]{6}$/);
      }
    });

    it("requires every built-in agent to declare its resize policy", () => {
      for (const id of BUILT_IN_AGENT_IDS) {
        expect(
          getAgentConfig(id)?.capabilities?.resizeStrategy,
          `${id} must choose a resize strategy explicitly`
        ).toBeDefined();
      }
    });

    it("returns undefined for non-existent agents", () => {
      expect(getAgentConfig("nonexistent")).toBeUndefined();
    });
  });

  describe("prerequisites", () => {
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

  describe("user registry", () => {
    const customAgent: AgentConfig = {
      id: "custom-agent",
      name: "Custom Agent",
      command: "custom",
      color: "#FF0000",
      iconId: "custom",
      supportsContextInjection: true,
    };

    it("user-defined agents are not built-in", () => {
      setUserRegistry({ "custom-agent": customAgent });

      expect(isBuiltInAgent("custom-agent")).toBe(false);
      expect(isEffectivelyRegisteredAgent("custom-agent")).toBe(true);
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

  describe("assistant support", () => {
    it("returns claude and codex as the stable-tier assistant agents", () => {
      const ids = getAssistantSupportedAgentIds();
      expect(ids).toEqual(["claude", "codex"]);
    });

    it("getAssistantWiredAgentIds includes stable and experimental tiers but excludes deprecated (#8811)", () => {
      const wired = getAssistantWiredAgentIds();
      expect(wired).toEqual(expect.arrayContaining(["claude", "codex"]));
      // Deprecated-tier agents (gemini) are excluded from the wired list, so
      // they cannot provision an assistant help session even though they
      // keep their `supports` shape for historical reference.
      expect(wired).not.toContain("gemini");
      // structurally ineligible / not wired entries must still be excluded
      expect(wired).not.toContain("aider");
      expect(wired).not.toContain("interpreter");
      expect(wired).not.toContain("goose");
      expect(wired).not.toContain("cursor");
    });

    it("excludes agents whose supports object is at experimental tier", () => {
      // Temporarily downgrade codex to experimental and verify the real
      // filter function (not a local copy of the predicate) excludes it.
      const original = AGENT_REGISTRY.codex as AgentConfig;
      const experimentalSupports: AssistantSupports = {
        mcpInjection: "cli-flags",
        settingsOverlay: false,
        permissionBypass: true,
        trustDialog: false,
        versionProbe: true,
        tier: "experimental",
      };
      AGENT_REGISTRY.codex = { ...original, supports: experimentalSupports } as AgentConfig;
      invalidateEffectiveRegistryCache();
      try {
        const ids = getAssistantSupportedAgentIds();
        expect(ids).not.toContain("codex");
        expect(ids).toContain("claude");
      } finally {
        AGENT_REGISTRY.codex = original;
        invalidateEffectiveRegistryCache();
      }
    });
  });

  describe("user-defined agents in assistant lists", () => {
    // `env-only` is the sole mode a third-party agent can be admitted under:
    // it needs no host-side writer or arg-builder, only the DAINTREE_MCP_* env
    // every help launch already carries (#12262).
    const stableSupports: AssistantSupports = {
      mcpInjection: "env-only",
      settingsOverlay: false,
      permissionBypass: true,
      trustDialog: false,
      versionProbe: true,
      tier: "stable",
    };

    const experimentalSupports: AssistantSupports = {
      ...stableSupports,
      tier: "experimental",
    };

    const cliFlagsSupports: AssistantSupports = {
      ...stableSupports,
      mcpInjection: "cli-flags",
    };

    const projectConfigSupports: AssistantSupports = {
      ...stableSupports,
      mcpInjection: "project-config",
    };

    const userDefinedWithStable: AgentConfig = {
      id: "my-cli-agent",
      name: "My CLI Agent",
      command: "mycli",
      color: "#FF8800",
      iconId: "custom",
      supportsContextInjection: true,
      supports: stableSupports,
    };

    const userDefinedWithExperimental: AgentConfig = {
      id: "exp-agent",
      name: "Experimental Agent",
      command: "exp",
      color: "#0088FF",
      iconId: "custom",
      supportsContextInjection: true,
      supports: experimentalSupports,
    };

    const userDefinedWithoutSupports: AgentConfig = {
      id: "no-support-agent",
      name: "No Support Agent",
      command: "nosup",
      color: "#888888",
      iconId: "custom",
      supportsContextInjection: true,
    };

    const userDefinedStructurallyIneligible: AgentConfig = {
      id: "ineligible-agent",
      name: "Ineligible Agent",
      command: "noassist",
      color: "#444444",
      iconId: "custom",
      supportsContextInjection: false,
      supports: false,
    };

    it("user-defined agent with stable-tier supports appears in supported list", () => {
      setUserRegistry({ "my-cli-agent": userDefinedWithStable });
      try {
        const ids = getAssistantSupportedAgentIds();
        expect(ids).toContain("my-cli-agent");
      } finally {
        setUserRegistry({});
      }
    });

    it("user-defined agent without supports is excluded from supported list", () => {
      setUserRegistry({ "no-support-agent": userDefinedWithoutSupports });
      try {
        const ids = getAssistantSupportedAgentIds();
        expect(ids).not.toContain("no-support-agent");
      } finally {
        setUserRegistry({});
      }
    });

    it("experimental user-defined agent appears in wired but not supported list", () => {
      setUserRegistry({ "exp-agent": userDefinedWithExperimental });
      try {
        const supported = getAssistantSupportedAgentIds();
        const wired = getAssistantWiredAgentIds();
        expect(supported).not.toContain("exp-agent");
        expect(wired).toContain("exp-agent");
      } finally {
        setUserRegistry({});
      }
    });

    it("deprecated user-defined agent is excluded from both lists even with an implemented mode", () => {
      // `env-only` clears the implementation check, so the tier gate is the only
      // thing that can drop it — gemini's `project-config` would fall out anyway.
      setUserRegistry({
        "old-agent": {
          ...userDefinedWithStable,
          id: "old-agent",
          supports: { ...stableSupports, tier: "deprecated" },
        },
      });
      try {
        expect(hasAssistantMcpImplementation("old-agent")).toBe(true);
        expect(getAssistantWiredAgentIds()).not.toContain("old-agent");
        expect(getAssistantSupportedAgentIds()).not.toContain("old-agent");
      } finally {
        setUserRegistry({});
      }
    });

    it("user-defined agent structurally ineligible excluded from both lists", () => {
      setUserRegistry({ "ineligible-agent": userDefinedStructurallyIneligible });
      try {
        const supported = getAssistantSupportedAgentIds();
        const wired = getAssistantWiredAgentIds();
        expect(supported).not.toContain("ineligible-agent");
        expect(wired).not.toContain("ineligible-agent");
      } finally {
        setUserRegistry({});
      }
    });

    it("built-in still shadows user-defined entry with same ID in assistant lists", () => {
      const fakeClaudeAgent: AgentConfig = {
        ...userDefinedWithStable,
        id: "claude",
        name: "Fake Claude",
        command: "fake-claude",
      };
      setUserRegistry({ claude: fakeClaudeAgent });
      try {
        const ids = getAssistantSupportedAgentIds();
        expect(ids).toContain("claude");
        // The effective config must be the REAL Claude, not the fake one
        const effective = getEffectiveAgentConfig("claude");
        expect(effective?.name).toBe("Claude");
        expect(effective?.command).toBe("claude");
      } finally {
        setUserRegistry({});
      }
    });

    it("supported list returns built-ins in BUILT_IN_AGENT_IDS order then user-defined", () => {
      const userAgent1: AgentConfig = {
        ...userDefinedWithStable,
        id: "zzz-last-agent",
        name: "ZZZ Agent",
        command: "zzz",
      };
      const userAgent2: AgentConfig = {
        ...userDefinedWithStable,
        id: "aaa-first-agent",
        name: "AAA Agent",
        command: "aaa",
      };
      setUserRegistry({ "zzz-last-agent": userAgent1, "aaa-first-agent": userAgent2 });
      try {
        const ids = getAssistantSupportedAgentIds();
        // Built-ins first, in BUILT_IN_AGENT_IDS order
        expect(ids[0]).toBe("claude");
        expect(ids[1]).toBe("codex");
        // Then user-defined agents in registration order
        const userDefinedIds = ids.slice(2);
        expect(userDefinedIds[0]).toBe("zzz-last-agent");
        expect(userDefinedIds[1]).toBe("aaa-first-agent");
      } finally {
        setUserRegistry({});
      }
    });

    it("user-defined shadow with supports:false does not remove built-in", () => {
      setUserRegistry({
        claude: { ...userDefinedStructurallyIneligible, id: "claude", supports: false },
      });
      try {
        const ids = getAssistantSupportedAgentIds();
        expect(ids).toContain("claude");
      } finally {
        setUserRegistry({});
      }
    });

    it.each([
      ["cli-flags", cliFlagsSupports],
      ["project-config", projectConfigSupports],
    ])(
      "excludes a stable user-defined agent declaring %s — Daintree implements neither for a third party (#12262)",
      (_mode, supports) => {
        setUserRegistry({
          "byo-agent": { ...userDefinedWithStable, id: "byo-agent", supports },
        });
        try {
          expect(getAssistantWiredAgentIds()).not.toContain("byo-agent");
          expect(getAssistantSupportedAgentIds()).not.toContain("byo-agent");
          expect(hasAssistantMcpImplementation("byo-agent")).toBe(false);
        } finally {
          setUserRegistry({});
        }
      }
    );

    it("admits a user-defined agent declaring env-only — the spawn env is the whole contract (#12262)", () => {
      setUserRegistry({ "my-cli-agent": userDefinedWithStable });
      try {
        expect(getAssistantWiredAgentIds()).toContain("my-cli-agent");
        expect(getAssistantSupportedAgentIds()).toContain("my-cli-agent");
        expect(hasAssistantMcpImplementation("my-cli-agent")).toBe(true);
      } finally {
        setUserRegistry({});
      }
    });

    it("does not treat an inherited Object.prototype key as a native implementation", () => {
      // `env-only` is the sensitive case: a bare `TABLE[id]` lookup resolves
      // `constructor` off the prototype, finds a function rather than
      // `undefined`, and compares it against the declared mode — wrongly
      // rejecting an agent the open contract should admit.
      const constructorAgent: AgentConfig = {
        ...userDefinedWithStable,
        id: "constructor",
        name: "Constructor Agent",
        command: "ctor",
      };
      setUserRegistry({ constructor: constructorAgent });
      try {
        expect(hasAssistantMcpImplementation("constructor")).toBe(true);
        expect(getAssistantWiredAgentIds()).toContain("constructor");
      } finally {
        setUserRegistry({});
      }
    });

    it("still rejects an inherited-key agent declaring an unimplemented mode", () => {
      setUserRegistry({
        constructor: {
          ...userDefinedWithStable,
          id: "constructor",
          name: "Constructor Agent",
          command: "ctor",
          supports: cliFlagsSupports,
        },
      });
      try {
        expect(hasAssistantMcpImplementation("constructor")).toBe(false);
        expect(getAssistantWiredAgentIds()).not.toContain("constructor");
      } finally {
        setUserRegistry({});
      }
    });
  });

  describe("mcpInjection is load-bearing (#12262)", () => {
    it("every active built-in declares a mode Daintree implements for it", () => {
      // The coverage guard: read the declarations directly rather than through
      // the wired list, or a built-in whose mode drifted would quietly drop out
      // of both the list and this assertion.
      for (const id of BUILT_IN_AGENT_IDS) {
        const supports = getAgentConfig(id)?.supports;
        if (!supports || supports.tier === "deprecated") continue;
        expect({ id, implemented: hasAssistantMcpImplementation(id) }).toEqual({
          id,
          implemented: true,
        });
      }
    });

    it("rejects a built-in whose declared mode drifts from its implementation", () => {
      // Claude's literal-id branches write project config regardless of what it
      // declares, so an `env-only` claim must not be admitted on the open
      // third-party contract.
      const original = AGENT_REGISTRY.claude as AgentConfig;
      const drifted: AssistantSupports = {
        ...(original.supports as AssistantSupports),
        mcpInjection: "env-only",
      };
      AGENT_REGISTRY.claude = { ...original, supports: drifted } as AgentConfig;
      invalidateEffectiveRegistryCache();
      try {
        expect(hasAssistantMcpImplementation("claude")).toBe(false);
        expect(getAssistantWiredAgentIds()).not.toContain("claude");
      } finally {
        AGENT_REGISTRY.claude = original;
        invalidateEffectiveRegistryCache();
      }
    });

    it("the stable list is a subset of the wired list, custom agents included", () => {
      setUserRegistry({
        "byo-ok": {
          id: "byo-ok",
          name: "BYO OK",
          command: "byo-ok",
          color: "#FF8800",
          iconId: "custom",
          supportsContextInjection: true,
          supports: {
            mcpInjection: "env-only",
            settingsOverlay: false,
            permissionBypass: false,
            trustDialog: false,
            versionProbe: true,
            tier: "stable",
          },
        },
        "byo-bad": {
          id: "byo-bad",
          name: "BYO Bad",
          command: "byo-bad",
          color: "#FF8800",
          iconId: "custom",
          supportsContextInjection: true,
          supports: {
            mcpInjection: "cli-flags",
            settingsOverlay: false,
            permissionBypass: false,
            trustDialog: false,
            versionProbe: true,
            tier: "stable",
          },
        },
      });
      try {
        const wired = new Set(getAssistantWiredAgentIds());
        const supported = getAssistantSupportedAgentIds();
        expect(supported).toContain("byo-ok");
        expect(supported).not.toContain("byo-bad");
        for (const id of supported) {
          expect({ id, wired: wired.has(id) }).toEqual({ id, wired: true });
        }
      } finally {
        setUserRegistry({});
      }
    });

    it("returns false for an agent with no supports declaration", () => {
      expect(hasAssistantMcpImplementation("grok")).toBe(false);
      expect(hasAssistantMcpImplementation("aider")).toBe(false);
      expect(hasAssistantMcpImplementation("not-an-agent")).toBe(false);
    });
  });
});

describe("mistral configuration", () => {
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
    if (resume?.kind !== "session-id") throw new Error("mistral resume must be session-id");
    expect(resume.sessionIdPattern).toBeDefined();
    const re = new RegExp(resume.sessionIdPattern!);
    const match = "Or: vibe --resume abc-123-def-456".match(re);
    expect(match?.[1]).toBe("abc-123-def-456");
    expect("vibe --continue".match(re)).toBeNull();
  });
});

describe("copilot configuration", () => {
  it("uses submitEnterDelayMs >= 200 so Ink TUI registers input before CR (issue #5830)", () => {
    const config = getAgentConfig("copilot");
    expect(config?.capabilities?.submitEnterDelayMs).toBeGreaterThanOrEqual(200);
  });

  it("uses single-write quit so /exit submits as one write (Ink TUI constraint)", () => {
    const config = getAgentConfig("copilot");
    expect(config?.capabilities?.quitSubmitMode).toBe("single-write");
  });
});

describe("kimi detection patterns", () => {
  function compilePatterns(key: string): RegExp[] {
    const config = getAgentConfig("kimi");
    const patterns = config?.detection?.[key as keyof typeof config.detection] as
      string[] | undefined;
    return (patterns ?? []).map((p: string) => new RegExp(p, "im"));
  }

  it.each(["✨", "💫", "📋", "$"])("matches prompt glyph %s", (glyph) => {
    const patterns = compilePatterns("promptPatterns");
    expect(patterns.some((p) => p.test(`${glyph} `))).toBe(true);
  });

  it.each(["🌑", "🌒", "🌓", "🌔", "🌕", "🌖", "🌗", "🌘"])(
    "matches moon-phase spinner frame %s as primary",
    (glyph) => {
      const patterns = compilePatterns("primaryPatterns");
      // Trailing space — Rich's documented frame format.
      expect(patterns.some((p) => p.test(`${glyph} `))).toBe(true);
      // No trailing space — renderers that drop the trailing whitespace when
      // the spinner is the only content on a line.
      expect(patterns.some((p) => p.test(glyph))).toBe(true);
    }
  );

  it("matches the kimi-cli welcome banner as boot-complete", () => {
    const patterns = compilePatterns("bootCompletePatterns");
    // Bare banner line (Rich Console.print output before Panel wrapping)
    expect(patterns.some((p) => p.test("Welcome to Kimi Code CLI!"))).toBe(true);
    // Banner wrapped in the Rich Panel box-drawing characters rendered in
    // the live terminal — a literal substring match must still fire here.
    expect(patterns.some((p) => p.test("╭─ Welcome to Kimi Code CLI! ─╮"))).toBe(true);
  });

  it("matches braille dots spinner with task description in fallback", () => {
    const patterns = compilePatterns("fallbackPatterns");
    expect(patterns.some((p) => p.test("⠋ Compacting..."))).toBe(true);
    expect(patterns.some((p) => p.test("⠹ Connecting to MCP servers..."))).toBe(true);
  });

  it("matches braille dots spinner with single word in fallback", () => {
    const patterns = compilePatterns("fallbackPatterns");
    expect(patterns.some((p) => p.test("⠹ Working"))).toBe(true);
  });

  it("does not match braille dots in primary (no #3941 footgun)", () => {
    const patterns = compilePatterns("primaryPatterns");
    // kimi-cli's content/tool blocks render braille-with-text, but a copy-paste
    // of that glyph class into primary would mis-classify goose's identical
    // cliclack spinner. The moon class is the only thing that earns primary.
    expect(patterns.some((p) => p.test("⠋ Thinking about the request"))).toBe(false);
    expect(patterns.some((p) => p.test("⠹ Working"))).toBe(false);
  });
});

describe("amp configuration", () => {
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

  it("resumes via `threads continue <id>` and exits on Ctrl+C", () => {
    const resume = getAgentConfig("amp")?.resume;
    expect(resume?.kind).toBe("named-target");
    if (resume?.kind === "named-target") {
      expect(resume.argsForTarget("T-abc123")).toEqual(["threads", "continue", "T-abc123"]);
      expect(resume.shutdownKeySequence).toBe("\x03");
      expect(resume.quitCommand).toBeUndefined();
    }
  });
});

describe("copilot detection patterns", () => {
  function compilePatterns(key: string): RegExp[] {
    const config = getAgentConfig("copilot");
    const patterns = config?.detection?.[key as keyof typeof config.detection] as
      string[] | undefined;
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
  // `claude --model` accepts either a full name or a family alias resolving to
  // the latest release. Pinned IDs go stale on every release (#11879), so the
  // invariant is the *shape* of the list, not which families are in it today.
  it.each(["claude", "gemini"])(
    "%s offers the CLI's own aliases, never pinned release IDs",
    (agentId) => {
      const config = getAgentConfig(agentId);
      expect(config?.models).toBeDefined();
      expect(config!.models!.length).toBeGreaterThanOrEqual(3);
      const pinned = config!.models!.map((m) => m.id).filter((id) => /\d/.test(id));
      expect(pinned).toEqual([]);
    }
  );

  // The installed CLI's own catalog names Codex models and retires old ones
  // (#13437); a bundled list is what left the picker a release behind.
  it("codex bundles no model list", () => {
    expect(getAgentConfig("codex")?.models ?? []).toEqual([]);
  });
});

describe("getAgentModelConfig", () => {
  it("returns model config for valid agent and model ID", () => {
    // A non-first entry whose name and shortLabel differ, so "returns the
    // first model" and "returns name instead of shortLabel" both fail here.
    const expected = getAgentConfig("qwen")!.models![1]!;
    const model = getAgentModelConfig("qwen", expected.id);
    expect(model).toEqual(expected);
    expect(model!.name).not.toBe(model!.shortLabel);
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
    const model = getAgentConfig("qwen")!.models![1]!;
    const agentName = getAgentConfig("qwen")!.name;
    expect(getAgentDisplayTitle("qwen", model.id)).toBe(`${agentName} (${model.shortLabel})`);
    expect(getAgentDisplayTitle("qwen", model.id)).not.toContain(model.name);
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

describe("screen-mode flag capabilities (#11423)", () => {
  // Select by property PRESENCE, not truthiness — filtering on the flag value
  // would drop an agent declaring `""`, which is exactly what the non-empty
  // assertion below exists to catch.
  const screenModeAgents = getAgentIds()
    .map((id) => ({ id, capabilities: getAgentConfig(id)?.capabilities }))
    .filter(
      (a) =>
        a.capabilities?.inlineModeFlag !== undefined || a.capabilities?.altScreenFlag !== undefined
    );

  it("declares every screen-mode flag as a single non-empty token", () => {
    // The launch path matches these by whole-token equality, so an empty or
    // whitespace-bearing value could never be stripped and would leak into
    // every persisted snapshot.
    expect(screenModeAgents.length).toBeGreaterThan(0);
    for (const { id, capabilities } of screenModeAgents) {
      for (const flag of [capabilities?.inlineModeFlag, capabilities?.altScreenFlag]) {
        if (flag === undefined) continue;
        expect(flag.length, `${id} declares an empty screen-mode flag`).toBeGreaterThan(0);
        expect(flag, `${id} declares a multi-token screen-mode flag`).not.toMatch(/\s/);
      }
    }
  });

  it("still ships at least one agent able to force alt screen", () => {
    // Non-vacuity guard: every assertion in this block passes trivially if no
    // agent declares `altScreenFlag`, which would mean #11423's fix went dead.
    expect(
      screenModeAgents.filter((a) => a.capabilities?.altScreenFlag !== undefined).length
    ).toBeGreaterThan(0);
  });

  it("keeps the two polarities distinct for any agent declaring both", () => {
    for (const { id, capabilities } of screenModeAgents) {
      if (!capabilities?.inlineModeFlag || !capabilities?.altScreenFlag) continue;
      expect(
        capabilities.altScreenFlag,
        `${id} declares the same token for both screen-mode polarities`
      ).not.toBe(capabilities.inlineModeFlag);
    }
  });

  it("never pairs a force-alt-screen flag with blockAltScreen", () => {
    // Forcing the CLI into its full-screen TUI while the terminal strips the
    // alt-screen escape sequences leaves the agent unusable.
    for (const { id, capabilities } of screenModeAgents) {
      if (!capabilities?.altScreenFlag) continue;
      expect(
        capabilities.blockAltScreen ?? false,
        `${id} forces alt screen but also blocks it`
      ).toBe(false);
    }
  });
});

describe("resume configuration", () => {
  it("every session-id agent declares exactly one shutdown protocol", () => {
    // Weaker than "must have a quitCommand" on purpose: an agent may take a
    // structured `shutdownSignal` instead (#11851). Stronger in the direction
    // that matters — declaring BOTH is the bug the type exists to prevent, since
    // a gated escalation exists precisely to avoid writing a slash command.
    for (const id of getAgentIds()) {
      const resume = getAgentConfig(id)?.resume;
      if (resume?.kind !== "session-id") continue;
      expect(typeof resume.args).toBe("function");
      // `shutdownKeySequence` counts as part of the legacy protocol: pairing it
      // with a structured signal is the same contradiction, and leaving it out
      // of this check would let that pair through.
      const legacy = Boolean(resume.quitCommand) || Boolean(resume.shutdownKeySequence);
      const structured = Boolean(resume.shutdownSignal);
      expect(
        [legacy, structured].filter(Boolean),
        `${id} must declare a legacy quit signal or a shutdownSignal, not both`
      ).toHaveLength(1);
      if (legacy) {
        // An empty string is falsy to the teardown's own `if (quitCommand)`
        // guard, so it would silently send nothing at all.
        expect(resume.quitCommand ?? resume.shutdownKeySequence).not.toBe("");
      }
    }
  });

  it("no session-id agent ships an empty or uncompilable sessionIdPattern", () => {
    // The field is optional now — an agent whose id was never observable omits
    // it rather than carrying a pattern that matches nothing (#11851). What is
    // NOT allowed is a present-but-useless one: an empty string matches
    // everywhere, and an uncompilable one throws inside the teardown listener.
    for (const id of getAgentIds()) {
      const resume = getAgentConfig(id)?.resume;
      if (resume?.kind !== "session-id" || resume.sessionIdPattern === undefined) continue;
      expect(resume.sessionIdPattern, `${id} declares an empty sessionIdPattern`).not.toBe("");
      // The teardown reads `match[1]`, so a pattern with no capture group can
      // never yield an id no matter what the agent prints. Alternating with an
      // empty branch forces a match on "" so the group count is readable even
      // when the pattern itself matches nothing.
      const groupCount = (new RegExp(`${resume.sessionIdPattern}|`).exec("")?.length ?? 1) - 1;
      expect(groupCount, `${id}'s sessionIdPattern has no capture group`).toBeGreaterThanOrEqual(1);
    }
  });

  it("an agent with no capture path still has a way to resume", () => {
    // Dropping a fabricated pattern must not strand the agent: without either a
    // capture path or a resume-latest fallback it could never come back at all.
    for (const id of getAgentIds()) {
      const resume = getAgentConfig(id)?.resume;
      if (resume?.kind !== "session-id") continue;
      const canCapture = Boolean(resume.sessionIdPattern) || Boolean(resume.assignSessionIdArgs);
      if (canCapture) continue;
      expect(
        resume.resumeLatestArgs?.length,
        `${id} can neither capture nor resume-latest`
      ).toBeGreaterThan(0);
    }
  });

  it("codex quits on a gated Ctrl-C and writes no slash command", () => {
    const resume = getAgentConfig("codex")?.resume;
    expect(resume?.kind).toBe("session-id");
    if (resume?.kind !== "session-id") return;
    // The `/quit` write is what landed in the user's own transcript (#11851).
    expect(resume.quitCommand).toBeUndefined();
    const signal = resume.shutdownSignal;
    expect(signal?.kind).toBe("gated-key-escalation");
    expect(signal?.keySequence).toBe(String.fromCharCode(3));
    // A gate the TUI never prints would silently degrade to a single press.
    expect("  Ctrl+C again to quit  ").toContain(signal?.gateText);
    // Budget fit lives in the pty suite, which owns GRACEFUL_SHUTDOWN_TIMEOUT_MS —
    // importing it here would drag electron into a shared/ test.
    expect(signal?.maxPresses).toBeGreaterThan(1);
    expect(signal?.perPressTimeoutMs).toBeGreaterThan(0);
  });

  it("antigravity captures the session id from its real `=` teardown line", () => {
    // #11851 recorded 0 captures in 6 teardowns because the old pattern put a
    // SPACE between the flag and the id. A live 1.1.22 capture shows agy prints
    // an equals sign, so the pattern is back — pinned against the real line
    // rather than against the shape that never matched.
    const resume = getAgentConfig("antigravity")?.resume;
    expect(resume?.kind).toBe("session-id");
    if (resume?.kind !== "session-id") return;
    const captured =
      "Resume with -c (or command below):\nagy --conversation=b0bced34-800c-4859-aaae-81d5f961c0f7".match(
        new RegExp(resume.sessionIdPattern!)
      );
    expect(captured?.[1]).toBe("b0bced34-800c-4859-aaae-81d5f961c0f7");
    // The space form is what #11851 proved agy never prints; it must not match.
    expect(
      "agy --conversation b0bced34-800c".match(new RegExp(resume.sessionIdPattern!))
    ).toBeNull();
    // Staying `session-id` is load-bearing, not incidental: the resume-latest
    // builder is gated on that kind, so reclassifying would silently take away
    // the `-c` restore that actually works. Pinned as built commands rather than
    // raw arrays so a change to either builder has to face this.
    expect(buildResumeCommand("antigravity", "conv-42")).toBe("agy --conversation conv-42");
    expect(buildResumeLatestCommand("antigravity")).toBe("agy -c");
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
      // `-C ./` pins the resume to the launch directory (#12434).
      expect(args).toEqual(["resume", "abc-123", "-C", "."]);
      expect(args[0]).not.toMatch(/^-/);
    }
  });

  it("declares cross-directory resume for codex only", () => {
    const declaring = Object.keys(AGENT_REGISTRY).filter((agentId) => {
      const resume = getAgentConfig(agentId)?.resume;
      return resume?.kind === "session-id" && resume.crossDirectoryResume === true;
    });
    expect(declaring).toEqual(["codex"]);
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

  it("kiro is project-scoped and produces chat --resume args without an ID", () => {
    const resume = getAgentConfig("kiro")?.resume;
    expect(resume?.kind).toBe("project-scoped");
    if (resume?.kind === "project-scoped") {
      expect(resume.args()).toEqual(["chat", "--resume"]);
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
    if (resume?.kind !== "session-id") throw new Error("goose resume must be session-id");
    expect(resume.sessionIdPattern).toBeDefined();
    const re = new RegExp(resume.sessionIdPattern!);
    const match = re.exec("● session closed · 20260429_1");
    expect(match?.[1]).toBe("20260429_1");
  });
});

describe("titleStatePatterns", () => {
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

describe("cursor detection patterns", () => {
  function compileAgentPatterns(agentId: string, key: string): RegExp[] {
    const config = getAgentConfig(agentId);
    const patterns = config?.detection?.[key as keyof typeof config.detection] as
      string[] | undefined;
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

describe("all built-in agents have Windows or generic install", () => {
  it.each([
    "claude",
    "gemini",
    "codex",
    "grok",
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

describe("claude providerTemplates descriptions", () => {
  it("all provider template ids are unique", () => {
    const templates = getAgentConfig("claude")?.providerTemplates ?? [];
    const ids = templates.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("all descriptions fit a short caption (<= 60 chars)", () => {
    const templates = getAgentConfig("claude")?.providerTemplates ?? [];
    for (const template of templates) {
      expect(template.description).toBeTruthy();
      expect(template.description!.length).toBeLessThanOrEqual(60);
    }
  });

  // #12783: the flag hides Monitor, PushNotification and claude.ai connectors
  // from Claude Code, so Daintree must never pre-fill it on the user's behalf.
  it("never pre-fills CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", () => {
    const config = getAgentConfig("claude");
    expect(config?.env?.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBeUndefined();
    for (const template of config?.providerTemplates ?? []) {
      expect(template.env?.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, template.id).toBeUndefined();
    }
  });

  it("warns that the nonessential-traffic suggestion removes Monitor", () => {
    const suggestion = getAgentConfig("claude")?.envSuggestions?.find(
      (s) => s.key === "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"
    );
    expect(suggestion?.hint).toContain("Monitor");
  });
});

describe("opencode detection patterns", () => {
  function compileAgentPatterns(agentId: string, key: string): RegExp[] {
    const config = getAgentConfig(agentId);
    const patterns = config?.detection?.[key as keyof typeof config.detection] as
      string[] | undefined;
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
      string[] | undefined;
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
      string[] | undefined;
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

describe("externalLinks", () => {
  it("every declared link has a non-empty label and an https URL", () => {
    for (const id of getAgentIds()) {
      for (const link of getAgentConfig(id)?.externalLinks ?? []) {
        expect(link.label.trim().length).toBeGreaterThan(0);
        expect(link.url).toMatch(/^https:\/\/\S+$/);
      }
    }
  });

  it("no agent declares an empty externalLinks array (omit over empty)", () => {
    for (const id of getAgentIds()) {
      const links = getAgentConfig(id)?.externalLinks;
      if (links !== undefined) {
        expect(links.length).toBeGreaterThan(0);
      }
    }
  });

  it("labels follow menu microcopy — no trailing period or ellipsis", () => {
    for (const id of getAgentIds()) {
      for (const link of getAgentConfig(id)?.externalLinks ?? []) {
        expect(link.label).not.toMatch(/[.…]$/);
      }
    }
  });

  it("link URLs are unique within each agent", () => {
    for (const id of getAgentIds()) {
      const urls = (getAgentConfig(id)?.externalLinks ?? []).map((l) => l.url);
      expect(new Set(urls).size).toBe(urls.length);
    }
  });

  it("agents with a genuine usage dashboard label it 'View usage'", () => {
    // claude and codex point usageUrl at real usage dashboards; their context
    // menu link must reuse that exact destination rather than drifting to a
    // separate URL.
    for (const id of ["claude", "codex"]) {
      const config = getAgentConfig(id);
      const usageLink = config?.externalLinks?.find((l) => l.label === "View usage");
      expect(usageLink).toBeDefined();
      expect(usageLink?.url).toBe(config?.usageUrl);
    }
  });
});

describe("UserAgentConfigSchema supports field", () => {
  it("preserves supports:false through validation", () => {
    const result = UserAgentConfigSchema.safeParse({
      id: "test-agent",
      name: "Test Agent",
      command: "test",
      color: "#FF0000",
      iconId: "test",
      supportsContextInjection: true,
      supports: false,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.supports).toBe(false);
    }
  });

  it("accepts a deprecated supports tier (#8811)", () => {
    const result = UserAgentConfigSchema.safeParse({
      id: "test-agent",
      name: "Test Agent",
      command: "test",
      color: "#FF0000",
      iconId: "test",
      supportsContextInjection: true,
      supports: {
        mcpInjection: "project-config",
        settingsOverlay: true,
        permissionBypass: false,
        trustDialog: true,
        versionProbe: true,
        tier: "deprecated",
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.supports).toMatchObject({ tier: "deprecated" });
    }
  });

  it("rejects invalid supports tier", () => {
    const result = UserAgentConfigSchema.safeParse({
      id: "test-agent",
      name: "Test Agent",
      command: "test",
      color: "#FF0000",
      iconId: "test",
      supportsContextInjection: true,
      supports: {
        mcpInjection: "cli-flags",
        settingsOverlay: false,
        permissionBypass: true,
        trustDialog: false,
        versionProbe: true,
        tier: "bogus",
      },
    });
    expect(result.success).toBe(false);
  });

  it("omitting supports is valid (optional field)", () => {
    const result = UserAgentConfigSchema.safeParse({
      id: "test-agent",
      name: "Test Agent",
      command: "test",
      color: "#FF0000",
      iconId: "test",
      supportsContextInjection: true,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.supports).toBeUndefined();
    }
  });
});
