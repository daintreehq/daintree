import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ActivityMonitor } from "../ActivityMonitor.js";
import {
  WAITING_REASON_CHECKLIST_ROWS,
  WAITING_REASON_SCAN_LINE_COUNT,
} from "../pty/WaitingReasonClassifier.js";

const RULE = "─".repeat(60);
const INPUT_ROW = "❯ ";
const FOOTER = "  ⏵⏵ accept edits on (shift+tab to cycle)";
const BANNER = "  ⎿  You've hit your weekly limit · resets Oct 2 at 9pm (Europe/Lisbon)";

// Claude Code 2.x after a plan limit: the banner in the transcript, the input
// row between its rules, and the auto-continue notice in the footer.
const LIMIT_SCREEN = [
  "● Refactoring the parser.",
  BANNER,
  "     /upgrade to increase your usage limit.",
  "",
  RULE,
  INPUT_ROW,
  RULE,
  "  Usage limit reached · continuing automatically at 10am · esc to cancel",
];

// The same pane once Escape cancels the auto-continue: the banner still sits
// in the transcript just above the input row.
const CANCELLED_SCREEN = [
  "● Refactoring the parser.",
  BANNER,
  "     /upgrade to increase your usage limit.",
  "",
  "  ⎿  Automatic continue cancelled · /rate-limit-options to re-arm",
  "",
  RULE,
  INPUT_ROW,
  RULE,
  FOOTER,
];

// A screen at the prompt with no blocking banner left in its tail.
const PROMPT_SCREEN = ["● Refactoring the parser.", "", RULE, INPUT_ROW, RULE, FOOTER];

const REASON_READ_ROWS = WAITING_REASON_SCAN_LINE_COUNT + WAITING_REASON_CHECKLIST_ROWS;

const monitors: ActivityMonitor[] = [];

function startClaude(id: string, initial: string[], options: { restored?: boolean } = {}) {
  const onStateChange = vi.fn();
  let visible = initial;
  let reasonReads = 0;
  const monitor = new ActivityMonitor(id, 1000, onStateChange, {
    agentId: "claude",
    getVisibleLines: (n) => {
      if (n === REASON_READ_ROWS) reasonReads++;
      return visible.slice(-n);
    },
    getCursorLine: () => visible.find((line) => line.startsWith("❯")) ?? visible.at(-1) ?? null,
    initialState: "idle",
    skipInitialStateEmit: true,
  });
  monitors.push(monitor);
  monitor.startPolling();
  if (!options.restored) {
    for (let i = 1; i <= 4; i++) {
      vi.advanceTimersByTime(650);
      visible = [`tick ${i}`];
      vi.advanceTimersByTime(50);
    }
    expect(monitor.getState()).toBe("busy");
  }
  return {
    monitor,
    onStateChange,
    show: (lines: string[]) => {
      visible = lines;
    },
    reasonReads: () => reasonReads,
  };
}

function settleOn(id: string, screen: string[], reason: string) {
  const pane = startClaude(id, ["waiting 0"]);
  pane.show(screen);
  vi.advanceTimersByTime(8200);
  expect(pane.monitor.getState()).toBe("idle");
  expect(pane.onStateChange).toHaveBeenLastCalledWith(
    id,
    1000,
    "idle",
    expect.objectContaining({ waitingReason: reason })
  );
  pane.onStateChange.mockClear();
  return pane;
}

function reasonUpdates(onStateChange: ReturnType<typeof vi.fn>) {
  return onStateChange.mock.calls
    .filter((call) => call[3]?.rereadAt !== undefined)
    .map((call) => call[3].waitingReason);
}

