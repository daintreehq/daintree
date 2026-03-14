// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

type TitleStatePatterns = {
  working: string[];
  waiting: string[];
};

const GEMINI_PATTERNS: TitleStatePatterns = {
  working: ["\u2726"],
  waiting: ["\u25C7", "\u270B"],
};

const TITLE_DEBOUNCE_MS = 250;

interface ManagedState {
  titleReportTimer?: number;
  pendingTitleState?: "working" | "waiting";
}

function createTitleHandler(
  patterns: TitleStatePatterns,
  managed: ManagedState,
  reportFn: (state: "working" | "waiting") => void
) {
  let lastReportedTitleState: "working" | "waiting" | undefined;

  return (title: string) => {
    let matched: "working" | "waiting" | undefined;
    for (const pattern of patterns.working) {
      if (title.includes(pattern)) {
        matched = "working";
        break;
      }
    }
    if (!matched) {
      for (const pattern of patterns.waiting) {
        if (title.includes(pattern)) {
          matched = "waiting";
          break;
        }
      }
    }
    if (!matched) {
      if (managed.titleReportTimer !== undefined) {
        clearTimeout(managed.titleReportTimer);
        managed.titleReportTimer = undefined;
        managed.pendingTitleState = undefined;
      }
      return;
    }

    if (matched === "working") {
      if (managed.titleReportTimer !== undefined) {
        clearTimeout(managed.titleReportTimer);
        managed.titleReportTimer = undefined;
        managed.pendingTitleState = undefined;
      }
      if (lastReportedTitleState !== "working") {
        lastReportedTitleState = "working";
        reportFn("working");
      }
    } else {
      managed.pendingTitleState = "waiting";
      if (managed.titleReportTimer !== undefined) {
        clearTimeout(managed.titleReportTimer);
      }
      managed.titleReportTimer = window.setTimeout(() => {
        managed.titleReportTimer = undefined;
        if (managed.pendingTitleState === "waiting") {
          managed.pendingTitleState = undefined;
          if (lastReportedTitleState !== "waiting") {
            lastReportedTitleState = "waiting";
            reportFn("waiting");
          }
        }
      }, TITLE_DEBOUNCE_MS);
    }
  };
}

describe("title state hysteresis (#3217)", () => {
  let managed: ManagedState;
  let reportFn: ReturnType<typeof vi.fn>;
  let handler: (title: string) => void;

  beforeEach(() => {
    vi.useFakeTimers();
    managed = {};
    reportFn = vi.fn<(state: "working" | "waiting") => void>();
    handler = createTitleHandler(GEMINI_PATTERNS, managed, reportFn);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reports working immediately", () => {
    handler("✦ Thinking...");
    expect(reportFn).toHaveBeenCalledWith("working");
    expect(reportFn).toHaveBeenCalledTimes(1);
  });

  it("debounces waiting by 250ms", () => {
    handler("◇ Ready");
    expect(reportFn).not.toHaveBeenCalled();

    vi.advanceTimersByTime(249);
    expect(reportFn).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(reportFn).toHaveBeenCalledWith("waiting");
    expect(reportFn).toHaveBeenCalledTimes(1);
  });

  it("cancels pending waiting when working arrives", () => {
    handler("◇ Ready");
    expect(reportFn).not.toHaveBeenCalled();

    handler("✦ Thinking...");
    expect(reportFn).toHaveBeenCalledWith("working");
    expect(reportFn).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(300);
    expect(reportFn).toHaveBeenCalledTimes(1);
  });

  it("deduplicates consecutive working reports", () => {
    handler("✦ Thinking...");
    handler("✦ Still thinking...");
    handler("✦ Almost done...");
    expect(reportFn).toHaveBeenCalledTimes(1);
    expect(reportFn).toHaveBeenCalledWith("working");
  });

  it("deduplicates consecutive waiting reports", () => {
    handler("◇ Ready");
    vi.advanceTimersByTime(250);
    expect(reportFn).toHaveBeenCalledTimes(1);

    handler("✋ Action required");
    vi.advanceTimersByTime(250);
    expect(reportFn).toHaveBeenCalledTimes(1);
  });

  it("handles rapid spinner alternation without flooding", () => {
    for (let i = 0; i < 30; i++) {
      handler(i % 2 === 0 ? "✦ Frame" : "◇ Frame");
    }
    expect(reportFn).toHaveBeenCalledTimes(1);
    expect(reportFn).toHaveBeenCalledWith("working");

    vi.advanceTimersByTime(300);
    expect(reportFn).toHaveBeenCalledTimes(1);
  });

  it("reports waiting after working when stable", () => {
    handler("✦ Thinking...");
    expect(reportFn).toHaveBeenCalledWith("working");

    handler("◇ Ready");
    vi.advanceTimersByTime(250);
    expect(reportFn).toHaveBeenCalledWith("waiting");
    expect(reportFn).toHaveBeenCalledTimes(2);
  });

  it("clears timer on unmatched title", () => {
    handler("◇ Ready");
    expect(managed.titleReportTimer).toBeDefined();

    handler("bash - /home/user");
    expect(managed.titleReportTimer).toBeUndefined();
    expect(managed.pendingTitleState).toBeUndefined();

    vi.advanceTimersByTime(300);
    expect(reportFn).not.toHaveBeenCalled();
  });

  it("cleans up timer state properly", () => {
    handler("◇ Ready");
    expect(managed.titleReportTimer).toBeDefined();

    if (managed.titleReportTimer !== undefined) {
      clearTimeout(managed.titleReportTimer);
      managed.titleReportTimer = undefined;
      managed.pendingTitleState = undefined;
    }

    vi.advanceTimersByTime(300);
    expect(reportFn).not.toHaveBeenCalled();
  });
});
