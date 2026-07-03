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
