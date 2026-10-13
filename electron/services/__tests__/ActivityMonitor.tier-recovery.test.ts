import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ActivityMonitor } from "../ActivityMonitor.js";

describe("ActivityMonitor", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllTimers();
    vi.restoreAllMocks();
  });

  describe("Background-tier recovery (#6641)", () => {
    // The background polling tier (500ms) was unable to escape "waiting" when
    // an agent resumed producing output: the AND-gated volume detector with a
    // 1000ms window required two frames within the same window, which 500ms
    // polling rarely satisfies, and the 1500ms debouncer required three
    // consecutive cycles. Spinner ticks were also short-circuited by the
    // cosmetic-redraw early-return, so they never reached any recovery path.
    // The fix applies tier-aware thresholds (2500ms window, 600ms debouncer)
    // when polling is throttled and adds an idle-state recovery path through
    // the cosmetic-redraw branch of onData().

    it("recovers idle→busy from sparse spinner ticks WITH polling running", () => {
      // Reproduces the actual production scenario: 500ms polling cycles run
      // continuously, and sparse spinner ticks (~700ms intervals) accumulate
      // in the cosmetic-redraw recovery path. The shared workingSignalDebouncer
      // would have been reset by the polling cycle's "no signal" branch,
      // defeating recovery; the dedicated cosmeticRecoveryDebouncer survives.
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("bg-poll-1", 1000, onStateChange, {
        getVisibleLines: () => ["> ready"],
        getCursorLine: () => "> ready",
        pollingIntervalMs: 500,
        initialState: "idle",
        skipInitialStateEmit: true,
        backgroundWorkingRecoveryDelayMs: 600,
        idleDebounceMs: 4000,
      });

      monitor.startPolling();
      // Pre-fix, the polling cycle's no-signal branch would have erased the
      // cosmetic accumulator. Drive several poll cycles with no data so the
      // shared-debouncer hypothesis would have reset sustainedSince repeatedly
      // before the next spinner tick.
      vi.advanceTimersByTime(2000);
      expect(monitor.getState()).toBe("idle");
      onStateChange.mockClear();

      // Sparse ticks: each tick is 700ms apart, with 500ms polling firing
      // between them. With the dedicated debouncer, the 600ms gate fires on
      // the second tick.
      monitor.onData("\r⠙ Working (esc to interrupt)");
      vi.advanceTimersByTime(700);
      monitor.onData("\r⠙ Working (esc to interrupt)");

      expect(monitor.getState()).toBe("busy");

      monitor.dispose();
    });

    it("does not recover when getVisibleLines is not provided (non-agent terminal)", () => {
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("plain-1", 1000, onStateChange, {
        pollingIntervalMs: 500,
        backgroundWorkingRecoveryDelayMs: 600,
        idleDebounceMs: 4000,
      });

      // Even with sustained spinner output, a non-agent terminal must not
      // false-positive into busy from cosmetic redraws alone.
      for (let i = 0; i < 6; i++) {
        monitor.onData("\r⠙ Working (esc to interrupt)");
        vi.advanceTimersByTime(500);
      }

      expect(monitor.getState()).toBe("idle");
      expect(onStateChange).not.toHaveBeenCalled();

      monitor.dispose();
    });

    it("preserves #6365: busy-state spinner ticks still reset the debounce timer", () => {
      // When the agent is already busy, the cosmetic-redraw branch must still
      // call resetDebounceTimer() — the new idle-recovery path is additive,
      // not a replacement for the busy-keepalive path.
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("bg-busy", 1000, onStateChange, {
        getVisibleLines: () => [],
        getCursorLine: () => null,
        pollingIntervalMs: 500,
        backgroundWorkingRecoveryDelayMs: 600,
        idleDebounceMs: 300,
      });

      monitor.onInput("run\r");
      expect(monitor.getState()).toBe("busy");
      onStateChange.mockClear();

      for (let i = 0; i < 10; i++) {
        monitor.onData("\r⠙ Working (esc to interrupt)");
        vi.advanceTimersByTime(100);
      }

      expect(monitor.getState()).toBe("busy");

      monitor.dispose();
    });

    it("keeps a polling agent busy while sparse cosmetic redraws continue", () => {
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("agent-cosmetic-keepalive", 1000, onStateChange, {
        getVisibleLines: () => ["booted"],
        getCursorLine: () => "booted",
        pollingIntervalMs: 100,
        bootCompletePatterns: [/booted/i],
        idleDebounceMs: 400,
      });

      monitor.startPolling();
      vi.advanceTimersByTime(100);
      expect(monitor.getState()).toBe("busy");
      onStateChange.mockClear();

      // These ticks are farther apart than LineRewriteDetector's 500ms
      // multi-rewrite window, but they are visible status-line changes. While
      // they continue, the agent should remain working; when they stop, silence
      // should take it back to waiting/idle.
      for (let i = 0; i < 6; i++) {
        monitor.onData("\r⠙ Working (esc to interrupt)");
        vi.advanceTimersByTime(300);
        expect(monitor.getState()).toBe("busy");
      }

      expect(onStateChange).not.toHaveBeenCalledWith(
        "agent-cosmetic-keepalive",
        1000,
        "idle",
        expect.anything()
      );

      vi.advanceTimersByTime(1700);
      expect(monitor.getState()).toBe("idle");
      expect(onStateChange).toHaveBeenCalledWith(
        "agent-cosmetic-keepalive",
        1000,
        "idle",
        expect.objectContaining({ trigger: "timeout" })
      );

      monitor.dispose();
    });

    it("recovers a waiting polling agent immediately on small non-protocol output", () => {
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("agent-small-output", 1000, onStateChange, {
        getVisibleLines: () => ["ready"],
        getCursorLine: () => "ready",
        pollingIntervalMs: 100,
        initialState: "idle",
        skipInitialStateEmit: true,
        idleDebounceMs: 800,
        outputActivityDetection: {
          enabled: true,
          activationThreshold: 10_000,
          leakRatePerMs: 0,
          maxBytesPerFrame: 64,
        },
      });

      monitor.startPolling();
      vi.advanceTimersByTime(100);
      expect(monitor.getState()).toBe("idle");
      onStateChange.mockClear();

      monitor.onData(".");

      expect(monitor.getState()).toBe("busy");
      expect(onStateChange).toHaveBeenCalledWith(
        "agent-small-output",
        1000,
        "busy",
        expect.objectContaining({ trigger: "output" })
      );

      vi.advanceTimersByTime(2000);
      expect(monitor.getState()).toBe("idle");

      monitor.dispose();
    });

    it("does not keep a polling agent busy from invisible protocol noise", () => {
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("agent-protocol-noise", 1000, onStateChange, {
        getVisibleLines: () => ["booted"],
        getCursorLine: () => "booted",
        pollingIntervalMs: 100,
        bootCompletePatterns: [/booted/i],
        idleDebounceMs: 300,
      });

      monitor.startPolling();
      vi.advanceTimersByTime(100);
      expect(monitor.getState()).toBe("busy");
      onStateChange.mockClear();

      for (let i = 0; i < 20; i++) {
        monitor.onData("\x1b[?25h\x1b]133;A\x07\x1b[24;80R\x1b[?25l");
        vi.advanceTimersByTime(50);
      }
      vi.advanceTimersByTime(600);

      expect(monitor.getState()).toBe("idle");
      expect(onStateChange).toHaveBeenCalledWith(
        "agent-protocol-noise",
        1000,
        "idle",
        expect.objectContaining({ trigger: "timeout" })
      );

      monitor.dispose();
    });
  });

  describe("Structural-signal tier (Issue #6668)", () => {
    type FrameSnapshot = import("../pty/SynchronizedFrameAnalyzer.js").FrameSnapshot;

    function buildSnapshot(opts: {
      capturedAt: number;
      bottomRowText: string;
      higherRows?: string[];
      cols?: number;
      cycleAtCol?: { col: number; codes: number[]; frameIndex: number };
    }): FrameSnapshot {
      const cols = opts.cols ?? 40;
      const rows: { code: number; width: number }[][] = [];
      const higherRows = opts.higherRows ?? [];

      for (const text of higherRows) {
        const row: { code: number; width: number }[] = [];
        for (let i = 0; i < cols; i++) {
          row.push({ code: i < text.length ? text.codePointAt(i)! : 0x20, width: 1 });
        }
        rows.push(row);
      }

      const bottomRow: { code: number; width: number }[] = [];
      const text = opts.bottomRowText;
      for (let i = 0; i < cols; i++) {
        let code = i < text.length ? text.codePointAt(i)! : 0x20;
        if (opts.cycleAtCol && i === opts.cycleAtCol.col) {
          code = opts.cycleAtCol.codes[opts.cycleAtCol.frameIndex % opts.cycleAtCol.codes.length];
        }
        bottomRow.push({ code, width: 1 });
      }
      rows.push(bottomRow);

      return {
        capturedAt: opts.capturedAt,
        terminalRows: 24,
        terminalCols: cols,
        rows,
        bottomRowText: text,
        secondToBottomText: higherRows.length > 0 ? higherRows[higherRows.length - 1] : "",
      };
    }

    it("recovers idle→busy on sustained cosmetic-only frames", () => {
      vi.setSystemTime(10000);
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("struct-1", 1000, onStateChange, {
        getVisibleLines: () => ["> "],
        getCursorLine: () => "> ",
        workingRecoveryDelayMs: 800,
        idleDebounceMs: 2500,
      });

      monitor.startPolling();
      vi.advanceTimersByTime(100);
      vi.advanceTimersByTime(2500);
      expect(monitor.getState()).toBe("idle");
      onStateChange.mockClear();

      // Cosmetic-only frames are still visible output. They must not veto
      // recovery; sustained bottom-row churn means the agent is alive.
      monitor.onSynchronizedFrame(
        buildSnapshot({
          capturedAt: Date.now(),
          higherRows: ["upper line", "middle line"],
          bottomRowText: "spinner ✦",
        })
      );
      vi.advanceTimersByTime(100);
      monitor.onSynchronizedFrame(
        buildSnapshot({
          capturedAt: Date.now(),
          higherRows: ["upper line", "middle line"],
          bottomRowText: "spinner ✧",
        })
      );
      vi.advanceTimersByTime(400);
      monitor.onSynchronizedFrame(
        buildSnapshot({
          capturedAt: Date.now(),
          higherRows: ["upper line", "middle line"],
          bottomRowText: "spinner ✦",
        })
      );
      vi.advanceTimersByTime(500);
      monitor.onSynchronizedFrame(
        buildSnapshot({
          capturedAt: Date.now(),
          higherRows: ["upper line", "middle line"],
          bottomRowText: "spinner ✧",
        })
      );

      expect(monitor.getState()).toBe("busy");
      monitor.dispose();
    });

    it("recovers idle→busy on sustained spinner frames", () => {
      vi.setSystemTime(10000);
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("struct-2", 1000, onStateChange, {
        getVisibleLines: () => ["> "],
        getCursorLine: () => "> ",
        workingRecoveryDelayMs: 800,
        idleDebounceMs: 2500,
      });

      monitor.startPolling();
      vi.advanceTimersByTime(100);
      vi.advanceTimersByTime(2500);
      expect(monitor.getState()).toBe("idle");
      onStateChange.mockClear();

      // 4-item cycle × 4 = 16 frames at 100ms → 1600ms total. The spinner
      // classifier needs the ring to satisfy `length > distinct`, which
      // requires at least 5 frames (cycle revisits index 0 on frame 5).
      // After detection, the structural-recovery debouncer needs 800ms of
      // sustained signal — so recovery fires around frame 13.
      const cycle = [0x280b, 0x2819, 0x2839, 0x2838];
      for (let i = 0; i < 16; i++) {
        vi.advanceTimersByTime(100);
        monitor.onSynchronizedFrame(
          buildSnapshot({
            capturedAt: Date.now(),
            bottomRowText: " static text",
            cycleAtCol: { col: 0, codes: cycle, frameIndex: i },
          })
        );
      }

      // After the workingRecoveryDelayMs window, recovery should have fired.
      expect(monitor.getState()).toBe("busy");
      monitor.dispose();
    });

    it("recovers idle→busy on monotonic time-counter frames", () => {
      vi.setSystemTime(10000);
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("struct-3", 1000, onStateChange, {
        getVisibleLines: () => ["> "],
        getCursorLine: () => "> ",
        workingRecoveryDelayMs: 800,
        idleDebounceMs: 2500,
      });

      monitor.startPolling();
      vi.advanceTimersByTime(100);
      vi.advanceTimersByTime(2500);
      expect(monitor.getState()).toBe("idle");
      onStateChange.mockClear();

      // First two frames establish the increment streak (signal=time-counter
      // fires on frame 2 once counterStreak reaches 2). Subsequent frames
      // sustain the structural signal across the 800ms debounce window.
      monitor.onSynchronizedFrame(
        buildSnapshot({ capturedAt: Date.now(), bottomRowText: "Working… 1s" })
      );
      vi.advanceTimersByTime(200);
      monitor.onSynchronizedFrame(
        buildSnapshot({ capturedAt: Date.now(), bottomRowText: "Working… 2s" })
      );
      vi.advanceTimersByTime(400);
      monitor.onSynchronizedFrame(
        buildSnapshot({ capturedAt: Date.now(), bottomRowText: "Working… 3s" })
      );
      vi.advanceTimersByTime(500);
      monitor.onSynchronizedFrame(
        buildSnapshot({ capturedAt: Date.now(), bottomRowText: "Working… 4s" })
      );

      expect(monitor.getState()).toBe("busy");
      monitor.dispose();
    });

    it("ignores frames during resize suppression", () => {
      vi.setSystemTime(10000);
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("struct-4", 1000, onStateChange, {
        getVisibleLines: () => ["> "],
        getCursorLine: () => "> ",
        workingRecoveryDelayMs: 800,
        idleDebounceMs: 2500,
      });

      monitor.startPolling();
      vi.advanceTimersByTime(100);
      vi.advanceTimersByTime(2500);
      expect(monitor.getState()).toBe("idle");
      onStateChange.mockClear();

      monitor.notifyResize(1000);

      const cycle = [0x280b, 0x2819, 0x2839, 0x2838];
      for (let i = 0; i < 8; i++) {
        // Stop short of the 1000ms suppression window so every frame is
        // suppressed.
        vi.advanceTimersByTime(100);
        monitor.onSynchronizedFrame(
          buildSnapshot({
            capturedAt: Date.now(),
            bottomRowText: " static",
            cycleAtCol: { col: 0, codes: cycle, frameIndex: i },
          })
        );
      }

      expect(monitor.getState()).toBe("idle");
      monitor.dispose();
    });

    it("cosmetic-only frames do not block line-rewrite recovery", () => {
      vi.setSystemTime(10000);
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("struct-bypass", 1000, onStateChange, {
        getVisibleLines: () => ["> "],
        getCursorLine: () => "> ",
        workingRecoveryDelayMs: 800,
        idleDebounceMs: 2500,
      });

      monitor.startPolling();
      vi.advanceTimersByTime(100);
      vi.advanceTimersByTime(2500);
      expect(monitor.getState()).toBe("idle");
      onStateChange.mockClear();

      // Two frames classify as cosmetic-only. This used to set a suppression
      // TTL that could keep visibly active agents stuck in waiting.
      monitor.onSynchronizedFrame(
        buildSnapshot({
          capturedAt: Date.now(),
          higherRows: ["upper", "middle"],
          bottomRowText: "spinner ✦",
        })
      );
      vi.advanceTimersByTime(100);
      monitor.onSynchronizedFrame(
        buildSnapshot({
          capturedAt: Date.now(),
          higherRows: ["upper", "middle"],
          bottomRowText: "spinner ✧",
        })
      );

      // Drive cosmetic redraws through onData. Sustained status-line output
      // should recover the agent to busy instead of being structurally vetoed.
      for (let i = 0; i < 6 && monitor.getState() !== "busy"; i++) {
        vi.advanceTimersByTime(200);
        monitor.onData(`\r⠙ working tick ${i}`);
      }

      expect(monitor.getState()).toBe("busy");
      monitor.dispose();
    });

    it("recovers idle→busy from cosmetic-only frames at background tier with polling running", () => {
      vi.setSystemTime(10000);
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("struct-background", 1000, onStateChange, {
        getVisibleLines: () => ["> "],
        getCursorLine: () => "> ",
        pollingIntervalMs: 500,
        initialState: "idle",
        skipInitialStateEmit: true,
        backgroundWorkingRecoveryDelayMs: 600,
        idleDebounceMs: 2500,
      });

      monitor.startPolling();
      // Let several background poll cycles run. The structural debouncer must
      // survive these no-signal polls, just like the cosmetic-redraw debouncer.
      vi.advanceTimersByTime(1500);
      expect(monitor.getState()).toBe("idle");
      onStateChange.mockClear();

      monitor.onSynchronizedFrame(
        buildSnapshot({
          capturedAt: Date.now(),
          higherRows: ["upper", "middle"],
          bottomRowText: "status ✦",
        })
      );
      vi.advanceTimersByTime(700);
      monitor.onSynchronizedFrame(
        buildSnapshot({
          capturedAt: Date.now(),
          higherRows: ["upper", "middle"],
          bottomRowText: "status ✧",
        })
      );
      expect(monitor.getState()).toBe("idle");
      vi.advanceTimersByTime(700);
      monitor.onSynchronizedFrame(
        buildSnapshot({
          capturedAt: Date.now(),
          higherRows: ["upper", "middle"],
          bottomRowText: "status ✦",
        })
      );

      expect(monitor.getState()).toBe("busy");
      expect(onStateChange).toHaveBeenCalledWith(
        "struct-background",
        1000,
        "busy",
        expect.objectContaining({ trigger: "pattern", patternConfidence: expect.any(Number) })
      );
      monitor.dispose();
    });

    it("ignores frames before boot completes", () => {
      vi.setSystemTime(10000);
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("struct-5", 1000, onStateChange, {
        getVisibleLines: () => ["", "Booting..."],
        getCursorLine: () => "Booting...",
        workingRecoveryDelayMs: 800,
        idleDebounceMs: 2500,
      });

      monitor.startPolling();
      // Don't advance enough for boot to complete; remain in boot.
      onStateChange.mockClear();

      const cycle = [0x280b, 0x2819, 0x2839, 0x2838];
      for (let i = 0; i < 6; i++) {
        monitor.onSynchronizedFrame(
          buildSnapshot({
            capturedAt: Date.now() + i * 100,
            bottomRowText: " static",
            cycleAtCol: { col: 0, codes: cycle, frameIndex: i },
          })
        );
      }

      // No state-change calls from the structural tier during boot.
      const structuralCalls = onStateChange.mock.calls.filter(
        ([, , , metadata]) => metadata?.trigger === "pattern"
      );
      expect(structuralCalls).toHaveLength(0);
      monitor.dispose();
    });
  });
});
