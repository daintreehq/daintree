import { describe, it, expect } from "vitest";
import { sanitizeRecipeTerminals } from "../recipeSanitizer.js";

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

  it("returns empty array when every terminal is invalid", () => {
    const result = sanitizeRecipeTerminals([
      { type: "bogus" },
      { type: "terminal", command: "bad\ncmd" },
    ]);
    expect(result).toEqual([]);
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
});
