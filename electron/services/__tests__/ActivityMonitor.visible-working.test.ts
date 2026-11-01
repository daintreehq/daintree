import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ActivityMonitor } from "../ActivityMonitor.js";
import { buildActivityMonitorOptions } from "../pty/terminalActivityPatterns.js";

// Claude Code mid-turn (#16062): the interrupt hint lives only in the footer,
// and the input box and its permission hint stay on screen while it works.
function claudeWorkingScreen(seconds: number): string[] {
  return [
    "● Read(src/components/Terminal/TerminalPane.tsx)",
    "  ⎿  Read 2010 lines",
    `✢ Befuddling… (${seconds}s · ↓ 3.1k tokens)`,
    "  ⎿  Tip: Use /btw to ask a quick side question without interrupting Claude's current work",
    "────────────────────────────────────────────────────────────────",
    "❯ ",
    "────────────────────────────────────────────────────────────────",
    "  ▸▸ bypass permissions on (shift+tab to cycle) · esc to interrupt",
  ];
}

const CLAUDE_WAITING_SCREEN = [
  "✻ Worked for 48s",
  "────────────────────────────────────────────────────────────────",
  "❯ ",
  "────────────────────────────────────────────────────────────────",
  "  ▸▸ bypass permissions on (shift+tab to cycle)",
];

// The first frame repaints the status block in place (erase-line), which the
// data path classes as a status-line rewrite and so never pattern-scans.
function fullRepaint(lines: string[]): string {
  return lines.map((line, row) => `\x1b[${row + 1};1H\x1b[2K${line}`).join("");
}

// Later frames touch only the cells that changed: the elapsed seconds.
function digitsOnly(seconds: number): string {
  return `\x1b[3;15H${seconds}`;
}

function createIdleClaudeMonitor(
  id: string,
  onStateChange: ReturnType<typeof vi.fn>,
  getScreen: () => string[]
): ActivityMonitor {
  return new ActivityMonitor(id, 1000, onStateChange, {
    ...buildActivityMonitorOptions("claude", {
      getVisibleLines: (n) => getScreen().slice(-n),
      getCursorLine: () => getScreen()[getScreen().length - 1] ?? null,
    }),
    initialState: "idle",
    skipInitialStateEmit: true,
  });
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

  it.each([50, 500])(
    "reads a Claude screen updated only in place as working (%ims polling)",
    (pollingMs) => {
      const onStateChange = vi.fn();
      let screen = CLAUDE_WAITING_SCREEN;
      const monitor = createIdleClaudeMonitor("visible-working", onStateChange, () => screen);
      monitor.setPollingInterval(pollingMs);
      monitor.startPolling();
      vi.advanceTimersByTime(500);
      expect(monitor.getState()).toBe("idle");

      let seconds = 47;
      screen = claudeWorkingScreen(seconds);
      monitor.onData(fullRepaint(screen));
      for (let tick = 0; tick < 6; tick++) {
        vi.advanceTimersByTime(1000);
        seconds += 1;
        screen = claudeWorkingScreen(seconds);
        monitor.onData(digitsOnly(seconds));
      }

      expect(monitor.getState()).toBe("busy");
      expect(onStateChange).toHaveBeenCalledWith(
        "visible-working",
        1000,
        "busy",
        expect.objectContaining({ trigger: "pattern" })
      );

      monitor.dispose();
    }
  );

  it("leaves a working line frozen on screen idle", () => {
    const onStateChange = vi.fn();
    const screen = claudeWorkingScreen(48);
    const monitor = createIdleClaudeMonitor("frozen-working", onStateChange, () => screen);
    monitor.startPolling();
    vi.advanceTimersByTime(10_000);

    expect(monitor.getState()).toBe("idle");
    expect(onStateChange).not.toHaveBeenCalled();
    monitor.dispose();
  });

  it("keeps a waiting screen idle while output still arrives", () => {
    const onStateChange = vi.fn();
    const screen = CLAUDE_WAITING_SCREEN;
    const monitor = createIdleClaudeMonitor("waiting-output", onStateChange, () => screen);
    monitor.startPolling();
    for (let tick = 0; tick < 8; tick++) {
      vi.advanceTimersByTime(1000);
      monitor.onData("\x1b[3;3H");
    }

    expect(monitor.getState()).toBe("idle");
    monitor.dispose();
  });

  it("waits out a focus repaint before reading the screen as working", () => {
    const onStateChange = vi.fn();
    let screen = CLAUDE_WAITING_SCREEN;
    const monitor = createIdleClaudeMonitor("focus-working", onStateChange, () => screen);
    monitor.startPolling();

    monitor.notifyFocus(2000);
    screen = claudeWorkingScreen(48);
    monitor.onData(fullRepaint(screen));
    vi.advanceTimersByTime(1000);
    monitor.onData(digitsOnly(49));
    vi.advanceTimersByTime(900);
    expect(monitor.getState()).toBe("idle");

    for (let seconds = 50; seconds < 54; seconds++) {
      vi.advanceTimersByTime(1000);
      monitor.onData(digitsOnly(seconds));
    }
    expect(monitor.getState()).toBe("busy");
    monitor.dispose();
  });
});
