import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ActivityMonitor } from "../ActivityMonitor.js";

const RULE = "─".repeat(60);

// Claude Code 2.x after a plan limit: the banner in the transcript, the input
// row between its rules, and the auto-continue notice in the footer.
const LIMIT_SCREEN = [
  "● Refactoring the parser.",
  "  ⎿  You've hit your weekly limit · resets Oct 2 at 9pm (Europe/Lisbon)",
  "     /upgrade to increase your usage limit.",
  "",
  RULE,
  "❯ ",
  RULE,
  "  Usage limit reached · continuing automatically at 10am · esc to cancel",
];

// The same pane once Escape cancels the auto-continue.
const CANCELLED_SCREEN = [
  "● Refactoring the parser.",
  "  ⎿  You've hit your weekly limit · resets Oct 2 at 9pm (Europe/Lisbon)",
  "     /upgrade to increase your usage limit.",
  "",
  "  ⎿  Automatic continue cancelled · /rate-limit-options to re-arm",
  "",
  RULE,
  "❯ ",
  RULE,
  "  ⏵⏵ accept edits on (shift+tab to cycle)",
];

function settleOnLimitScreen(id: string) {
  const onStateChange = vi.fn();
  let visible = ["waiting 0"];
  const monitor = new ActivityMonitor(id, 1000, onStateChange, {
    agentId: "claude",
    getVisibleLines: () => visible,
    getCursorLine: () => "❯ ",
    initialState: "idle",
    skipInitialStateEmit: true,
  });
  monitor.startPolling();
  for (let i = 1; i <= 4; i++) {
    vi.advanceTimersByTime(650);
    visible = [`tick ${i}`];
    vi.advanceTimersByTime(50);
  }
  expect(monitor.getState()).toBe("busy");

  visible = LIMIT_SCREEN;
  vi.advanceTimersByTime(8200);
  expect(monitor.getState()).toBe("idle");
  expect(onStateChange).toHaveBeenLastCalledWith(
    id,
    1000,
    "idle",
    expect.objectContaining({ waitingReason: "error" })
  );
  onStateChange.mockClear();
  return {
    monitor,
    onStateChange,
    show: (lines: string[]) => {
      visible = lines;
    },
  };
}

describe("ActivityMonitor waiting-reason re-read (#16093)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllTimers();
    vi.restoreAllMocks();
  });

  it("re-reads the reason once an idle agent's screen changes and settles", () => {
    const { monitor, onStateChange, show } = settleOnLimitScreen("reread-escape");

    // Escape is held back as a possible sequence start, so only the redraw
    // reaches the monitor.
    monitor.onInput("\x1b");
    monitor.onData("\x1b[2K  ⎿  Automatic continue cancelled · /rate-limit-options to re-arm");
    show(CANCELLED_SCREEN);
    vi.advanceTimersByTime(5000);

    expect(monitor.getState()).toBe("idle");
    expect(onStateChange).toHaveBeenCalledWith(
      "reread-escape",
      1000,
      "idle",
      expect.objectContaining({ waitingReason: "prompt" })
    );
    expect(onStateChange).not.toHaveBeenCalledWith(
      "reread-escape",
      1000,
      "busy",
      expect.anything()
    );

    monitor.dispose();
  });

  it("re-reads only once per settled change, and never on time alone", () => {
    const { monitor, onStateChange, show } = settleOnLimitScreen("reread-once");

    vi.advanceTimersByTime(60_000);
    expect(onStateChange).not.toHaveBeenCalled();

    monitor.onData("redraw");
    show(CANCELLED_SCREEN);
    vi.advanceTimersByTime(5000);
    expect(onStateChange).toHaveBeenCalledTimes(1);
    expect(onStateChange.mock.calls[0]![3]).toEqual({
      trigger: "pattern",
      waitingReason: "prompt",
      rereadAt: expect.any(Number),
    });

    // A later redraw that reads the same reason sends nothing more.
    monitor.onData("redraw again");
    vi.advanceTimersByTime(5000);
    expect(onStateChange).toHaveBeenCalledTimes(1);

    monitor.dispose();
  });

  it("waits for the screen to settle before reading it", () => {
    const { monitor, onStateChange, show } = settleOnLimitScreen("reread-settle");

    monitor.onData("redraw");
    show(CANCELLED_SCREEN);
    vi.advanceTimersByTime(500);
    expect(onStateChange).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1000);
    expect(onStateChange).toHaveBeenCalledTimes(1);

    monitor.dispose();
  });

  it("keeps the error while the limit banner still sits above the input row", () => {
    const { monitor, onStateChange, show } = settleOnLimitScreen("reread-still-limited");

    monitor.onData("redraw");
    show([
      "  ⎿  Automatic continue cancelled · /rate-limit-options to re-arm",
      "  ⎿  You've hit your weekly limit · resets Oct 2 at 9pm (Europe/Lisbon)",
      "",
      RULE,
      "❯ ",
      RULE,
      "  ⏵⏵ accept edits on (shift+tab to cycle)",
    ]);
    vi.advanceTimersByTime(5000);

    expect(onStateChange).not.toHaveBeenCalled();
    monitor.dispose();
  });

  it("changes nothing while the input row holds a draft", () => {
    const { monitor, onStateChange, show } = settleOnLimitScreen("reread-draft");

    monitor.onData("hello");
    show(CANCELLED_SCREEN.map((line) => (line === "❯ " ? "❯ hello" : line)));
    vi.advanceTimersByTime(5000);

    expect(onStateChange).not.toHaveBeenCalled();
    monitor.dispose();
  });

  it("reads a finished turn as a prompt wait under a footer that outlived the limit", () => {
    const onStateChange = vi.fn();
    let visible = ["waiting 0"];
    const monitor = new ActivityMonitor("reread-footer", 1000, onStateChange, {
      agentId: "claude",
      getVisibleLines: () => visible,
      getCursorLine: () => "❯ ",
      initialState: "idle",
      skipInitialStateEmit: true,
    });
    monitor.startPolling();
    for (let i = 1; i <= 4; i++) {
      vi.advanceTimersByTime(650);
      visible = [`tick ${i}`];
      vi.advanceTimersByTime(50);
    }
    expect(monitor.getState()).toBe("busy");

    visible = [
      "● The parser now handles empty input, and its tests pass.",
      "",
      RULE,
      "❯ ",
      RULE,
      "  Usage limit reached · continuing automatically at 10am · esc to cancel",
    ];
    vi.advanceTimersByTime(8200);

    expect(onStateChange).toHaveBeenLastCalledWith(
      "reread-footer",
      1000,
      "idle",
      expect.objectContaining({ waitingReason: "prompt" })
    );
    monitor.dispose();
  });
});
