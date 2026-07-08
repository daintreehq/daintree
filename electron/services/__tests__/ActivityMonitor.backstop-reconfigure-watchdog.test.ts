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

  describe("Stale pattern buffer TTL", () => {
    it("should allow idle transition after stale pattern result expires (non-polling)", () => {
      const onStateChange = vi.fn();
      const processStateValidator = {
        hasActiveChildren: vi.fn().mockReturnValue(null as unknown as boolean),
      };
      const monitor = new ActivityMonitor("stale-1", 100, onStateChange, {
        idleDebounceMs: 1000,
        processStateValidator,
        patternConfig: {
          primaryPatterns: [/working/i],
          scanLineCount: 10,
        },
      });

      // Enter busy via input
      monitor.onInput("\r");
      expect(monitor.getState()).toBe("busy");
      onStateChange.mockClear();

      // Send data with working pattern — sets lastPatternResult.isWorking = true
      monitor.onData("Working on task...\n");
      const patternResult = monitor.getLastPatternResult();
      expect(patternResult?.isWorking).toBe(true);

      // First debounce: pattern result still fresh, reschedules
      vi.advanceTimersByTime(1000);
      expect(monitor.getState()).toBe("busy");

      // Advance past WORKING_INDICATOR_TTL_MS (5s) — pattern result expires
      // The stale lastPatternResult.isWorking no longer blocks idle
      vi.advanceTimersByTime(5000);
      expect(monitor.getState()).toBe("idle");

      monitor.dispose();
    });
  });

  describe("CPU-active quiet-agent backstop", () => {
    it("keeps a polling agent busy while descendant CPU remains high", () => {
      const onStateChange = vi.fn();
      const processStateValidator = {
        hasActiveChildren: vi.fn().mockReturnValue(true),
        getDescendantsCpuUsage: vi.fn().mockReturnValue(18),
      };
      const monitor = new ActivityMonitor("cpu-quiet-1", 100, onStateChange, {
        getVisibleLines: () => ["$ "],
        getCursorLine: () => "$ ",
        pollingIntervalMs: 50,
        pollingMaxBootMs: 0,
        idleDebounceMs: 300,
        processStateValidator,
      });

      monitor.startPolling();
      onStateChange.mockClear();

      vi.advanceTimersByTime(5000);

      expect(monitor.getState()).toBe("busy");
      expect(onStateChange.mock.calls.some((c: unknown[]) => c[2] === "idle")).toBe(false);

      processStateValidator.getDescendantsCpuUsage.mockReturnValue(1);
      vi.advanceTimersByTime(100);

      expect(monitor.getState()).toBe("idle");

      monitor.dispose();
    });

    it("allows quiet polling agents to become idle after the CPU-high escape deadline", () => {
      const onStateChange = vi.fn();
      const processStateValidator = {
        hasActiveChildren: vi.fn().mockReturnValue(true),
        getDescendantsCpuUsage: vi.fn().mockReturnValue(20),
      };
      const monitor = new ActivityMonitor("cpu-quiet-2", 100, onStateChange, {
        getVisibleLines: () => ["$ "],
        getCursorLine: () => "$ ",
        pollingIntervalMs: 50,
        pollingMaxBootMs: 0,
        idleDebounceMs: 300,
        maxCpuHighEscapeMs: 2000,
        processStateValidator,
      });

      monitor.startPolling();
      onStateChange.mockClear();

      vi.advanceTimersByTime(1500);
      expect(monitor.getState()).toBe("busy");

      vi.advanceTimersByTime(2500);
      expect(monitor.getState()).toBe("idle");

      monitor.dispose();
    });

    it("does not transition idle agents to busy from CPU activity alone", () => {
      const onStateChange = vi.fn();
      const processStateValidator = {
        hasActiveChildren: vi.fn().mockReturnValue(true),
        getDescendantsCpuUsage: vi.fn().mockReturnValue(30),
      };
      const monitor = new ActivityMonitor("cpu-quiet-3", 100, onStateChange, {
        getVisibleLines: () => ["$ "],
        getCursorLine: () => "$ ",
        pollingIntervalMs: 50,
        pollingMaxBootMs: 0,
        initialState: "idle",
        skipInitialStateEmit: true,
        processStateValidator,
      });

      monitor.startPolling();
      vi.advanceTimersByTime(5000);

      expect(monitor.getState()).toBe("idle");
      expect(onStateChange.mock.calls.some((c: unknown[]) => c[2] === "busy")).toBe(false);

      monitor.dispose();
    });
  });

  describe("Dispose emits idle", () => {
    it("should emit idle with dispose trigger when busy monitor is disposed", () => {
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("dispose-1", 100, onStateChange);

      monitor.onInput("\r");
      expect(monitor.getState()).toBe("busy");
      onStateChange.mockClear();

      monitor.dispose();

      expect(onStateChange).toHaveBeenCalledTimes(1);
      expect(onStateChange).toHaveBeenCalledWith("dispose-1", 100, "idle", {
        trigger: "dispose",
      });
      expect(monitor.getState()).toBe("idle");
    });

    it("should NOT emit idle when idle monitor is disposed", () => {
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("dispose-2", 100, onStateChange);

      // Monitor starts idle — no state change on dispose
      monitor.dispose();
      expect(onStateChange).not.toHaveBeenCalled();
    });

    it("should emit idle only once on double dispose", () => {
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("dispose-3", 100, onStateChange);

      monitor.onInput("\r");
      onStateChange.mockClear();

      monitor.dispose();
      monitor.dispose();

      expect(onStateChange).toHaveBeenCalledTimes(1);
      expect(onStateChange).toHaveBeenCalledWith("dispose-3", 100, "idle", {
        trigger: "dispose",
      });
    });

    it("should complete cleanup even if onStateChange throws during dispose", () => {
      const onStateChange = vi.fn().mockImplementation((_id, _at, state) => {
        if (state === "idle") throw new Error("callback failed");
      });
      const monitor = new ActivityMonitor("dispose-4", 100, onStateChange);

      monitor.onInput("\r");
      expect(monitor.getState()).toBe("busy");

      // dispose() should not throw despite callback failure
      expect(() => monitor.dispose()).not.toThrow();
      expect(monitor.getState()).toBe("idle");

      // Further calls are no-ops — cleanup completed
      monitor.onInput("\r");
      monitor.onData("test");
      vi.advanceTimersByTime(10000);
      // Only 2 calls: busy from input + idle from dispose (which threw)
      expect(onStateChange).toHaveBeenCalledTimes(2);
    });

    it("should remain disposed if callback re-enters via notifySubmission", () => {
      const ref: { monitor?: InstanceType<typeof ActivityMonitor> } = {};
      const onStateChange = vi
        .fn()
        .mockImplementation(
          (_id: string, _at: number, _state: string, meta?: { trigger?: string }) => {
            if (meta?.trigger === "dispose") {
              ref.monitor?.notifySubmission();
            }
          }
        );
      const monitor = new ActivityMonitor("dispose-5", 100, onStateChange);
      ref.monitor = monitor;

      monitor.onInput("\r");
      onStateChange.mockClear();

      monitor.dispose();
      // Should still be idle — re-entrant notifySubmission was blocked by isDisposed
      expect(monitor.getState()).toBe("idle");
      expect(onStateChange).toHaveBeenCalledTimes(1);
    });
  });

  describe("reconfigure", () => {
    const CLAUDE_WORKING = "✽ Deliberating… (esc to interrupt · 15s)";
    const GEMINI_WORKING = "⠼ Unpacking Project Details (esc to cancel, 14s)";

    it("swaps detector so old-agent patterns no longer match after reconfigure", () => {
      vi.setSystemTime(10000);
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("reconf-1", 1, onStateChange, {
        agentId: "claude",
        simpleOutputState: false,
      });

      // Baseline: claude detector matches its own pattern
      monitor.onData(CLAUDE_WORKING);
      expect(monitor.getLastPatternResult()?.isWorking).toBe(true);

      monitor.reconfigure("gemini");

      // Feed claude-only pattern — gemini detector should not match it
      monitor.onData("✽ Deliberating…");
      expect(monitor.getLastPatternResult()?.isWorking).toBeFalsy();

      // Feed gemini-only pattern — new detector should match
      monitor.onData(GEMINI_WORKING);
      expect(monitor.getLastPatternResult()?.isWorking).toBe(true);

      monitor.dispose();
    });

    it("clears pattern buffer and TTL fields on reconfigure", () => {
      vi.setSystemTime(10000);
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("reconf-2", 1, onStateChange, {
        agentId: "claude",
        simpleOutputState: false,
      });

      monitor.onData(CLAUDE_WORKING);
      expect(monitor.getLastPatternResult()?.isWorking).toBe(true);

      type MonitorInternals = {
        patternBuf: { getText(): string };
        lastPatternResult: unknown;
        lastPatternResultAt: number;
        lastWorkingIndicatorTimestamp: number;
      };
      const internals = monitor as unknown as MonitorInternals;
      expect(internals.patternBuf.getText().length).toBeGreaterThan(0);

      monitor.reconfigure("gemini");

      expect(internals.patternBuf.getText()).toBe("");
      expect(internals.lastPatternResult).toBeUndefined();
      expect(internals.lastPatternResultAt).toBe(0);
      expect(internals.lastWorkingIndicatorTimestamp).toBe(0);

      monitor.dispose();
    });

    it("preserves timing state (lastActivityTimestamp, workingHoldUntil) across reconfigure", () => {
      vi.setSystemTime(10000);
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("reconf-3", 1, onStateChange, { agentId: "claude" });

      monitor.onData(CLAUDE_WORKING);

      type MonitorInternals = {
        lastActivityTimestamp: number;
        workingHoldUntil: number;
      };
      const before = monitor as unknown as MonitorInternals;
      const ts = before.lastActivityTimestamp;
      const hold = before.workingHoldUntil;
      expect(ts).toBeGreaterThan(0);

      vi.setSystemTime(10050);
      monitor.reconfigure("gemini");

      expect(before.lastActivityTimestamp).toBe(ts);
      expect(before.workingHoldUntil).toBe(hold);

      monitor.dispose();
    });

    it("does not emit stale working state after reconfigure (debounce TTL guard)", () => {
      vi.setSystemTime(10000);
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("reconf-4", 1, onStateChange, {
        agentId: "claude",
        simpleOutputState: false,
        idleDebounceMs: 1000,
      });

      // Enter working via claude pattern
      monitor.onData(CLAUDE_WORKING);
      expect(monitor.getState()).toBe("busy");
      onStateChange.mockClear();

      // Swap to gemini — stale pattern result must not hold working through TTL
      monitor.reconfigure("gemini");

      // Advance past idle debounce. With stale TTL fields cleared, monitor should
      // go idle (no new working signals from old detector's stale state).
      vi.advanceTimersByTime(5000);

      expect(monitor.getState()).toBe("idle");
      expect(onStateChange).toHaveBeenCalledWith("reconf-4", 1, "idle");

      monitor.dispose();
    });

    it("treats reconfigure with no args as disabling the detector", () => {
      vi.setSystemTime(10000);
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("reconf-5", 1, onStateChange, { agentId: "claude" });

      monitor.reconfigure();

      // With no detector, claude pattern should not register a working result
      monitor.onData(CLAUDE_WORKING);
      expect(monitor.getLastPatternResult()).toBeUndefined();

      monitor.dispose();
    });

    it("builds a detector when reconfigure is called on a monitor that had none", () => {
      vi.setSystemTime(10000);
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("reconf-6", 1, onStateChange);

      // No detector initially
      monitor.onData(CLAUDE_WORKING);
      expect(monitor.getLastPatternResult()).toBeUndefined();

      monitor.reconfigure("claude");
      monitor.onData(CLAUDE_WORKING);
      expect(monitor.getLastPatternResult()?.isWorking).toBe(true);

      monitor.dispose();
    });

    it("is a no-op after dispose", () => {
      vi.setSystemTime(10000);
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("reconf-7", 1, onStateChange, { agentId: "claude" });

      monitor.dispose();

      expect(() => monitor.reconfigure("gemini")).not.toThrow();

      // Disposed monitor should not react to further data
      onStateChange.mockClear();
      monitor.onData(GEMINI_WORKING);
      expect(onStateChange).not.toHaveBeenCalled();
    });
  });

  describe("Waiting watchdog", () => {
    it("should fire onWaitingTimeout after MAX_WAITING_SILENCE_MS when idle with dead children", () => {
      const onStateChange = vi.fn();
      const onWaitingTimeout = vi.fn();
      const processStateValidator = {
        hasActiveChildren: vi.fn().mockReturnValue(false),
      };
      const monitor = new ActivityMonitor("test-wd-1", 100, onStateChange, {
        processStateValidator,
        onWaitingTimeout,
        maxWaitingSilenceMs: 1000,
      });

      // Default WATCHDOG_FAIL_THRESHOLD is 3 — fires only after 3 consecutive
      // dead-looking watchdog ticks (≈15s at the 5s cadence).
      vi.advanceTimersByTime(16000);

      expect(onWaitingTimeout).toHaveBeenCalledWith("test-wd-1", 100);

      monitor.dispose();
    });

    it("should not fire before MAX_WAITING_SILENCE_MS elapses", () => {
      const onStateChange = vi.fn();
      const onWaitingTimeout = vi.fn();
      const processStateValidator = {
        hasActiveChildren: vi.fn().mockReturnValue(false),
      };
      const monitor = new ActivityMonitor("test-wd-2", 100, onStateChange, {
        processStateValidator,
        onWaitingTimeout,
        maxWaitingSilenceMs: 60000,
      });

      // Advance past watchdog interval but not past silence threshold
      vi.advanceTimersByTime(10000);

      expect(onWaitingTimeout).not.toHaveBeenCalled();

      monitor.dispose();
    });

    it("should not fire when hasActiveChildren returns true", () => {
      const onStateChange = vi.fn();
      const onWaitingTimeout = vi.fn();
      const processStateValidator = {
        hasActiveChildren: vi.fn().mockReturnValue(true),
      };
      const monitor = new ActivityMonitor("test-wd-3", 100, onStateChange, {
        processStateValidator,
        onWaitingTimeout,
        maxWaitingSilenceMs: 1000,
      });

      vi.advanceTimersByTime(5100);

      expect(onWaitingTimeout).not.toHaveBeenCalled();

      monitor.dispose();
    });

    it("should not fire when hasActiveChildren returns null (no validator)", () => {
      const onStateChange = vi.fn();
      const onWaitingTimeout = vi.fn();
      // No processStateValidator at all
      const monitor = new ActivityMonitor("test-wd-4", 100, onStateChange, {
        onWaitingTimeout,
        maxWaitingSilenceMs: 1000,
      });

      vi.advanceTimersByTime(5100);

      expect(onWaitingTimeout).not.toHaveBeenCalled();

      monitor.dispose();
    });

    it("should not fire when state is busy", () => {
      const onStateChange = vi.fn();
      const onWaitingTimeout = vi.fn();
      const processStateValidator = {
        hasActiveChildren: vi.fn().mockReturnValue(false),
      };
      const monitor = new ActivityMonitor("test-wd-5", 100, onStateChange, {
        processStateValidator,
        onWaitingTimeout,
        maxWaitingSilenceMs: 1000,
        idleDebounceMs: 30000, // Keep busy long enough to test watchdog gate
      });

      // Enter busy state
      monitor.onInput("\r");
      expect(onStateChange).toHaveBeenCalledWith("test-wd-5", 100, "busy", { trigger: "input" });

      // Advance past watchdog interval but not past idle debounce — still busy
      vi.advanceTimersByTime(5100);
      expect(monitor.getState()).toBe("busy");
      expect(onWaitingTimeout).not.toHaveBeenCalled();

      monitor.dispose();
    });

    it("should fire only once per idle episode", () => {
      const onStateChange = vi.fn();
      const onWaitingTimeout = vi.fn();
      const processStateValidator = {
        hasActiveChildren: vi.fn().mockReturnValue(false),
      };
      const monitor = new ActivityMonitor("test-wd-6", 100, onStateChange, {
        processStateValidator,
        onWaitingTimeout,
        maxWaitingSilenceMs: 1000,
      });

      // Advance well past multiple watchdog intervals
      vi.advanceTimersByTime(15000);

      expect(onWaitingTimeout).toHaveBeenCalledTimes(1);

      monitor.dispose();
    });

    it("should reset after becomeBusy and fire again next idle cycle", () => {
      const onStateChange = vi.fn();
      const onWaitingTimeout = vi.fn();
      const processStateValidator = {
        hasActiveChildren: vi.fn().mockReturnValue(false),
      };
      const monitor = new ActivityMonitor("test-wd-7", 100, onStateChange, {
        processStateValidator,
        onWaitingTimeout,
        maxWaitingSilenceMs: 1000,
      });

      // Fire first watchdog (3 consecutive ticks at the 5s cadence).
      vi.advanceTimersByTime(16000);
      expect(onWaitingTimeout).toHaveBeenCalledTimes(1);

      // Transition to busy — must reset waitingWatchdogFired AND watchdogFailCount.
      monitor.onInput("\r");
      onWaitingTimeout.mockClear();

      // Default idleDebounceMs=4000 returns to idle without further input.
      // Then the new waiting period needs another 3-tick streak past the
      // ceiling to fire — proving the count was actually reset, not retained.
      vi.advanceTimersByTime(40000);
      expect(onWaitingTimeout).toHaveBeenCalledTimes(1);

      monitor.dispose();
    });

    it("should not fire after dispose", () => {
      const onStateChange = vi.fn();
      const onWaitingTimeout = vi.fn();
      const processStateValidator = {
        hasActiveChildren: vi.fn().mockReturnValue(false),
      };
      const monitor = new ActivityMonitor("test-wd-8", 100, onStateChange, {
        processStateValidator,
        onWaitingTimeout,
        maxWaitingSilenceMs: 1000,
      });

      monitor.dispose();

      vi.advanceTimersByTime(1100);
      expect(onWaitingTimeout).not.toHaveBeenCalled();
    });

    it("should fire for polling monitors after becoming idle", () => {
      const onStateChange = vi.fn();
      const onWaitingTimeout = vi.fn();
      const processStateValidator = {
        hasActiveChildren: vi.fn().mockReturnValue(false),
      };
      const getVisibleLines = vi.fn(() => ["$ "]);
      const monitor = new ActivityMonitor("test-wd-9", 100, onStateChange, {
        processStateValidator,
        onWaitingTimeout,
        maxWaitingSilenceMs: 100,
        getVisibleLines,
        getCursorLine: () => "$ ",
        promptPatterns: [/^\$\s*$/],
        pollingIntervalMs: 20,
        pollingMaxBootMs: 0,
        idleDebounceMs: 50,
      });

      monitor.startPolling();

      // Polling starts in boot phase — watchdog suppressed while state is busy
      vi.advanceTimersByTime(50);
      expect(onWaitingTimeout).not.toHaveBeenCalled();

      // The watchdog runs solely on its dedicated 5s interval (independent of
      // the polling cadence) to keep WATCHDOG_FAIL_THRESHOLD consistent across
      // polling and non-polling monitors. With threshold=3 and ceiling
      // already met, fire requires 3 watchdog ticks ≈ 15s.
      vi.advanceTimersByTime(16000);
      expect(monitor.getState()).toBe("idle");
      expect(onWaitingTimeout).toHaveBeenCalledTimes(1);
      expect(onWaitingTimeout).toHaveBeenCalledWith("test-wd-9", 100);

      monitor.dispose();
    });

    it("requires WATCHDOG_FAIL_THRESHOLD consecutive dead-looking ticks (#6667)", () => {
      const onStateChange = vi.fn();
      const onWaitingTimeout = vi.fn();
      const processStateValidator = {
        hasActiveChildren: vi.fn().mockReturnValue(false),
      };
      const monitor = new ActivityMonitor("test-wd-threshold", 100, onStateChange, {
        processStateValidator,
        onWaitingTimeout,
        maxWaitingSilenceMs: 1000,
      });

      // After 1 watchdog tick (5000ms): ceiling met, count=1 — not yet fired.
      vi.advanceTimersByTime(5100);
      expect(onWaitingTimeout).not.toHaveBeenCalled();

      // After 2 ticks (10100ms total): count=2 — still not fired.
      vi.advanceTimersByTime(5000);
      expect(onWaitingTimeout).not.toHaveBeenCalled();

      // After 3 ticks (15100ms total): count=3 → fires.
      vi.advanceTimersByTime(5000);
      expect(onWaitingTimeout).toHaveBeenCalledTimes(1);

      monitor.dispose();
    });

    it("ambiguous probe result resets the consecutive-fail streak (#6667)", () => {
      const onStateChange = vi.fn();
      const onWaitingTimeout = vi.fn();
      let callCount = 0;
      const processStateValidator = {
        // Sequence: false, false, throws (→ null/true via safe), false, false, false.
        // After the throw, the streak resets so we need 3 more dead ticks.
        hasActiveChildren: vi.fn().mockImplementation(() => {
          callCount += 1;
          if (callCount === 3) {
            throw new Error("validator transient failure");
          }
          return false;
        }),
      };
      const monitor = new ActivityMonitor("test-wd-ambiguous", 100, onStateChange, {
        processStateValidator,
        onWaitingTimeout,
        maxWaitingSilenceMs: 1000,
      });

      // Ticks 1, 2 = false (count 1, 2). Tick 3 throws → safe returns true →
      // alive-veto-equivalent path resets count to 0. Ticks 4, 5 = false
      // (count 1, 2). Tick 6 = false (count 3 → fires).
      vi.advanceTimersByTime(31000);
      expect(onWaitingTimeout).toHaveBeenCalledTimes(1);

      monitor.dispose();
    });

    it("recent PTY data resets the streak (#6667)", () => {
      const onStateChange = vi.fn();
      const onWaitingTimeout = vi.fn();
      const processStateValidator = {
        hasActiveChildren: vi.fn().mockReturnValue(false),
      };
      const monitor = new ActivityMonitor("test-wd-data", 100, onStateChange, {
        processStateValidator,
        onWaitingTimeout,
        maxWaitingSilenceMs: 1000,
      });

      // Two ticks accumulate (count=2 after 10s).
      vi.advanceTimersByTime(10100);
      expect(onWaitingTimeout).not.toHaveBeenCalled();

      // Refreshes lastDataTimestamp without flipping state to busy.
      // OutputVolumeDetector defaults to disabled, so a single small frame
      // doesn't trigger becomeBusyFromOutput.
      monitor.onData("a");

      // Tick at 15000ms: now-lastDataTimestamp ≈ 4900ms < 5000ms → veto resets
      // count to 0. Three more ticks at 20000/25000/30000 each see
      // now-lastDataTimestamp ≥ 5000ms — no veto, count rebuilds to 3, fires.
      vi.advanceTimersByTime(20000);
      expect(onWaitingTimeout).toHaveBeenCalledTimes(1);

      monitor.dispose();
    });

    it("respects waitingWatchdogFailThreshold = 1 (single-tick fire) (#6667)", () => {
      const onStateChange = vi.fn();
      const onWaitingTimeout = vi.fn();
      const processStateValidator = {
        hasActiveChildren: vi.fn().mockReturnValue(false),
      };
      const monitor = new ActivityMonitor("test-wd-thresh1", 100, onStateChange, {
        processStateValidator,
        onWaitingTimeout,
        maxWaitingSilenceMs: 1000,
        waitingWatchdogFailThreshold: 1,
      });

      // One tick post-ceiling fires immediately at threshold=1.
      vi.advanceTimersByTime(5100);
      expect(onWaitingTimeout).toHaveBeenCalledTimes(1);

      monitor.dispose();
    });

    it("clamps waitingWatchdogFailThreshold = 0 to 1 (no logic hole) (#6667)", () => {
      const onStateChange = vi.fn();
      const onWaitingTimeout = vi.fn();
      const processStateValidator = {
        hasActiveChildren: vi.fn().mockReturnValue(false),
      };
      const monitor = new ActivityMonitor("test-wd-thresh0", 100, onStateChange, {
        processStateValidator,
        onWaitingTimeout,
        maxWaitingSilenceMs: 1000,
        waitingWatchdogFailThreshold: 0,
      });

      // Clamped to 1 — fires after the first dead tick, just like threshold=1.
      vi.advanceTimersByTime(5100);
      expect(onWaitingTimeout).toHaveBeenCalledTimes(1);

      monitor.dispose();
    });
  });
});
