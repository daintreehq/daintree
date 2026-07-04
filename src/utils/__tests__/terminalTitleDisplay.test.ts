import { describe, it, expect } from "vitest";
import { getTerminalDisplayTitle, getTerminalTaskTitle } from "../terminalTitleDisplay";
import type { TerminalInstance } from "@shared/types/panel";

function ptyPanel(overrides: Partial<TerminalInstance> = {}): TerminalInstance {
  return {
    id: "t1",
    kind: "terminal",
    title: "Claude",
    cwd: "/tmp",
    cols: 80,
    rows: 24,
    location: "grid",
    detectedAgentId: "claude",
    agentState: "working",
    lastObservedTitle: "✳ fix auth tests",
    ...overrides,
  };
}

describe("getTerminalTaskTitle", () => {
  it("returns the cleaned task for a live agent", () => {
    expect(getTerminalTaskTitle(ptyPanel())).toBe("fix auth tests");
  });

  it("returns null when no agent is detected (stale task must not survive into plain-shell display)", () => {
    expect(getTerminalTaskTitle(ptyPanel({ detectedAgentId: undefined }))).toBeNull();
  });

  it("returns null when the agent has exited", () => {
    expect(getTerminalTaskTitle(ptyPanel({ agentState: "exited" }))).toBeNull();
  });

  it("returns null under a user lock", () => {
    expect(getTerminalTaskTitle(ptyPanel({ titleMode: "user" }))).toBeNull();
  });

  it("still composes under a custom (preset/automation) title", () => {
    expect(getTerminalTaskTitle(ptyPanel({ titleMode: "custom" }))).toBe("fix auth tests");
  });

  it("filters useless titles (agent binary echoes, paths)", () => {
    expect(getTerminalTaskTitle(ptyPanel({ lastObservedTitle: "claude" }))).toBeNull();
    expect(getTerminalTaskTitle(ptyPanel({ lastObservedTitle: "/Users/me/proj" }))).toBeNull();
  });

  it("returns null when the task merely echoes the identity title", () => {
    expect(getTerminalTaskTitle(ptyPanel({ lastObservedTitle: "Claude" }))).toBeNull();
  });

  it("returns null for product-name identity echoes (agent name + generic filler)", () => {
    expect(getTerminalTaskTitle(ptyPanel({ lastObservedTitle: "Claude Code" }))).toBeNull();
    expect(getTerminalTaskTitle(ptyPanel({ lastObservedTitle: "✳ Claude Code" }))).toBeNull();
    expect(
      getTerminalTaskTitle(
        ptyPanel({ detectedAgentId: "gemini", title: "Gemini", lastObservedTitle: "Gemini CLI" })
      )
    ).toBeNull();
  });

  it("recognizes the echo against the registry identity even under a preset title", () => {
    expect(
      getTerminalTaskTitle(ptyPanel({ title: "Claude [Z.ai]", lastObservedTitle: "Claude Code" }))
    ).toBeNull();
  });

  it("a real task containing the agent name still counts as a task", () => {
    expect(getTerminalTaskTitle(ptyPanel({ lastObservedTitle: "Claude Code refactor plan" }))).toBe(
      "Claude Code refactor plan"
    );
  });

  it("returns null for pure filler titles with no identity token (idle-status words)", () => {
    expect(getTerminalTaskTitle(ptyPanel({ lastObservedTitle: "Ready" }))).toBeNull();
    expect(getTerminalTaskTitle(ptyPanel({ lastObservedTitle: "Terminal" }))).toBeNull();
  });

  it("filler words inherited into the identity ('Qwen Code') don't make pure filler an echo", () => {
    const qwen = ptyPanel({ detectedAgentId: "qwen", title: "Qwen Code" });
    expect(getTerminalTaskTitle({ ...qwen, lastObservedTitle: "Code CLI" })).toBeNull();
    expect(getTerminalDisplayTitle({ ...qwen, lastObservedTitle: "Code CLI" }, "full")).toBe(
      "Qwen Code"
    );
  });

  it("workspace echo: a title that is just the cwd folder name is not a task (Codex idle)", () => {
    const codex = ptyPanel({
      detectedAgentId: "codex",
      title: "Codex",
      cwd: "/Users/gpriday/Projects/Daintree/daintree",
      lastObservedTitle: "⣿ daintree",
    });
    expect(getTerminalTaskTitle(codex)).toBeNull();
    expect(getTerminalDisplayTitle(codex, "full")).toBe("Codex");
  });

  it("strips identity suffixes from real tasks (Grok's ' - grok')", () => {
    const grok = ptyPanel({
      detectedAgentId: "grok",
      title: "Grok",
      lastObservedTitle: "User Greets AI and Queries Project Details - grok",
    });
    expect(getTerminalDisplayTitle(grok, "full")).toBe(
      "Grok: User Greets AI and Queries Project Details"
    );
  });

  it("keeps useful status remainders after affix stripping (Grok busy)", () => {
    const busy = ptyPanel({
      detectedAgentId: "grok",
      title: "Grok",
      lastObservedTitle: "⣿ - Responding - grok",
    });
    expect(getTerminalDisplayTitle(busy, "full")).toBe("Grok: Responding");
  });

  it("strips abbreviation prefixes derived from the agent name (OpenCode's 'OC | ')", () => {
    const opencode = ptyPanel({
      detectedAgentId: "opencode",
      title: "OpenCode",
      lastObservedTitle: "OC | Greeting and project overview",
    });
    expect(getTerminalDisplayTitle(opencode, "full")).toBe(
      "OpenCode: Greeting and project overview"
    );
    expect(getTerminalTaskTitle({ ...opencode, lastObservedTitle: "OC" })).toBeNull();
  });

  it("affix stripping requires a whole identity label — filler and partial-name segments survive", () => {
    expect(
      getTerminalTaskTitle(ptyPanel({ lastObservedTitle: "Terminal: preserve OSC title" }))
    ).toBe("Terminal: preserve OSC title");
    const interpreter = ptyPanel({
      detectedAgentId: "interpreter",
      title: "Open Interpreter",
      lastObservedTitle: "Open: file picker",
    });
    expect(getTerminalTaskTitle(interpreter)).toBe("Open: file picker");
  });

  it("strips stacked affixes (abbreviation prefix plus name suffix)", () => {
    const opencode = ptyPanel({
      detectedAgentId: "opencode",
      title: "OpenCode",
      lastObservedTitle: "OC | fix panel resize - opencode",
    });
    expect(getTerminalTaskTitle(opencode)).toBe("fix panel resize");
  });

  it("cursor-agent's 'Cursor Agent' startup title replaces the default identity", () => {
    const cursor = ptyPanel({
      detectedAgentId: "cursor",
      title: "Cursor",
      lastObservedTitle: "Cursor Agent",
    });
    expect(getTerminalDisplayTitle(cursor, "full")).toBe("Cursor Agent");
    expect(
      getTerminalDisplayTitle({ ...cursor, lastObservedTitle: "Project Explainer" }, "full")
    ).toBe("Cursor: Project Explainer");
  });

  it("returns null when no task was ever observed", () => {
    expect(getTerminalTaskTitle(ptyPanel({ lastObservedTitle: undefined }))).toBeNull();
  });
});

