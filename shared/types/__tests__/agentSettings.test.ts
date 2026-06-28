import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  buildResumeCommand,
  buildResumeLatestCommand,
  buildAgentLaunchFlags,
  buildLaunchCommandFromFlags,
  generateAgentCommand,
  generateAgentFlags,
  resolveEffectiveBypass,
  resolveDangerousMode,
  combineDangerousModes,
  reconcileBypassFlags,
  isAgentBypassSupported,
  DEFAULT_DANGEROUS_ARGS,
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
    expect(buildResumeCommand("kiro", "ignored-session-id")).toBe("kiro-cli chat --resume");
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

describe("buildResumeLatestCommand", () => {
  forcePosixPlatform();

  it("builds claude resume-latest command with --continue", () => {
    expect(buildResumeLatestCommand("claude")).toBe("claude --continue");
  });

  it("builds gemini resume-latest command with -r latest (positional required)", () => {
    // Bare `-r` opens an interactive picker that blocks the PTY; `latest`
    // must be passed positionally.
    expect(buildResumeLatestCommand("gemini")).toBe("gemini -r latest");
  });

  it("builds codex resume-latest command with subcommand + --last", () => {
    const cmd = buildResumeLatestCommand("codex");
    expect(cmd).toBe("codex resume --last");
    expect(cmd).toContain("resume");
    expect(cmd).toContain("--last");
  });

  it("returns undefined for unknown agent", () => {
    expect(buildResumeLatestCommand("unknown-agent")).toBeUndefined();
  });

  it("returns undefined for agent without resume config", () => {
    expect(buildResumeLatestCommand("my-custom-agent")).toBeUndefined();
  });

  it("returns undefined for agents whose resume kind is not session-id", () => {
    // Kimi uses rolling-history; Kiro uses project-scoped. Neither has the
    // session-id resumeLatestArgs surface — they already always launch with
    // resume flags via their own resume.args() path.
    expect(buildResumeLatestCommand("kimi")).toBeUndefined();
    expect(buildResumeLatestCommand("kiro")).toBeUndefined();
  });

  it("returns undefined for session-id agents that don't declare resumeLatestArgs", () => {
    // Copilot/Goose/Qwen/Mistral are session-id agents that didn't ship a
    // resume-latest fallback; should return undefined.
    expect(buildResumeLatestCommand("copilot")).toBeUndefined();
    expect(buildResumeLatestCommand("goose")).toBeUndefined();
    expect(buildResumeLatestCommand("qwen")).toBeUndefined();
    expect(buildResumeLatestCommand("mistral")).toBeUndefined();
  });

  it("returns opencode --continue for opencode without flags", () => {
    // OpenCode declares resumeLatestArgs: ["--continue"] so a previously-open
    // terminal can resume the latest session on restart even when no session id
    // was captured (issue #10822).
    expect(buildResumeLatestCommand("opencode")).toBe("opencode --continue");
  });

  it("prepends launch flags before resume-latest args for claude", () => {
    const cmd = buildResumeLatestCommand("claude", ["--dangerously-skip-permissions"]);
    expect(cmd).toBe("claude --dangerously-skip-permissions --continue");
  });

  it("prepends launch flags before resume-latest args for codex", () => {
    const cmd = buildResumeLatestCommand("codex", [
      "--no-alt-screen",
      "--dangerously-bypass-approvals-and-sandbox",
    ]);
    expect(cmd).toBe(
      "codex --no-alt-screen --dangerously-bypass-approvals-and-sandbox resume --last"
    );
  });

  it("prepends launch flags before resume-latest args for gemini", () => {
    const cmd = buildResumeLatestCommand("gemini", ["--yolo"]);
    expect(cmd).toBe("gemini --yolo -r latest");
  });

  it("handles empty launch flags array like no flags", () => {
    expect(buildResumeLatestCommand("claude", [])).toBe("claude --continue");
  });

  it("handles undefined launch flags like no flags", () => {
    expect(buildResumeLatestCommand("claude", undefined)).toBe("claude --continue");
  });

  it("escapes non-flag launch flag values", () => {
    const cmd = buildResumeLatestCommand("claude", [
      "--dangerously-skip-permissions",
      "some value",
    ]);
    expect(cmd).toBeDefined();
    expect(cmd).toContain("--dangerously-skip-permissions");
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

describe("generateAgentCommand per-agent prompt injection", () => {
  forcePosixPlatform();

  it("gemini uses -p for non-interactive (bare positional launches the TUI)", () => {
    const cmd = generateAgentCommand("gemini", {}, "gemini", {
      initialPrompt: "Fix the bug",
      interactive: false,
    });
    expect(cmd).toMatch(/-p\s+'Fix the bug'/);
  });

  it("gemini keeps -i for interactive", () => {
    const cmd = generateAgentCommand("gemini", {}, "gemini", {
      initialPrompt: "Fix the bug",
    });
    expect(cmd).toMatch(/-i\s+'Fix the bug'/);
  });

  it("qwen uses explicit -i/-p flags, never a bare positional", () => {
    const interactiveCmd = generateAgentCommand("qwen", {}, "qwen", {
      initialPrompt: "Fix the bug",
    });
    const printCmd = generateAgentCommand("qwen", {}, "qwen", {
      initialPrompt: "Fix the bug",
      interactive: false,
    });
    expect(interactiveCmd).toMatch(/-i\s+'Fix the bug'/);
    expect(printCmd).toMatch(/-p\s+'Fix the bug'/);
  });

  it("copilot uses -p for non-interactive", () => {
    const cmd = generateAgentCommand("copilot", {}, "copilot", {
      initialPrompt: "Fix the bug",
      interactive: false,
    });
    expect(cmd).toMatch(/-p\s+'Fix the bug'/);
  });

  it("opencode uses --prompt for interactive (bare positional is a project path)", () => {
    const cmd = generateAgentCommand("opencode", {}, "opencode", {
      initialPrompt: "Fix the bug",
    });
    expect(cmd).toMatch(/--prompt\s+'Fix the bug'/);
  });

  it("opencode uses the run subcommand for non-interactive", () => {
    const cmd = generateAgentCommand("opencode", {}, "opencode", {
      initialPrompt: "Fix the bug",
      interactive: false,
    });
    expect(cmd).toMatch(/run\s+'Fix the bug'/);
    expect(cmd).not.toContain("--prompt");
  });

  it("aider uses -m in both modes (positionals are filenames)", () => {
    const interactiveCmd = generateAgentCommand("aider", {}, "aider", {
      initialPrompt: "Fix the bug",
    });
    const oneShotCmd = generateAgentCommand("aider", {}, "aider", {
      initialPrompt: "Fix the bug",
      interactive: false,
    });
    expect(interactiveCmd).toMatch(/-m\s+'Fix the bug'/);
    expect(oneShotCmd).toMatch(/-m\s+'Fix the bug'/);
  });

  it("goose swaps the session arg for run -t and stays interactive", () => {
    const cmd = generateAgentCommand("goose", {}, "goose", {
      initialPrompt: "Fix the bug",
    });
    expect(cmd).toMatch(/^goose run\b/);
    expect(cmd).not.toMatch(/\bsession\b/);
    expect(cmd).toMatch(/-t\s+'Fix the bug'/);
    expect(cmd).toContain("--interactive");
  });

  it("goose omits --interactive in one-shot mode", () => {
    const cmd = generateAgentCommand("goose", {}, "goose", {
      initialPrompt: "Fix the bug",
      interactive: false,
    });
    expect(cmd).toMatch(/^goose run\b/);
    expect(cmd).toMatch(/-t\s+'Fix the bug'/);
    expect(cmd).not.toContain("--interactive");
  });

  it("amp uses -x for non-interactive one-shot", () => {
    const cmd = generateAgentCommand("amp", {}, "amp", {
      initialPrompt: "Fix the bug",
      interactive: false,
    });
    expect(cmd).toMatch(/-x\s+'Fix the bug'/);
  });

  it("crush uses the run subcommand for non-interactive", () => {
    const cmd = generateAgentCommand("crush", {}, "crush", {
      initialPrompt: "Fix the bug",
      interactive: false,
    });
    expect(cmd).toMatch(/run\s+'Fix the bug'/);
  });

  it("kimi uses -p in both modes (no bare-positional prompt form)", () => {
    const interactiveCmd = generateAgentCommand("kimi", {}, "kimi", {
      initialPrompt: "Fix the bug",
    });
    const oneShotCmd = generateAgentCommand("kimi", {}, "kimi", {
      initialPrompt: "Fix the bug",
      interactive: false,
    });
    expect(interactiveCmd).toMatch(/-p\s+'Fix the bug'/);
    expect(oneShotCmd).toMatch(/-p\s+'Fix the bug'/);
  });

  it("mistral adds --prompt only for non-interactive", () => {
    const interactiveCmd = generateAgentCommand("vibe", {}, "mistral", {
      initialPrompt: "Fix the bug",
    });
    const oneShotCmd = generateAgentCommand("vibe", {}, "mistral", {
      initialPrompt: "Fix the bug",
      interactive: false,
    });
    expect(interactiveCmd).not.toContain("--prompt");
    expect(interactiveCmd).toContain("'Fix the bug'");
    expect(oneShotCmd).toMatch(/--prompt\s+'Fix the bug'/);
  });

  it("kiro adds chat --no-interactive only for non-interactive", () => {
    const interactiveCmd = generateAgentCommand("kiro-cli", {}, "kiro", {
      initialPrompt: "Fix the bug",
    });
    const oneShotCmd = generateAgentCommand("kiro-cli", {}, "kiro", {
      initialPrompt: "Fix the bug",
      interactive: false,
    });
    expect(interactiveCmd).not.toContain("--no-interactive");
    expect(interactiveCmd).toContain("'Fix the bug'");
    expect(oneShotCmd).toMatch(/chat --no-interactive\s+'Fix the bug'/);
  });
});

describe("generateAgentCommand antigravity prompt injection", () => {
  forcePosixPlatform();

  it("uses -i flag for interactive prompt", () => {
    const cmd = generateAgentCommand("agy", {}, "antigravity", {
      initialPrompt: "Fix the bug",
    });
    expect(cmd).toContain("-i");
    expect(cmd).toContain("Fix the bug");
  });

  it("uses -p flag for non-interactive mode", () => {
    const cmd = generateAgentCommand("agy", {}, "antigravity", {
      initialPrompt: "Fix the bug",
      interactive: false,
    });
    expect(cmd).toContain("-p");
    expect(cmd).not.toContain("-i");
    expect(cmd).toContain("Fix the bug");
  });

  it("never emits a bare positional prompt (agy rejects them)", () => {
    const interactiveCmd = generateAgentCommand("agy", {}, "antigravity", {
      initialPrompt: "Fix the bug",
    });
    const printCmd = generateAgentCommand("agy", {}, "antigravity", {
      initialPrompt: "Fix the bug",
      interactive: false,
    });
    expect(interactiveCmd).toMatch(/-i\s+'Fix the bug'/);
    expect(printCmd).toMatch(/-p\s+'Fix the bug'/);
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

// #10432 — global skip-permissions override. claude/codex declare
// supports.permissionBypass === true; gemini declares false but still has a
// per-agent dangerous flag (--yolo) in DEFAULT_DANGEROUS_ARGS.
describe("isAgentBypassSupported", () => {
  it("is true only for agents declaring supports.permissionBypass", () => {
    expect(isAgentBypassSupported("claude")).toBe(true);
    expect(isAgentBypassSupported("codex")).toBe(true);
    expect(isAgentBypassSupported("gemini")).toBe(false);
    expect(isAgentBypassSupported(undefined)).toBe(false);
  });
});

describe("resolveEffectiveBypass", () => {
  it("forces bypass for a supported agent when the global is on, even with the per-agent toggle off", () => {
    expect(resolveEffectiveBypass({ dangerousEnabled: false }, "claude", true)).toBe(true);
    expect(resolveEffectiveBypass({ dangerousEnabled: false }, "codex", true)).toBe(true);
  });

  it("does not force bypass for an unsupported agent when the global is on", () => {
    expect(resolveEffectiveBypass({ dangerousEnabled: false }, "gemini", true)).toBe(false);
  });

  it("keeps the per-agent toggle working regardless of bypass support (unguarded)", () => {
    // Gemini is not bypass-supported but its per-agent dangerous toggle must
    // still resolve true — the global guard applies only to the global override.
    expect(resolveEffectiveBypass({ dangerousEnabled: true }, "gemini", false)).toBe(true);
  });

  it("resolves false when the global is off and the per-agent toggle is off", () => {
    expect(resolveEffectiveBypass({ dangerousEnabled: false }, "claude", false)).toBe(false);
    expect(resolveEffectiveBypass({}, "claude", undefined)).toBe(false);
  });

  it("honors an explicit 'off' veto over the global override (least privilege)", () => {
    // The whole point of the tri-state: a supported agent that would otherwise
    // inherit the global 'on' can force itself off.
    expect(resolveEffectiveBypass({ dangerousMode: "off" }, "claude", true)).toBe(false);
    expect(resolveEffectiveBypass({ dangerousMode: "off" }, "codex", true)).toBe(false);
  });

  it("treats 'on' as an unguarded force-enable (even for unsupported agents)", () => {
    expect(resolveEffectiveBypass({ dangerousMode: "on" }, "gemini", false)).toBe(true);
    expect(resolveEffectiveBypass({ dangerousMode: "on" }, "claude", false)).toBe(true);
  });

  it("'inherit' defers to the global override, gated by bypass support", () => {
    expect(resolveEffectiveBypass({ dangerousMode: "inherit" }, "claude", true)).toBe(true);
    expect(resolveEffectiveBypass({ dangerousMode: "inherit" }, "claude", false)).toBe(false);
    // Unsupported agent never inherits the global flag.
    expect(resolveEffectiveBypass({ dangerousMode: "inherit" }, "gemini", true)).toBe(false);
  });

  it("prefers the tri-state field over the legacy boolean when both are present", () => {
    // 'off' must win over a stale legacy `dangerousEnabled: true`.
    expect(
      resolveEffectiveBypass({ dangerousMode: "off", dangerousEnabled: true }, "claude", true)
    ).toBe(false);
  });
});

describe("resolveDangerousMode (legacy back-compat)", () => {
  it("maps the legacy boolean: true → on, false/absent → inherit", () => {
    expect(resolveDangerousMode({ dangerousEnabled: true })).toBe("on");
    expect(resolveDangerousMode({ dangerousEnabled: false })).toBe("inherit");
    expect(resolveDangerousMode({})).toBe("inherit");
  });

  it("prefers the explicit tri-state field over the legacy boolean", () => {
    expect(resolveDangerousMode({ dangerousMode: "off", dangerousEnabled: true })).toBe("off");
    expect(resolveDangerousMode({ dangerousMode: "inherit", dangerousEnabled: true })).toBe(
      "inherit"
    );
    expect(resolveDangerousMode({ dangerousMode: "on" })).toBe("on");
  });
});

describe("combineDangerousModes (preset layered over agent)", () => {
  it("uses the preset mode when it is an explicit override", () => {
    expect(combineDangerousModes("on", "off")).toBe("off"); // preset veto beats agent on
    expect(combineDangerousModes("off", "on")).toBe("on"); // preset on beats agent off
  });

  it("falls back to the agent mode when the preset inherits or is absent", () => {
    expect(combineDangerousModes("off", "inherit")).toBe("off");
    expect(combineDangerousModes("on", undefined)).toBe("on");
    expect(combineDangerousModes("inherit", "inherit")).toBe("inherit");
  });

  it("end-to-end: a preset 'off' vetoes an agent 'on' and the global through resolveEffectiveBypass", () => {
    const agentMode = resolveDangerousMode({ dangerousMode: "on" });
    const presetMode = resolveDangerousMode({ dangerousMode: "off" });
    const merged = { dangerousMode: combineDangerousModes(agentMode, presetMode) };
    expect(resolveEffectiveBypass(merged, "claude", true)).toBe(false);
  });
});

describe("reconcileBypassFlags", () => {
  // Non-null: "claude" is a known key of DEFAULT_DANGEROUS_ARGS (noUncheckedIndexedAccess).
  const claudeFlag = DEFAULT_DANGEROUS_ARGS.claude as string;

  it("strips the canonical bypass flag when the effective bypass is off, preserving order of other flags", () => {
    const result = reconcileBypassFlags([claudeFlag, "--model", "opus"], "claude", false);
    expect(result).toEqual(["--model", "opus"]);
  });

  it("re-adds the canonical bypass flag when the effective bypass is on", () => {
    const result = reconcileBypassFlags(["--model", "opus"], "claude", true);
    expect(result).toContain(claudeFlag);
    expect(result.filter((f) => f === claudeFlag)).toHaveLength(1);
  });

  it("is idempotent — a flag already present is not duplicated", () => {
    const once = reconcileBypassFlags(["--model", "opus"], "claude", true);
    const twice = reconcileBypassFlags(once, "claude", true);
    expect(twice).toEqual(once);
    expect(twice.filter((f) => f === claudeFlag)).toHaveLength(1);
  });

  it("dedupes multiple stale occurrences when stripping", () => {
    const result = reconcileBypassFlags([claudeFlag, claudeFlag, "--model"], "claude", false);
    expect(result).toEqual(["--model"]);
  });

  it("leaves flags untouched for an agent with no canonical bypass flag", () => {
    const flags = ["--some-flag", "value"];
    // opencode is intentionally absent from DEFAULT_DANGEROUS_ARGS.
    expect(reconcileBypassFlags(flags, "opencode", false)).toEqual(flags);
    expect(reconcileBypassFlags(flags, "opencode", true)).toEqual(flags);
  });

  it("honours a custom bypassArgs value for strip-and-re-add", () => {
    const stripped = reconcileBypassFlags(
      ["--custom-skip", "--model"],
      "claude",
      false,
      "--custom-skip"
    );
    expect(stripped).toEqual(["--model"]);
    const readded = reconcileBypassFlags(["--model"], "claude", true, "--custom-skip");
    expect(readded).toContain("--custom-skip");
  });

  it("does not mutate the input array", () => {
    const flags = [claudeFlag, "--model"];
    reconcileBypassFlags(flags, "claude", false);
    expect(flags).toEqual([claudeFlag, "--model"]);
  });

  it("strips a stale flag for an UNSUPPORTED agent when an 'off' veto resolves bypass off (#10432 follow-up)", () => {
    // Gemini is not bypass-supported but has a canonical --yolo. A user who
    // flips it to "off" must have the stale token stripped on restart/resume,
    // not replayed verbatim. effectiveBypass=false carries the veto here.
    const geminiFlag = DEFAULT_DANGEROUS_ARGS.gemini as string;
    expect(isAgentBypassSupported("gemini")).toBe(false);
    expect(reconcileBypassFlags([geminiFlag, "--model", "x"], "gemini", false)).toEqual([
      "--model",
      "x",
    ]);
  });

  it("keeps the flag for an UNSUPPORTED agent when 'on' resolves bypass true", () => {
    const geminiFlag = DEFAULT_DANGEROUS_ARGS.gemini as string;
    const result = reconcileBypassFlags(["--model"], "gemini", true);
    expect(result).toContain(geminiFlag);
  });
});

describe("generateAgentFlags with globalSkipPermissions", () => {
  it("injects the dangerous flag for a supported agent when the global is on", () => {
    const flags = generateAgentFlags({ dangerousEnabled: false }, "claude", {
      globalSkipPermissions: true,
    });
    expect(flags).toContain(DEFAULT_DANGEROUS_ARGS.claude);
  });

  it("does not inject the dangerous flag for an unsupported agent when the global is on", () => {
    const flags = generateAgentFlags({ dangerousEnabled: false }, "gemini", {
      globalSkipPermissions: true,
    });
    expect(flags).not.toContain(DEFAULT_DANGEROUS_ARGS.gemini);
  });

  it("still honours the per-agent toggle for an unsupported agent when the global is off", () => {
    const flags = generateAgentFlags({ dangerousEnabled: true }, "gemini", {
      globalSkipPermissions: false,
    });
    expect(flags).toContain(DEFAULT_DANGEROUS_ARGS.gemini);
  });

  it("omits the dangerous flag when both the global and per-agent toggle are off", () => {
    const flags = generateAgentFlags({ dangerousEnabled: false }, "claude", {
      globalSkipPermissions: false,
    });
    expect(flags).not.toContain(DEFAULT_DANGEROUS_ARGS.claude);
  });
});

describe("buildAgentLaunchFlags with globalSkipPermissions", () => {
  it("captures the dangerous flag for a supported agent when the global is on", () => {
    const flags = buildAgentLaunchFlags({ dangerousEnabled: false }, "claude", {
      globalSkipPermissions: true,
    });
    expect(flags).toContain(DEFAULT_DANGEROUS_ARGS.claude);
  });

  it("does not capture the dangerous flag for an unsupported agent when the global is on", () => {
    const flags = buildAgentLaunchFlags({ dangerousEnabled: false }, "gemini", {
      globalSkipPermissions: true,
    });
    expect(flags).not.toContain(DEFAULT_DANGEROUS_ARGS.gemini);
  });
});