describe("ActivityMonitor waiting-reason re-read (#16093)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    for (const monitor of monitors.splice(0)) monitor.dispose();
    vi.useRealTimers();
    vi.clearAllTimers();
    vi.restoreAllMocks();
  });

  it("re-reads an idle agent's reason once its screen changes and settles", () => {
    const { monitor, onStateChange, show } = settleOn("reread", LIMIT_SCREEN, "error");

    // Escape is held back as a possible sequence start, so only the redraw
    // reaches the monitor.
    monitor.onInput("\x1b");
    monitor.onData("\x1b[2J redraw");
    show(PROMPT_SCREEN);
    vi.advanceTimersByTime(5000);

    expect(monitor.getState()).toBe("idle");
    expect(onStateChange).toHaveBeenCalledTimes(1);
    expect(onStateChange).toHaveBeenCalledWith("reread", 1000, "idle", {
      trigger: "pattern",
      waitingReason: "prompt",
      rereadAt: expect.any(Number),
    });
  });

  it("keeps the error after Escape while the limit banner is still in view", () => {
    const { monitor, onStateChange, show, reasonReads } = settleOn(
      "reread-cancelled",
      LIMIT_SCREEN,
      "error"
    );
    const readsBefore = reasonReads();

    monitor.onInput("\x1b");
    monitor.onData("\x1b[2K  ⎿  Automatic continue cancelled · /rate-limit-options to re-arm");
    show(CANCELLED_SCREEN);
    vi.advanceTimersByTime(5000);

    expect(reasonReads()).toBe(readsBefore + 1);
    expect(onStateChange).not.toHaveBeenCalled();
  });

  it("reads a limit that lands while the agent stays idle", () => {
    const { monitor, onStateChange, show } = settleOn("reread-limit", PROMPT_SCREEN, "prompt");

    monitor.onData("banner");
    show(LIMIT_SCREEN);
    vi.advanceTimersByTime(5000);

    expect(reasonUpdates(onStateChange)).toEqual(["error"]);
  });

  it("reads the screen once per settled change, and never on time alone", () => {
    const { monitor, onStateChange, show, reasonReads } = settleOn(
      "reread-once",
      LIMIT_SCREEN,
      "error"
    );
    const readsBefore = reasonReads();

    vi.advanceTimersByTime(60_000);
    expect(reasonReads()).toBe(readsBefore);
    expect(onStateChange).not.toHaveBeenCalled();

    monitor.onData("redraw");
    show(PROMPT_SCREEN);
    vi.advanceTimersByTime(5000);
    expect(reasonReads()).toBe(readsBefore + 1);
    expect(reasonUpdates(onStateChange)).toEqual(["prompt"]);

    // A later redraw is read again, but the same reason sends nothing more.
    monitor.onData("redraw again");
    vi.advanceTimersByTime(5000);
    expect(reasonReads()).toBe(readsBefore + 2);
    expect(onStateChange).toHaveBeenCalledTimes(1);
  });

  it("times the settle from the screen's last change", () => {
    const { monitor, onStateChange, show } = settleOn("reread-settle", LIMIT_SCREEN, "error");

    monitor.onData("redraw");
    show(PROMPT_SCREEN);
    vi.advanceTimersByTime(900);
    monitor.onData("more redraw");
    vi.advanceTimersByTime(600);
    expect(onStateChange).not.toHaveBeenCalled();

    vi.advanceTimersByTime(500);
    expect(reasonUpdates(onStateChange)).toEqual(["prompt"]);
  });

  it("waits out recent input, then reads without another redraw", () => {
    const { monitor, onStateChange, show } = settleOn("reread-input", LIMIT_SCREEN, "error");

    monitor.onData("redraw");
    show(PROMPT_SCREEN);
    vi.advanceTimersByTime(900);
    monitor.onInput("\x1b");
    vi.advanceTimersByTime(300);
    expect(onStateChange).not.toHaveBeenCalled();

    vi.advanceTimersByTime(800);
    expect(reasonUpdates(onStateChange)).toEqual(["prompt"]);
  });

  it("reads past an empty Enter that never started a turn", () => {
    const { monitor, onStateChange, show } = settleOn("reread-enter", LIMIT_SCREEN, "error");

    monitor.onInput("\r");
    monitor.onData("redraw");
    show(PROMPT_SCREEN);
    vi.advanceTimersByTime(5000);

    expect(monitor.getState()).toBe("idle");
    expect(reasonUpdates(onStateChange)).toEqual(["prompt"]);
  });

  it("changes nothing while the input row holds a draft, and reads it once emptied", () => {
    const { monitor, onStateChange, show } = settleOn("reread-draft", LIMIT_SCREEN, "error");

    monitor.onData("hello");
    show(PROMPT_SCREEN.map((line) => (line === INPUT_ROW ? "❯ hello" : line)));
    vi.advanceTimersByTime(5000);
    expect(onStateChange).not.toHaveBeenCalled();

    monitor.onData("\b\b\b\b\b");
    show(PROMPT_SCREEN);
    vi.advanceTimersByTime(5000);
    expect(reasonUpdates(onStateChange)).toEqual(["prompt"]);
  });

  it("reads a restored idle pane once, then waits for a change", () => {
    const { onStateChange, reasonReads } = startClaude("reread-restored", LIMIT_SCREEN, {
      restored: true,
    });

    vi.advanceTimersByTime(5000);
    expect(reasonUpdates(onStateChange)).toEqual(["error"]);
    const reads = reasonReads();

    vi.advanceTimersByTime(60_000);
    expect(reasonReads()).toBe(reads);
    expect(onStateChange).toHaveBeenCalledTimes(1);
  });

  it("reads a finished turn as a prompt wait under a footer that outlived the limit", () => {
    settleOn(
      "reread-footer",
      [
        "● The parser now handles empty input, and its tests pass.",
        "",
        RULE,
        INPUT_ROW,
        RULE,
        "  Usage limit reached · continuing automatically at 10am · esc to cancel",
      ],
      "prompt"
    );
  });
});
