import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ActivityMonitor, type ActivityStateMetadata } from "../ActivityMonitor.js";
import { buildActivityMonitorOptions } from "../pty/terminalActivityPatterns.js";

const RULE = "─".repeat(60);
const CLAUDE_PROMPT = ["● Resumed.", "", RULE, "❯ ", RULE, "  ? for shortcuts"];
const CODEX_PROMPT = ["", "› Ask Codex to do anything", "", "  ⏎ send   ⌃J newline"];

const monitors: ActivityMonitor[] = [];

/** A freshly launched agent's monitor, from its boot, over whatever `show` puts on screen. */
function launch(agentId: string, initial: string[]) {
  const onStateChange = vi.fn();
  let visible = initial;
  const monitor = new ActivityMonitor(
    "t-launch",
    1000,
    onStateChange,
    buildActivityMonitorOptions(agentId, {
      getVisibleLines: (n: number) => visible.slice(-n),
      getCursorLine: () => visible.at(-1) ?? null,
    })
  );
  monitors.push(monitor);
  monitor.startPolling();
  const idleSettles = (): ActivityStateMetadata[] =>
    onStateChange.mock.calls.filter((call) => call[2] === "idle").map((call) => call[3]);
  return {
    monitor,
    idleSettles,
    show: (lines: string[]) => {
      visible = lines;
    },
    /** The screen changes while the agent stays idle, and is left to settle. */
    redraw: (lines: string[]) => {
      // Escape is held back as a possible sequence start, so only the redraw
      // reaches the monitor, as in the re-read tests.
      monitor.onInput("\x1b");
      monitor.onData("\x1b[2J redraw");
      visible = lines;
      vi.advanceTimersByTime(5_000);
    },
  };
}

describe("ActivityMonitor prompt evidence on a settle (#18018)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
  });

  afterEach(() => {
    for (const monitor of monitors.splice(0)) monitor.dispose();
    vi.useRealTimers();
  });

  it.each([
    ["a CLI still silent at its boot timeout", ["", "", ""]],
    ["the shell line that started it, under a prompt glyph", ["❯ claude --resume 0b1c", ""]],
    ["the shell line under a plain shell prompt", ["~/project $ claude", ""]],
  ])("settles at a prompt with no input row of its own for %s", (_label, screen) => {
    const pane = launch("claude", screen);
    vi.advanceTimersByTime(25_000);

    expect(pane.monitor.getState()).toBe("idle");
    const settles = pane.idleSettles();
    expect(settles).toHaveLength(1);
    expect(settles[0]).toMatchObject({ waitingReason: "prompt" });
    expect(settles[0]!.promptDrawnAt).toBeUndefined();
  });

  it("sends the first sight of its input row, drawn without going busy, as a re-read", () => {
    const pane = launch("claude", ["❯ claude --resume 0b1c", ""]);
    vi.advanceTimersByTime(25_000);
    expect(pane.idleSettles()).toHaveLength(1);

    pane.redraw(["❯ claude --resume 0b1c", ...CLAUDE_PROMPT]);

    expect(pane.monitor.getState()).toBe("idle");
    const settles = pane.idleSettles();
    expect(settles).toHaveLength(2);
    expect(settles[1]).toMatchObject({ waitingReason: "prompt" });
    expect(settles[1]!.promptDrawnAt).toBe(settles[1]!.rereadAt);
    expect(settles[1]!.promptDrawnAt).toBeGreaterThan(settles[0]!.rereadAt ?? 10_000);

    // Seen once, the same reading isn't sent again.
    pane.redraw([...CLAUDE_PROMPT, ""]);
    expect(pane.idleSettles()).toHaveLength(2);
  });

  it("reads the time of a settle on its own input row", () => {
    const pane = launch("claude", CLAUDE_PROMPT);
    vi.advanceTimersByTime(25_000);

    const [settle] = pane.idleSettles();
    expect(settle).toMatchObject({ waitingReason: "prompt" });
    expect(settle!.promptDrawnAt).toBeGreaterThan(10_000);
    expect(settle!.promptDrawnAt).toBeLessThanOrEqual(Date.now());
  });

  it("sends another agent's first sight after it takes over, though the reason is the same", () => {
    const pane = launch("claude", CLAUDE_PROMPT);
    vi.advanceTimersByTime(25_000);
    expect(pane.idleSettles()[0]!.promptDrawnAt).toBeDefined();

    pane.monitor.reconfigure("codex");
    pane.redraw(CODEX_PROMPT);

    const settles = pane.idleSettles();
    expect(settles).toHaveLength(2);
    expect(settles[1]).toMatchObject({ waitingReason: "prompt" });
    expect(settles[1]!.promptDrawnAt).toBeDefined();
  });
});
