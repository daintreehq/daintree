import { describe, it, expect } from "vitest";
import { AgentContributionSchema, getPluginManifestSchema } from "../plugin.js";

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

  it("accepts args and supportsContextInjection", () => {
    const result = AgentContributionSchema.safeParse({
      ...VALID_AGENT,
      args: ["--flag", "value"],
      supportsContextInjection: true,
    });
    expect(result.success).toBe(true);
  });

  it("accepts a detection block with valid regex patterns (#10587)", () => {
    const result = AgentContributionSchema.safeParse({
      ...VALID_AGENT,
      detection: {
        primaryPatterns: ["thinking", "working\\.\\.\\."],
        completionPatterns: ["completed"],
        promptPatterns: ["waiting for approval"],
        scanLineCount: 10,
        primaryConfidence: 0.9,
      },
    });
    expect(result.success).toBe(true);
  });

  it("requires at least one primaryPattern when a detection block is present (#10587)", () => {
    expect(
      AgentContributionSchema.safeParse({ ...VALID_AGENT, detection: { primaryPatterns: [] } })
        .success
    ).toBe(false);
    // Omitting primaryPatterns entirely is also invalid.
    expect(
      AgentContributionSchema.safeParse({
        ...VALID_AGENT,
        detection: { completionPatterns: ["done"] },
      }).success
    ).toBe(false);
  });

  it("rejects a detection pattern that is not a compilable regex (#10587)", () => {
    expect(
      AgentContributionSchema.safeParse({
        ...VALID_AGENT,
        detection: { primaryPatterns: ["("] },
      }).success
    ).toBe(false);
  });

  it("rejects an over-long detection pattern and an oversized pattern array (#10587)", () => {
    expect(
      AgentContributionSchema.safeParse({
        ...VALID_AGENT,
        detection: { primaryPatterns: ["a".repeat(257)] },
      }).success
    ).toBe(false);
    expect(
      AgentContributionSchema.safeParse({
        ...VALID_AGENT,
        detection: { primaryPatterns: Array.from({ length: 51 }, (_, i) => `p${i}`) },
      }).success
    ).toBe(false);
  });

  it("rejects an out-of-range confidence and unknown detection key (strict) (#10587)", () => {
    expect(
      AgentContributionSchema.safeParse({
        ...VALID_AGENT,
        detection: { primaryPatterns: ["x"], primaryConfidence: 1.5 },
      }).success
    ).toBe(false);
    expect(
      AgentContributionSchema.safeParse({
        ...VALID_AGENT,
        detection: { primaryPatterns: ["x"], bogusField: true },
      }).success
    ).toBe(false);
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

  it("rejects reserved ids that could pollute the registry object", () => {
    for (const id of ["__proto__", "constructor", "prototype"]) {
      expect(AgentContributionSchema.safeParse({ ...VALID_AGENT, id }).success).toBe(false);
    }
  });

  it("accepts a bare PATH binary name as the command", () => {
    expect(
      AgentContributionSchema.safeParse({ ...VALID_AGENT, command: "claude-cli" }).success
    ).toBe(true);
  });

  it("accepts a plugin-relative ./ command path (#10560)", () => {
    for (const command of ["./bin/agent.mjs", "./agent", "./dist/cli/run.js"]) {
      expect(AgentContributionSchema.safeParse({ ...VALID_AGENT, command }).success).toBe(true);
    }
  });

  it("rejects relative paths without an explicit ./ prefix (#10560)", () => {
    // A bare relative path is ambiguous with a PATH name, so it must be rejected
    // — only ./-prefixed paths or separator-free PATH names are allowed.
    expect(
      AgentContributionSchema.safeParse({ ...VALID_AGENT, command: "bin/agent.mjs" }).success
    ).toBe(false);
  });

  it("rejects traversal, absolute, and Windows-separator command paths (#10560)", () => {
    for (const command of [
      "../agent",
      "./../agent",
      "./bin/../../escape",
      "/usr/bin/agent",
      ".\\bin\\agent.cmd",
      "./bin\\agent.cmd",
    ]) {
      expect(AgentContributionSchema.safeParse({ ...VALID_AGENT, command }).success).toBe(false);
    }
  });

  it("rejects bare-dot and empty relative command paths (#10560)", () => {
    for (const command of ["./", "./."]) {
      expect(AgentContributionSchema.safeParse({ ...VALID_AGENT, command }).success).toBe(false);
    }
  });

  it("rejects empty, current-dir, and trailing segments in relative command paths (#10560)", () => {
    for (const command of ["./bin//agent", "./bin/./agent", "./bin/agent/"]) {
      expect(AgentContributionSchema.safeParse({ ...VALID_AGENT, command }).success).toBe(false);
    }
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

  it("accepts a manifest whose agent declares a valid detection block (#10587)", () => {
    const result = schema.safeParse(
      manifestWith({
        capabilities: ["agent:register"],
        contributes: {
          agents: [{ ...VALID_AGENT, detection: { primaryPatterns: ["thinking"] } }],
        },
      })
    );
    expect(result.success).toBe(true);
  });

  it("rejects a manifest whose agent declares a malformed detection regex (#10587)", () => {
    const result = schema.safeParse(
      manifestWith({
        capabilities: ["agent:register"],
        contributes: {
          agents: [{ ...VALID_AGENT, detection: { primaryPatterns: ["("] } }],
        },
      })
    );
    expect(result.success).toBe(false);
  });
});
