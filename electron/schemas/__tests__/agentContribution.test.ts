import { describe, it, expect } from "vitest";
import { PROMPT_FORM_PLACEHOLDER } from "../../../shared/config/agentRegistry.js";
import {
  LAUNCH_MCP_ENV_ONLY_FORMATS,
  LAUNCH_MCP_FORMATS,
} from "../../../shared/config/launchMcp.js";
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

describe("a prompt form's -- beside launchMcp (#16404)", () => {
  const schema = getPluginManifestSchema("user");
  const terminated = { args: ["--", "{prompt}"] };
  const flagged = { args: ["--task", "{prompt}"] };
  const issues = (agent: Record<string, unknown>) =>
    schema
      .safeParse(
        manifestWith({
          capabilities: ["agent:register"],
          contributes: { agents: [{ ...VALID_AGENT, ...agent }] },
        })
      )
      .error?.issues.map((issue) => issue.path.join(".")) ?? [];

  it("refuses it in either mode with a format that adds flags", () => {
    const launchMcp = { format: "claude-mcp-config" };
    expect(
      issues({ launchMcp, initialPromptForm: { interactive: terminated, headless: flagged } })
    ).toEqual(["contributes.agents.0.initialPromptForm.interactive.args"]);
    expect(
      issues({ launchMcp, initialPromptForm: { interactive: flagged, headless: terminated } })
    ).toEqual(["contributes.agents.0.initialPromptForm.headless.args"]);
  });

  it.each([...LAUNCH_MCP_ENV_ONLY_FORMATS])("allows it with %s, which adds no flags", (format) => {
    expect(
      issues({
        launchMcp: { format },
        initialPromptForm: { interactive: terminated, headless: terminated },
      })
    ).toEqual([]);
  });

  it("allows it without launchMcp, and any other form with it", () => {
    expect(
      issues({ initialPromptForm: { interactive: terminated, headless: terminated } })
    ).toEqual([]);
    expect(
      issues({
        launchMcp: { format: "claude-mcp-config" },
        initialPromptForm: { interactive: flagged, headless: flagged },
      })
    ).toEqual([]);
  });
});

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

  describe("initialPromptForm (#16404)", () => {
    const FORM = { args: ["--task", "{prompt}"] };
    const parse = (initialPromptForm: unknown) =>
      AgentContributionSchema.safeParse({ ...VALID_AGENT, initialPromptForm });
    const withInteractive = (interactive: unknown) => parse({ interactive, headless: FORM });
    const message = (result: ReturnType<typeof parse>) => result.error?.issues[0]?.message;

    it("accepts both modes with a subcommand and a caveat, and keeps every field", () => {
      const declared = {
        interactive: {
          args: ["--", PROMPT_FORM_PLACEHOLDER],
          caveat: "may-be-ignored",
        },
        headless: {
          subcommand: { name: "run", replaces: "session" },
          args: ["-t", PROMPT_FORM_PLACEHOLDER, "--quiet"],
          caveat: "exits-after-reply",
        },
      };
      const result = parse(declared);
      expect(result.success).toBe(true);
      expect(result.data?.initialPromptForm).toEqual(declared);
    });

    it("stays optional", () => {
      const result = AgentContributionSchema.safeParse(VALID_AGENT);
      expect(result.success).toBe(true);
      expect(result.data).not.toHaveProperty("initialPromptForm");
    });

    it("needs both modes", () => {
      expect(parse({ interactive: FORM }).success).toBe(false);
      expect(parse({ headless: FORM }).success).toBe(false);
      expect(parse({}).success).toBe(false);
    });

    it.each([
      ["the declaration", { interactive: FORM, headless: FORM, oneShot: FORM }, [], "oneShot"],
      [
        "a mode",
        { interactive: { ...FORM, build: "--task {prompt}" }, headless: FORM },
        ["interactive"],
        "build",
      ],
      [
        "a subcommand",
        {
          interactive: { ...FORM, subcommand: { name: "run", replaces: "chat", at: 1 } },
          headless: FORM,
        },
        ["interactive", "subcommand"],
        "at",
      ],
    ])("names an unknown field on %s and where it is", (_level, declared, path, key) => {
      const issue = parse(declared).error?.issues[0];
      expect(issue?.path).toEqual(["initialPromptForm", ...path]);
      expect(issue?.message).toContain(key);
    });

    it("rejects anything but plain data for the args", () => {
      expect(withInteractive({ args: "--task {prompt}" }).success).toBe(false);
      expect(withInteractive({ args: () => ["{prompt}"] }).success).toBe(false);
      expect(withInteractive({ args: [] }).success).toBe(false);
    });

    it.each([
      ["missing", ["--task"]],
      ["repeated", ["{prompt}", "{prompt}"]],
      ["embedded", ["--task={prompt}"]],
      ["embedded beside a whole one", ["{prompt}", "--again={prompt}"]],
    ])("rejects a {prompt} that is %s, saying how to write it", (_name, args) => {
      expect(message(withInteractive({ args }))).toBe(
        "A prompt form's args must contain {prompt} exactly once, as a whole arg"
      );
    });

    it.each(["--a\nb", "--a\rb", "--a\0b", "--a\tb", "--a\u001bb", "--a\u007fb", "--a\u0085b"])(
      "rejects the control character in %j",
      (arg) => {
        expect(message(withInteractive({ args: [arg, "{prompt}"] }))).toBe(
          "A prompt form's args can't contain control characters"
        );
      }
    );

    it("bounds the args and their length", () => {
      expect(withInteractive({ args: ["a".repeat(256), "{prompt}"] }).success).toBe(true);
      const tooLong = withInteractive({ args: ["a".repeat(257), "{prompt}"] }).error?.issues[0];
      expect(tooLong?.path).toEqual(["initialPromptForm", "interactive", "args", 0]);
      expect(tooLong?.message).toContain("256");
      expect(withInteractive({ args: ["", "{prompt}"] }).success).toBe(false);
      const padding = Array.from({ length: 19 }, (_, index) => `-${index}`);
      expect(withInteractive({ args: [...padding, "{prompt}"] }).success).toBe(true);
      const tooMany = withInteractive({ args: [...padding, "-x", "{prompt}"] }).error?.issues[0];
      expect(tooMany?.path).toEqual(["initialPromptForm", "interactive", "args"]);
      expect(tooMany?.message).toContain("20");
    });

    it.each(["--id={sessionId}", "--token=${settings:apiToken}", "${HOME}"])(
      "rejects the template in %s",
      (arg) => {
        expect(message(withInteractive({ args: [arg, "{prompt}"] }))).toContain("can't carry");
      }
    );

    it.each([
      ["an option", { name: "--run", replaces: "chat" }],
      ["two words", { name: "ask it", replaces: "chat" }],
      ["a template", { name: "${settings:mode}", replaces: "chat" }],
      ["a placeholder", { name: "{prompt}", replaces: "chat" }],
      ["an option to replace", { name: "run", replaces: "--chat" }],
      ["a missing name", { replaces: "chat" }],
      ["a missing word to replace", { name: "run" }],
      ["an over-long word", { name: "a".repeat(65), replaces: "chat" }],
    ])("rejects a subcommand with %s", (_name, subcommand) => {
      expect(withInteractive({ ...FORM, subcommand }).success).toBe(false);
    });

    it("rejects a caveat the host doesn't define", () => {
      expect(withInteractive({ ...FORM, caveat: "flaky" }).success).toBe(false);
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
      expect(parses({ kind: "session-id", args: ["{sessionId}"], shutdownSignal: "ctrl-c" })).toBe(
        false
      );
      expect(
        parses({ kind: "project-scoped", args: ["--continue"], sessionIdPattern: "(x)" })
      ).toBe(false);
      expect(
        parses({
          kind: "project-scoped",
          args: ["--continue"],
          assignSessionIdArgs: ["--session-id", "{sessionId}"],
        })
      ).toBe(false);
    });

    describe("assignSessionIdArgs (#16470)", () => {
      const assigning = (assignSessionIdArgs: unknown) =>
        parses({ kind: "session-id", args: ["--resume", "{sessionId}"], assignSessionIdArgs });

      it("accepts a flag followed by the id, or a flag fused to it", () => {
        expect(assigning(["--session-id", "{sessionId}"])).toBe(true);
        expect(assigning(["--session-id={sessionId}"])).toBe(true);
        expect(assigning(["-s", "{sessionId}"])).toBe(true);
        expect(assigning(["--new", "--id", "{sessionId}"])).toBe(true);
      });

      it("keeps today's declarations valid without it", () => {
        expect(
          parses({
            kind: "session-id",
            args: ["--session", "{sessionId}"],
            quitCommand: "/quit",
            resumeLatestArgs: ["--continue"],
          })
        ).toBe(true);
      });

      it("accepts the same args as resume, for a CLI whose flag opens or creates", () => {
        expect(
          parses({
            kind: "session-id",
            args: ["--session-id", "{sessionId}"],
            assignSessionIdArgs: ["--session-id", "{sessionId}"],
          })
        ).toBe(true);
      });

      it("needs the placeholder exactly once", () => {
        expect(assigning(["--session-id"])).toBe(false);
        expect(assigning(["--session-id", "{sessionId}", "{sessionId}"])).toBe(false);
        expect(assigning(["--a={sessionId}", "--b={sessionId}"])).toBe(false);
        expect(assigning([])).toBe(false);
      });

      it("refuses a placeholder with no flag to anchor it, which would match any word", () => {
        expect(assigning(["{sessionId}"])).toBe(false);
        expect(assigning(["{sessionId}", "--session-id"])).toBe(false);
      });

      it("refuses a fused form that isn't --option={sessionId}", () => {
        expect(assigning(["--{sessionId}"])).toBe(false);
        expect(assigning(["--session-{sessionId}"])).toBe(false);
        expect(assigning(["--session-id={sessionId}.json"])).toBe(false);
        expect(assigning(["session={sessionId}"])).toBe(false);
      });

      it("refuses a word a launch would quote, which couldn't be stripped back off", () => {
        expect(assigning(["session", "--id", "{sessionId}"])).toBe(false);
        expect(assigning(["--session id", "{sessionId}"])).toBe(false);
        expect(assigning(["--session-id", "{sessionId}", "$(whoami)"])).toBe(false);
      });

      it("refuses control characters and oversized templates like any resume arg", () => {
        expect(assigning(["--session-id\n", "{sessionId}"])).toBe(false);
        expect(assigning([...Array.from({ length: 20 }, () => "-x"), "--id", "{sessionId}"])).toBe(
          false
        );
      });
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

describe("permissionBypassArgs (#16374)", () => {
  const parses = (permissionBypassArgs: unknown) =>
    AgentContributionSchema.safeParse({ ...VALID_AGENT, permissionBypassArgs }).success;

  it("accepts a flag, or an option with its value", () => {
    expect(parses(["--yes-to-all"])).toBe(true);
    expect(parses(["--approval", "never"])).toBe(true);
    expect(parses(["-c", "approval_policy=never"])).toBe(true);
  });

  it("is optional and maps through unchanged", () => {
    const parsed = AgentContributionSchema.safeParse({
      ...VALID_AGENT,
      permissionBypassArgs: ["--yolo"],
    });
    expect(parsed.success && parsed.data.permissionBypassArgs).toEqual(["--yolo"]);
    expect(AgentContributionSchema.safeParse(VALID_AGENT).success).toBe(true);
  });

  it("bounds the args like other agent args", () => {
    expect(parses([])).toBe(false);
    expect(parses(Array.from({ length: 21 }, (_, i) => `--flag${i}`))).toBe(false);
    expect(parses(Array.from({ length: 20 }, (_, i) => `--flag${i}`))).toBe(true);
    expect(parses([`--${"a".repeat(254)}`])).toBe(true);
    expect(parses([`--${"a".repeat(255)}`])).toBe(false);
    expect(parses(["--bad\nflag"])).toBe(false);
    expect(parses(["--bad\0flag"])).toBe(false);
    expect(parses("--yolo")).toBe(false);
  });

  it("rejects an empty token, whitespace inside one, or a template a launch would expand", () => {
    expect(parses([""])).toBe(false);
    expect(parses(["--approval never"])).toBe(false);
    expect(parses(["--approval\tnever"])).toBe(false);
    expect(parses(["--session={sessionId}"])).toBe(false);
    expect(parses(["--token=${settings:apiToken}"])).toBe(false);
    expect(parses(["--home=${HOME}"])).toBe(false);
  });

  it("takes options only, each followed by at most one value", () => {
    expect(parses(["yolo"])).toBe(false);
    expect(parses(["--approval", "never", "always"])).toBe(false);
    expect(parses(["--yes", "--approval", "never"])).toBe(true);
    expect(parses(["-y"])).toBe(true);
  });

  describe("kept out of args every launch or resume carries", () => {
    const schema = getPluginManifestSchema("user");
    const withAgent = (agent: Record<string, unknown>) =>
      schema.safeParse(
        manifestWith({
          capabilities: ["agent:register"],
          contributes: { agents: [{ ...VALID_AGENT, ...agent }] },
        })
      );
    const issuePaths = (agent: Record<string, unknown>) =>
      withAgent(agent).error?.issues.map((issue) => issue.path.join(".")) ?? [];

    it("rejects a declared flag in the default args", () => {
      expect(issuePaths({ args: ["--tui", "--yolo"], permissionBypassArgs: ["--yolo"] })).toEqual([
        "contributes.agents.0.args",
      ]);
      expect(
        issuePaths({ args: ["--approval", "never"], permissionBypassArgs: ["--approval", "never"] })
      ).toEqual(["contributes.agents.0.args"]);
    });

    it("rejects any one declared option, not only the whole declaration", () => {
      expect(
        issuePaths({ args: ["--yes"], permissionBypassArgs: ["--yes", "--approval", "never"] })
      ).toEqual(["contributes.agents.0.args"]);
      expect(
        issuePaths({
          args: ["--approval", "never"],
          permissionBypassArgs: ["--yes", "--approval", "never"],
        })
      ).toEqual(["contributes.agents.0.args"]);
    });

    it("rejects a declared flag in resume args", () => {
      expect(
        issuePaths({
          permissionBypassArgs: ["--yolo"],
          resume: { kind: "project-scoped", args: ["--continue", "--yolo"] },
        })
      ).toEqual(["contributes.agents.0.resume.args"]);
      expect(
        issuePaths({
          permissionBypassArgs: ["--yolo"],
          resume: {
            kind: "session-id",
            args: ["--resume", "{sessionId}"],
            resumeLatestArgs: ["--continue", "--yolo"],
          },
        })
      ).toEqual(["contributes.agents.0.resume.resumeLatestArgs"]);
      expect(
        issuePaths({
          permissionBypassArgs: ["--yolo"],
          resume: { kind: "session-id", args: ["--resume", "{sessionId}", "--yolo"] },
        })
      ).toEqual(["contributes.agents.0.resume.args"]);
      expect(
        issuePaths({
          permissionBypassArgs: ["--yolo"],
          resume: {
            kind: "session-id",
            args: ["--resume", "{sessionId}"],
            assignSessionIdArgs: ["--yolo", "--session-id", "{sessionId}"],
          },
        })
      ).toEqual(["contributes.agents.0.resume.assignSessionIdArgs"]);
    });

    it("rejects a declared option carried in either prompt form", () => {
      const clean = { args: ["{prompt}"] };
      const carrying = { args: ["--approval", "never", "{prompt}"] };
      const permissionBypassArgs = ["--approval", "never"];
      expect(
        issuePaths({
          permissionBypassArgs,
          initialPromptForm: { interactive: carrying, headless: clean },
        })
      ).toEqual(["contributes.agents.0.initialPromptForm.interactive.args"]);
      expect(
        issuePaths({
          permissionBypassArgs,
          initialPromptForm: { interactive: clean, headless: carrying },
        })
      ).toEqual(["contributes.agents.0.initialPromptForm.headless.args"]);
      expect(
        withAgent({
          permissionBypassArgs,
          initialPromptForm: {
            interactive: { args: ["--approval", "ask", "{prompt}"] },
            headless: clean,
          },
        }).success
      ).toBe(true);
    });

    it("allows the same option with another value, and a shared option prefix", () => {
      expect(
        withAgent({ args: ["--approval", "ask"], permissionBypassArgs: ["--approval", "never"] })
          .success
      ).toBe(true);
      expect(
        withAgent({
          args: ["-c", "model=fast"],
          permissionBypassArgs: ["-c", "approval_policy=never"],
        }).success
      ).toBe(true);
      expect(withAgent({ args: ["--tui"], permissionBypassArgs: ["--yolo"] }).success).toBe(true);
      expect(withAgent({ permissionBypassArgs: ["--yolo"] }).success).toBe(true);
      expect(withAgent({ args: ["--yolo"] }).success).toBe(true);
    });
  });
});

describe("discovery metadata (#16468)", () => {
  const schema = getPluginManifestSchema("user");
  const withAgent = (agent: Record<string, unknown>) =>
    schema.safeParse(
      manifestWith({
        capabilities: ["agent:register"],
        contributes: { agents: [{ ...VALID_AGENT, ...agent }] },
      })
    );
  const errorCodes = (agent: Record<string, unknown>) =>
    withAgent(agent).error?.issues.map(
      (issue) => (issue as { params?: { errorCode?: string } }).params?.errorCode
    ) ?? [];
  const issuePaths = (agent: Record<string, unknown>) =>
    withAgent(agent).error?.issues.map((issue) => issue.path.join(".")) ?? [];

  it("accepts the Pi and mini-swe-agent shapes the issue names", () => {
    expect(
      withAgent({
        id: "pi",
        command: "pi",
        packages: { npm: "@earendil-works/pi-coding-agent" },
      }).success
    ).toBe(true);
    expect(
      withAgent({
        id: "mini-swe-agent",
        command: "mini",
        packages: { pypi: "mini-swe-agent" },
        nativePaths: ["%USERPROFILE%\\.local\\bin\\mini.exe", "~/.local/bin/mini"],
      }).success
    ).toBe(true);
  });

  it("keeps both fields optional", () => {
    const result = withAgent({});
    expect(result.success).toBe(true);
    const agent = result.data?.contributes.agents[0];
    expect(agent).not.toHaveProperty("nativePaths");
    expect(agent).not.toHaveProperty("packages");
  });

  describe("nativePaths", () => {
    const parses = (nativePaths: unknown, command = "acme") =>
      withAgent({ command, nativePaths }).success;

    it.each([
      "~/.acme/bin/acme",
      "~/Library/Application Support/Acme (beta)/bin/acme",
      "/opt/acme/bin/acme",
      "/opt/@acme/c++_tools/acme",
      "%USERPROFILE%\\.acme\\bin\\acme.exe",
      "%LOCALAPPDATA%\\Programs\\Acme\\acme.cmd",
      "%APPDATA%\\npm\\acme.cmd",
      "%ProgramFiles%\\Acme\\acme.exe",
      "%PROGRAMFILES%\\Acme\\acme.exe",
      "%ProgramFiles(x86)%\\Acme\\acme.exe",
      "%ProgramData%\\Acme\\acme.bat",
    ])("accepts %s", (entry) => {
      expect(parses([entry])).toBe(true);
    });

    it.each([
      ["relative", "bin/acme"],
      ["dot-relative", "./bin/acme"],
      ["parent-relative", "../bin/acme"],
      ["bare", "acme"],
      ["another user's home", "~other/bin/acme"],
      ["a bare tilde", "~"],
      ["a drive path", "C:\\tools\\acme.exe"],
      ["a forward-slash drive path", "C:/tools/acme.exe"],
      ["drive-relative", "C:acme.exe"],
      ["UNC", "\\\\server\\share\\acme.exe"],
      ["forward-slash UNC", "//server/share/acme"],
      ["mixed-slash UNC", "/\\server\\share\\acme"],
      ["a device path", "\\\\?\\C:\\tools\\acme.exe"],
      ["root-relative backslash", "\\tools\\acme.exe"],
      ["a variable outside the list", "%TEMP%\\acme.exe"],
      ["a variable that can name a network share", "%LOGONSERVER%\\share\\acme.exe"],
      ["a variable holding a drive-relative path", "%HOMEPATH%\\acme.exe"],
      ["a second variable", "%USERPROFILE%\\%APPDATA%\\acme.exe"],
      ["a variable below a POSIX root", "~/%APPDATA%/acme"],
      ["a variable with forward slashes", "%USERPROFILE%/bin/acme"],
      ["a backslash in a POSIX entry", "/opt\\acme"],
      ["a forward slash in a Windows entry", "%USERPROFILE%\\bin/acme.exe"],
      ["traversal", "~/../../bin/acme"],
      ["Windows traversal", "%USERPROFILE%\\..\\..\\acme.exe"],
      ["a dot segment", "/opt/./acme"],
      ["traversal Win32 would normalize", "%USERPROFILE%\\.. \\acme.exe"],
      ["dots Win32 would normalize", "%USERPROFILE%\\...\\acme.exe"],
      ["an empty segment", "/opt//acme"],
      ["a trailing separator", "/opt/acme/"],
      ["only a root", "~/"],
      ["only a variable root", "%USERPROFILE%\\"],
      ["an alternate data stream", "%USERPROFILE%\\acme.exe:stream\\acme.exe"],
      ["a settings template", "~/${settings:dir}/acme"],
      ["a shell expansion", "~/$HOME/acme"],
      ["a newline", "~/bin\n/acme"],
      ["NUL", "~/bin\0/acme"],
      ["a non-ASCII lookalike", "~/bіn/acme"],
    ])("refuses %s", (_name, entry) => {
      // The field alone, so the rule about the command's name can't refuse it instead.
      expect(
        AgentContributionSchema.safeParse({ ...VALID_AGENT, nativePaths: [entry] }).success
      ).toBe(false);
    });

    it("caps the count and the length", () => {
      const entry = "~/bin/acme";
      expect(parses(Array.from({ length: 16 }, () => entry))).toBe(true);
      expect(parses(Array.from({ length: 17 }, () => entry))).toBe(false);
      expect(parses([])).toBe(false);
      const atCap = `~/${"a".repeat(256 - "~/".length - "/acme".length)}/acme`;
      expect(atCap).toHaveLength(256);
      expect(parses([atCap])).toBe(true);
      expect(parses([`~/a${atCap.slice(2)}`])).toBe(false);
    });

    describe("each ending in the agent's own command", () => {
      it.each([
        ["acme", "~/bin/acme"],
        ["acme", "~/bin/acme.exe"],
        ["acme", "~/bin/acme.cmd"],
        ["acme", "~/bin/acme.bat"],
        ["acme", "~/bin/acme.com"],
        ["acme", "%USERPROFILE%\\bin\\acme.EXE"],
        ["acme.dev", "~/bin/acme.dev"],
        ["acme.dev", "~/bin/acme.dev.exe"],
        ["acme.cmd", "~/bin/acme.cmd"],
        ["acme.ps1", "~/bin/acme.ps1"],
      ])("a %s command accepts %s", (command, entry) => {
        expect(parses([entry], command)).toBe(true);
      });

      it.each([
        ["acme", "~/bin/notacme"],
        ["acme", "~/bin/acme-beta"],
        ["acme", "~/bin/acme.sh"],
        ["acme", "~/bin/acme.ps1"],
        ["acme", "~/bin/acme.exe.exe"],
        ["acme", "~/acme/bin"],
        ["acme", "~/bin/ACME"],
        ["acme", "%USERPROFILE%\\bin\\ACME.exe"],
        ["acme.cmd", "~/bin/acme"],
        ["acme.cmd", "~/bin/acme.exe"],
        ["acme.cmd", "~/bin/acme.cmd.cmd"],
        ["acme.ps1", "~/bin/acme.ps1.exe"],
      ])("a %s command refuses %s", (command, entry) => {
        expect(parses([entry], command)).toBe(false);
      });

      it("points at the entry that doesn't", () => {
        const agent = { nativePaths: ["~/bin/acme", "~/bin/other"] };
        expect(issuePaths(agent)).toEqual(["contributes.agents.0.nativePaths.1"]);
        expect(errorCodes(agent)).toEqual(["agent_native_path_not_command"]);
      });
    });
  });

  describe("packages", () => {
    const parses = (packages: unknown) => withAgent({ packages }).success;

    it.each([
      "acme",
      "acme-agent",
      "acme_agent",
      "acme.agent",
      "@acme/agent",
      "@earendil-works/pi-coding-agent",
    ])("accepts the npm name %s", (npm) => {
      expect(parses({ npm })).toBe(true);
    });

    it.each([
      "",
      "Acme",
      "@Acme/agent",
      "@acme",
      "@acme/",
      "/agent",
      "acme/agent",
      "@acme/agent/extra",
      "@acme/../agent",
      "acme@1.2.3",
      "@acme/agent@latest",
      "https://example.com/acme.tgz",
      "git+ssh://git@example.com/acme.git",
      "../acme",
      ".acme",
      "_acme",
      "acme agent",
      "acme\n",
      "a".repeat(215),
    ])("refuses the npm name %j", (npm) => {
      expect(parses({ npm })).toBe(false);
    });

    it("accepts an npm name at npm's own length limit", () => {
      expect(parses({ npm: "a".repeat(214) })).toBe(true);
    });

    it.each(["acme", "mini-swe-agent", "aider-chat", "a1-b2"])(
      "accepts the PyPI name %s",
      (pypi) => {
        expect(parses({ pypi })).toBe(true);
      }
    );

    it.each([
      "",
      // uv and pipx name their directories by the normalized form, so any other
      // spelling would validate and then quietly never be found.
      "Acme",
      "acme_agent",
      "acme.agent",
      "acme--agent",
      "-acme",
      "acme-",
      "acme[extra]",
      "acme==1.2.3",
      "acme>=1",
      "../acme",
      "acme/agent",
      "acme\\agent",
      "..",
      "acme agent",
      "acme\n",
      "https://example.com/acme.whl",
      "a".repeat(129),
    ])("refuses the PyPI name %j", (pypi) => {
      expect(parses({ pypi })).toBe(false);
    });

    it("accepts a PyPI name at the cap", () => {
      expect(parses({ pypi: "a".repeat(128) })).toBe(true);
    });

    it("accepts both ecosystems together", () => {
      expect(parses({ npm: "acme", pypi: "acme" })).toBe(true);
    });

    it("refuses other ecosystems and an empty declaration", () => {
      expect(parses({})).toBe(false);
      expect(parses({ brew: "acme" })).toBe(false);
      expect(parses({ npm: "acme", cargo: "acme" })).toBe(false);
    });
  });

  it("refuses fields that would run the agent or stand in for the declared ones", () => {
    expect(withAgent({ supportsWsl: true }).success).toBe(false);
    expect(withAgent({ npmGlobalPackage: "acme" }).success).toBe(false);
  });

  describe("beside a bundled command", () => {
    const command = "./bin/acme";

    it("refuses nativePaths, which is never probed for one", () => {
      const agent = { command, nativePaths: ["~/bin/acme"] };
      expect(issuePaths(agent)).toEqual(["contributes.agents.0.nativePaths"]);
      expect(errorCodes(agent)).toEqual(["agent_discovery_bundled_command"]);
    });

    it("refuses packages, which are never probed for one", () => {
      const agent = { command, packages: { npm: "acme" } };
      expect(issuePaths(agent)).toEqual(["contributes.agents.0.packages"]);
      expect(errorCodes(agent)).toEqual(["agent_discovery_bundled_command"]);
    });

    it("still accepts the command alone", () => {
      expect(withAgent({ command }).success).toBe(true);
    });
  });

  describe("packages beside a command that already names its launcher", () => {
    it.each(["acme.cmd", "acme.EXE", "acme.bat", "acme.com", "acme.ps1"])(
      "refuses them beside %s, since the package layers would add a second suffix",
      (command) => {
        const agent = { command, packages: { npm: "acme" } };
        expect(issuePaths(agent)).toEqual(["contributes.agents.0.packages"]);
        expect(errorCodes(agent)).toEqual(["agent_discovery_suffixed_command"]);
      }
    );

    it("leaves a dotted name that isn't a launcher alone", () => {
      expect(withAgent({ command: "acme.dev", packages: { npm: "acme" } }).success).toBe(true);
    });
  });
});
