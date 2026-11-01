import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ActivityMonitor } from "../ActivityMonitor.js";
import { buildActivityMonitorOptions } from "../pty/terminalActivityPatterns.js";
import { createVisibleContentSnapshot } from "../pty/SustainedChangeTracker.js";

type StateChange = ConstructorParameters<typeof ActivityMonitor>[2];

const SPINNER_ROW = 3;
const VIEWPORT_ROWS = 30;

function spinnerLine(seconds: number): string {
  return `✢ Befuddling… (${seconds}s · ↓ 3.1k tokens)`;
}

// Claude Code mid-turn (#16062): the interrupt hint lives only in the footer,
// and the input box and its permission hint stay on screen while it works.
function claudeWorkingScreen(seconds: number, footer = true): string[] {
  return [
    "● Read(src/components/Terminal/TerminalPane.tsx)",
    "  ⎿  Read 2010 lines",
    spinnerLine(seconds),
    "  ⎿  Tip: Use /btw to ask a quick side question without interrupting Claude's current work",
    "────────────────────────────────────────────────────────────────",
    "❯ ",
    "────────────────────────────────────────────────────────────────",
    footer
      ? "  ▸▸ bypass permissions on (shift+tab to cycle) · esc to interrupt"
      : "  ▸▸ bypass permissions on (shift+tab to cycle)",
  ];
}

function claudeWaitingScreen(clock = ""): string[] {
  return [
    "✻ Worked for 48s",
    "────────────────────────────────────────────────────────────────",
    "❯ ",
    "────────────────────────────────────────────────────────────────",
    `  ▸▸ bypass permissions on (shift+tab to cycle)${clock}`,
  ];
}

// The first frame repaints the status block in place (erase-line), which the
// data path classes as a status-line rewrite and so never pattern-scans.
function fullRepaint(lines: string[]): string {
  return lines.map((line, row) => `\x1b[${row + 1};1H\x1b[2K${line}`).join("");
}

// Later frames touch only the cells that changed: the elapsed seconds.
function digitsOnly(seconds: number): string {
  const column = spinnerLine(seconds).indexOf("(") + 2;
  return `\x1b[${SPINNER_ROW};${column}H${seconds}`;
}

// An inline TUI that hasn't reached the bottom of a tall pane: its content sits
// at the top and the bottom rows are blank, as the headless mirror reads them.
class Viewport {
  constructor(public content: string[]) {}

  rows(): string[] {
    return [
      ...this.content,
      ...Array.from({ length: VIEWPORT_ROWS - this.content.length }, () => ""),
    ];
  }

  bottomRows(n: number): string[] {
    return this.rows().slice(-n);
  }

  lastTextRows(n: number): string[] {
    return this.rows()
      .filter((row) => row.trim().length > 0)
      .slice(-n);
  }
}

function createIdleClaudeMonitor(
  id: string,
  onStateChange: StateChange,
  viewport: Viewport
): ActivityMonitor {
  return new ActivityMonitor(id, 1000, onStateChange, {
    ...buildActivityMonitorOptions("claude", {
      getVisibleLines: (n) => viewport.bottomRows(n),
      getLastTextLines: (n) => viewport.lastTextRows(n),
      getVisibleContentSnapshot: () => createVisibleContentSnapshot(viewport.rows()),
      getCursorLine: () => viewport.content[viewport.content.length - 1] ?? null,
    }),
    initialState: "idle",
    skipInitialStateEmit: true,
  });
}

function tickSeconds(
  monitor: ActivityMonitor,
  viewport: Viewport,
  from: number,
  count: number,
  footer = true
): void {
  for (let seconds = from; seconds < from + count; seconds++) {
    vi.advanceTimersByTime(1000);
    viewport.content = claudeWorkingScreen(seconds, footer);
    monitor.onData(digitsOnly(seconds));
  }
}

