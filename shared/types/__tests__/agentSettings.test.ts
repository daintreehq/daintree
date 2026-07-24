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
  resolveInlineMode,
  combineInlineModes,
  resolveEffectiveInlineMode,
  reconcileInlineModeFlag,
  isAgentBypassSupported,
  DEFAULT_AGENT_SETTINGS,
  DEFAULT_DANGEROUS_ARGS,
} from "../agentSettings.js";
import { setUserRegistry } from "../../config/agentRegistry.js";
import type { AgentConfig } from "../../config/agentRegistry.js";

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

  it("uses an explicitly resolved executable", () => {
    expect(buildResumeCommand("claude", "abc-123", undefined, "'C:\\fake bin\\claude.cmd'")).toBe(
      "'C:\\fake bin\\claude.cmd' --resume abc-123"
    );
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

  it("prepends launch flags before resume-latest args for opencode", () => {
    const cmd = buildResumeLatestCommand("opencode", ["--dangerously-skip-permissions"]);
    expect(cmd).toBe("opencode --dangerously-skip-permissions --continue");
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

  it("uses an explicitly resolved executable", () => {
    expect(buildResumeLatestCommand("claude", undefined, "'C:\\fake bin\\claude.cmd'")).toBe(
      "'C:\\fake bin\\claude.cmd' --continue"
    );
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

  it("defaults grok to inline like codex (no curated default → global switch, off ⇒ inline)", () => {
    // Neither grok nor codex pins a curated default now, so an unset inlineMode
    // follows the global switch (default off ⇒ inline) and both get --no-alt-screen.
    const grok = buildAgentLaunchFlags({}, "grok");
    const codex = buildAgentLaunchFlags({}, "codex");
    expect(grok).toContain("--no-alt-screen");
    expect(codex).toContain("--no-alt-screen");
  });

  it("still lets grok opt into inline mode explicitly", () => {
    const flags = buildAgentLaunchFlags({ inlineMode: true }, "grok");
    expect(flags).toContain("--no-alt-screen");
  });

  it("injects opencode's --mini on the interactive spawn and drops it when alt-screen is forced", () => {
    // buildAgentLaunchFlags is the persistent interactive-terminal spawn path,
    // so opencode's inline flag rides every spawn/restart unless the global
    // switch (or a per-agent choice) forces alt-screen.
    expect(buildAgentLaunchFlags({}, "opencode")).toContain("--mini");
    expect(buildAgentLaunchFlags({}, "opencode", { globalUseAltScreen: true })).not.toContain(
      "--mini"
    );
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

  it("grok seeds the TUI with a bare positional, headless uses -p", () => {
    const interactiveCmd = generateAgentCommand("grok", {}, "grok", {
      initialPrompt: "Fix the bug",
    });
    const oneShotCmd = generateAgentCommand("grok", {}, "grok", {
      initialPrompt: "Fix the bug",
      interactive: false,
    });
    expect(interactiveCmd).toMatch(/'Fix the bug'$/);
    expect(interactiveCmd).not.toMatch(/-p\s+'Fix the bug'/);
    expect(oneShotCmd).toMatch(/-p\s+'Fix the bug'/);
  });

  it("grok's and codex's first-spawn commands default to inline (--no-alt-screen)", () => {
    // Covers the generateAgentCommand inline-flag path (separate from
    // buildAgentLaunchFlags): an unset inlineMode follows the global switch
    // (default off ⇒ inline), so both agents get --no-alt-screen.
    const grok = generateAgentCommand("grok", {}, "grok");
    const codex = generateAgentCommand("codex", {}, "codex");
    expect(grok).toContain("--no-alt-screen");
    expect(codex).toContain("--no-alt-screen");
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

  it("opencode injects --mini for the interactive TUI but never the headless run", () => {
    // `--mini` is opencode's inline (scrollback-native) flag on the default
    // command. Its `run` subcommand rejects it ("--mini must be used without the
    // run subcommand"), so the inline flag is interactive-only.
    const interactiveCmd = generateAgentCommand("opencode", {}, "opencode", {
      initialPrompt: "Fix the bug",
    });
    const headlessCmd = generateAgentCommand("opencode", {}, "opencode", {
      initialPrompt: "Fix the bug",
      interactive: false,
    });
    expect(interactiveCmd).toContain("--mini");
    expect(headlessCmd).not.toContain("--mini");
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

describe("resolveInlineMode (tri-state, #10876)", () => {
  it("maps a genuinely-absent value to inherit", () => {
    expect(resolveInlineMode({})).toBe("inherit");
    expect(resolveInlineMode({ inlineMode: undefined })).toBe("inherit");
  });

  it("maps a legacy boolean literally, NOT like resolveDangerousMode", () => {
    // The literal mapping (false → "off") is the deliberate difference from
    // resolveDangerousMode (false → "inherit"): inlineMode was seeded with a
    // concrete per-agent boolean, so false must stay an explicit alt-screen veto.
    expect(resolveInlineMode({ inlineMode: true })).toBe("on");
    expect(resolveInlineMode({ inlineMode: false })).toBe("off");
    // Contrast: the bypass resolver collapses false to inherit.
    expect(resolveDangerousMode({ dangerousEnabled: false })).toBe("inherit");
  });

  it("passes an explicit tri-state string through unchanged", () => {
    expect(resolveInlineMode({ inlineMode: "inherit" })).toBe("inherit");
    expect(resolveInlineMode({ inlineMode: "on" })).toBe("on");
    expect(resolveInlineMode({ inlineMode: "off" })).toBe("off");
  });
});

describe("combineInlineModes (#10876)", () => {
  it("lets an explicit preset mode win over the agent mode", () => {
    expect(combineInlineModes("on", "off")).toBe("off");
    expect(combineInlineModes("off", "on")).toBe("on");
  });

  it("defers to the agent mode when the preset inherits", () => {
    expect(combineInlineModes("on", "inherit")).toBe("on");
    expect(combineInlineModes("off", undefined)).toBe("off");
  });
});

describe("resolveEffectiveInlineMode (#10876)", () => {
  // Synthetic agent exercising the curated registry-default tier. No shipped
  // agent sets `defaultInlineMode` anymore — they all default inline via the
  // global switch so it stays user-overridable — so the tier is covered here
  // with a registered test agent instead of coupling to a real one.
  const ALT_DEFAULT_AGENT: AgentConfig = {
    id: "alt-default-agent",
    name: "Alt Default Agent",
    command: "alt-default-agent",
    color: "#ffffff",
    iconId: "custom",
    supportsContextInjection: false,
    capabilities: {
      scrollback: 1000,
      inlineModeFlag: "--no-alt-screen",
      defaultInlineMode: false,
    },
  };
  beforeEach(() => setUserRegistry({ "alt-default-agent": ALT_DEFAULT_AGENT }));
  afterEach(() => setUserRegistry({}));

  it("honours an explicit on/off regardless of the global switch", () => {
    expect(resolveEffectiveInlineMode({ inlineMode: "on" }, "codex", true)).toBe(true);
    expect(resolveEffectiveInlineMode({ inlineMode: "off" }, "codex", false)).toBe(false);
    // Explicit off is a veto that beats a global "use alt-screen" of false too.
    expect(resolveEffectiveInlineMode({ inlineMode: "off" }, "codex", true)).toBe(false);
  });

  it("keeps a curated registry default winning over the global switch on inherit", () => {
    // The agent declares defaultInlineMode: false (alt-screen) — it must stay
    // alt-screen even when the global "use alt-screen by default" is OFF.
    expect(resolveEffectiveInlineMode({}, "alt-default-agent", false)).toBe(false);
    expect(resolveEffectiveInlineMode({}, "alt-default-agent", true)).toBe(false);
    expect(resolveEffectiveInlineMode({ inlineMode: "inherit" }, "alt-default-agent", false)).toBe(
      false
    );
  });

  it("falls back to the global switch on inherit when no registry default is declared", () => {
    // Codex and Grok declare no defaultInlineMode → the global switch decides,
    // so both now default inline (global off ⇒ inline).
    expect(resolveEffectiveInlineMode({}, "codex", false)).toBe(true); // global off → inline
    expect(resolveEffectiveInlineMode({}, "codex", true)).toBe(false); // global on → alt-screen
    expect(resolveEffectiveInlineMode({}, "grok", false)).toBe(true); // grok follows global now
    expect(resolveEffectiveInlineMode({}, "grok", true)).toBe(false);
  });

  it("still lets an agent override its curated registry default explicitly", () => {
    expect(resolveEffectiveInlineMode({ inlineMode: "on" }, "alt-default-agent", false)).toBe(true);
  });
});

describe("reconcileInlineModeFlag (resume trap, #10876)", () => {
  it("strips a stale --no-alt-screen when the resolved decision is alt-screen", () => {
    const flags = ["--model", "gpt", "--no-alt-screen"];
    expect(reconcileInlineModeFlag(flags, "codex", false)).toEqual(["--model", "gpt"]);
  });

  it("re-appends the flag when inline is wanted but the snapshot lacks it", () => {
    expect(reconcileInlineModeFlag(["--model", "gpt"], "codex", true)).toEqual([
      "--model",
      "gpt",
      "--no-alt-screen",
    ]);
  });

  it("is idempotent when the snapshot already matches the decision", () => {
    const inline = ["--no-alt-screen", "--model", "gpt"];
    expect(reconcileInlineModeFlag(inline, "codex", true)).toEqual(inline);
    const alt = ["--model", "gpt"];
    expect(reconcileInlineModeFlag(alt, "codex", false)).toEqual(alt);
  });

  it("dedupes duplicate flags, keeping the first in place, when inline is wanted", () => {
    const flags = ["--no-alt-screen", "--model", "gpt", "--no-alt-screen"];
    expect(reconcileInlineModeFlag(flags, "codex", true)).toEqual([
      "--no-alt-screen",
      "--model",
      "gpt",
    ]);
  });

  it("leaves flags untouched for an agent with no inlineModeFlag", () => {
    const flags = ["--foo", "--no-alt-screen"];
    expect(reconcileInlineModeFlag(flags, "claude", false)).toEqual(flags);
    expect(reconcileInlineModeFlag(flags, "claude", true)).toEqual(flags);
  });
});

describe("paired screen-mode polarities (#11423)", () => {
  // Sentinel tokens, not the real `--no-alt-screen`/`--fullscreen`: these cases
  // pin the selection *mechanism* across the capability matrix, so they stay
  // green if a shipped agent's flag spelling ever changes.
  const INLINE = "--sentinel-inline";
  const ALT = "--sentinel-alt";

  const agent = (id: string, capabilities: AgentConfig["capabilities"]): AgentConfig => ({
    id,
    name: id,
    command: id,
    color: "#ffffff",
    iconId: "custom",
    supportsContextInjection: false,
    capabilities,
  });

  beforeEach(() =>
    setUserRegistry({
      "inline-only": agent("inline-only", { inlineModeFlag: INLINE }),
      "alt-only": agent("alt-only", { altScreenFlag: ALT }),
      "both-modes": agent("both-modes", { inlineModeFlag: INLINE, altScreenFlag: ALT }),
      "neither-mode": agent("neither-mode", { scrollback: 1000 }),
    })
  );
  afterEach(() => setUserRegistry({}));

  it("selects at most one token per direction across the capability matrix", () => {
    // The gap #11423 closes: an agent declaring only `inlineModeFlag` still has
    // NO way to force alt-screen (undefined row), which is why grok needed the
    // opposite polarity added rather than a change to the resolver.
    const cases: Array<[string, boolean, string | undefined]> = [
      ["inline-only", true, INLINE],
      ["inline-only", false, undefined],
      ["alt-only", true, undefined],
      ["alt-only", false, ALT],
      ["both-modes", true, INLINE],
      ["both-modes", false, ALT],
      ["neither-mode", true, undefined],
      ["neither-mode", false, undefined],
    ];
    for (const [agentId, effectiveInline, expected] of cases) {
      const flags = buildAgentLaunchFlags({ inlineMode: effectiveInline ? "on" : "off" }, agentId);
      const screenTokens = flags.filter((f) => f === INLINE || f === ALT);
      expect(screenTokens).toEqual(expected ? [expected] : []);
    }
  });

  it("never lets both polarities coexist after reconciliation", () => {
    for (const effectiveInline of [true, false]) {
      const reconciled = reconcileInlineModeFlag([INLINE, "--model", ALT], "both-modes", effectiveInline);
      expect(reconciled).toEqual([effectiveInline ? INLINE : ALT, "--model"]);
    }
  });

  it("flips a stale token in place rather than relocating it", () => {
    // Position stability keeps an already-persisted snapshot's ordering intact
    // so a flip rewrites one slot instead of churning the whole array.
    expect(reconcileInlineModeFlag(["--a", INLINE, "--b"], "both-modes", false)).toEqual([
      "--a",
      ALT,
      "--b",
    ]);
    expect(reconcileInlineModeFlag(["--a", ALT, "--b"], "both-modes", true)).toEqual([
      "--a",
      INLINE,
      "--b",
    ]);
  });

  it("upgrades a pre-#11423 snapshot that carried no screen-mode token", () => {
    // The migration path: snapshots captured before `altScreenFlag` existed hold
    // only the absence of the inline flag, which used to mean "alt screen" but
    // actually left the CLI on its own default.
    const legacy = ["--model", "grok-build"];
    const upgraded = reconcileInlineModeFlag(legacy, "both-modes", false);
    expect(upgraded).toEqual(["--model", "grok-build", ALT]);
    // Reconciling the upgraded snapshot again must be a no-op.
    expect(reconcileInlineModeFlag(upgraded, "both-modes", false)).toEqual(upgraded);
  });

  it("dedupes repeated managed tokens down to the wanted one", () => {
    expect(
      reconcileInlineModeFlag([INLINE, "--keep", INLINE, ALT], "both-modes", true)
    ).toEqual([INLINE, "--keep"]);
  });

  it("strips the only declared token when the other direction has none", () => {
    // An inline-only agent asked for alt-screen loses its inline flag and gains
    // nothing — it falls back to the CLI's own default, unchanged from #10876.
    expect(reconcileInlineModeFlag(["--a", INLINE], "inline-only", false)).toEqual(["--a"]);
    expect(reconcileInlineModeFlag(["--a", ALT], "alt-only", true)).toEqual(["--a"]);
  });

  it("leaves an agent declaring neither polarity untouched", () => {
    const flags = ["--a", INLINE, ALT];
    expect(reconcileInlineModeFlag(flags, "neither-mode", true)).toEqual(flags);
    expect(reconcileInlineModeFlag(flags, "neither-mode", false)).toEqual(flags);
  });
});

describe("screen-mode reconciliation composed with bypass reconciliation (#11423)", () => {
  // All three relaunch chokepoints (agentResume, panelRegistry/restart,
  // stateHydration/statePatcher) compose the two reconcilers in this exact
  // order. They own disjoint tokens, so neither may disturb the other's — this
  // is the interaction the composition would hide if it regressed.
  const reconcileBoth = (
    flags: readonly string[],
    agentId: string,
    effectiveBypass: boolean,
    effectiveInline: boolean
  ) => reconcileInlineModeFlag(reconcileBypassFlags(flags, agentId, effectiveBypass), agentId, effectiveInline);

  it("flips the screen-mode token while the bypass reconciler flips its own", () => {
    // Grok carries both polarities; codex's bypass token is independent.
    const withInline = reconcileBoth(["--no-alt-screen"], "grok", true, false);
    expect(withInline).toContain("--fullscreen");
    expect(withInline).not.toContain("--no-alt-screen");

    // Flipping back leaves exactly one screen token and preserves the bypass
    // decision the first reconciler made.
    const backToInline = reconcileBoth(withInline, "grok", true, true);
    expect(backToInline.filter((f) => f === "--no-alt-screen" || f === "--fullscreen")).toEqual([
      "--no-alt-screen",
    ]);
    expect(backToInline.filter((f) => f.startsWith("--dangerously"))).toEqual(
      withInline.filter((f) => f.startsWith("--dangerously"))
    );
  });

  it("is idempotent under repeated composed reconciliation", () => {
    const once = reconcileBoth(["--model", "grok-build"], "grok", false, false);
    expect(once).toEqual(reconcileBoth(once, "grok", false, false));
    expect(once).toContain("--fullscreen");
  });
});

describe("global alt-screen threading through command generation (#10876)", () => {
  it("drops --no-alt-screen for an inherit agent when globalUseAltScreen is on", () => {
    // Codex inherits (no explicit choice, no registry default) → follows global.
    expect(buildAgentLaunchFlags({}, "codex", { globalUseAltScreen: true })).not.toContain(
      "--no-alt-screen"
    );
    expect(generateAgentCommand("codex", {}, "codex", { globalUseAltScreen: true })).not.toContain(
      "--no-alt-screen"
    );
  });

  it("keeps --no-alt-screen for an inherit agent when globalUseAltScreen is off", () => {
    expect(buildAgentLaunchFlags({}, "codex", { globalUseAltScreen: false })).toContain(
      "--no-alt-screen"
    );
  });

  it("makes grok follow the global switch now that it has no curated default", () => {
    // Grok no longer pins a curated default, so it threads the global switch
    // like any other inherit agent: inline when off, alt-screen when on. Grok
    // declares BOTH polarities (#11423), so each direction is asserted
    // positively — "alt screen" must inject the force-fullscreen token, not
    // merely omit the inline one, or the setting is a no-op against grok's own
    // config/auto-detected default.
    const inline = buildAgentLaunchFlags({}, "grok", { globalUseAltScreen: false });
    expect(inline).toContain("--no-alt-screen");
    expect(inline).not.toContain("--fullscreen");

    const altScreen = buildAgentLaunchFlags({}, "grok", { globalUseAltScreen: true });
    expect(altScreen).toContain("--fullscreen");
    expect(altScreen).not.toContain("--no-alt-screen");
  });

  it("threads both grok polarities through the generated command too", () => {
    // generateAgentCommand and buildAgentLaunchFlags are dual representations
    // (#9654) — a fix applied to only one silently drops the flag on restart.
    const inline = generateAgentCommand("grok", {}, "grok", { globalUseAltScreen: false });
    expect(inline).toContain("--no-alt-screen");
    expect(inline).not.toContain("--fullscreen");

    const altScreen = generateAgentCommand("grok", {}, "grok", { globalUseAltScreen: true });
    expect(altScreen).toContain("--fullscreen");
    expect(altScreen).not.toContain("--no-alt-screen");
  });

  it("omits both screen-mode polarities for a headless one-shot", () => {
    // Screen mode configures the interactive TUI only, so neither token may
    // reach a non-interactive invocation in either direction.
    for (const globalUseAltScreen of [true, false]) {
      const command = generateAgentCommand("grok", {}, "grok", {
        globalUseAltScreen,
        interactive: false,
      });
      expect(command).not.toContain("--fullscreen");
      expect(command).not.toContain("--no-alt-screen");
    }
  });

  it("lets an explicit per-agent choice veto the global switch", () => {
    expect(
      buildAgentLaunchFlags({ inlineMode: "on" }, "codex", { globalUseAltScreen: true })
    ).toContain("--no-alt-screen");
    expect(
      buildAgentLaunchFlags({ inlineMode: "off" }, "codex", { globalUseAltScreen: false })
    ).not.toContain("--no-alt-screen");
  });
});

describe("DEFAULT_AGENT_SETTINGS inline seeding (#10876)", () => {
  it("no longer seeds a concrete per-agent inlineMode so untouched agents inherit", () => {
    for (const entry of Object.values(DEFAULT_AGENT_SETTINGS.agents)) {
      expect(entry.inlineMode).toBeUndefined();
    }
  });

  it("defaults globalUseAltScreen off", () => {
    expect(DEFAULT_AGENT_SETTINGS.globalUseAltScreen).toBe(false);
  });
});
