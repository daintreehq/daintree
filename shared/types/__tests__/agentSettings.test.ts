import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  buildResumeCommand,
  buildAgentLaunchFlags,
  buildLaunchCommandFromFlags,
  generateAgentCommand,
} from "../agentSettings.js";

// Force POSIX shell-escape semantics so the hardcoded single-quote assertions
// below hold on Windows CI. The Windows double-quote branch is exercised via
// the `platform` override in shellEscape's own unit tests.
function forcePosixPlatform() {
  const original = process.platform;
  beforeEach(() => {
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
  });
  afterEach(() => {
    Object.defineProperty(process, "platform", { value: original, configurable: true });
  });
}

describe("buildResumeCommand", () => {
  it("builds claude resume command with --resume flag", () => {
    expect(buildResumeCommand("claude", "abc-123")).toBe("claude --resume abc-123");
  });

  it("builds gemini resume command with --resume flag", () => {
    expect(buildResumeCommand("gemini", "abc-123")).toBe("gemini --resume abc-123");
  });

  it("builds codex resume command with subcommand (no dash)", () => {
    const cmd = buildResumeCommand("codex", "abc-123");
    expect(cmd).toBe("codex resume abc-123");
    expect(cmd).not.toContain("--resume");
  });

  it("builds opencode resume command with -s flag", () => {
    expect(buildResumeCommand("opencode", "ses_abc")).toBe("opencode -s ses_abc");
  });

  it("builds copilot resume command with --resume= (equals concatenation)", () => {
    const cmd = buildResumeCommand("copilot", "abc-def-123");
    expect(cmd).toBe("copilot --resume=abc-def-123");
    expect(cmd).toContain("--resume=");
  });

  it("returns undefined for unknown agent", () => {
    expect(buildResumeCommand("unknown-agent", "abc")).toBeUndefined();
  });

  it("returns undefined for agent without resume config", () => {
    // User-defined agents without resume config should return undefined
    expect(buildResumeCommand("my-custom-agent", "abc")).toBeUndefined();
  });

  it("builds project-scoped (Kiro) resume command without using the sessionId param", () => {
    // Kiro's `--resume` is directory-scoped — the session ID we pass in is
    // ignored. Verify the schema dispatch correctly drops it instead of
    // appending a stale ID after `--resume`.
    expect(buildResumeCommand("kiro", "ignored-session-id")).toBe("kiro-cli --resume");
  });

  it("escapes session IDs with special characters", () => {
    const cmd = buildResumeCommand("claude", "id with spaces");
    expect(cmd).toBeDefined();
    expect(cmd).toContain("--resume");
    // The session ID should be shell-escaped
    expect(cmd).not.toBe("claude --resume id with spaces");
  });

  it("prepends launch flags before resume args for claude", () => {
    const cmd = buildResumeCommand("claude", "sess-123", ["--dangerously-skip-permissions"]);
    expect(cmd).toBe("claude --dangerously-skip-permissions --resume sess-123");
  });

  it("prepends launch flags before resume args for codex", () => {
    const cmd = buildResumeCommand("codex", "sess-456", [
      "--no-alt-screen",
      "--dangerously-bypass-approvals-and-sandbox",
    ]);
    expect(cmd).toBe(
      "codex --no-alt-screen --dangerously-bypass-approvals-and-sandbox resume sess-456"
    );
  });

  it("prepends launch flags before resume args for gemini", () => {
    const cmd = buildResumeCommand("gemini", "sess-789", ["--yolo"]);
    expect(cmd).toBe("gemini --yolo --resume sess-789");
  });

  it("handles empty launch flags array like no flags", () => {
    expect(buildResumeCommand("claude", "abc-123", [])).toBe("claude --resume abc-123");
  });

  it("handles undefined launch flags like no flags", () => {
    expect(buildResumeCommand("claude", "abc-123", undefined)).toBe("claude --resume abc-123");
  });

  it("escapes non-flag launch flag values", () => {
    const cmd = buildResumeCommand("claude", "abc-123", [
      "--dangerously-skip-permissions",
      "some value",
    ]);
    expect(cmd).toBeDefined();
    expect(cmd).toContain("--dangerously-skip-permissions");
    // Non-flag value should be shell-escaped
    expect(cmd).not.toContain(" some value ");
  });
});