describe("ActivityMonitor visible working screen (#16062)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllTimers();
    vi.restoreAllMocks();
  });

  it.each([50, 200, 500])(
    "reads a Claude screen updated only in place as working (%ims polling)",
    (pollingMs) => {
      const onStateChange = vi.fn<StateChange>();
      const viewport = new Viewport(claudeWaitingScreen());
      const monitor = createIdleClaudeMonitor("visible-working", onStateChange, viewport);
      monitor.setPollingInterval(pollingMs);
      monitor.startPolling();
      vi.advanceTimersByTime(500);
      expect(monitor.getState()).toBe("idle");

      viewport.content = claudeWorkingScreen(47);
      monitor.onData(fullRepaint(viewport.content));
      tickSeconds(monitor, viewport, 48, 4);

      expect(monitor.getState()).toBe("busy");
      expect(onStateChange).toHaveBeenCalledWith(
        "visible-working",
        1000,
        "busy",
        expect.objectContaining({ trigger: "pattern" })
      );

      // It stays working for as long as the seconds keep counting.
      tickSeconds(monitor, viewport, 52, 20);
      expect(monitor.getState()).toBe("busy");
      monitor.dispose();
    }
  );

  it.each([50, 200])(
    "leaves a restored working line that never changes idle (%ims)",
    (pollingMs) => {
      const onStateChange = vi.fn<StateChange>();
      const viewport = new Viewport(claudeWorkingScreen(48));
      const monitor = createIdleClaudeMonitor("frozen-working", onStateChange, viewport);
      monitor.setPollingInterval(pollingMs);
      monitor.startPolling();
      vi.advanceTimersByTime(10_000);

      expect(monitor.getState()).toBe("idle");
      expect(onStateChange).not.toHaveBeenCalled();
      monitor.dispose();
    }
  );

  it("doesn't take bytes that move nothing on screen as a working line's progress", () => {
    const onStateChange = vi.fn<StateChange>();
    const viewport = new Viewport(claudeWorkingScreen(48));
    const monitor = createIdleClaudeMonitor("stale-working", onStateChange, viewport);
    monitor.startPolling();
    for (let tick = 0; tick < 8; tick++) {
      vi.advanceTimersByTime(1000);
      monitor.onData("\x1b[6;3H\x1b]0;claude\x07");
    }

    expect(monitor.getState()).toBe("idle");
    monitor.dispose();
  });

  it("doesn't read a single repaint of a working screen as work", () => {
    const onStateChange = vi.fn<StateChange>();
    const viewport = new Viewport(claudeWaitingScreen());
    const monitor = createIdleClaudeMonitor("single-repaint", onStateChange, viewport);
    monitor.setPollingInterval(500);
    monitor.startPolling();
    vi.advanceTimersByTime(500);

    viewport.content = claudeWorkingScreen(48);
    monitor.onData(fullRepaint(viewport.content));
    vi.advanceTimersByTime(10_000);

    expect(monitor.getState()).toBe("idle");
    monitor.dispose();
  });

  it("needs the interrupt hint, not just a spinner line, to read a sparse screen as working", () => {
    const onStateChange = vi.fn<StateChange>();
    const viewport = new Viewport(claudeWaitingScreen());
    const monitor = createIdleClaudeMonitor("fallback-only", onStateChange, viewport);
    monitor.startPolling();

    viewport.content = claudeWorkingScreen(47, false);
    monitor.onData(fullRepaint(viewport.content));
    tickSeconds(monitor, viewport, 48, 8, false);

    expect(monitor.getState()).toBe("idle");
    monitor.dispose();
  });

  it("keeps a waiting screen idle while it changes", () => {
    const onStateChange = vi.fn<StateChange>();
    const viewport = new Viewport(claudeWaitingScreen());
    const monitor = createIdleClaudeMonitor("waiting-clock", onStateChange, viewport);
    monitor.startPolling();
    for (let seconds = 0; seconds < 8; seconds++) {
      vi.advanceTimersByTime(1000);
      viewport.content = claudeWaitingScreen(` · 12:00:0${seconds}`);
      monitor.onData(`\x1b[5;50H${seconds}`);
    }

    expect(monitor.getState()).toBe("idle");
    monitor.dispose();
  });

  it("waits out a focus repaint before reading the screen as working", () => {
    const onStateChange = vi.fn<StateChange>();
    const viewport = new Viewport(claudeWaitingScreen());
    const monitor = createIdleClaudeMonitor("focus-working", onStateChange, viewport);
    monitor.startPolling();

    monitor.notifyFocus(2000);
    viewport.content = claudeWorkingScreen(47);
    monitor.onData(fullRepaint(viewport.content));
    tickSeconds(monitor, viewport, 48, 1);
    vi.advanceTimersByTime(900);
    expect(monitor.getState()).toBe("idle");

    tickSeconds(monitor, viewport, 49, 4);
    expect(monitor.getState()).toBe("busy");
    monitor.dispose();
  });
});
