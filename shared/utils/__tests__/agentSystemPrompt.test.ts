import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { parse as parseToml } from "smol-toml";
import {
  extractSystemPromptArgs,
  normalizeSystemPrompt,
  resolveSystemPromptArgs,
  SYSTEM_PROMPT_MAX_LENGTH,
} from "../agentSystemPrompt.js";
import {
  buildAgentLaunchFlags,
  buildLaunchCommandFromFlags,
  buildResumeCommand,
  buildResumeLatestCommand,
  generateAgentCommand,
  reconcileBypassFlags,
  reconcileDecorationFlags,
  reconcileInlineModeFlag,
} from "../../types/agentSettings.js";

const INSTRUCTION = "Do not ask multiple-choice questions; infer the best option.";

function codexValue(args: string[]): unknown {
  expect(args[0]).toBe("-c");
  return parseToml(args[1] ?? "").developer_instructions;
}

describe("normalizeSystemPrompt", () => {
  it("treats absent and blank text as no instruction", () => {
    expect(normalizeSystemPrompt(undefined)).toBeUndefined();
    expect(normalizeSystemPrompt("")).toBeUndefined();
    expect(normalizeSystemPrompt("  \n\t ")).toBeUndefined();
  });

  it("flattens line breaks and other controls to single spaces", () => {
    expect(normalizeSystemPrompt("one\r\ntwo\nthree\tfour")).toBe("one two three four");
    expect(normalizeSystemPrompt(`a${String.fromCharCode(0x1b)}[31mb`)).toBe("a [31mb");
    expect(normalizeSystemPrompt(`a${String.fromCharCode(0x7f, 0x9b)}b`)).toBe("a b");
    expect(normalizeSystemPrompt("a\u2028b\u2029c")).toBe("a b c");
  });

  it("keeps ordinary Unicode and replaces lone surrogates", () => {
    expect(normalizeSystemPrompt("naïve — 日本語 🚀")).toBe("naïve — 日本語 🚀");
    expect(normalizeSystemPrompt("a\ud800b\udc00c")).toBe("a\ufffdb\ufffdc");
  });
});

describe("resolveSystemPromptArgs", () => {
  it("maps to Claude's append flag with the text as its own argument", () => {
    expect(resolveSystemPromptArgs("claude", ` ${INSTRUCTION}\n`)).toEqual({
      ok: true,
      args: ["--append-system-prompt", INSTRUCTION],
    });
  });

  it("maps to a Codex developer_instructions override that parses back to the text", () => {
    const result = resolveSystemPromptArgs("codex", INSTRUCTION);
    if (!result.ok) throw new Error(result.reason);
    expect(result.args).toEqual(["-c", `developer_instructions=${JSON.stringify(INSTRUCTION)}`]);
    expect(codexValue(result.args)).toBe(INSTRUCTION);
  });

  it.each([
    ['say "hi" \\ then \\"quote\\"', 'say "hi" \\ then \\"quote\\"'],
    ["tabs\tand\nlines", "tabs and lines"],
    ["unicode 日本語 🚀 and \u00a0nbsp", "unicode 日本語 🚀 and \u00a0nbsp"],
    [`del${String.fromCharCode(0x7f)}and lone \ud800 surrogate`, "del and lone \ufffd surrogate"],
    [
      "single 'quotes' and $(subshell) `ticks` %PATH%",
      "single 'quotes' and $(subshell) `ticks` %PATH%",
    ],
  ])("encodes %j as valid TOML for Codex", (input, expected) => {
    const result = resolveSystemPromptArgs("codex", input);
    if (!result.ok) throw new Error(result.reason);
    expect(codexValue(result.args)).toBe(expected);
  });

  it("maps blank text to no arguments, whatever the agent", () => {
    expect(resolveSystemPromptArgs("gemini", "   ")).toEqual({ ok: true, args: [] });
    expect(resolveSystemPromptArgs("claude", undefined)).toEqual({ ok: true, args: [] });
  });

  it.each(["gemini", "qwen", "cursor", "opencode", "daintree-assistant"])(
    "refuses %s, which has no way to append to its system prompt",
    (agentId) => {
      const result = resolveSystemPromptArgs(agentId, INSTRUCTION);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toContain("appends to its system prompt");
    }
  );

  it("names the agent in the refusal, and refuses unknown agents", () => {
    const gemini = resolveSystemPromptArgs("gemini", INSTRUCTION);
    expect(gemini.ok === false && gemini.reason.startsWith("Gemini")).toBe(true);
    expect(resolveSystemPromptArgs("not-an-agent", INSTRUCTION).ok).toBe(false);
  });

  it("refuses text starting with a dash rather than letting it pass as an option", () => {
    const result = resolveSystemPromptArgs("claude", "\n--dangerously-skip-permissions");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("can't start with '-'");
    expect(resolveSystemPromptArgs("claude", "Use - for bullets").ok).toBe(true);
  });

  it("enforces the length limit on the normalized text", () => {
    expect(resolveSystemPromptArgs("claude", "a".repeat(SYSTEM_PROMPT_MAX_LENGTH)).ok).toBe(true);
    expect(resolveSystemPromptArgs("claude", "a".repeat(SYSTEM_PROMPT_MAX_LENGTH + 1)).ok).toBe(
      false
    );
  });
});