describe("buildAgentLaunchFlags", () => {
  it("returns empty array for default settings with no dangerous mode", () => {
    const flags = buildAgentLaunchFlags({}, "claude");
    expect(flags).toEqual([]);
  });

  it("includes dangerous args when enabled", () => {
    const flags = buildAgentLaunchFlags(
      { dangerousEnabled: true, dangerousArgs: "--dangerously-skip-permissions" },
      "claude"
    );
    expect(flags).toContain("--dangerously-skip-permissions");
  });

  it("includes custom flags", () => {
    const flags = buildAgentLaunchFlags({ customFlags: "--verbose --debug" }, "claude");
    expect(flags).toContain("--verbose");
    expect(flags).toContain("--debug");
  });

  it("includes inline mode flag for codex when enabled", () => {
    const flags = buildAgentLaunchFlags({ inlineMode: true }, "codex");
    expect(flags).toContain("--no-alt-screen");
  });

  it("includes inline mode flag for codex by default (inlineMode not explicitly false)", () => {
    const flags = buildAgentLaunchFlags({}, "codex");
    expect(flags).toContain("--no-alt-screen");
  });

  it("excludes inline mode flag when inlineMode is false", () => {
    const flags = buildAgentLaunchFlags({ inlineMode: false }, "codex");
    expect(flags).not.toContain("--no-alt-screen");
  });

  it("does not include clipboard directory", () => {
    const flags = buildAgentLaunchFlags({ shareClipboardDirectory: true }, "gemini");
    expect(flags).not.toContain("--include-directories");
  });

  it("combines dangerous args, custom flags, and inline mode", () => {
    const flags = buildAgentLaunchFlags(
      {
        dangerousEnabled: true,
        dangerousArgs: "--dangerously-bypass-approvals-and-sandbox",
        customFlags: "--verbose",
        inlineMode: true,
      },
      "codex"
    );
    expect(flags).toContain("--no-alt-screen");
    expect(flags).toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(flags).toContain("--verbose");
  });

  it("includes --model flag when modelId is provided", () => {
    const flags = buildAgentLaunchFlags({}, "claude", { modelId: "claude-opus-4-6" });
    expect(flags).toContain("--model");
    expect(flags).toContain("claude-opus-4-6");
    const modelIdx = flags.indexOf("--model");
    expect(flags[modelIdx + 1]).toBe("claude-opus-4-6");
  });

  it("includes preset args in persisted launch flags after model and before settings flags", () => {
    const flags = buildAgentLaunchFlags({ customFlags: "--verbose" }, "claude", {
      modelId: "claude-opus-4-6",
      presetArgs: ["--provider", "blue"],
    });
    expect(flags).toEqual(["--model", "claude-opus-4-6", "--provider", "blue", "--verbose"]);
  });

  it("does not include --model flag when modelId is not provided", () => {
    const flags = buildAgentLaunchFlags({}, "claude");
    expect(flags).not.toContain("--model");
  });

  it("does not include --model flag when options is undefined", () => {
    const flags = buildAgentLaunchFlags({}, "claude", undefined);
    expect(flags).not.toContain("--model");
  });
});

describe("generateAgentCommand copilot prompt injection", () => {
  it("uses -i flag for interactive prompt", () => {
    const cmd = generateAgentCommand("copilot", {}, "copilot", {
      initialPrompt: "Fix the bug",
    });
    expect(cmd).toContain("-i");
    expect(cmd).toContain("Fix the bug");
  });

  it("does not use -i for non-interactive mode", () => {
    const cmd = generateAgentCommand("copilot", {}, "copilot", {
      initialPrompt: "Fix the bug",
      interactive: false,
    });
    expect(cmd).not.toContain("-i");
    expect(cmd).toContain("Fix the bug");
  });
});

