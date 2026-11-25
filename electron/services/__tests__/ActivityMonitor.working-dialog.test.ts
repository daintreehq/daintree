import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ActivityMonitor } from "../ActivityMonitor.js";

const TRANSCRIPT = ["• Ran npm test", "  └ 212 passed", ""];

// Codex's safety-buffering picker as its own snapshots draw it, with and
// without the retry row it adds or drops on a redraw (#18167).
const PICKER = [
  ...TRANSCRIPT,
  "  Giving this request a little extra thought",
  "  If you'd rather not wait, retry with a faster model. It may be less capable",
  "  of handling complex requests.",
  "",
  "",
  "› 1. Retry with a faster model",
  "  2. Dismiss and keep waiting",
  "  3. Learn more",
  "",
  "  No action is required. Codex will keep waiting, and this menu will close when",
  "  the response is ready.",
  "",
];
const PICKER_WITHOUT_RETRY = [
  ...TRANSCRIPT,
  "  Giving this request a little extra thought",
  "",
  "",
  "› 1. Dismiss and keep waiting",
  "  2. Learn more",
  "",
  "  No action is required. Codex will keep waiting, and this menu will close when",
  "  the response is ready.",
  "",
];
const PROMPT_SCREEN = [
  ...TRANSCRIPT,
  "• Done. Every test passes.",
  "",
  "› Ask Codex to do anything",
  "",
  "  100% context left",
];

const monitors: ActivityMonitor[] = [];

function startPane(id: string, agentId = "codex") {
  const onStateChange = vi.fn();
  let visible = ["booting"];
  const monitor = new ActivityMonitor(id, 1000, onStateChange, {
    agentId,
    getVisibleLines: (n) => visible.slice(-n),
    getCursorLine: () => visible.at(-1) ?? null,
    initialState: "idle",
    skipInitialStateEmit: true,
  });
  monitors.push(monitor);
  monitor.startPolling();
  const draw = (lines: string[]) => {
    visible = lines;
    monitor.onData("\x1b[H redraw");
  };
  for (let i = 1; i <= 4; i++) {
    vi.advanceTimersByTime(650);
    draw([`• Working (${i}s • esc to interrupt)`]);
    vi.advanceTimersByTime(50);
  }
  expect(monitor.getState()).toBe("busy");
  onStateChange.mockClear();
  return { monitor, onStateChange, draw };
}

type Call = [string, number, string, Record<string, unknown> | undefined];

function calls(onStateChange: ReturnType<typeof vi.fn>): Call[] {
  return onStateChange.mock.calls as Call[];
}

function opened(onStateChange: ReturnType<typeof vi.fn>) {
  return calls(onStateChange).filter(([, , , m]) => m?.workingDialog === true);
}

function closed(onStateChange: ReturnType<typeof vi.fn>) {
  return calls(onStateChange).filter(([, , , m]) => m?.workingDialog === false);
}

function settles(onStateChange: ReturnType<typeof vi.fn>) {
  return calls(onStateChange).filter(([, , state]) => state === "idle" || state === "completed");
}