describe("extractSystemPromptArgs", () => {
  it("finds the pair among other flags and returns the last one", () => {
    expect(
      extractSystemPromptArgs(
        ["--model", "opus", "--append-system-prompt", "first", "--append-system-prompt", "second"],
        "claude"
      )
    ).toEqual(["--append-system-prompt", "second"]);
  });

  it("matches Codex's config key and ignores other -c overrides", () => {
    const pair = ["-c", 'developer_instructions="Be terse"'];
    expect(extractSystemPromptArgs(["-c", "tui.whimsy=false", ...pair], "codex")).toEqual(pair);
    expect(extractSystemPromptArgs(["-c", "tui.whimsy=false"], "codex")).toEqual([]);
  });

  it("ignores a flag whose next token is another option", () => {
    expect(extractSystemPromptArgs(["--append-system-prompt", "--verbose"], "claude")).toEqual([]);
    expect(extractSystemPromptArgs(["--append-system-prompt"], "claude")).toEqual([]);
  });

  it("returns nothing for agents without the capability or without flags", () => {
    expect(extractSystemPromptArgs(["--append-system-prompt", "x"], "gemini")).toEqual([]);
    expect(extractSystemPromptArgs(undefined, "claude")).toEqual([]);
  });
});

describe("standing instruction through the launch builders", () => {
  const originalPlatform = process.platform;
  beforeEach(() => {
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
  });
  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
  });

  const text = "It's one argument; don't split $(it)";
  const claudeArgs = ["--append-system-prompt", text];
  const quoted = `'It'\\''s one argument; don'\\''t split $(it)'`;

  it("quotes the value as a single shell word ahead of the first-turn prompt", () => {
    const cmd = generateAgentCommand("claude", {}, "claude", {
      modelId: "opus",
      systemPromptArgs: claudeArgs,
      initialPrompt: "Fix the bug",
    });
    expect(cmd).toBe(`claude --model opus --append-system-prompt ${quoted} 'Fix the bug'`);
  });

  it("persists the raw pair so every relaunch path replays it quoted", () => {
    const flags = buildAgentLaunchFlags({}, "claude", { systemPromptArgs: claudeArgs });
    expect(flags).toEqual(claudeArgs);
    expect(buildResumeCommand("claude", "abc", flags)).toBe(
      `claude --append-system-prompt ${quoted} --resume abc`
    );
    expect(buildResumeLatestCommand("claude", flags)).toBe(
      `claude --append-system-prompt ${quoted} --continue`
    );
    expect(buildLaunchCommandFromFlags("claude", "claude", flags)).toBe(
      `claude --append-system-prompt ${quoted}`
    );
  });

  it("survives flag reconciliation for Codex, whose decorations share the -c flag", () => {
    const resolved = resolveSystemPromptArgs("codex", "tui.whimsy=false");
    if (!resolved.ok) throw new Error(resolved.reason);
    const flags = buildAgentLaunchFlags({}, "codex", { systemPromptArgs: resolved.args });
    const reconciled = reconcileDecorationFlags(
      reconcileInlineModeFlag(reconcileBypassFlags(flags, "codex", false), "codex", false),
      "codex",
      true
    );
    expect(extractSystemPromptArgs(reconciled, "codex")).toEqual(resolved.args);
    expect(reconciled).not.toContain("tui.whimsy=false");
  });
});
