import { describe, it, expect } from "vitest";
import {
  AgentContributionSchema,
  AgentDetectionContributionSchema,
  getPluginManifestSchema,
} from "../plugin.js";

const VALID_AGENT = {
  id: "acme-agent",
  name: "Acme Agent",
  command: "acme",
  color: "#3366ff",
  iconId: "terminal",
};

function manifestWith(overrides: Record<string, unknown>) {
  return {
    name: "acme.my-plugin",
    version: "1.0.0",
    ...overrides,
  };
}

describe("AgentContributionSchema (issue #9560)", () => {
  it("accepts a minimal agent contribution and defaults supportsContextInjection to false", () => {
    const result = AgentContributionSchema.safeParse(VALID_AGENT);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.supportsContextInjection).toBe(false);
    }
  });

  it("accepts args, supportsContextInjection, and a detection block", () => {
    const result = AgentContributionSchema.safeParse({
      ...VALID_AGENT,
      args: ["--flag", "value"],
      supportsContextInjection: true,
      detection: { primaryPatterns: ["thinking", "working\\.\\.\\."] },
    });
    expect(result.success).toBe(true);
  });

  it("rejects unknown top-level fields (strict)", () => {
    expect(
      AgentContributionSchema.safeParse({ ...VALID_AGENT, resume: { kind: "rolling-history" } })
        .success
    ).toBe(false);
  });

  it("rejects a malformed color", () => {
    expect(AgentContributionSchema.safeParse({ ...VALID_AGENT, color: "blue" }).success).toBe(
      false
    );
  });

  it("rejects an id or command with shell metacharacters", () => {
    expect(AgentContributionSchema.safeParse({ ...VALID_AGENT, id: "bad id" }).success).toBe(false);
    expect(
      AgentContributionSchema.safeParse({ ...VALID_AGENT, command: "acme; rm -rf /" }).success
    ).toBe(false);
  });

  it("rejects control characters in args and caps arg count at 20", () => {
    expect(
      AgentContributionSchema.safeParse({ ...VALID_AGENT, args: ["ok", "bad\nflag"] }).success
    ).toBe(false);
    expect(
      AgentContributionSchema.safeParse({
        ...VALID_AGENT,
        args: Array.from({ length: 21 }, (_, i) => `--flag${i}`),
      }).success
    ).toBe(false);
  });
});

describe("AgentDetectionContributionSchema bounded-regex contract (issue #9560)", () => {
  it("rejects an invalid regular expression", () => {
    expect(AgentDetectionContributionSchema.safeParse({ primaryPatterns: ["("] }).success).toBe(
      false
    );
  });

  it("rejects backreferences, lookarounds, and nested quantifiers", () => {
    expect(
      AgentDetectionContributionSchema.safeParse({ primaryPatterns: ["(foo)\\1"] }).success
    ).toBe(false);
    expect(
      AgentDetectionContributionSchema.safeParse({ primaryPatterns: ["foo(?=bar)"] }).success
    ).toBe(false);
    expect(AgentDetectionContributionSchema.safeParse({ primaryPatterns: ["(a+)+"] }).success).toBe(
      false
    );
  });

  it("rejects a pattern longer than 250 chars and more than 8 patterns", () => {
    expect(
      AgentDetectionContributionSchema.safeParse({ primaryPatterns: ["a".repeat(251)] }).success
    ).toBe(false);
    expect(
      AgentDetectionContributionSchema.safeParse({
        primaryPatterns: Array.from({ length: 9 }, (_, i) => `p${i}`),
      }).success
    ).toBe(false);
  });

  it("rejects unknown detection fields (strict)", () => {
    expect(
      AgentDetectionContributionSchema.safeParse({ titleStatePatterns: { working: ["x"] } }).success
    ).toBe(false);
  });
});

describe("manifest-level agent contribution gates (issue #9560)", () => {
  const schema = getPluginManifestSchema(false);

  it("rejects contributes.agents without the agent:register capability", () => {
    const result = schema.safeParse(manifestWith({ contributes: { agents: [VALID_AGENT] } }));
    expect(result.success).toBe(false);
  });

  it("accepts contributes.agents when agent:register is declared", () => {
    const result = schema.safeParse(
      manifestWith({ capabilities: ["agent:register"], contributes: { agents: [VALID_AGENT] } })
    );
    expect(result.success).toBe(true);
  });

  it("rejects a plugin agent id that collides with a built-in", () => {
    const result = schema.safeParse(
      manifestWith({
        capabilities: ["agent:register"],
        contributes: { agents: [{ ...VALID_AGENT, id: "claude" }] },
      })
    );
    expect(result.success).toBe(false);
  });

  it("defaults contributes.agents to an empty array when omitted", () => {
    const result = schema.safeParse(manifestWith({}));
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.contributes.agents).toEqual([]);
    }
  });
});
