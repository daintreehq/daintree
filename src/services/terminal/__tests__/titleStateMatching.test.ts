import { describe, it, expect, vi } from "vitest";

/**
 * Unit tests for terminal title state pattern matching logic.
 * Tests the matching algorithm used in TerminalInstanceService.onTitleChange.
 */

type TitleStatePatterns = {
  working: string[];
  waiting: string[];
};

function matchTitleState(
  title: string,
  patterns: TitleStatePatterns,
  reportFn: (state: "working" | "waiting") => void
) {
  for (const pattern of patterns.working) {
    if (title.includes(pattern)) {
      reportFn("working");
      return;
    }
  }
  for (const pattern of patterns.waiting) {
    if (title.includes(pattern)) {
      reportFn("waiting");
      return;
    }
  }
}

const GEMINI_PATTERNS: TitleStatePatterns = {
  working: ["\u2726"],
  waiting: ["\u25C7", "\u270B"],
};

describe("title state pattern matching", () => {
  it("matches working icon ✦ and reports working", () => {
    const report = vi.fn();
    matchTitleState("✦ Gemini is thinking...", GEMINI_PATTERNS, report);
    expect(report).toHaveBeenCalledWith("working");
  });

  it("matches waiting icon ◇ and reports waiting", () => {
    const report = vi.fn();
    matchTitleState("◇ Ready", GEMINI_PATTERNS, report);
    expect(report).toHaveBeenCalledWith("waiting");
  });

  it("matches action-required icon ✋ and reports waiting", () => {
    const report = vi.fn();
    matchTitleState("✋ Action required", GEMINI_PATTERNS, report);
    expect(report).toHaveBeenCalledWith("waiting");
  });

  it("does not report for unrelated title changes", () => {
    const report = vi.fn();
    matchTitleState("bash - /home/user/project", GEMINI_PATTERNS, report);
    expect(report).not.toHaveBeenCalled();
  });

  it("working takes priority when both icons are present", () => {
    const report = vi.fn();
    matchTitleState("✦ ◇ mixed title", GEMINI_PATTERNS, report);
    expect(report).toHaveBeenCalledWith("working");
    expect(report).toHaveBeenCalledTimes(1);
  });

  it("handles empty title without reporting", () => {
    const report = vi.fn();
    matchTitleState("", GEMINI_PATTERNS, report);
    expect(report).not.toHaveBeenCalled();
  });

  it("handles title with icon as only content", () => {
    const report = vi.fn();
    matchTitleState("\u2726", GEMINI_PATTERNS, report);
    expect(report).toHaveBeenCalledWith("working");
  });

  it("agents without titleStatePatterns do not run matching", () => {
    const report = vi.fn();
    // Simulating the guard: if titlePatterns is undefined, skip
    const patterns: TitleStatePatterns | undefined = undefined;
    if (patterns) {
      matchTitleState("✦ working", patterns, report);
    }
    expect(report).not.toHaveBeenCalled();
  });
});
