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
  reconcileInlineModeFlag,
  reconcileDecorationFlags,
  isAgentBypassSupported,
  isAgentTerminalBypassSupported,
  buildAssignedSessionIdArgs,
  supportsSessionIdAssignment,
  mintAssignedSessionId,
  assignmentReopensSession,
  commandNamesSession,
  stripAssignedSessionIdArgs,
  stripConversationSelectorArgs,
  stripConversationSelectorFlags,
  relaunchResumeAsAssignedSession,
  supportsExactSessionCapture,
  DEFAULT_AGENT_SETTINGS,
  DEFAULT_DANGEROUS_ARGS,
  getDefaultDangerousArgs,
  getPluginBypassArgHistory,
  agentClipboardDirectory,
} from "../agentSettings.js";
import { getEffectiveAgentConfig, setUserRegistry } from "../../config/agentRegistry.js";
import { BUILT_IN_AGENT_IDS } from "../../config/agentIds.js";
import { quoteLaunchPrompt } from "../../utils/launchPromptArg.js";
import {
  registerPluginAgents,
  clearPluginAgentRegistryForTests,
} from "../../config/pluginAgentRegistry.js";
import { setAgentCommandDialectResolver } from "../../utils/shellEscape.js";
import type { AgentConfig } from "../../config/agentRegistry.js";
import type { AgentSettingsEntry } from "../agentSettings.js";

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
    // Pinned to the launch directory (#12434), and still readable by the
    // `codex resume <id>` scrape when the shell echoes it.
    expect(cmd).toBe(`codex resume abc-123 -C '.'`);
    expect(cmd).toContain("codex resume abc-123");
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
      `codex --no-alt-screen --dangerously-bypass-approvals-and-sandbox resume sess-456 -C '.'`
    );
  });

  it("handles empty launch flags array like no flags", () => {
    expect(buildResumeCommand("claude", "abc-123", [])).toBe("claude --resume abc-123");
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

  it("uses a rolling-history agent's own args as its resume-latest form (#13847)", () => {
    // Nothing is captured for these, so their args are the only way back to the
    // conversation after a restore.
    expect(buildResumeLatestCommand("kimi")).toBe("kimi --continue");
    expect(buildResumeLatestCommand("aider", ["--no-auto-commits"])).toBe(
      "aider --no-auto-commits --restore-chat-history"
    );
  });

  it("keeps the registry's default args when the pane hands over no captured flags", () => {
    // A deleted preset voids the captured flags. Aider must still resume with
    // auto-commits off, as the fresh launch this replaced always did.
    expect(buildResumeLatestCommand("aider")).toBe(
      "aider --no-auto-commits --restore-chat-history"
    );
    expect(buildResumeLatestCommand("aider", ["--model", "sonnet"])).toBe(
      "aider --no-auto-commits --model 'sonnet' --restore-chat-history"
    );
  });

  it("returns undefined for a rolling-history agent whose only way back is a picker", () => {
    // Empty args stand in for a picker that would sit on the restored PTY.
    setUserRegistry({
      "picker-only": {
        id: "picker-only",
        name: "Picker Only",
        command: "picker-only",
        color: "#ffffff",
        iconId: "custom",
        supportsContextInjection: false,
        resume: { kind: "rolling-history", args: () => [] },
      },
    });
    try {
      expect(buildResumeLatestCommand("picker-only")).toBeUndefined();
      // Control: the same agent with resume flags does get a command.
      setUserRegistry({
        "picker-only": {
          id: "picker-only",
          name: "Picker Only",
          command: "picker-only",
          color: "#ffffff",
          iconId: "custom",
          supportsContextInjection: false,
          resume: { kind: "rolling-history", args: () => ["--continue"] },
        },
      });
      expect(buildResumeLatestCommand("picker-only")).toBe("picker-only --continue");
    } finally {
      setUserRegistry({});
    }
  });

  it("resumes Open Interpreter's latest session in the folder with resume --last", () => {
    // The Rust product, not the Python CLI whose only way back was a picker (#15567).
    expect(buildResumeLatestCommand("interpreter")).toBe("interpreter resume --last");
    expect(buildResumeLatestCommand("interpreter", ["-m", "o4"])).toBe(
      "interpreter -m 'o4' resume --last"
    );
  });

  it("returns undefined for a named-target agent, whose args need the target", () => {
    expect(buildResumeLatestCommand("amp")).toBeUndefined();
  });

  it("resumes Cursor's latest chat with --continue but never claims a capturable id", () => {
    expect(buildResumeLatestCommand("cursor")).toBe("cursor-agent --continue");
    expect(buildResumeCommand("cursor", "chat-1")).toBe("cursor-agent --resume chat-1");
    // Cursor prints no id, so bookmarking (a kill-then-capture) must refuse it.
    expect(supportsExactSessionCapture("cursor")).toBe(false);
  });

  it("uses a project-scoped agent's own args as its resume-latest form (#13687)", () => {
    // Kiro captures no id, so without this a restore had nothing to rebuild.
    expect(buildResumeLatestCommand("kiro")).toBe("kiro-cli chat --resume");
    expect(buildResumeLatestCommand("kiro", ["--trust-all-tools"], "/opt/kiro")).toBe(
      "/opt/kiro --trust-all-tools chat --resume"
    );
  });

  it("returns undefined for session-id agents that don't declare resumeLatestArgs", () => {
    // Copilot's and Goose's "latest" isn't confined to the launch directory, so
    // they deliberately ship no fallback.
    expect(buildResumeLatestCommand("copilot")).toBeUndefined();
    expect(buildResumeLatestCommand("goose")).toBeUndefined();
  });

  it("falls back to --continue for Qwen and Mistral when the id capture missed (#13847)", () => {
    expect(buildResumeLatestCommand("qwen")).toBe("qwen --continue");
    expect(buildResumeLatestCommand("mistral", ["--trust"])).toBe("vibe --trust --continue");
    expect(buildResumeLatestCommand("mistral")).toBe("vibe --trust --continue");
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

  it("prepends launch flags before resume-latest args for codex", () => {
    const cmd = buildResumeLatestCommand("codex", [
      "--no-alt-screen",
      "--dangerously-bypass-approvals-and-sandbox",
    ]);
    expect(cmd).toBe(
      "codex --no-alt-screen --dangerously-bypass-approvals-and-sandbox resume --last"
    );
  });

  it("handles empty launch flags array like no flags", () => {
    expect(buildResumeLatestCommand("claude", [])).toBe("claude --continue");
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

  it("includes the inline flag for codex and grok", () => {
    expect(buildAgentLaunchFlags({}, "codex")).toContain("--no-alt-screen");
    expect(buildAgentLaunchFlags({}, "grok")).toContain("--no-alt-screen");
  });

  it("keeps the inline flag when an older build stored an alt-screen choice (#16356)", () => {
    for (const inlineMode of [false, "off"]) {
      expect(buildAgentLaunchFlags({ inlineMode }, "codex")).toContain("--no-alt-screen");
      const grok = buildAgentLaunchFlags({ inlineMode }, "grok");
      expect(grok).toContain("--no-alt-screen");
      expect(grok).not.toContain("--fullscreen");
    }
  });

  it("injects opencode's --mini on the interactive spawn", () => {
    // buildAgentLaunchFlags is the persistent interactive-terminal spawn path,
    // so opencode's inline flag rides every spawn/restart.
    expect(buildAgentLaunchFlags({}, "opencode")).toContain("--mini");
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

  it("never persists --model for Mistral Vibe, whose restart and resume reject or ignore it (#15569)", () => {
    const flags = buildAgentLaunchFlags({}, "mistral", { modelId: "devstral-small" });
    expect(flags).toEqual(["--trust"]);
  });

  it("never persists a Vibe --model a preset or recipe adds either (#15569)", () => {
    const flags = buildAgentLaunchFlags({}, "mistral", {
      presetArgs: ["--model", "devstral-2", "--agent", "accept-edits"],
      recipeArgs: "--model=local",
    });
    expect(flags).toEqual(["--trust", "--agent", "accept-edits"]);
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

describe("generateAgentCommand with a multi-line prompt (#16378)", () => {
  forcePosixPlatform();
  afterEach(() => setAgentCommandDialectResolver(null));

  const prompt = '# Plan\n\n- it\'s one\n\t- "two"';
  const shapes = BUILT_IN_AGENT_IDS.flatMap((id) => [
    [id, true],
    [id, false],
  ]) as ReadonlyArray<readonly [string, boolean]>;
  const command = (id: string, interactive: boolean, initialPrompt: string) =>
    generateAgentCommand(id, {}, id, { initialPrompt, interactive });

  // Everything but the prompt's own word stays as a single-line launch has it.
  it.each(shapes)("%s (interactive %s) carries it as one built word", (id, interactive) => {
    const word = `"$(printf '%b' '# Plan\\n\\n- it\\0047s one\\n\\t- \\0042two\\0042')"`;
    const built = command(id, interactive, prompt);

    const baseline = command(id, interactive, "PLACEHOLDER");
    expect(baseline).toContain("'PLACEHOLDER'");
    expect(built).toContain(word);
    expect(built).toBe(baseline.replace("'PLACEHOLDER'", word));
    // eslint-disable-next-line no-control-regex
    expect(built).not.toMatch(/[\x00-\x1F\x7F]/);
  });

  it.each(shapes)("%s (interactive %s) carries it under PowerShell too", (id, interactive) => {
    setAgentCommandDialectResolver(() => "windows");
    const word = `"# Plan\`n\`n- it's one\`n\`t- ""two"""`;
    const built = command(id, interactive, prompt);

    const baseline = command(id, interactive, "PLACEHOLDER");
    expect(baseline).toContain("'PLACEHOLDER'");
    expect(built).toContain(word);
    expect(built).toBe(baseline.replace("'PLACEHOLDER'", word));
    // eslint-disable-next-line no-control-regex
    expect(built).not.toMatch(/[\x00-\x1F\x7F]/);
  });

  it("stays one word for a command rewrite, whatever the prompt holds", () => {
    const relaunch = relaunchResumeAsAssignedSession(
      `claude --resume 11111111-1111-4111-8111-111111111111 ${quoteLaunchPrompt(
        `say "x --resume 22222222-2222-4222-8222-222222222222  y"\nnext`
      )}`,
      "claude"
    );

    expect(relaunch?.sessionId).toBe("11111111-1111-4111-8111-111111111111");
    expect(relaunch?.command).toContain(
      `"$(printf '%b' 'say \\0042x --resume 22222222-2222-4222-8222-222222222222  y\\0042\\nnext')"`
    );
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

  it("grok's and codex's first-spawn commands launch inline (--no-alt-screen)", () => {
    // Covers the generateAgentCommand inline-flag path (separate from
    // buildAgentLaunchFlags).
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

  describe("Mistral Vibe (#15569)", () => {
    forcePosixPlatform();

    it("leaves --model off an interactive launch, which Vibe ignores or rejects", () => {
      const bare = generateAgentCommand("vibe", {}, "mistral", { modelId: "devstral-small" });
      const seeded = generateAgentCommand("vibe", {}, "mistral", {
        modelId: "devstral-small",
        initialPrompt: "Fix the bug",
      });
      expect(bare).toBe("vibe --trust");
      expect(seeded).toBe("vibe --trust 'Fix the bug'");
    });

    it("drops a --model a preset, recipe or settings flag adds to an interactive launch", () => {
      const cmd = generateAgentCommand("vibe", { customFlags: "--model=local" }, "mistral", {
        presetArgs: ["--model", "devstral-2", "--agent", "accept-edits"],
        recipeArgs: "--model devstral-small",
      });
      expect(cmd).toBe("vibe --trust --agent 'accept-edits'");
    });

    it("keeps a preset's --model on a headless launch, where Vibe takes it", () => {
      const cmd = generateAgentCommand("vibe", {}, "mistral", {
        presetArgs: ["--model", "devstral-2"],
        initialPrompt: "Fix the bug",
        interactive: false,
      });
      expect(cmd).toBe("vibe --trust --model 'devstral-2' --prompt 'Fix the bug'");
    });

    it("passes --model to a headless launch, ahead of --prompt", () => {
      const cmd = generateAgentCommand("vibe", {}, "mistral", {
        modelId: "devstral-small",
        initialPrompt: "Fix the bug",
        interactive: false,
      });
      expect(cmd).toBe("vibe --trust --model devstral-small --prompt 'Fix the bug'");
    });
  });
});

describe("generateAgentCommand with recipeArgs", () => {
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

describe("quoted launch arguments (#15637)", () => {
  forcePosixPlatform();

  const spacedPath = "/tmp/project with spaces/config.json";

  it("keeps a quoted spaced value in recipe args as one argument", () => {
    const cmd = generateAgentCommand("claude", {}, "claude", {
      recipeArgs: `--config "${spacedPath}"`,
    });
    expect(cmd).toBe(`claude --config '${spacedPath}'`);
  });

  it("keeps a quoted spaced value in custom flags as one argument", () => {
    const cmd = generateAgentCommand(
      "claude",
      { customFlags: `--add-dir "/Users/me/My Project" --append-system-prompt 'be terse'` },
      "claude"
    );
    expect(cmd).toBe("claude --add-dir '/Users/me/My Project' --append-system-prompt 'be terse'");
  });

  it("persists quoted custom flags as the argv the launch command used", () => {
    const entry = { customFlags: `--config "${spacedPath}" --verbose` };
    expect(generateAgentFlags(entry, "claude")).toEqual(["--config", spacedPath, "--verbose"]);
    const flags = buildAgentLaunchFlags(entry, "claude");
    expect(flags).toEqual(["--config", spacedPath, "--verbose"]);
    expect(generateAgentCommand("claude", entry, "claude")).toBe(
      buildLaunchCommandFromFlags("claude", "claude", flags)
    );
  });

  it("persists recipe args where the launch command puts them", () => {
    const entry = { customFlags: "--custom-flag", dangerousEnabled: true };
    const options = {
      presetArgs: ["--preset-flag"],
      recipeArgs: `--config "${spacedPath}"`,
    };
    const flags = buildAgentLaunchFlags(entry, "claude", options);
    expect(flags).toEqual([
      "--preset-flag",
      "--config",
      spacedPath,
      "--dangerously-skip-permissions",
      "--custom-flag",
    ]);
    expect(generateAgentCommand("claude", entry, "claude", options)).toBe(
      buildLaunchCommandFromFlags("claude", "claude", flags)
    );
  });

  it("keeps an empty quoted argument and an apostrophe inside double quotes", () => {
    const cmd = generateAgentCommand("claude", {}, "claude", {
      recipeArgs: `--prefix "" --name "O'Brien"`,
    });
    expect(cmd).toBe("claude --prefix '' --name 'O'\\''Brien'");
  });

  it("keeps a quoted Windows path whole with its backslashes for PowerShell", () => {
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    const cmd = generateAgentCommand(
      "claude",
      { customFlags: `--add-dir "C:\\Users\\O'Brien\\My Project"` },
      "claude",
      { recipeArgs: `--config 'C:\\Program Files\\cfg.json'` }
    );
    expect(cmd).toBe(
      "claude --config 'C:\\Program Files\\cfg.json' --add-dir 'C:\\Users\\O''Brien\\My Project'"
    );
  });

  it("recognises a quoted clipboard directory in custom flags as already shared", () => {
    const dir = "/tmp/my clipboard";
    const customFlags = `--include-directories "${dir}"`;
    const flags = generateAgentFlags({ customFlags }, "gemini", { clipboardDirectory: dir });
    expect(flags.filter((flag) => flag === "--include-directories")).toHaveLength(1);
    expect(flags).toContain(dir);
    expect(
      generateAgentFlags({ customFlags, shareClipboardDirectory: false }, "gemini", {
        clipboardDirectory: dir,
      })
    ).toEqual(["--include-directories", dir]);
  });

  it("keeps the whitespace split for text with an unclosed quote", () => {
    const entry = { customFlags: "--name O'Brien --verbose" };
    expect(generateAgentFlags(entry, "claude")).toEqual(["--name", "O'Brien", "--verbose"]);
    expect(
      generateAgentCommand("claude", {}, "claude", { recipeArgs: `--title "draft --yolo` })
    ).toBe(`claude --title '"draft' --yolo`);
  });

  it("cleans control characters on the unclosed-quote path too", () => {
    const recipeArgs = "--name O'Brien --label a\u001bb\u007f";
    expect(generateAgentFlags({ customFlags: recipeArgs }, "claude")).toEqual([
      "--name",
      "O'Brien",
      "--label",
      "a b ",
    ]);
    expect(buildAgentLaunchFlags({}, "claude", { recipeArgs })).toEqual([
      "--name",
      "O'Brien",
      "--label",
      "a b ",
    ]);
    expect(generateAgentCommand("claude", {}, "claude", { recipeArgs })).not.toMatch(
      // eslint-disable-next-line no-control-regex
      /[\x00-\x1F\x7F]/
    );
  });

  it("turns a control character inside a quoted value into a space", () => {
    const entry = { customFlags: '--append-system-prompt "first\nsecond\tthird"' };
    expect(generateAgentFlags(entry, "claude")).toEqual([
      "--append-system-prompt",
      "first second third",
    ]);
    expect(generateAgentCommand("claude", {}, "claude", { recipeArgs: '--label "a\r\nb"' })).toBe(
      "claude --label 'a b'"
    );
  });

  it("leaves an explicit recipe decoration override in the persisted flags", () => {
    const entry = { decorativeEffects: true };
    const options = { recipeArgs: "-c tui.whimsy=false" };
    const flags = buildAgentLaunchFlags(entry, "codex", options);
    expect(flags).toEqual(expect.arrayContaining(["-c", "tui.whimsy=false"]));
    expect(generateAgentCommand("codex", entry, "codex", options)).toBe(
      buildLaunchCommandFromFlags("codex", "codex", flags)
    );
  });

  it("leaves unquoted arguments exactly as the whitespace split did", () => {
    expect(
      generateAgentCommand("claude", { customFlags: "  --verbose   --debug " }, "claude", {
        recipeArgs: " --model   opus --yolo ",
      })
    ).toBe("claude --model 'opus' --yolo --verbose --debug");
  });
});

describe("generateAgentCommand with presetArgs (#15638)", () => {
  forcePosixPlatform();

  it("keeps a multi-word preset element as one quoted argument", () => {
    const cmd = generateAgentCommand("claude", {}, "claude", {
      presetArgs: ["--system-prompt", "two words"],
    });
    expect(cmd).toBe("claude --system-prompt 'two words'");
  });

  it("quotes non-flag preset elements and leaves safe options bare", () => {
    const cmd = generateAgentCommand("claude", {}, "claude", {
      presetArgs: ["--provider", "blue", "--verbose"],
    });
    expect(cmd).toBe("claude --provider 'blue' --verbose");
  });

  it("produces the same argv as the persisted launch flags replayed on resume", () => {
    const presetArgs = ["--system-prompt", "be concise and direct", "--verbose"];
    const launch = generateAgentCommand("claude", {}, "claude", { presetArgs });
    const flags = buildAgentLaunchFlags({}, "claude", { presetArgs });
    expect(launch).toBe(buildLaunchCommandFromFlags("claude", "claude", flags));
  });

  it("places preset args after --model and before recipe args", () => {
    const cmd = generateAgentCommand("claude", {}, "claude", {
      modelId: "claude-opus-4-6",
      presetArgs: ["--append-system-prompt", "stay terse"],
      recipeArgs: "--recipe-flag",
    });
    expect(cmd).toBe(
      "claude --model claude-opus-4-6 --append-system-prompt 'stay terse' --recipe-flag"
    );
  });

  it("produces no change for an empty preset args array", () => {
    const base = generateAgentCommand("claude", {}, "claude");
    expect(generateAgentCommand("claude", {}, "claude", { presetArgs: [] })).toBe(base);
  });

  it("keeps fused, padded, whitespace-only and apostrophe elements exactly as given", () => {
    const presetArgs = ["--label=two words", "  padded  ", " ", "it's fine"];
    const cmd = generateAgentCommand("claude", {}, "claude", { presetArgs });
    expect(cmd).toBe("claude '--label=two words' '  padded  ' ' ' 'it'\\''s fine'");
    const flags = buildAgentLaunchFlags({}, "claude", { presetArgs });
    expect(flags).toEqual(presetArgs);
    expect(cmd).toBe(buildLaunchCommandFromFlags("claude", "claude", flags));
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
// supports.permissionBypass === true for the assistant; gemini declares false
// there but still has a terminal bypass flag (--yolo) in DEFAULT_DANGEROUS_ARGS,
// which is what the global switch follows (#16414).
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

  it("does not force bypass for an agent with no terminal bypass flag when the global is on", () => {
    expect(resolveEffectiveBypass({ dangerousEnabled: false }, "opencode", true)).toBe(false);
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

  it("'inherit' defers to the global override, gated by a terminal bypass flag", () => {
    expect(resolveEffectiveBypass({ dangerousMode: "inherit" }, "claude", true)).toBe(true);
    expect(resolveEffectiveBypass({ dangerousMode: "inherit" }, "claude", false)).toBe(false);
    // An agent with no bypass flag never inherits the global switch.
    expect(resolveEffectiveBypass({ dangerousMode: "inherit" }, "opencode", true)).toBe(false);
  });

  it("prefers the tri-state field over the legacy boolean when both are present", () => {
    // 'off' must win over a stale legacy `dangerousEnabled: true`.
    expect(
      resolveEffectiveBypass({ dangerousMode: "off", dangerousEnabled: true }, "claude", true)
    ).toBe(false);
  });
});

// #16414 — the global switch reaches every agent with a terminal bypass flag,
// not just the ones whose Daintree Assistant wiring declares bypass support.
describe("global skip-permissions reaches every agent with a terminal bypass flag", () => {
  afterEach(() => {
    setUserRegistry({});
  });

  it("injects the registry bypass flag for an agent with no assistant wiring", () => {
    expect(isAgentBypassSupported("antigravity")).toBe(false);
    expect(resolveEffectiveBypass({}, "antigravity", true)).toBe(true);
    expect(generateAgentFlags({}, "antigravity", { globalSkipPermissions: true })).toContain(
      DEFAULT_DANGEROUS_ARGS.antigravity
    );
  });

  it("injects every registered bypass flag for an agent left on Default", () => {
    for (const [agentId, flag] of Object.entries(DEFAULT_DANGEROUS_ARGS)) {
      const off = generateAgentFlags({}, agentId);
      const on = generateAgentFlags({}, agentId, { globalSkipPermissions: true });
      expect(isAgentTerminalBypassSupported(agentId), agentId).toBe(true);
      expect(on.join(" "), agentId).toContain(flag);
      expect(off.join(" "), agentId).not.toContain(flag);
    }
  });

  it("gives Gemini --yolo: its assistant permissionBypass opt-out doesn't reach terminals", () => {
    expect(isAgentBypassSupported("gemini")).toBe(false);
    expect(isAgentTerminalBypassSupported("gemini")).toBe(true);
    expect(resolveEffectiveBypass({ dangerousMode: "inherit" }, "gemini", true)).toBe(true);
    expect(generateAgentFlags({}, "gemini", { globalSkipPermissions: true })).toContain(
      DEFAULT_DANGEROUS_ARGS.gemini
    );
  });

  it("never reaches an agent with no registered bypass flag, even with written dangerousArgs", () => {
    for (const agentId of ["opencode", "copilot", "goose", "mistral", "toString", "unknown"]) {
      expect(isAgentTerminalBypassSupported(agentId), agentId).toBe(false);
      expect(resolveEffectiveBypass({}, agentId, true), agentId).toBe(false);
    }
    const entry = { dangerousArgs: "--dangerously-skip-permissions" };
    expect(resolveEffectiveBypass(entry, "opencode", true)).toBe(false);
    expect(generateAgentFlags(entry, "opencode", { globalSkipPermissions: true })).not.toContain(
      "--dangerously-skip-permissions"
    );
    expect(isAgentTerminalBypassSupported(undefined)).toBe(false);
  });

  it("keeps a user-defined agent that opts in through supports.permissionBypass", () => {
    setUserRegistry({
      "my-agent": {
        id: "my-agent",
        name: "My Agent",
        command: "my-agent",
        color: "#123456",
        iconId: "terminal",
        supportsContextInjection: false,
        supports: {
          mcpInjection: "project-config",
          settingsOverlay: false,
          permissionBypass: true,
          trustDialog: false,
          versionProbe: false,
          tier: "experimental",
        },
      },
    });
    expect(isAgentTerminalBypassSupported("my-agent")).toBe(true);
    expect(
      generateAgentFlags({ dangerousArgs: "--auto" }, "my-agent", { globalSkipPermissions: true })
    ).toContain("--auto");
  });

  it("still lets an explicit agent or preset Off veto the global switch", () => {
    expect(resolveEffectiveBypass({ dangerousMode: "off" }, "antigravity", true)).toBe(false);
    const merged = combineDangerousModes("inherit", "off");
    expect(resolveEffectiveBypass({ dangerousMode: merged }, "gemini", true)).toBe(false);
  });

  it("reconciles a resumed snapshot to carry the flag while the global is on", () => {
    const flag = DEFAULT_DANGEROUS_ARGS.antigravity as string;
    const bypass = resolveEffectiveBypass({}, "antigravity", true);
    expect(reconcileBypassFlags(["--model", "x"], "antigravity", bypass)).toEqual([
      "--model",
      "x",
      flag,
    ]);
    expect(
      reconcileBypassFlags([flag], "antigravity", resolveEffectiveBypass({}, "antigravity", false))
    ).toEqual([]);
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

  it("replaces Open Interpreter's retired Python flag captured in a snapshot (#15567)", () => {
    const current = DEFAULT_DANGEROUS_ARGS.interpreter as string;
    expect(current).not.toBe("--auto_run");
    // A pane captured under the old default must not relaunch with a flag the
    // Rust CLI rejects: dropped when bypass is off, swapped in place when on.
    expect(reconcileBypassFlags(["--auto_run", "-m", "o4"], "interpreter", false)).toEqual([
      "-m",
      "o4",
    ]);
    expect(reconcileBypassFlags(["--auto_run", "-m", "o4"], "interpreter", true)).toEqual([
      current,
      "-m",
      "o4",
    ]);
    // Another agent's flag of the same spelling is not touched.
    expect(reconcileBypassFlags(["--auto_run"], "aider", false)).toEqual(["--auto_run"]);
  });

  it("resolves bypass args for a custom agent whose id names an Object.prototype member", () => {
    expect(
      generateAgentFlags({ dangerousArgs: "--approve", dangerousMode: "on" }, "toString")
    ).toEqual(["--approve"]);
    expect(reconcileBypassFlags(["--approve", "-v"], "toString", false, "--approve")).toEqual([
      "-v",
    ]);
    expect(reconcileBypassFlags(["-v"], "constructor", true, "--approve")).toEqual([
      "-v",
      "--approve",
    ]);
    // With nothing written there is no default to inherit from the prototype.
    expect(generateAgentFlags({ dangerousMode: "on" }, "toString")).toEqual([]);
  });

  it("reads Open Interpreter's retired flag in settings as unset (#15567)", () => {
    // An old config bundle can bring the Python default back after migration 042.
    const current = DEFAULT_DANGEROUS_ARGS.interpreter as string;
    expect(reconcileBypassFlags(["--auto_run"], "interpreter", true, "--auto_run")).toEqual([
      current,
    ]);
    expect(
      generateAgentFlags({ dangerousArgs: "--auto_run", dangerousMode: "on" }, "interpreter")
    ).toEqual([current]);
    // A value the user wrote themselves still wins.
    expect(
      generateAgentFlags(
        { dangerousArgs: "--auto_run --verbose", dangerousMode: "on" },
        "interpreter"
      )
    ).toEqual(["--auto_run", "--verbose"]);
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

  describe("multi-token bypass args (#13046)", () => {
    const customBypass = "-c approval_policy=never";

    it("strips only the whole sequence, leaving other `-c` overrides paired", () => {
      const flags = [
        "-c",
        "tui.whimsy=false",
        "-c",
        "approval_policy=never",
        "-c",
        "model_reasoning_effort=high",
      ];
      expect(reconcileBypassFlags(flags, "codex", false, customBypass)).toEqual([
        "-c",
        "tui.whimsy=false",
        "-c",
        "model_reasoning_effort=high",
      ]);
    });

    it("keeps the sequence in place when bypass is on, without touching other pairs", () => {
      const flags = ["-c", "approval_policy=never", "-c", "model_reasoning_effort=high"];
      expect(reconcileBypassFlags(flags, "codex", true, customBypass)).toEqual(flags);
    });

    it("appends the sequence when absent and bypass is on", () => {
      expect(
        reconcileBypassFlags(["-c", "model_reasoning_effort=high"], "codex", true, customBypass)
      ).toEqual(["-c", "model_reasoning_effort=high", "-c", "approval_policy=never"]);
    });

    it("swaps the registry default for the custom sequence in place", () => {
      const codexDefault = DEFAULT_DANGEROUS_ARGS.codex as string;
      expect(
        reconcileBypassFlags(
          [codexDefault, "-c", "model_reasoning_effort=high"],
          "codex",
          true,
          customBypass
        )
      ).toEqual(["-c", "approval_policy=never", "-c", "model_reasoning_effort=high"]);
    });

    // Another reconciler can rewrite part of a custom bypass (here the inline
    // pass drops `--no-alt-screen`); the rest must still be recognised.
    it("still recognises a bypass whose other option another reconciler removed", () => {
      const mixed = "-c approval_policy=never --no-alt-screen";
      const normalised = ["-c", "approval_policy=never", "-c", "model_reasoning_effort=high"];
      expect(reconcileBypassFlags(normalised, "codex", false, mixed)).toEqual([
        "-c",
        "model_reasoning_effort=high",
      ]);
      const on = reconcileBypassFlags(normalised, "codex", true, mixed);
      expect(on).toEqual([
        "-c",
        "approval_policy=never",
        "--no-alt-screen",
        "-c",
        "model_reasoning_effort=high",
      ]);
      expect(reconcileBypassFlags(on, "codex", true, mixed)).toEqual(on);
    });

    it("does not strip a lone token that is only part of the sequence", () => {
      const flags = ["-c", "model_reasoning_effort=high", "approval_policy=never"];
      expect(reconcileBypassFlags(flags, "codex", false, customBypass)).toEqual(flags);
    });
  });
});

describe("generateAgentFlags with globalSkipPermissions", () => {
  it("injects the dangerous flag for a supported agent when the global is on", () => {
    const flags = generateAgentFlags({ dangerousEnabled: false }, "claude", {
      globalSkipPermissions: true,
    });
    expect(flags).toContain(DEFAULT_DANGEROUS_ARGS.claude);
  });

  it("injects no bypass flag for an agent that has none when the global is on", () => {
    const flags = generateAgentFlags({ dangerousEnabled: false }, "opencode", {
      globalSkipPermissions: true,
    });
    expect(flags).toEqual(generateAgentFlags({ dangerousEnabled: false }, "opencode"));
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

  it("captures Gemini's flag when the global is on, despite its assistant opt-out (#16414)", () => {
    const flags = buildAgentLaunchFlags({ dangerousEnabled: false }, "gemini", {
      globalSkipPermissions: true,
    });
    expect(flags).toContain(DEFAULT_DANGEROUS_ARGS.gemini);
  });
});

describe("inline-only launches (#16356)", () => {
  const inlineAgents = Object.keys(DEFAULT_AGENT_SETTINGS.agents).filter(
    (id) => getEffectiveAgentConfig(id)?.capabilities?.inlineModeFlag
  );
  // What an older build stored when someone chose alt screen: the entry keeps
  // it through its index signature, and nothing reads it any more.
  const storedChoices: AgentSettingsEntry[] = [
    {},
    { inlineMode: "off" },
    { inlineMode: false },
    { inlineMode: "inherit" },
    { inlineMode: "on" },
  ];

  it("launches every agent with an inline flag inline, whatever choice was stored", () => {
    expect(inlineAgents).toEqual(expect.arrayContaining(["codex", "grok", "opencode"]));
    for (const agentId of inlineAgents) {
      const capabilities = getEffectiveAgentConfig(agentId)!.capabilities!;
      for (const entry of storedChoices) {
        const label = `${agentId} ${JSON.stringify(entry)}`;
        const flags = buildAgentLaunchFlags(entry, agentId);
        expect(
          flags.filter((f) => f === capabilities.inlineModeFlag),
          label
        ).toHaveLength(1);
        const command = generateAgentCommand(agentId, entry, agentId);
        expect(command.split(" "), label).toContain(capabilities.inlineModeFlag);
        if (capabilities.altScreenFlag) {
          expect(flags, label).not.toContain(capabilities.altScreenFlag);
          expect(command.split(" "), label).not.toContain(capabilities.altScreenFlag);
        }
      }
    }
  });

  it("carries no screen-mode flag on a headless one-shot", () => {
    for (const agentId of inlineAgents) {
      const capabilities = getEffectiveAgentConfig(agentId)!.capabilities!;
      const tokens = generateAgentCommand(agentId, {}, agentId, {
        initialPrompt: "Fix the bug",
        interactive: false,
      }).split(" ");
      expect(tokens, agentId).not.toContain(capabilities.inlineModeFlag);
      if (capabilities.altScreenFlag)
        expect(tokens, agentId).not.toContain(capabilities.altScreenFlag);
    }
  });

  it("leaves agents with no inline mode on their own full-screen default", () => {
    // Crush must run full-screen and Goose declares no inline flag: no screen
    // token is added to their launch, and a saved one is never stripped.
    for (const agentId of ["crush", "goose"]) {
      expect(getEffectiveAgentConfig(agentId)?.capabilities?.inlineModeFlag).toBeUndefined();
      expect(buildAgentLaunchFlags({ inlineMode: "on" }, agentId)).toEqual(
        buildAgentLaunchFlags({ inlineMode: "off" }, agentId)
      );
      const saved = ["--fullscreen", "--x", "--no-alt-screen"];
      expect(reconcileInlineModeFlag(saved, agentId)).toEqual(saved);
    }
  });
});

describe("reconcileInlineModeFlag (#10876, #16356)", () => {
  it("rewrites a saved --fullscreen to the inline flag in place", () => {
    expect(reconcileInlineModeFlag(["--model", "x", "--fullscreen", "--y"], "grok")).toEqual([
      "--model",
      "x",
      "--no-alt-screen",
      "--y",
    ]);
  });

  it("appends the inline flag when the snapshot lacks it", () => {
    expect(reconcileInlineModeFlag(["--model", "gpt"], "codex")).toEqual([
      "--model",
      "gpt",
      "--no-alt-screen",
    ]);
    expect(reconcileInlineModeFlag([], "opencode")).toEqual(["--mini"]);
  });

  it("is idempotent when the snapshot is already inline", () => {
    const inline = ["--no-alt-screen", "--model", "gpt"];
    expect(reconcileInlineModeFlag(inline, "codex")).toEqual(inline);
  });

  it("dedupes duplicate flags, keeping the first in place", () => {
    const flags = ["--no-alt-screen", "--model", "gpt", "--no-alt-screen"];
    expect(reconcileInlineModeFlag(flags, "codex")).toEqual(["--no-alt-screen", "--model", "gpt"]);
  });

  it("leaves flags untouched for an agent with no inlineModeFlag", () => {
    const flags = ["--foo", "--no-alt-screen"];
    expect(reconcileInlineModeFlag(flags, "claude")).toEqual(flags);
  });
});

describe("paired screen-mode tokens (#11423, #16356)", () => {
  // Sentinel tokens, not the real `--no-alt-screen`/`--fullscreen`: these cases
  // pin the mechanism across the capability matrix, so they stay green if a
  // shipped agent's flag spelling ever changes.
  const INLINE = "--sentinel-inline";
  const ALT = "--sentinel-alt";
  const AGENT_IDS = ["inline-only", "alt-only", "both-modes", "neither-mode"];

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

  it("injects only the inline token, whatever choice was stored", () => {
    const cases: Array<[string, string | undefined]> = [
      ["inline-only", INLINE],
      ["alt-only", undefined],
      ["both-modes", INLINE],
      ["neither-mode", undefined],
    ];
    for (const [agentId, expected] of cases) {
      for (const entry of [{}, { inlineMode: "off" }, { inlineMode: false }]) {
        const flags = buildAgentLaunchFlags(entry, agentId);
        const screenTokens = flags.filter((f) => f === INLINE || f === ALT);
        expect(screenTokens, `${agentId} ${JSON.stringify(entry)}`).toEqual(
          expected ? [expected] : []
        );
        const commandTokens = generateAgentCommand(agentId, entry, agentId)
          .split(" ")
          .filter((f) => f === INLINE || f === ALT);
        expect(commandTokens, `${agentId} command`).toEqual(expected ? [expected] : []);
      }
    }
  });

  it("never lets both polarities survive reconciliation", () => {
    expect(reconcileInlineModeFlag([INLINE, "--model", ALT], "both-modes")).toEqual([
      INLINE,
      "--model",
    ]);
    expect(reconcileInlineModeFlag([ALT, "--model", INLINE], "both-modes")).toEqual([
      INLINE,
      "--model",
    ]);
  });

  it("rewrites a stale alt token in place rather than relocating it", () => {
    // Position stability keeps an already-persisted snapshot's ordering intact
    // so the rewrite touches one slot instead of churning the whole array.
    expect(reconcileInlineModeFlag(["--a", ALT, "--b"], "both-modes")).toEqual([
      "--a",
      INLINE,
      "--b",
    ]);
  });

  it("dedupes repeated managed tokens down to the inline one", () => {
    expect(reconcileInlineModeFlag([INLINE, "--keep", INLINE, ALT], "both-modes")).toEqual([
      INLINE,
      "--keep",
    ]);
  });

  it("leaves an agent with no inline flag untouched, an alt-only one included", () => {
    for (const agentId of ["alt-only", "neither-mode"]) {
      const flags = ["--a", INLINE, ALT];
      expect(reconcileInlineModeFlag(flags, agentId)).toEqual(flags);
      expect(reconcileInlineModeFlag([], agentId)).toEqual([]);
    }
  });

  it("injects into an empty snapshot, the shape the relaunch chokepoints pass", () => {
    // restart.ts calls the reconciler with [] and uses the result only when it
    // comes back non-empty, so a session launched before the inline flag
    // existed still picks it up.
    expect(reconcileInlineModeFlag([], "both-modes")).toEqual([INLINE]);
    expect(reconcileInlineModeFlag([], "inline-only")).toEqual([INLINE]);
  });

  it("never mutates the input array", () => {
    for (const agentId of AGENT_IDS) {
      const input = ["--keep", INLINE, ALT];
      const snapshot = [...input];
      reconcileInlineModeFlag(input, agentId);
      expect(input, `${agentId} mutated its input`).toEqual(snapshot);
    }
  });

  it("is idempotent for every capability combination", () => {
    const inputs = [[], ["--keep"], [INLINE], [ALT], ["--keep", INLINE, ALT, INLINE]];
    for (const agentId of AGENT_IDS) {
      for (const input of inputs) {
        const once = reconcileInlineModeFlag(input, agentId);
        expect(
          reconcileInlineModeFlag(once, agentId),
          `${agentId} input=${JSON.stringify(input)}`
        ).toEqual(once);
      }
    }
  });

  it("keeps an alt-only agent's token out of a headless one-shot", () => {
    const headless = generateAgentCommand("alt-only", { inlineMode: "off" }, "alt-only", {
      interactive: false,
    });
    expect(headless).not.toContain(ALT);
  });
});

describe("screen-mode reconciliation composed with bypass reconciliation (#11423)", () => {
  // All three relaunch chokepoints (agentResume, panelRegistry/restart,
  // stateHydration/statePatcher) compose the two reconcilers in this exact
  // order. They own disjoint tokens, so neither may disturb the other's — this
  // is the interaction the composition would hide if it regressed.
  const reconcileBoth = (flags: readonly string[], agentId: string, effectiveBypass: boolean) =>
    reconcileInlineModeFlag(reconcileBypassFlags(flags, agentId, effectiveBypass), agentId);

  // Grok's real bypass token, so the composition is exercised with a token the
  // bypass reconciler actually owns rather than one it ignores.
  const bypassToken = DEFAULT_DANGEROUS_ARGS.grok!;
  const screenTokens = (flags: readonly string[]) =>
    flags.filter((f) => f === "--no-alt-screen" || f === "--fullscreen");

  it("rewrites a saved --fullscreen while the bypass reconciler keeps its own token", () => {
    const reconciled = reconcileBoth(["--fullscreen"], "grok", true);
    expect(screenTokens(reconciled)).toEqual(["--no-alt-screen"]);
    expect(reconciled.filter((f) => f === bypassToken)).toEqual([bypassToken]);
  });

  it("drops the bypass token without disturbing the screen-mode token", () => {
    const both = reconcileBoth([], "grok", true);
    expect(both).toContain(bypassToken);

    const bypassOff = reconcileBoth(both, "grok", false);
    expect(bypassOff).not.toContain(bypassToken);
    expect(screenTokens(bypassOff)).toEqual(["--no-alt-screen"]);
  });

  it("is idempotent under repeated composed reconciliation", () => {
    const once = reconcileBoth(["--model", "grok-build", "--fullscreen"], "grok", false);
    expect(reconcileBoth(once, "grok", false)).toEqual(once);
    expect(screenTokens(once)).toEqual(["--no-alt-screen"]);
  });
});

describe("launch-time session id assignment (#11782)", () => {
  // Claude accepts `--session-id <uuid>`; Codex has no launch-time equivalent
  // and keeps the teardown scrape. Using the pair keeps every assertion below
  // about the capability's effect rather than about one agent's literal flags.
  const ASSIGNING = "claude";
  const SCRAPING = "codex";

  it("reports the capability exactly when a launch actually carries an id", () => {
    // Cross-check rather than a restatement of the registry: the predicate that
    // teardown trusts to skip the scrape must agree, for every agent, with
    // whether the launch command really got an id. A disagreement means either
    // a scrape skipped with nothing captured, or an id assigned that nothing
    // records.
    const probe = "33333333-4444-5555-6666-777777777777";
    for (const agentId of Object.keys(DEFAULT_AGENT_SETTINGS.agents)) {
      const emitsId = generateAgentCommand(agentId, {}, agentId, {
        sessionId: probe,
      }).includes(probe);
      expect(supportsSessionIdAssignment(agentId)).toBe(emitsId);
    }
  });

  it("reports no capability for an absent or unknown agent", () => {
    expect(supportsSessionIdAssignment(undefined)).toBe(false);
    expect(supportsSessionIdAssignment("not-a-real-agent")).toBe(false);
  });

  it("mints an id only where one can actually be assigned", () => {
    expect(mintAssignedSessionId(SCRAPING)).toBeUndefined();
    expect(mintAssignedSessionId(undefined)).toBeUndefined();

    const minted = mintAssignedSessionId(ASSIGNING);
    expect(minted).toBeDefined();
    // The CLI requires a real UUID and rejects anything else outright.
    expect(minted).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });

  it("mints a distinct id per call so sibling panes never collide", () => {
    // Two panes sharing an id is the failure this must structurally prevent:
    // the second launch would be rejected as "already in use".
    const ids = new Set(Array.from({ length: 25 }, () => mintAssignedSessionId(ASSIGNING)));
    expect(ids.size).toBe(25);
  });

  it("puts the assigned id in the launch command ahead of the positional prompt", () => {
    const sessionId = "11111111-2222-3333-4444-555555555555";
    const command = generateAgentCommand("claude", {}, ASSIGNING, {
      sessionId,
      initialPrompt: "fix the bug",
    });

    const idIndex = command.indexOf(sessionId);
    expect(idIndex).toBeGreaterThan(-1);
    // Ordering is load-bearing: emitted after the prompt, the CLI would read
    // the flag as part of the prompt rather than as a flag.
    expect(idIndex).toBeLessThan(command.indexOf("fix the bug"));
  });

  it("leaves the command untouched for an agent that mints its own id", () => {
    const withId = generateAgentCommand("codex", {}, SCRAPING, { sessionId: "abc-123" });
    const withoutId = generateAgentCommand("codex", {}, SCRAPING, {});
    expect(withId).toBe(withoutId);
    expect(buildAssignedSessionIdArgs(SCRAPING, "abc-123")).toBeUndefined();
  });

  it("keeps a from-flags rebuild free of any assigned id", () => {
    // That builder reproduces the CAPTURED launch configuration, which a
    // one-shot per-launch id is not part of. Letting one leak in would also
    // mean a pane could be handed an id its command never actually carried.
    const command = buildLaunchCommandFromFlags("claude", ASSIGNING, ["--verbose"]);
    expect(command).toBe("claude --verbose");
  });

  describe("one-shot flag handling", () => {
    const sessionId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

    it("strips the assigning flag so a copied command launches fresh", () => {
      const assigned = generateAgentCommand("claude", {}, ASSIGNING, { sessionId });
      const stripped = stripAssignedSessionIdArgs(assigned, ASSIGNING);

      expect(stripped).not.toContain(sessionId);
      expect(stripped).not.toContain("--session-id");
      // Still a runnable command, not a mangled one.
      expect(stripped.startsWith("claude")).toBe(true);
      expect(stripped).not.toMatch(/\s{2,}/);
    });

    it("is idempotent, so a repeated strip stays valid", () => {
      const assigned = generateAgentCommand("claude", {}, ASSIGNING, { sessionId });
      const once = stripAssignedSessionIdArgs(assigned, ASSIGNING);
      expect(stripAssignedSessionIdArgs(once, ASSIGNING)).toBe(once);
    });

    it("preserves flags on both sides of the removed one", () => {
      // A fixture with nothing around the flag would pass even if the strip
      // threw the rest of the command away.
      const assigned = generateAgentCommand("claude", { customFlags: "--verbose" }, ASSIGNING, {
        sessionId,
        initialPrompt: "hello",
      });
      const stripped = stripAssignedSessionIdArgs(assigned, ASSIGNING);

      expect(stripped).not.toContain(sessionId);
      expect(stripped).toContain("--verbose");
      expect(stripped).toContain("hello");
      expect(stripped.startsWith("claude ")).toBe(true);
    });

    it("strips without being told which id was used", () => {
      // The worktree-move flow clears `agentSessionId` before restarting,
      // precisely because it wants a fresh launch. A strip that needed the id
      // to find the flag would no-op there and relaunch with a spent one.
      const assigned = generateAgentCommand("claude", {}, ASSIGNING, {
        sessionId: "99999999-8888-7777-6666-555555555555",
      });
      expect(stripAssignedSessionIdArgs(assigned, ASSIGNING)).toBe("claude");
    });

    it("keeps a quoted argument's internal spacing intact", () => {
      // Removing the flag must not reflow the rest of the command — collapsing
      // whitespace globally would rewrite a prompt that contains a run of them.
      const assigned = generateAgentCommand("claude", {}, ASSIGNING, {
        sessionId,
        initialPrompt: "fix  the  bug",
      });
      expect(stripAssignedSessionIdArgs(assigned, ASSIGNING)).toContain("fix  the  bug");
    });

    it("reads a POSIX-escaped apostrophe as part of its quoted word", () => {
      // `escapeShellArg` emits `'\''` for every apostrophe. Read without
      // backslash escapes, that run leaves the quote state inverted, the flag
      // scan reaches inside the prompt, and the command is cut at the next
      // space with a stray quote left behind.
      const command = `claude 'don'\\''t touch --session-id here'`;
      expect(stripAssignedSessionIdArgs(command, ASSIGNING)).toBe(command);
    });

    it("strips the flag from a prompt containing an apostrophe without reflowing it", () => {
      const initialPrompt = "don't  fix  it";
      const assigned = generateAgentCommand("claude", {}, ASSIGNING, { sessionId, initialPrompt });
      const stripped = stripAssignedSessionIdArgs(assigned, ASSIGNING);

      expect(stripped).not.toContain(sessionId);
      expect(stripped).not.toContain("--session-id");
      // Byte-identical to the launch that never carried an id — so the strip
      // neither collapsed the prompt's spacing nor unbalanced its quoting.
      expect(stripped).toBe(generateAgentCommand("claude", {}, ASSIGNING, { initialPrompt }));
    });

    it("leaves commands that never carried the flag alone", () => {
      const plain = generateAgentCommand("claude", {}, ASSIGNING, {});
      expect(stripAssignedSessionIdArgs(plain, ASSIGNING)).toBe(plain);
    });

    it("ignores the flag when it is only text inside a prompt", () => {
      // Scanning the raw string would cut the quoted prompt in half and leave
      // an unbalanced quote — a command that no longer runs at all.
      const command = generateAgentCommand("claude", {}, ASSIGNING, {
        initialPrompt: "Explain --session-id foo to me",
      });
      expect(stripAssignedSessionIdArgs(command, ASSIGNING)).toBe(command);
    });

    it("removes the real flag while leaving a lookalike prompt intact", () => {
      const command = generateAgentCommand("claude", {}, ASSIGNING, {
        sessionId,
        initialPrompt: "Explain --session-id foo to me",
      });
      const stripped = stripAssignedSessionIdArgs(command, ASSIGNING);

      expect(stripped).not.toContain(sessionId);
      expect(stripped).toContain("Explain --session-id foo to me");
    });

    it("leaves an agent that mints its own id alone", () => {
      const codexCommand = `codex --session-id ${sessionId}`;
      expect(stripAssignedSessionIdArgs(codexCommand, SCRAPING)).toBe(codexCommand);
    });

    it("does nothing without an agent to act on", () => {
      const assigned = generateAgentCommand("claude", {}, ASSIGNING, { sessionId });
      expect(stripAssignedSessionIdArgs(assigned, undefined)).toBe(assigned);
      expect(stripAssignedSessionIdArgs("", ASSIGNING)).toBe("");
    });
  });

  describe("relaunching an untouched session under its own id (#12371)", () => {
    const sessionId = "006fdfc0-67bf-4df0-ad82-48ebfe4df184";

    it("turns an exact resume into an assignment of the same id", () => {
      const resume = buildResumeCommand(ASSIGNING, sessionId, ["--verbose"]) as string;
      expect(resume).toBe(`claude --verbose --resume ${sessionId}`);

      expect(relaunchResumeAsAssignedSession(resume, ASSIGNING)).toEqual({
        sessionId,
        command: `claude --verbose --session-id ${sessionId}`,
      });
    });

    it("keeps a resolved base command and the flags on both sides", () => {
      const command = `/opt/claude/bin/claude --dangerously-skip-permissions --resume ${sessionId} --verbose`;
      expect(relaunchResumeAsAssignedSession(command, ASSIGNING)?.command).toBe(
        `/opt/claude/bin/claude --dangerously-skip-permissions --session-id ${sessionId} --verbose`
      );
    });

    it("reads an id the shell escaper wrapped in quotes", () => {
      expect(relaunchResumeAsAssignedSession(`claude --resume '${sessionId}'`, ASSIGNING)).toEqual({
        sessionId,
        command: `claude --session-id ${sessionId}`,
      });
    });

    it("ignores the flag when it is only text inside a prompt", () => {
      const command = `claude 'why does --resume ${sessionId} fail'`;
      expect(relaunchResumeAsAssignedSession(command, ASSIGNING)).toBeUndefined();
    });

    it("refuses anything the CLI would not assign as an id", () => {
      expect(relaunchResumeAsAssignedSession("claude --resume s-1", ASSIGNING)).toBeUndefined();
      // A bare `--resume` opens the CLI's picker; there is no id to carry over.
      expect(relaunchResumeAsAssignedSession("claude --resume", ASSIGNING)).toBeUndefined();
    });

    it("leaves a fresh launch alone", () => {
      const fresh = generateAgentCommand("claude", {}, ASSIGNING, { sessionId });
      expect(relaunchResumeAsAssignedSession(fresh, ASSIGNING)).toBeUndefined();
      expect(relaunchResumeAsAssignedSession("", ASSIGNING)).toBeUndefined();
    });

    it("declines a command whose quoting reads differently from shell to shell", () => {
      // A POSIX shell ends this prompt at the last quote and PowerShell at the
      // first; a tokenizer can only guess, so no rewrite.
      const command = `claude --append-system-prompt "say \\" --resume ${sessionId} \\" once" --resume ${sessionId}`;
      expect(relaunchResumeAsAssignedSession(command, ASSIGNING)).toBeUndefined();
    });

    it("strips the flag after a Windows path that ends in a backslash", () => {
      const command = `claude --add-dir "C:\\work\\" --session-id ${sessionId}`;
      expect(stripAssignedSessionIdArgs(command, ASSIGNING)).toBe(`claude --add-dir "C:\\work\\"`);
    });

    it("declines a command that picks its conversation more than one way", () => {
      const other = "1ad2578c-b710-4302-90c1-b222c4c29aa2";
      for (const command of [
        `claude --continue --resume ${sessionId}`,
        `claude --resume ${other} --resume ${sessionId}`,
        `claude --session-id ${other} --resume ${sessionId}`,
      ]) {
        expect(relaunchResumeAsAssignedSession(command, ASSIGNING)).toBeUndefined();
      }
    });

    it("leaves agents that mint their own id alone", () => {
      const codexResume = buildResumeCommand(SCRAPING, sessionId) as string;
      expect(relaunchResumeAsAssignedSession(codexResume, SCRAPING)).toBeUndefined();
      expect(
        relaunchResumeAsAssignedSession(`claude --resume ${sessionId}`, undefined)
      ).toBeUndefined();
    });
  });
});

describe("Windows launch command quoting", () => {
  const originalPlatform = process.platform;
  beforeEach(() => {
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
  });
  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
  });

  it("hands PowerShell a prompt it cannot expand or execute", () => {
    // The command runs as a PowerShell script (`-EncodedCommand`). In cmd-style
    // "..." this prompt's `$(...)` ran before the agent started — a recipe or an
    // issue body could execute code — and `$HOME`, `$5` and the backticks were
    // rewritten on their way to the agent.
    const prompt = "Fix the `greet` function in $HOME. Price is $5. Probe: $(Set-Content x pwned)";
    const command = generateAgentCommand("codex", {}, "codex", { initialPrompt: prompt });
    expect(command.endsWith(` '${prompt}'`)).toBe(true);
    expect(command).not.toContain(`"${prompt}"`);
  });

  it("quotes leading-dash payloads on fresh, resumed and rebuilt launches", () => {
    const flag = "--value=$(Get-Date)";
    expect(generateAgentCommand("claude", { customFlags: flag }, "claude")).toContain(`'${flag}'`);
    expect(buildResumeCommand("claude", "session", [flag])).toContain(`'${flag}'`);
    expect(buildResumeLatestCommand("claude", [flag])).toContain(`'${flag}'`);
    expect(buildLaunchCommandFromFlags("claude", "claude", [flag])).toContain(`'${flag}'`);
  });

  it("doubles apostrophes and preserves double quotes as source literals", () => {
    const command = generateAgentCommand("claude", {}, "claude", {
      initialPrompt: `don't print "hi"`,
    });
    expect(command.endsWith(` 'don''t print "hi"'`)).toBe(true);
  });
});

describe("launch commands built for another machine's shell", () => {
  const originalPlatform = process.platform;
  afterEach(() => {
    setAgentCommandDialectResolver(null);
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
  });

  it("quotes for a WSL host's bash even under a Windows Shell", () => {
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    setAgentCommandDialectResolver(() => "posix");
    const command = generateAgentCommand("claude", {}, "claude", { initialPrompt: "don't stop" });
    // PowerShell's doubled apostrophe would reach bash as "dont stop".
    expect(command.endsWith(` 'don'\\''t stop'`)).toBe(true);
    expect(command).not.toContain("'don''t");
    expect(buildResumeCommand("claude", "session", ["--value=$(x)"])).toContain("'--value=$(x)'");
  });

  it("leaves this machine's own platform in charge when nothing says otherwise", () => {
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    setAgentCommandDialectResolver(() => null);
    const command = generateAgentCommand("claude", {}, "claude", { initialPrompt: "don't" });
    expect(command.endsWith(` 'don''t'`)).toBe(true);
  });
});

describe("decorative effects (registry capabilities.decorations)", () => {
  const OFF = ["-c", "tui.whimsy=false"];

  describe.each([
    ["linux", "'tui.whimsy=false'", "'.'"],
    // Windows launches run through PowerShell, so they take its literal quotes too.
    ["win32", "'tui.whimsy=false'", "'.'"],
  ])("launch commands on %s", (platform, quotedOverride, quotedDir) => {
    const originalPlatform = process.platform;

    beforeEach(() => {
      Object.defineProperty(process, "platform", { value: platform, configurable: true });
    });
    afterEach(() => {
      Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    });

    it("switches codex's composer sparkles off by default on every launch path", () => {
      expect(buildAgentLaunchFlags({}, "codex")).toEqual(expect.arrayContaining(OFF));
      // The override must be quoted for the platform's shell on both paths.
      const launch = generateAgentCommand("codex", {}, "codex");
      expect(launch).toBe(`codex --no-alt-screen -c ${quotedOverride}`);
      // A `-c` override is a global option, so it must precede the subcommand.
      expect(buildResumeCommand("codex", "abc-123", buildAgentLaunchFlags({}, "codex"))).toBe(
        `codex --no-alt-screen -c ${quotedOverride} resume abc-123 -C ${quotedDir}`
      );
    });
  });

  it("keeps the effects when the user opts in", () => {
    expect(buildAgentLaunchFlags({ decorativeEffects: true }, "codex")).not.toContain("-c");
    expect(generateAgentCommand("codex", { decorativeEffects: true }, "codex")).not.toContain(
      "tui.whimsy"
    );
  });

  it("leaves agents that declare no decorations alone", () => {
    expect(buildAgentLaunchFlags({}, "claude")).toEqual([]);
    expect(reconcileDecorationFlags(["--verbose"], "claude", false)).toEqual(["--verbose"]);
  });

  it("does not duplicate tokens the user already put in custom flags", () => {
    const flags = buildAgentLaunchFlags({ customFlags: "-c tui.whimsy=false" }, "codex");
    expect(flags.filter((f) => f === "tui.whimsy=false")).toHaveLength(1);
  });

  it("reconciles a persisted snapshot against the current choice, idempotently", () => {
    const stale = ["--no-alt-screen", "--model", "gpt-5.5"];
    const withOff = reconcileDecorationFlags(stale, "codex", false);
    expect(withOff).toEqual([...stale, ...OFF]);
    // Already correct → untouched, position preserved.
    expect(reconcileDecorationFlags(withOff, "codex", false)).toEqual(withOff);
    // User later keeps the effects → the token pair is removed as a unit.
    expect(reconcileDecorationFlags(withOff, "codex", true)).toEqual(stale);
    expect(reconcileDecorationFlags(stale, "codex", true)).toEqual(stale);
    // The pair is matched as a sequence, not as loose tokens.
    const split = ["-c", "model=x", "tui.whimsy=false"];
    expect(reconcileDecorationFlags(split, "codex", false)).toEqual([...split, ...OFF]);
    // Duplicates converge: two copies become one (first position kept) or none.
    const doubled = [...OFF, "--verbose", ...OFF];
    expect(reconcileDecorationFlags(doubled, "codex", false)).toEqual([...OFF, "--verbose"]);
    expect(reconcileDecorationFlags(doubled, "codex", true)).toEqual(["--verbose"]);
  });

  it("does not double the pair when a preset's args already carry it", () => {
    const flags = buildAgentLaunchFlags({}, "codex", { presetArgs: [...OFF, "--verbose"] });
    expect(flags.filter((f) => f === "tui.whimsy=false")).toHaveLength(1);
    // And a later opt-in removes the preset's copy as well as the generated one.
    const kept = buildAgentLaunchFlags({ decorativeEffects: true }, "codex", {
      presetArgs: [...OFF, "--verbose"],
    });
    expect(kept).not.toContain("tui.whimsy=false");
  });
});

describe("agentClipboardDirectory", () => {
  it("keeps this machine's clipboard folder for a local window", () => {
    expect(agentClipboardDirectory("/var/folders/tmp", false)).toBe(
      "/var/folders/tmp/daintree-clipboard"
    );
  });

  it("points a remote window's Gemini at the host inbox", () => {
    const dir = agentClipboardDirectory("/tmp", true);
    expect(dir).toBe("/tmp/daintree-inbox");
    expect(
      buildLaunchCommandFromFlags("gemini", "gemini", [], { clipboardDirectory: dir })
    ).toContain(`--include-directories '/tmp/daintree-inbox'`);
  });
});

describe("plugin-declared resume (#13687)", () => {
  forcePosixPlatform();
  afterEach(() => clearPluginAgentRegistryForTests());

  const plugin = {
    name: "Plugin",
    color: "#3366ff",
    iconId: "terminal",
  };

  it("builds an exact resume from a session-id template, quoting the id", () => {
    registerPluginAgents("me.extra-agents", [
      {
        ...plugin,
        id: "hermes",
        command: "hermes",
        resume: { kind: "session-id", args: ["--resume", "{sessionId}"], quitCommand: "/exit" },
      },
    ]);
    expect(buildResumeCommand("hermes", "abc123")).toBe("hermes --resume abc123");
    expect(buildResumeCommand("hermes", "it's")).toBe("hermes --resume 'it'\\''s'");
    expect(buildResumeLatestCommand("hermes")).toBeUndefined();
    expect(buildAssignedSessionIdArgs("hermes", "abc")).toBeUndefined();
    expect(supportsSessionIdAssignment("hermes")).toBe(false);
  });

  it("builds a resume-latest command for a project-scoped plugin agent", () => {
    registerPluginAgents("me.extra-agents", [
      {
        ...plugin,
        id: "pi",
        command: "pi",
        resume: { kind: "project-scoped", args: ["--continue"] },
      },
    ]);
    expect(buildResumeLatestCommand("pi")).toBe("pi --continue");
  });

  it("keeps a plugin's default option and its value together on a resume-latest (#13847)", () => {
    registerPluginAgents("me.extra-agents", [
      {
        ...plugin,
        id: "pi",
        command: "pi",
        args: ["--profile", "latest"],
        resume: { kind: "project-scoped", args: ["--resume", "latest"] },
      },
    ]);
    // The fallback's own `latest` must not stand in for the profile's value.
    expect(buildResumeLatestCommand("pi")).toBe("pi --profile 'latest' --resume latest");
    expect(buildResumeLatestCommand("pi", ["--profile", "latest", "--fast"])).toBe(
      "pi --profile 'latest' --fast --resume latest"
    );
  });
});

describe("plugin-declared permission bypass (#16374)", () => {
  forcePosixPlatform();
  afterEach(() => clearPluginAgentRegistryForTests());

  const plugin = {
    name: "Plugin",
    color: "#3366ff",
    iconId: "terminal",
  };

  function registerHermes(permissionBypassArgs?: string[]) {
    registerPluginAgents("me.extra-agents", [
      {
        ...plugin,
        id: "hermes",
        command: "hermes",
        args: ["--tui"],
        ...(permissionBypassArgs ? { permissionBypassArgs } : {}),
      },
    ]);
  }

  it("makes a declaring plugin agent eligible for the global switch", () => {
    registerHermes(["--yes-to-all"]);
    expect(isAgentTerminalBypassSupported("hermes")).toBe(true);
    expect(getDefaultDangerousArgs("hermes")).toBe("--yes-to-all");
  });

  it("launches with the declared args only when the global switch is on", () => {
    registerHermes(["--yes-to-all"]);
    expect(generateAgentCommand("hermes", {}, "hermes", { globalSkipPermissions: true })).toBe(
      "hermes --tui --yes-to-all"
    );
    expect(generateAgentCommand("hermes", {}, "hermes", { globalSkipPermissions: false })).toBe(
      "hermes --tui"
    );
    expect(generateAgentCommand("hermes", {}, "hermes")).toBe("hermes --tui");
  });

  it("lets an agent or preset 'off' veto the global switch", () => {
    registerHermes(["--yes-to-all"]);
    expect(
      generateAgentFlags({ dangerousMode: "off" }, "hermes", { globalSkipPermissions: true })
    ).toEqual([]);
    const presetVeto = combineDangerousModes("on", "off");
    expect(
      generateAgentFlags({ dangerousMode: presetVeto }, "hermes", { globalSkipPermissions: true })
    ).toEqual([]);
  });

  it("adds the declared args for an agent setting of 'on' with the global switch off", () => {
    registerHermes(["--yes-to-all"]);
    expect(
      generateAgentFlags({ dangerousMode: "on" }, "hermes", { globalSkipPermissions: false })
    ).toEqual(["--yes-to-all"]);
  });

  it("keeps a declared option and its value together", () => {
    registerHermes(["--approval", "never"]);
    expect(generateAgentFlags({}, "hermes", { globalSkipPermissions: true })).toEqual([
      "--approval",
      "never",
    ]);
    expect(reconcileBypassFlags(["--approval", "never", "--fast"], "hermes", false)).toEqual([
      "--fast",
    ]);
  });

  it("leaves a plugin agent that declares nothing ineligible and its flags untouched", () => {
    registerHermes();
    expect(isAgentTerminalBypassSupported("hermes")).toBe(false);
    expect(getDefaultDangerousArgs("hermes")).toBe("");
    expect(generateAgentFlags({}, "hermes", { globalSkipPermissions: true })).toEqual([]);
    expect(reconcileBypassFlags(["--yes-to-all"], "hermes", true)).toEqual(["--yes-to-all"]);
  });

  it("strips a recorded declaration while the plugin's own is missing, and never adds it", () => {
    // Cold restore runs before the plugin catalog loads, so the registry is empty.
    const recorded = [["--yolo"], ["--approval", "never"]];
    expect(
      reconcileBypassFlags(
        ["--tui", "--yolo", "--approval", "never"],
        "hermes",
        false,
        undefined,
        recorded
      )
    ).toEqual(["--tui"]);
    expect(reconcileBypassFlags(["--tui"], "hermes", true, undefined, recorded)).toEqual(["--tui"]);
    expect(
      reconcileBypassFlags(["--approval", "ask"], "hermes", false, undefined, recorded)
    ).toEqual(["--approval", "ask"]);
  });

  it("replaces a recorded older declaration with the current one when bypass is on", () => {
    registerHermes(["--trust-all"]);
    expect(
      reconcileBypassFlags(["--yolo", "--fast"], "hermes", true, undefined, [["--yolo"]])
    ).toEqual(["--trust-all", "--fast"]);
  });

  it("reads the recorded history defensively", () => {
    const settings = {
      pluginBypassArgHistory: {
        hermes: [["--yolo"], [], ["--ok", 7], "--bad", ["--approval", "never"]],
        broken: "nope",
      },
    };
    expect(getPluginBypassArgHistory(settings, "hermes")).toEqual([
      ["--yolo"],
      ["--approval", "never"],
    ]);
    expect(getPluginBypassArgHistory(settings, "broken")).toEqual([]);
    expect(getPluginBypassArgHistory(settings, "toString")).toEqual([]);
    expect(getPluginBypassArgHistory(settings, "missing")).toEqual([]);
    expect(getPluginBypassArgHistory({ pluginBypassArgHistory: null }, "hermes")).toEqual([]);
    const inherited = Object.create({ hermes: [["--yolo"]] }) as Record<string, string[][]>;
    expect(getPluginBypassArgHistory({ pluginBypassArgHistory: inherited }, "hermes")).toEqual([]);
    expect(getPluginBypassArgHistory(undefined, "hermes")).toEqual([]);
  });

  it("reconciles a resumed launch's flags against the declared args", () => {
    registerHermes(["--yes-to-all"]);
    expect(reconcileBypassFlags(["--yes-to-all", "--fast"], "hermes", false)).toEqual(["--fast"]);
    expect(reconcileBypassFlags(["--fast"], "hermes", true)).toEqual(["--fast", "--yes-to-all"]);
    // A custom bypass the user wrote still strips the plugin's own flag.
    expect(
      reconcileBypassFlags(["--yes-to-all", "--fast"], "hermes", true, "--trust-everything")
    ).toEqual(["--trust-everything", "--fast"]);
  });
});

describe("stripConversationSelectorFlags (#13746)", () => {
  it("drops Claude's resume, assign and continue selectors and keeps everything else", () => {
    expect(
      stripConversationSelectorFlags(
        ["--model", "opus", "--continue", "--resume", "abc", "--session-id", "def", "--verbose"],
        "claude"
      )
    ).toEqual(["--model", "opus", "--verbose"]);
  });

  it("drops Codex's two-word resume-latest", () => {
    expect(stripConversationSelectorFlags(["resume", "--last", "--full-auto"], "codex")).toEqual([
      "--full-auto",
    ]);
  });

  it("leaves an agent without a session-id resume untouched", () => {
    expect(stripConversationSelectorFlags(["--continue"], "no-such-agent")).toEqual(["--continue"]);
  });

  it("ignores a resume of nothing but the id, which would match every word (#16470)", () => {
    registerPluginAgents("me.extra-agents", [
      {
        id: "bare",
        name: "Bare",
        command: "bare",
        color: "#3366ff",
        iconId: "terminal",
        resume: { kind: "session-id", args: ["{sessionId}"], resumeLatestArgs: ["--continue"] },
      },
    ]);
    try {
      expect(stripConversationSelectorFlags(["--model", "x", "--continue"], "bare")).toEqual([
        "--model",
        "x",
      ]);
    } finally {
      clearPluginAgentRegistryForTests();
    }
  });
});

describe("a plugin agent's assigned session id (#16470)", () => {
  const SESSION = "11111111-1111-4111-8111-111111111111";
  const pi = (resume: NonNullable<AgentConfig["resumeTemplate"]>) =>
    registerPluginAgents("digitalfrontier.agents", [
      {
        id: "pi",
        name: "Pi",
        command: "pi",
        args: ["--no-banner"],
        color: "#3366ff",
        iconId: "terminal",
        resume,
      },
    ]);
  const SAME_FLAG: NonNullable<AgentConfig["resumeTemplate"]> = {
    kind: "session-id",
    args: ["--session-id", "{sessionId}"],
    assignSessionIdArgs: ["--session-id", "{sessionId}"],
    resumeLatestArgs: ["--continue"],
  };
  const OWN_RESUME_FLAG: NonNullable<AgentConfig["resumeTemplate"]> = {
    kind: "session-id",
    args: ["--session", "{sessionId}"],
    assignSessionIdArgs: ["--session-id", "{sessionId}"],
    quitCommand: "/quit",
    resumeLatestArgs: ["--continue"],
  };

  afterEach(() => {
    clearPluginAgentRegistryForTests();
    setAgentCommandDialectResolver(null);
  });

  it("assigns through the same lifecycle a built-in uses", () => {
    pi(OWN_RESUME_FLAG);

    expect(supportsSessionIdAssignment("pi")).toBe(true);
    expect(supportsExactSessionCapture("pi")).toBe(true);
    const first = mintAssignedSessionId("pi");
    const second = mintAssignedSessionId("pi");
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    expect(first).not.toBe(second);
    expect(buildAssignedSessionIdArgs("pi", SESSION)).toEqual(["--session-id", SESSION]);
    expect(buildResumeCommand("pi", SESSION)).toBe(`pi --session ${SESSION}`);
  });

  it("leaves a plugin agent that declares no assignment as it was", () => {
    pi({ kind: "session-id", args: ["--session", "{sessionId}"], quitCommand: "/quit" });

    expect(supportsSessionIdAssignment("pi")).toBe(false);
    expect(mintAssignedSessionId("pi")).toBeUndefined();
    expect(generateAgentCommand("pi", {}, "pi", { sessionId: SESSION })).toBe("pi --no-banner");
  });

  it.each([
    ["a separate id", ["--session-id", "{sessionId}"]],
    ["a fused id", ["--session-id={sessionId}"]],
    ["two options before the id", ["--new", "--id", "{sessionId}"]],
  ])("strips %s back off the command a launch built, on every shell", (_label, assignArgs) => {
    pi({ kind: "session-id", args: ["--session", "{sessionId}"], assignSessionIdArgs: assignArgs });
    for (const dialect of ["posix", "windows"] as const) {
      setAgentCommandDialectResolver(() => dialect);
      const command = generateAgentCommand("pi", {}, "pi", {
        sessionId: SESSION,
        initialPrompt: "fix the bug",
      });
      expect(command).toContain(SESSION);
      const stripped = stripAssignedSessionIdArgs(command, "pi");
      expect(stripped).not.toContain(SESSION);
      expect(stripped).toMatch(/^pi --no-banner /);
      expect(stripped).toContain("fix the bug");
    }
  });

  it("tells a flag that also resumes from one with its own resume flag", () => {
    pi(SAME_FLAG);
    expect(assignmentReopensSession("pi")).toBe(true);

    pi(OWN_RESUME_FLAG);
    expect(assignmentReopensSession("pi")).toBe(false);

    expect(assignmentReopensSession("claude")).toBe(false);
    expect(assignmentReopensSession("no-such-agent")).toBe(false);
    expect(assignmentReopensSession(undefined)).toBe(false);
  });

  describe("commandNamesSession", () => {
    it.each([
      ["a word of its own", `pi --session ${SESSION}`],
      ["a quoted word", `pi --session '${SESSION}'`],
      ["a fused option", `pi --session=${SESSION}`],
      ["a quoted fused option", `pi '--session=${SESSION}'`],
      ["a bare positional", `pi ${SESSION}`],
      ["a prefix with no equals sign", `pi 'session:${SESSION}'`],
      ["a suffix after the id", `pi --session=${SESSION}.json`],
    ])("finds %s", (_label, command) => {
      expect(commandNamesSession(command, SESSION)).toBe(true);
    });

    it("doesn't find a short id inside a longer word, or in the binary", () => {
      expect(commandNamesSession("pi --no-banner", "a")).toBe(false);
      expect(commandNamesSession("a --no-banner", "a")).toBe(false);
    });

    it("doesn't take a prompt that mentions the id for a selector", () => {
      expect(commandNamesSession(`pi 'look at ${SESSION} please'`, SESSION)).toBe(false);
    });

    it("finds nothing with no id", () => {
      expect(commandNamesSession("pi --session=undefined", undefined)).toBe(false);
      expect(commandNamesSession("pi ''", "")).toBe(false);
    });
  });

  describe("stripConversationSelectorArgs", () => {
    it.each([
      ["an assignment", `pi --no-banner --session-id '${SESSION}'`],
      ["a resume by id", `pi --no-banner --session '${SESSION}'`],
      ["a resume of the latest", "pi --no-banner --continue"],
    ])("takes %s off a stored command", (_label, command) => {
      pi(OWN_RESUME_FLAG);
      expect(stripConversationSelectorArgs(command, "pi")).toBe("pi --no-banner");
    });

    it("leaves a prompt that only mentions a selector", () => {
      pi(OWN_RESUME_FLAG);
      const command = "pi --no-banner '--continue'";
      expect(stripConversationSelectorArgs(command, "pi")).toBe(command);
    });

    it("never takes the binary, even when a selector starts with its name", () => {
      pi({
        kind: "session-id",
        args: ["--session", "{sessionId}"],
        resumeLatestArgs: ["pi", "last"],
      });
      const command = "pi last --no-banner";
      expect(stripConversationSelectorArgs(command, "pi")).toBe(command);
    });

    it("returns a command with nothing to strip untouched, spacing and all", () => {
      pi(OWN_RESUME_FLAG);
      const command = "pi  --no-banner";
      expect(stripConversationSelectorArgs(command, "pi")).toBe(command);
      expect(stripConversationSelectorArgs("", "pi")).toBe("");
    });
  });
});