describe("generateAgentCommand with modelId", () => {
  it("includes --model flag in command when modelId is provided", () => {
    const cmd = generateAgentCommand("claude", {}, "claude", { modelId: "claude-opus-4-6" });
    expect(cmd).toContain("--model claude-opus-4-6");
  });

  it("does not include --model flag when modelId is not provided", () => {
    const cmd = generateAgentCommand("claude", {}, "claude");
    expect(cmd).not.toContain("--model");
  });

  it("places --model before user custom flags", () => {
    const cmd = generateAgentCommand("claude", { customFlags: "--verbose" }, "claude", {
      modelId: "claude-opus-4-6",
    });
    const modelIdx = cmd.indexOf("--model");
    const verboseIdx = cmd.indexOf("--verbose");
    expect(modelIdx).toBeLessThan(verboseIdx);
  });

  it("places --model before initial prompt", () => {
    const cmd = generateAgentCommand("claude", {}, "claude", {
      modelId: "claude-sonnet-4-6",
      initialPrompt: "Fix the bug",
    });
    const modelIdx = cmd.indexOf("--model");
    const promptIdx = cmd.indexOf("Fix the bug");
    expect(modelIdx).toBeLessThan(promptIdx);
  });
});

describe("generateAgentCommand with recipeArgs", () => {
  it("includes single flag from recipeArgs", () => {
    const cmd = generateAgentCommand("claude", {}, "claude", {
      recipeArgs: "--model sonnet",
    });
    expect(cmd).toContain("--model");
    expect(cmd).toContain("sonnet");
  });

  it("includes multiple tokens from recipeArgs", () => {
    const cmd = generateAgentCommand("claude", {}, "claude", {
      recipeArgs: "--model opus --verbose",
    });
    expect(cmd).toContain("--model");
    expect(cmd).toContain("opus");
    expect(cmd).toContain("--verbose");
  });

  it("produces no change for empty or whitespace-only recipeArgs", () => {
    const base = generateAgentCommand("claude", {}, "claude");
    const withEmpty = generateAgentCommand("claude", {}, "claude", { recipeArgs: "" });
    const withSpaces = generateAgentCommand("claude", {}, "claude", { recipeArgs: "   " });
    expect(withEmpty).toBe(base);
    expect(withSpaces).toBe(base);
  });

  it("escapes non-flag tokens in recipeArgs", () => {
    const cmd = generateAgentCommand("claude", {}, "claude", {
      recipeArgs: "--model some value",
    });
    // "some" and "value" don't start with "-", so they should be shell-escaped
    expect(cmd).toContain("--model");
    // Non-flag values should be quoted (not raw)
    expect(cmd).not.toMatch(/\s+some\s+/);
  });

  it("places recipeArgs after --model and before customFlags", () => {
    const cmd = generateAgentCommand("claude", { customFlags: "--custom-flag" }, "claude", {
      modelId: "claude-opus-4-6",
      recipeArgs: "--recipe-flag",
    });
    const modelIdx = cmd.indexOf("--model");
    const recipeIdx = cmd.indexOf("--recipe-flag");
    const customIdx = cmd.indexOf("--custom-flag");
    expect(modelIdx).toBeLessThan(recipeIdx);
    expect(recipeIdx).toBeLessThan(customIdx);
  });

  it("places recipeArgs before initial prompt", () => {
    const cmd = generateAgentCommand("claude", {}, "claude", {
      recipeArgs: "--recipe-flag",
      initialPrompt: "Do the thing",
    });
    const recipeIdx = cmd.indexOf("--recipe-flag");
    const promptIdx = cmd.indexOf("Do the thing");
    expect(recipeIdx).toBeLessThan(promptIdx);
  });
});