describe("ActivityMonitor and a menu over a running turn (#18167)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    for (const monitor of monitors.splice(0)) monitor.dispose();
    vi.useRealTimers();
    vi.clearAllTimers();
    vi.restoreAllMocks();
  });

  it("keeps a Codex pane working, however long its picker sits quiet", () => {
    const { monitor, onStateChange, draw } = startPane("picker");

    draw(PICKER);
    // Past the idle debounce and the working-silence cap alike.
    vi.advanceTimersByTime(200_000);

    expect(monitor.getState()).toBe("busy");
    expect(settles(onStateChange)).toEqual([]);
    expect(opened(onStateChange)).toEqual([
      [
        "picker",
        1000,
        "busy",
        { trigger: "pattern", patternConfidence: expect.any(Number), workingDialog: true },
      ],
    ]);
  });

  it("stays working when Codex redraws the picker with and without its retry row", () => {
    const { monitor, onStateChange, draw } = startPane("redraw");

    draw(PICKER);
    vi.advanceTimersByTime(20_000);
    draw(PICKER_WITHOUT_RETRY);
    vi.advanceTimersByTime(20_000);
    draw(PICKER);
    vi.advanceTimersByTime(20_000);

    expect(monitor.getState()).toBe("busy");
    expect(settles(onStateChange)).toEqual([]);
    expect(opened(onStateChange)).toHaveLength(1);
    expect(closed(onStateChange)).toEqual([]);
  });

  it("holds through a redraw caught halfway", () => {
    const { onStateChange, draw } = startPane("halfway");

    draw(PICKER);
    vi.advanceTimersByTime(5_000);
    draw(TRANSCRIPT);
    vi.advanceTimersByTime(300);
    draw(PICKER);
    vi.advanceTimersByTime(20_000);

    expect(opened(onStateChange)).toHaveLength(1);
    expect(closed(onStateChange)).toEqual([]);
    expect(settles(onStateChange)).toEqual([]);
  });

  it("settles at the prompt once the turn ends, closing the menu first", () => {
    const { monitor, onStateChange, draw } = startPane("ends");

    draw(PICKER);
    vi.advanceTimersByTime(20_000);
    draw(PROMPT_SCREEN);
    vi.advanceTimersByTime(20_000);

    expect(monitor.getState()).toBe("idle");
    const all = calls(onStateChange);
    const closeAt = all.findIndex(([, , , m]) => m?.workingDialog === false);
    const settleAt = all.findIndex(([, , state]) => state === "idle");
    expect(closeAt).toBeGreaterThanOrEqual(0);
    expect(settleAt).toBeGreaterThan(closeAt);
    expect(all[settleAt]![3]?.waitingReason).toBe("prompt");
  });

  it("publishes the close while the turn works on after the picker", () => {
    const { monitor, onStateChange, draw } = startPane("dismissed");

    draw(PICKER);
    vi.advanceTimersByTime(5_000);
    for (let i = 1; i <= 6; i++) {
      draw([...TRANSCRIPT, `• Working (${40 + i}s • esc to interrupt)`]);
      vi.advanceTimersByTime(400);
    }

    expect(monitor.getState()).toBe("busy");
    expect(closed(onStateChange)).toEqual([
      ["dismissed", 1000, "busy", { trigger: "pattern", workingDialog: false }],
    ]);
    expect(settles(onStateChange)).toEqual([]);
  });

  it("moves a pane that settled on the picker as an approval back to working", () => {
    const { monitor, onStateChange, draw } = startPane("misread");

    // A real choice first, so the pane settles as an approval wait.
    draw(["  Stop this attempt and retry?", "", "  › 1. Keep waiting", "    2. Stop and retry"]);
    vi.advanceTimersByTime(10_000);
    expect(monitor.getState()).toBe("idle");
    expect(settles(onStateChange).at(-1)?.[3]?.waitingReason).toBe("approval");
    onStateChange.mockClear();

    draw(PICKER);
    vi.advanceTimersByTime(3_000);

    expect(monitor.getState()).toBe("busy");
    expect(opened(onStateChange)).toHaveLength(1);
    expect(settles(onStateChange)).toEqual([]);
  });

  it("reads the same screen in another agent's pane as an approval wait", () => {
    const { monitor, onStateChange, draw } = startPane("claude-pane", "claude");

    draw(PICKER);
    vi.advanceTimersByTime(20_000);

    expect(monitor.getState()).toBe("idle");
    expect(opened(onStateChange)).toEqual([]);
    expect(settles(onStateChange).at(-1)?.[3]?.waitingReason).toBe("approval");
  });

  it("drops the hold when the pane's agent changes", () => {
    const { monitor, onStateChange, draw } = startPane("swap");

    draw(PICKER);
    vi.advanceTimersByTime(5_000);
    monitor.reconfigure("claude");

    expect(closed(onStateChange)).toHaveLength(1);
  });
});