describe("getTerminalDisplayTitle", () => {
  it("full: composes identity and task", () => {
    expect(getTerminalDisplayTitle(ptyPanel(), "full")).toBe("Claude: fix auth tests");
  });

  it("full: preset identity keeps its brand prefix", () => {
    expect(getTerminalDisplayTitle(ptyPanel({ title: "Claude [Z.ai]" }), "full")).toBe(
      "Claude [Z.ai]: fix auth tests"
    );
  });

  it("compact: task-first (the icon carries identity in narrow tabs)", () => {
    expect(getTerminalDisplayTitle(ptyPanel(), "compact")).toBe("fix auth tests");
  });

  it("compact: falls back to identity when no task", () => {
    expect(getTerminalDisplayTitle(ptyPanel({ lastObservedTitle: undefined }), "compact")).toBe(
      "Claude"
    );
  });

  it("identity echo replaces a default identity instead of composing", () => {
    const idle = ptyPanel({ lastObservedTitle: "✳ Claude Code" });
    expect(getTerminalDisplayTitle(idle, "full")).toBe("Claude Code");
    expect(getTerminalDisplayTitle(idle, "compact")).toBe("Claude Code");
    expect(getTerminalDisplayTitle(idle, "base")).toBe("Claude");
  });

  it("identity echo yields to a custom preset identity", () => {
    const idle = ptyPanel({
      title: "Claude [Z.ai]",
      titleMode: "custom",
      lastObservedTitle: "Claude Code",
    });
    expect(getTerminalDisplayTitle(idle, "full")).toBe("Claude [Z.ai]");
    expect(getTerminalDisplayTitle(idle, "compact")).toBe("Claude [Z.ai]");
  });

  it("base: identity only, even with a live task", () => {
    expect(getTerminalDisplayTitle(ptyPanel(), "base")).toBe("Claude");
  });

  it("user lock renders exactly the locked title in every variant", () => {
    const locked = ptyPanel({ title: "My debug shell", titleMode: "user" });
    expect(getTerminalDisplayTitle(locked, "full")).toBe("My debug shell");
    expect(getTerminalDisplayTitle(locked, "compact")).toBe("My debug shell");
    expect(getTerminalDisplayTitle(locked, "base")).toBe("My debug shell");
  });

  it("showTask: false disables composition", () => {
    expect(getTerminalDisplayTitle(ptyPanel(), "full", { showTask: false })).toBe("Claude");
    expect(getTerminalDisplayTitle(ptyPanel(), "compact", { showTask: false })).toBe("Claude");
  });

  it("non-pty panels always render their stored title", () => {
    const browser: TerminalInstance = {
      id: "b1",
      kind: "browser",
      title: "Browser",
      location: "grid",
    };
    expect(getTerminalDisplayTitle(browser, "full")).toBe("Browser");
  });
});