describe("buildLaunchCommandFromFlags", () => {
  forcePosixPlatform();

  it("joins flag-style tokens raw", () => {
    const cmd = buildLaunchCommandFromFlags("claude", "claude", [
      "--dangerously-skip-permissions",
      "--yolo",
    ]);
    expect(cmd).toBe("claude --dangerously-skip-permissions --yolo");
  });

  it("escapes non-flag positional tokens (e.g. model IDs, file paths)", () => {
    const cmd = buildLaunchCommandFromFlags("claude", "claude", ["--model", "claude-opus-4-7"]);
    // `--model` is flag-style (raw); `claude-opus-4-7` is positional (escaped).
    expect(cmd).toBe("claude --model 'claude-opus-4-7'");
  });

  it("quotes tokens containing shell metacharacters to prevent injection", () => {
    // A user customFlag like `--log /tmp/a;b.log` would split on `;` if not quoted.
    const cmd = buildLaunchCommandFromFlags("claude", "claude", ["--log", "/tmp/a;b.log"]);
    expect(cmd).toBe("claude --log '/tmp/a;b.log'");
  });

  it("escapes embedded single quotes in positional tokens", () => {
    const cmd = buildLaunchCommandFromFlags("claude", "claude", ["--msg", "it's fine"]);
    // POSIX single-quote escape: close, escape the quote, reopen.
    expect(cmd).toBe("claude --msg 'it'\\''s fine'");
  });

  it("appends --include-directories for Gemini when clipboardDirectory is provided", () => {
    const cmd = buildLaunchCommandFromFlags("gemini", "gemini", ["--yolo"], {
      clipboardDirectory: "/tmp/daintree-clipboard",
    });
    // Exact assertion locks flag/value pairing and ordering.
    expect(cmd).toBe("gemini --yolo --include-directories '/tmp/daintree-clipboard'");
  });

  it("does not inject --include-directories for non-Gemini agents", () => {
    const cmd = buildLaunchCommandFromFlags("claude", "claude", ["--yolo"], {
      clipboardDirectory: "/tmp/daintree-clipboard",
    });
    expect(cmd).not.toContain("--include-directories");
  });

  it("skips --include-directories for Gemini when shareClipboardDirectory is false", () => {
    const cmd = buildLaunchCommandFromFlags("gemini", "gemini", ["--yolo"], {
      clipboardDirectory: "/tmp/daintree-clipboard",
      shareClipboardDirectory: false,
    });
    expect(cmd).not.toContain("--include-directories");
  });

  it("skips --include-directories for Gemini when clipboardDirectory is missing", () => {
    const cmd = buildLaunchCommandFromFlags("gemini", "gemini", ["--yolo"]);
    expect(cmd).not.toContain("--include-directories");
  });

  it("deduplicates --include-directories when the same directory is already persisted", () => {
    const cmd = buildLaunchCommandFromFlags(
      "gemini",
      "gemini",
      ["--yolo", "--include-directories", "/tmp/daintree-clipboard"],
      { clipboardDirectory: "/tmp/daintree-clipboard" }
    );
    // Count exact flag-token occurrences, not substring matches.
    const tokens = cmd.split(/\s+/).filter((t) => t === "--include-directories");
    expect(tokens).toHaveLength(1);
  });

  it("does NOT dedup when persisted flags reference a different directory", () => {
    // Persisted `--include-directories /old/path` should be preserved, AND the
    // runtime clipboard dir should still be appended — each serves a distinct purpose.
    const cmd = buildLaunchCommandFromFlags(
      "gemini",
      "gemini",
      ["--include-directories", "/user/chosen/dir"],
      { clipboardDirectory: "/tmp/daintree-clipboard" }
    );
    expect(cmd).toContain("/user/chosen/dir");
    expect(cmd).toContain("/tmp/daintree-clipboard");
    const tokens = cmd.split(/\s+/).filter((t) => t === "--include-directories");
    expect(tokens).toHaveLength(2);
  });

  it("handles empty flag arrays safely", () => {
    expect(buildLaunchCommandFromFlags("claude", "claude", [])).toBe("claude");
  });

  it("does not mutate the input flags array", () => {
    const flags = ["--yolo"];
    buildLaunchCommandFromFlags("gemini", "gemini", flags, {
      clipboardDirectory: "/tmp/daintree-clipboard",
    });
    expect(flags).toEqual(["--yolo"]);
  });
});
