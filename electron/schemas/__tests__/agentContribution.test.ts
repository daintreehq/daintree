import { describe, it, expect } from "vitest";
import { LAUNCH_MCP_FORMATS } from "../../../shared/config/launchMcp.js";
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
    expect(AgentContributionSchema.safeParse({ ...VALID_AGENT, continuity: {} }).success).toBe(
      false
    );
  });

  describe("launchMcp (#13803)", () => {
    const parses = (launchMcp: unknown) =>
      AgentContributionSchema.safeParse({ ...VALID_AGENT, launchMcp }).success;

    it.each(LAUNCH_MCP_FORMATS)("accepts the %s format", (format) => {
      expect(parses({ format })).toBe(true);
    });

    it("rejects an unknown format, a missing format and extra keys", () => {
      expect(parses({ format: "replace-user-servers" })).toBe(false);
      expect(parses({})).toBe(false);
      expect(parses({ format: "claude-mcp-config", strict: true })).toBe(false);
    });

    it("rejects a manifest-chosen env var", () => {
      expect(parses({ format: "opencode-config-content", envVar: "NODE_OPTIONS" })).toBe(false);
    });
  });

  describe("resume (#13687)", () => {
    const parses = (resume: unknown) =>
      AgentContributionSchema.safeParse({ ...VALID_AGENT, resume }).success;

    it("accepts a session-id template with a one-group pattern and quit command", () => {
      expect(
        parses({
          kind: "session-id",
          args: ["--resume", "{sessionId}"],
          sessionIdPattern: "hermes --resume (\\S+)",
          quitCommand: "/exit",
          resumeLatestArgs: ["--continue"],
        })
      ).toBe(true);
      expect(parses({ kind: "session-id", args: ["--session={sessionId}"] })).toBe(true);
    });

    it("accepts a project-scoped resume with static args", () => {
      expect(parses({ kind: "project-scoped", args: ["--continue"], quitCommand: "/quit" })).toBe(
        true
      );
    });

    it("rejects the kinds plugins can't declare", () => {
      expect(parses({ kind: "rolling-history", args: ["--continue"] })).toBe(false);
      expect(parses({ kind: "named-target", args: ["--plan"] })).toBe(false);
    });

    it("requires exactly one {sessionId} arg in a session-id template", () => {
      expect(parses({ kind: "session-id", args: ["--resume"] })).toBe(false);
      expect(parses({ kind: "session-id", args: ["{sessionId}", "{sessionId}"] })).toBe(false);
      expect(parses({ kind: "session-id", args: ["{sessionId}{sessionId}"] })).toBe(false);
    });

    it("rejects {sessionId} outside a session-id template's args", () => {
      expect(parses({ kind: "project-scoped", args: ["--session", "{sessionId}"] })).toBe(false);
      expect(
        parses({ kind: "project-scoped", args: ["--continue"], quitCommand: "/quit {sessionId}" })
      ).toBe(false);
      expect(
        parses({ kind: "session-id", args: ["{sessionId}"], quitCommand: "/exit {sessionId}" })
      ).toBe(false);
      expect(
        parses({
          kind: "session-id",
          args: ["{sessionId}"],
          sessionIdPattern: "({sessionId})",
          quitCommand: "/exit",
        })
      ).toBe(false);
      expect(
        parses({ kind: "session-id", args: ["{sessionId}"], resumeLatestArgs: ["{sessionId}"] })
      ).toBe(false);
    });

    it("requires a sessionIdPattern to compile with exactly one capture group", () => {
      const withPattern = (sessionIdPattern: string) =>
        parses({ kind: "session-id", args: ["{sessionId}"], sessionIdPattern, quitCommand: "/q" });
      expect(withPattern("id: ([\\w-]+)")).toBe(true);
      expect(withPattern("(?:resume|continue) (?<id>\\S+)(?=\\s)")).toBe(true);
      expect(withPattern("\\(literal\\) [(](\\S+)")).toBe(true);
      expect(withPattern("id: \\S+")).toBe(false);
      expect(withPattern("(id): (\\S+)")).toBe(false);
      expect(withPattern("(")).toBe(false);
      expect(withPattern(`(${"a".repeat(255)})`)).toBe(false);
    });

    it("requires a quitCommand to provoke the hint a sessionIdPattern reads (#13687)", () => {
      expect(
        parses({ kind: "session-id", args: ["{sessionId}"], sessionIdPattern: "id: (\\S+)" })
      ).toBe(false);
      expect(parses({ kind: "session-id", args: ["{sessionId}"], resumeLatestArgs: ["-c"] })).toBe(
        true
      );
    });

    it("parses a resume block through the full manifest gate", () => {
      const resume = { kind: "project-scoped", args: ["--continue"] };
      const manifest = (capabilities: string[]) =>
        manifestWith({
          capabilities,
          contributes: { agents: [{ ...VALID_AGENT, id: "pi", resume }] },
        });
      const parsed = getPluginManifestSchema("user").safeParse(manifest(["agent:register"]));
      expect(parsed.success).toBe(true);
      if (parsed.success) expect(parsed.data.contributes.agents[0]?.resume).toEqual(resume);
      expect(getPluginManifestSchema("user").safeParse(manifest([])).success).toBe(false);
    });

    it("holds args and quitCommand to the same rules as the launch args", () => {
      expect(parses({ kind: "session-id", args: ["{sessionId}"], quitCommand: "/exit\r" })).toBe(
        false
      );
      expect(parses({ kind: "session-id", args: ["{sessionId}"], quitCommand: "" })).toBe(false);
      expect(parses({ kind: "project-scoped", args: ["--continue\n"] })).toBe(false);
      expect(parses({ kind: "project-scoped", args: [] })).toBe(false);
      expect(parses({ kind: "project-scoped", args: Array.from({ length: 21 }, () => "-x") })).toBe(
        false
      );
    });

    it("rejects unknown resume fields (strict)", () => {
      expect(
        parses({ kind: "session-id", args: ["{sessionId}"], assignSessionIdArgs: ["--id"] })
      ).toBe(false);
      expect(
        parses({ kind: "project-scoped", args: ["--continue"], sessionIdPattern: "(x)" })
      ).toBe(false);
    });
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
  const schema = getPluginManifestSchema("user");

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
});
