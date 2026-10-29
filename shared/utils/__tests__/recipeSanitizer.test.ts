import { describe, it, expect } from "vitest";
import { inspectRecipeTerminals, sanitizeRecipeTerminals } from "../recipeSanitizer.js";

describe("sanitizeRecipeTerminals", () => {
  it("returns empty array for non-array input", () => {
    expect(sanitizeRecipeTerminals(undefined)).toEqual([]);
    expect(sanitizeRecipeTerminals(null)).toEqual([]);
    expect(sanitizeRecipeTerminals("nope")).toEqual([]);
    expect(sanitizeRecipeTerminals({})).toEqual([]);
  });

  it("keeps valid terminals and trims empty commands", () => {
    const result = sanitizeRecipeTerminals([
      { type: "terminal", title: "Shell", command: "  npm test  " },
      { type: "dev-preview", title: "Dev", devCommand: "  npm run dev  " },
      { type: "codex", title: "Agent", initialPrompt: "hello\r\n", args: "  --fast  " },
    ]);

    expect(result).toHaveLength(3);
    expect(result[0]).toMatchObject({ type: "terminal", command: "npm test" });
    expect(result[1]).toMatchObject({ type: "dev-preview", devCommand: "npm run dev" });
    expect(result[2]).toMatchObject({ type: "codex", initialPrompt: "hello", args: "--fast" });
  });

  it("drops terminals with a type outside the allowlist", () => {
    const result = sanitizeRecipeTerminals([
      { type: "terminal", command: "ok" },
      { type: "rm-rf-everything", command: "evil" },
      { type: "", command: "blank" },
      { command: "no-type" },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]?.type).toBe("terminal");
  });

  it("drops terminals with control characters in command", () => {
    const result = sanitizeRecipeTerminals([
      { type: "terminal", command: "echo hi\nrm -rf /" },
      { type: "terminal", command: "echo\x00boom" },
      { type: "terminal", command: "echo safe" },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]?.command).toBe("echo safe");
  });

  it("drops terminals with control characters in args or devCommand", () => {
    const result = sanitizeRecipeTerminals([
      { type: "claude", args: "--model\x00evil" },
      { type: "dev-preview", devCommand: "npm run\ndev" },
      { type: "claude", args: "--model sonnet" },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]?.args).toBe("--model sonnet");
  });

  it("allows newlines in initialPrompt but rejects other control chars", () => {
    const result = sanitizeRecipeTerminals([
      { type: "claude", initialPrompt: "line one\r\nline two" },
      { type: "claude", initialPrompt: "bad\x07bell" },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]?.initialPrompt).toBe("line one\nline two");
  });

  it("drops terminals whose env has non-string values", () => {
    const result = sanitizeRecipeTerminals([
      { type: "terminal", command: "ok", env: { FOO: 123 } },
      { type: "terminal", command: "ok", env: { FOO: "bar" } },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]?.env).toEqual({ FOO: "bar" });
  });

  it("drops terminals whose env has control characters in keys or values", () => {
    const result = sanitizeRecipeTerminals([
      { type: "terminal", command: "ok", env: { GOOD: "value\ninjected" } },
      { type: "terminal", command: "ok", env: { "BAD\nKEY": "value" } },
      { type: "terminal", command: "ok", env: { GOOD: "value" } },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]?.env).toEqual({ GOOD: "value" });
  });

  it("strips unknown fields — only known keys survive", () => {
    const result = sanitizeRecipeTerminals([
      {
        type: "terminal",
        command: "ok",
        shell: true,
        __proto__hack: "x",
        agentModelId: "leak",
        agentLaunchFlags: ["--leak"],
      },
    ]);
    expect(result).toHaveLength(1);
    expect(Object.keys(result[0]!).sort()).toEqual([
      "args",
      "command",
      "devCommand",
      "env",
      "exitBehavior",
      "initialPrompt",
      "title",
      "type",
    ]);
    expect((result[0] as unknown as Record<string, unknown>).shell).toBeUndefined();
    expect((result[0] as unknown as Record<string, unknown>).agentModelId).toBeUndefined();
  });

  it("drops terminals with an unknown non-empty exitBehavior but keeps known ones", () => {
    const result = sanitizeRecipeTerminals([
      { type: "terminal", command: "ok", exitBehavior: "keep" },
      { type: "terminal", command: "ok", exitBehavior: "restart" },
      { type: "terminal", command: "ok", exitBehavior: "" },
    ]);
    expect(result).toHaveLength(2);
    expect(result[0]?.exitBehavior).toBe("keep");
    expect(result[1]?.exitBehavior).toBeUndefined();
  });

  describe("additionalAllowedTypes (#11860)", () => {
    it("admits an extra agent id only when it is passed in", () => {
      const terminals = [{ type: "acme-agent", initialPrompt: "go" }];
      expect(sanitizeRecipeTerminals(terminals)).toEqual([]);
      expect(
        sanitizeRecipeTerminals(terminals, {
          additionalAllowedTypes: new Set(["acme-agent"]),
        })
      ).toHaveLength(1);
    });

    it("admits only the listed extras, not every unknown type", () => {
      const result = sanitizeRecipeTerminals(
        [
          { type: "acme-agent", initialPrompt: "go" },
          { type: "someone-elses-agent", initialPrompt: "go" },
        ],
        { additionalAllowedTypes: new Set(["acme-agent"]) }
      );
      expect(result.map((t) => t.type)).toEqual(["acme-agent"]);
    });

    it("still applies content validation to an admitted extra type", () => {
      // Widening the type allowlist must not widen the control-character gate:
      // an admitted agent id with an injected newline in its flags is dropped.
      const result = sanitizeRecipeTerminals([{ type: "acme-agent", args: "--x\nrm -rf /" }], {
        additionalAllowedTypes: new Set(["acme-agent"]),
      });
      expect(result).toEqual([]);
    });
  });

  describe("plugin-only steps and fields (#13797)", () => {
    const PANELS = new Set(["acme.records"]);

    it("drops a plugin-panel step at every boundary that doesn't name the plugin's own kinds", () => {
      const steps = [{ type: "plugin-panel", panelKindId: "acme.records" }];
      expect(sanitizeRecipeTerminals(steps)).toEqual([]);
      expect(sanitizeRecipeTerminals(steps, { pluginPanelKinds: new Set() })).toEqual([]);
      expect(
        sanitizeRecipeTerminals([{ type: "plugin-panel", panelKindId: "other.records" }], {
          pluginPanelKinds: PANELS,
        })
      ).toEqual([]);
    });

    it("keeps an own panel step with only its panel fields, copying its args", () => {
      const panelArgs = { recordId: "42", nested: { tab: "notes" } };
      const [step] = sanitizeRecipeTerminals(
        [
          {
            type: "plugin-panel",
            title: "Records",
            panelKindId: "acme.records",
            panelArgs,
            command: "rm -rf /",
            env: { TOKEN: "x" },
          },
        ],
        { pluginPanelKinds: PANELS }
      );
      expect(step).toEqual({
        type: "plugin-panel",
        title: "Records",
        panelKindId: "acme.records",
        panelArgs,
      });
      expect(step!.panelArgs).not.toBe(panelArgs);
    });

    it("drops a panel step whose args are not plain JSON within the cap", () => {
      const oversized = { blob: "x".repeat(9000) };
      expect(
        sanitizeRecipeTerminals(
          [
            { type: "plugin-panel", panelKindId: "acme.records", panelArgs: oversized },
            { type: "plugin-panel", panelKindId: "acme.records", panelArgs: ["not", "an object"] },
          ],
          { pluginPanelKinds: PANELS }
        )
      ).toEqual([]);
    });

    it("keeps an agent step's systemPrompt only where the boundary allows it", () => {
      const steps = [{ type: "claude", systemPrompt: "  Use the ledger tools.  " }];
      expect(sanitizeRecipeTerminals(steps)[0]!.systemPrompt).toBeUndefined();
      expect(sanitizeRecipeTerminals(steps, { allowSystemPrompt: true })[0]!.systemPrompt).toBe(
        "Use the ledger tools."
      );
      expect(
        sanitizeRecipeTerminals([{ type: "terminal", systemPrompt: "x" }], {
          allowSystemPrompt: true,
        })[0]!.systemPrompt
      ).toBeUndefined();
    });

    it("drops an agent step whose systemPrompt holds control characters", () => {
      expect(
        sanitizeRecipeTerminals([{ type: "claude", systemPrompt: "ok\u0007bell" }], {
          allowSystemPrompt: true,
        })
      ).toEqual([]);
    });
  });
});

describe("inspectRecipeTerminals (#15044)", () => {
  const reasonsFor = (
    terminals: unknown[],
    options?: Parameters<typeof inspectRecipeTerminals>[1]
  ) => inspectRecipeTerminals(terminals, options).rejected.map((r) => r.rejection);

  it("names each dropped terminal by its original position and title", () => {
    const { accepted, rejected } = inspectRecipeTerminals([
      { type: "terminal", title: "Shell", command: "npm test" },
      { type: "acme-agent", title: "Plugin agent" },
      "not a terminal",
      { type: "claude", title: 42, args: "--model\u0000evil" },
    ]);

    expect(accepted.map((t) => t.title)).toEqual(["Shell"]);
    expect(rejected).toEqual([
      {
        index: 1,
        title: "Plugin agent",
        rejection: { kind: "unsupported-type", type: "acme-agent" },
      },
      { index: 2, rejection: { kind: "not-an-object" } },
      { index: 3, rejection: { kind: "control-char", field: "args" } },
    ]);
  });

  it("says why for every check a terminal can fail", () => {
    expect(
      reasonsFor([
        { command: "no type" },
        { type: "" },
        { type: 7 },
        { type: "terminal", command: ["npm", "test"] },
        { type: "terminal", command: "a\rb" },
        { type: "claude", initialPrompt: "bell\u0007" },
        { type: "dev-preview", devCommand: "npm\nrun" },
        { type: "terminal", env: "FOO=bar" },
        { type: "terminal", env: { FOO: 1 } },
        { type: "terminal", env: { "BAD\nKEY": "v" } },
        { type: "terminal", exitBehavior: "restart" },
      ])
    ).toEqual([
      { kind: "missing-type" },
      { kind: "missing-type" },
      { kind: "missing-type" },
      { kind: "wrong-shape", field: "command" },
      { kind: "control-char", field: "command" },
      { kind: "control-char", field: "initialPrompt" },
      { kind: "control-char", field: "devCommand" },
      { kind: "wrong-shape", field: "env" },
      { kind: "wrong-shape", field: "env" },
      { kind: "control-char", field: "env" },
      { kind: "unsupported-value", field: "exitBehavior" },
    ]);
  });

  it("reports only the first check a terminal fails", () => {
    expect(reasonsFor([{ type: "terminal", command: 1, args: "x\ny", env: "nope" }])).toEqual([
      { kind: "wrong-shape", field: "command" },
    ]);
  });

  it("follows the boundary's options for plugin steps and system prompts", () => {
    expect(reasonsFor([{ type: "plugin-panel", panelKindId: "acme.records" }])).toEqual([
      { kind: "unsupported-type", type: "plugin-panel" },
    ]);
    const panels = { pluginPanelKinds: new Set(["acme.records"]) };
    expect(
      reasonsFor(
        [
          { type: "plugin-panel", panelKindId: "acme.other" },
          { type: "plugin-panel", panelKindId: 3 },
          { type: "plugin-panel", panelKindId: "acme.records", panelArgs: ["no"] },
        ],
        panels
      )
    ).toEqual([
      { kind: "unsupported-value", field: "panelKindId" },
      { kind: "wrong-shape", field: "panelKindId" },
      { kind: "unsupported-value", field: "panelArgs" },
    ]);
    const prompt = [{ type: "claude", systemPrompt: "bell\u0007" }];
    expect(reasonsFor(prompt)).toEqual([]);
    expect(reasonsFor(prompt, { allowSystemPrompt: true })).toEqual([
      { kind: "control-char", field: "systemPrompt" },
    ]);
  });

  it("keeps the empty type admissible where a boundary explicitly allows it", () => {
    const { accepted, rejected } = inspectRecipeTerminals([{ type: "" }], {
      additionalAllowedTypes: new Set([""]),
    });
    expect(rejected).toEqual([]);
    expect(accepted).toHaveLength(1);
  });

  it("accepts exactly what sanitizeRecipeTerminals keeps", () => {
    const input = [
      { type: "terminal", command: "  npm test  ", extra: "dropped field" },
      { type: "bogus" },
      { type: "codex", initialPrompt: "hi\r\n", args: "  --fast  " },
      { type: "dev-preview", devCommand: "a\nb" },
    ];
    const { accepted, rejected } = inspectRecipeTerminals(input);
    expect(accepted).toEqual([
      {
        type: "terminal",
        title: undefined,
        command: "npm test",
        env: undefined,
        initialPrompt: undefined,
        devCommand: undefined,
        args: undefined,
        exitBehavior: undefined,
      },
      {
        type: "codex",
        title: undefined,
        command: undefined,
        env: undefined,
        initialPrompt: "hi",
        devCommand: undefined,
        args: "--fast",
        exitBehavior: undefined,
      },
    ]);
    expect(accepted[0]).not.toHaveProperty("extra");
    expect(rejected.map((r) => r.index)).toEqual([1, 3]);
    expect(sanitizeRecipeTerminals(input)).toEqual(accepted);
  });

  it("returns nothing for input that isn't an array", () => {
    expect(inspectRecipeTerminals({ type: "terminal" })).toEqual({ accepted: [], rejected: [] });
  });
});
