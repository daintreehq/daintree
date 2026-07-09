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

  describe("Prompt-driven polling", () => {
    it("should transition to idle when prompt is visible", () => {
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("test-1", 1000, onStateChange, {
        getVisibleLines: () => ["> "],
        getCursorLine: () => "> ",
        idleDebounceMs: 2000,
      });

      monitor.startPolling();

      vi.advanceTimersByTime(2200);

      expect(onStateChange).toHaveBeenCalledWith(
        "test-1",
        1000,
        "idle",
        expect.objectContaining({ trigger: expect.any(String) })
      );

      monitor.dispose();
    });

    it("should ignore prompt-like history when cursor line is active output", () => {
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("test-1", 1000, onStateChange, {
        getVisibleLines: () => ["> prompt", "working output"],
        getCursorLine: () => "working output",
        bootCompletePatterns: [/working output/i],
        initialState: "busy",
        skipInitialStateEmit: true,
        idleDebounceMs: 2000,
      });

      monitor.startPolling();

      vi.advanceTimersByTime(600);

      expect(onStateChange).not.toHaveBeenCalledWith("test-1", 1000, "idle");

      monitor.dispose();
    });

    it("should accept prompt hints even when cursor line is active output", () => {
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("test-1", 1000, onStateChange, {
        getVisibleLines: () => ["100% context left ? for shortcuts", "working output"],
        getCursorLine: () => "working output",
        promptHintPatterns: [/context left/i],
        initialState: "busy",
        skipInitialStateEmit: true,
        idleDebounceMs: 2000,
      });

      monitor.startPolling();

      vi.advanceTimersByTime(2200);

      expect(onStateChange).toHaveBeenCalledWith(
        "test-1",
        1000,
        "idle",
        expect.objectContaining({ trigger: expect.any(String) })
      );

      monitor.dispose();
    });

    it("should detect universal approval prompt and transition to idle", () => {
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("test-1", 1000, onStateChange, {
        getVisibleLines: () => [
          "Daintree wants to run: rm -rf /tmp",
          "Approve Once",
          "Approve This Session",
          "Reject",
        ],
        getCursorLine: () => "",
        promptHintPatterns: [/approve\s+once/i, /approve\s+this\s+session/i],
        initialState: "busy",
        skipInitialStateEmit: true,
        idleDebounceMs: 2000,
      });

      monitor.startPolling();

      vi.advanceTimersByTime(2200);

      expect(onStateChange).toHaveBeenCalledWith(
        "test-1",
        1000,
        "idle",
        expect.objectContaining({ trigger: expect.any(String) })
      );

      monitor.dispose();
    });

    it("should transition to idle after sustained quiet without prompt", () => {
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("test-1", 1000, onStateChange, {
        getVisibleLines: () => ["> prompt", "working output"],
        getCursorLine: () => "working output",
        bootCompletePatterns: [/working output/i],
        initialState: "busy",
        skipInitialStateEmit: true,
        idleDebounceMs: 2000,
      });

      monitor.startPolling();

      vi.advanceTimersByTime(2200);

      expect(onStateChange).toHaveBeenCalledWith(
        "test-1",
        1000,
        "idle",
        expect.objectContaining({ trigger: expect.any(String) })
      );

      monitor.dispose();
    });

    it("should settle to idle after quiet even with stale working patterns", () => {
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("test-1", 1000, onStateChange, {
        agentId: "claude",
        getVisibleLines: () => ["✽ Deliberating (esc to interrupt)", "> "],
        getCursorLine: () => "> ",
        initialState: "busy",
        skipInitialStateEmit: true,
        idleDebounceMs: 2000,
      });

      monitor.startPolling();

      vi.advanceTimersByTime(2200);

      expect(onStateChange).toHaveBeenCalledWith(
        "test-1",
        1000,
        "idle",
        expect.objectContaining({ trigger: expect.any(String) })
      );

      monitor.dispose();
    });

    it("should delay busy on Enter until confirmation window expires", () => {
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("test-1", 1000, onStateChange, {
        getVisibleLines: () => [""],
        getCursorLine: () => "",
        initialState: "idle",
        skipInitialStateEmit: true,
      });

      monitor.startPolling();
      monitor.onInput("\r");

      vi.advanceTimersByTime(500);
      expect(onStateChange).not.toHaveBeenCalledWith("test-1", 1000, "busy", {
        trigger: "input",
      });

      vi.advanceTimersByTime(700);
      expect(onStateChange).toHaveBeenCalledWith("test-1", 1000, "busy", {
        trigger: "input",
      });

      monitor.dispose();
    });

    it("should enter busy immediately after non-empty input (Issue #1638)", () => {
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("test-1", 1000, onStateChange, {
        getVisibleLines: () => ["> "],
        getCursorLine: () => "> ",
        initialState: "idle",
        skipInitialStateEmit: true,
      });

      monitor.startPolling();
      monitor.onInput("ls");
      monitor.onInput("\r");

      // Non-empty Enter should immediately transition to busy (Issue #1638)
      expect(onStateChange).toHaveBeenCalledWith("test-1", 1000, "busy", {
        trigger: "input",
      });

      monitor.dispose();
    });

    it("should not enter busy when prompt appears during input confirmation", () => {
      const onStateChange = vi.fn();
      let showPrompt = false;
      const monitor = new ActivityMonitor("test-1", 1000, onStateChange, {
        getVisibleLines: () => (showPrompt ? ["> "] : [""]),
        getCursorLine: () => (showPrompt ? "> " : ""),
        initialState: "idle",
        skipInitialStateEmit: true,
      });

      monitor.startPolling();
      monitor.onInput("\r");

      showPrompt = true;
      vi.advanceTimersByTime(600);

      expect(onStateChange).not.toHaveBeenCalledWith("test-1", 1000, "busy", {
        trigger: "input",
      });

      monitor.dispose();
    });
  });

  describe("Debounce timer (idle transition)", () => {
    it("should transition to idle after debounce period", () => {
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("test-1", 1000, onStateChange);

      monitor.onInput("\r");
      expect(onStateChange).toHaveBeenCalledTimes(1);

      // Default debounce is 4000ms
      vi.advanceTimersByTime(4000);

      expect(onStateChange).toHaveBeenCalledTimes(2);
      expect(onStateChange).toHaveBeenNthCalledWith(2, "test-1", 1000, "idle");

      monitor.dispose();
    });

    it("should reset debounce timer on continued output while busy", () => {
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("test-1", 1000, onStateChange, {
        idleDebounceMs: 2500,
      });

      monitor.onInput("\r");
      expect(onStateChange).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(2000);
      monitor.onData("some output");

      vi.advanceTimersByTime(2000);

      // Still busy - output reset the timer
      expect(onStateChange).toHaveBeenCalledTimes(1);

      // Complete remaining 500ms to reach 2500ms debounce
      vi.advanceTimersByTime(500);

      expect(onStateChange).toHaveBeenCalledTimes(2);
      expect(onStateChange).toHaveBeenNthCalledWith(2, "test-1", 1000, "idle");

      monitor.dispose();
    });

    it("should not fire duplicate busy state changes", () => {
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("test-1", 1000, onStateChange);

      monitor.onInput("\r");
      monitor.onInput("\r");
      monitor.onInput("\r");

      expect(onStateChange).toHaveBeenCalledTimes(1);

      monitor.dispose();
    });

    it("should not fire duplicate busy from output after Enter", () => {
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("test-1", 1000, onStateChange, {
        outputActivityDetection: {
          enabled: true,
          activationThreshold: 1,
          maxBytesPerFrame: 65536,
          leakRatePerMs: 0.001,
        },
      });

      // Press Enter first to allow output-based busy
      monitor.onInput("\r");
      expect(onStateChange).toHaveBeenCalledWith("test-1", 1000, "busy", { trigger: "input" });

      // Multiple outputs should not fire duplicate busy calls
      monitor.onData("output1");
      monitor.onData("output2");
      monitor.onData("output3");

      // Only the initial input-triggered busy should have been called
      expect(onStateChange).toHaveBeenCalledTimes(1);

      monitor.dispose();
    });

    it("should not transition to idle mid-stream when pattern buffer evicts working indicator (Issue #3540)", () => {
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("test-1", 1000, onStateChange, {
        patternConfig: {
          primaryPatterns: [/esc to interrupt/i],
        },
        patternBufferSize: 2000,
        idleDebounceMs: 2500,
      });

      // Go busy via input
      monitor.onInput("\r");
      expect(onStateChange).toHaveBeenCalledTimes(1);
      expect(onStateChange).toHaveBeenCalledWith("test-1", 1000, "busy", {
        trigger: "input",
      });

      // Send data containing the working indicator — stamps lastWorkingIndicatorTimestamp
      monitor.onData("\nesc to interrupt\n");
      vi.advanceTimersByTime(500);

      // Send a large data burst that evicts the working indicator from the
      // pattern buffer — must exceed 2x patternBufferSize (the buffer trims
      // lazily at 2x capacity) so the trim actually fires.
      monitor.onData("x".repeat(5000));

      // Verify the buffer eviction actually happened
      expect(monitor.getLastPatternResult()?.isWorking).toBe(false);

      vi.advanceTimersByTime(500);

      // Pattern buffer no longer contains "esc to interrupt", so lastPatternResult.isWorking is false.
      // Without the fix, the next debounce firing would transition to idle.
      // Wait for the debounce to fire (2500ms from last data)
      vi.advanceTimersByTime(2500);

      // With the fix: TTL guard keeps the timer alive because lastWorkingIndicatorTimestamp
      // is within WORKING_INDICATOR_TTL_MS (5000ms)
      expect(onStateChange).toHaveBeenCalledTimes(1); // still only the initial busy

      // Now wait long enough for the TTL to expire (5000ms total from when indicator was last seen)
      // The indicator was seen at ~t=0+small offset. We've advanced ~3500ms so far.
      // Advance another 5000ms to ensure TTL expires and the debounce fires without extension.
      vi.advanceTimersByTime(5000);

      expect(onStateChange).toHaveBeenCalledTimes(2);
      expect(onStateChange).toHaveBeenNthCalledWith(2, "test-1", 1000, "idle");

      monitor.dispose();
    });

    it("should not transition to idle mid-stream with default 10k pattern buffer (Issue #3550)", () => {
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("test-1", 1000, onStateChange, {
        patternConfig: {
          primaryPatterns: [/esc to interrupt/i],
        },
        idleDebounceMs: 2500,
      });

      // Go busy via input
      monitor.onInput("\r");
      expect(onStateChange).toHaveBeenCalledTimes(1);

      // Send data containing the working indicator
      monitor.onData("\nesc to interrupt\n");
      vi.advanceTimersByTime(100);

      // Send a large data burst (>2000 chars) that would have evicted the working indicator
      // from the old 2000-char buffer but NOT from the new 10000-char buffer
      monitor.onData("x".repeat(5000));

      // Pattern should still be found in the enlarged buffer
      expect(monitor.getLastPatternResult()?.isWorking).toBe(true);

      monitor.dispose();
    });
  });

  describe("Mixed input and output activity", () => {
    it("should maintain busy state with mixed input and output", () => {
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("test-1", 1000, onStateChange, {
        idleDebounceMs: 2500,
      });

      monitor.onInput("\r");
      expect(onStateChange).toHaveBeenCalledWith("test-1", 1000, "busy", { trigger: "input" });

      vi.advanceTimersByTime(500);
      monitor.onData("output data");

      vi.advanceTimersByTime(500);
      monitor.onData("more output");

      vi.advanceTimersByTime(500);
      monitor.onData("even more");

      expect(onStateChange).toHaveBeenCalledTimes(1);

      // Debounce is 2500ms
      vi.advanceTimersByTime(2500);

      expect(onStateChange).toHaveBeenCalledTimes(2);
      expect(onStateChange).toHaveBeenNthCalledWith(2, "test-1", 1000, "idle");

      monitor.dispose();
    });

    it("should NOT re-enter busy from idle via output during echo window - Issue #1476", () => {
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("test-1", 1000, onStateChange, {
        outputActivityDetection: {
          enabled: true,
          activationThreshold: 1,
          maxBytesPerFrame: 65536,
          leakRatePerMs: 0.001,
        },
        idleDebounceMs: 2500,
      });

      monitor.onInput("\r");
      expect(onStateChange).toHaveBeenCalledWith("test-1", 1000, "busy", { trigger: "input" });

      // Debounce is 2500ms
      vi.advanceTimersByTime(2500);
      expect(onStateChange).toHaveBeenNthCalledWith(2, "test-1", 1000, "idle");

      // User types while idle (sets recent input timestamp)
      monitor.onInput("h");

      // Output during echo window should NOT re-trigger busy
      monitor.onData("h");

      expect(onStateChange).toHaveBeenCalledTimes(2); // Only initial busy and idle
      expect(monitor.getState()).toBe("idle");

      monitor.dispose();
    });

    it("should re-enter busy when Enter is pressed again after going idle", () => {
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("test-1", 1000, onStateChange, {
        outputActivityDetection: {
          enabled: true,
          activationThreshold: 1,
          maxBytesPerFrame: 65536,
          leakRatePerMs: 0.001,
        },
        idleDebounceMs: 2500,
      });

      monitor.onInput("\r");
      expect(onStateChange).toHaveBeenCalledWith("test-1", 1000, "busy", { trigger: "input" });

      // Debounce is 2500ms
      vi.advanceTimersByTime(2500);
      expect(onStateChange).toHaveBeenNthCalledWith(2, "test-1", 1000, "idle");

      // Press Enter again to start a new work cycle
      monitor.onInput("\r");

      expect(onStateChange).toHaveBeenCalledTimes(3);
      expect(onStateChange).toHaveBeenLastCalledWith("test-1", 1000, "busy", {
        trigger: "input",
      });

      monitor.dispose();
    });
  });

  describe("Hysteresis — false entry prevention (Issue #3550)", () => {
    it("should NOT enter working from plain carriage-return burst without spinner content", () => {
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("test-1", 1000, onStateChange);

      // Simulate a shell prompt redraw: bare \r without matching STATUS_LINE_PATTERNS
      monitor.onData("\r> ");
      vi.advanceTimersByTime(50);
      monitor.onData("\r> ");
      vi.advanceTimersByTime(50);
      monitor.onData("\r> ");

      // Plain prompt redraws must not trigger busy
      expect(monitor.getState()).toBe("idle");
      expect(onStateChange).not.toHaveBeenCalled();

      monitor.dispose();
    });

    it("should NOT enter working from ANSI cursor-up escape sequences without spinner content", () => {
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("test-1", 1000, onStateChange);

      // Simulate terminal reflow with cursor movement but no spinner patterns
      monitor.onData("\x1b[2K\r$ ");
      vi.advanceTimersByTime(50);
      monitor.onData("\x1b[2K\r$ ");

      expect(monitor.getState()).toBe("idle");
      expect(onStateChange).not.toHaveBeenCalled();

      monitor.dispose();
    });

    it("should stay busy until idle debounce expires during LLM API silence gap (Issue #3550)", () => {
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("test-1", 1000, onStateChange);

      // Enter busy via input
      monitor.onInput("\r");
      expect(monitor.getState()).toBe("busy");
      onStateChange.mockClear();

      // Simulate 3.9 seconds of complete silence (LLM API call in progress)
      vi.advanceTimersByTime(3900);

      // Should still be busy — 3.9s is within the 4000ms default debounce
      expect(monitor.getState()).toBe("busy");
      expect(onStateChange).not.toHaveBeenCalled();

      // After 4000ms (default debounce) it goes idle
      vi.advanceTimersByTime(200);
      expect(onStateChange).toHaveBeenCalledWith("test-1", 1000, "idle");

      monitor.dispose();
    });

    it("should transition idle quickly via prompt fast-path in polling mode after working (Issue #3550)", () => {
      const onStateChange = vi.fn();
      let visibleLines = ["Working... (esc to interrupt)"];
      const monitor = new ActivityMonitor("test-1", 1000, onStateChange, {
        getVisibleLines: () => visibleLines,
        getCursorLine: () => visibleLines[visibleLines.length - 1],
        initialState: "busy",
        skipInitialStateEmit: true,
        idleDebounceMs: 4000,
        pollingIntervalMs: 50,
      });

      monitor.startPolling();
      expect(monitor.getState()).toBe("busy");
      onStateChange.mockClear();

      // Agent finishes — prompt appears
      visibleLines = ["> "];
      vi.advanceTimersByTime(100); // Boot detection

      // The prompt fast-path requires at least 3000ms of quiet output before firing,
      // to avoid misfiring during inter-tool-call gaps (Issue #3606).
      // Wait 3100ms to exceed both the 3000ms quiet threshold and 1500ms working hold.
      vi.advanceTimersByTime(3100);

      // Should have gone idle via prompt fast-path, well before the 4000ms debounce
      expect(monitor.getState()).toBe("idle");
      expect(onStateChange).toHaveBeenCalledWith(
        "test-1",
        1000,
        "idle",
        expect.objectContaining({ trigger: expect.any(String) })
      );

      monitor.dispose();
    });
  });

  describe("Agent state jitter prevention (Issue #3606)", () => {
    it("should not jitter between busy and idle during multi-step agent work with inter-tool-call gaps", () => {
      const onStateChange = vi.fn();
      let visibleLines: string[] = ["Working... (esc to interrupt)"];
      const monitor = new ActivityMonitor("test-1", 1000, onStateChange, {
        getVisibleLines: () => visibleLines,
        getCursorLine: () => visibleLines[visibleLines.length - 1],
        idleDebounceMs: 4000,
        pollingIntervalMs: 50,
        pollingMaxBootMs: 0,
      });

      monitor.startPolling();
      // Boot immediately exits, enters busy via working pattern + output
      monitor.onData("Working on tool call...\n");
      vi.advanceTimersByTime(100);
      expect(monitor.getState()).toBe("busy");
      onStateChange.mockClear();

      // Simulate inter-tool-call gap: prompt briefly visible for 1.5s
      visibleLines = ["> "];
      vi.advanceTimersByTime(1500);

      // Should still be busy — 1.5s gap is within 1500ms working hold
      expect(monitor.getState()).toBe("busy");
      const idleCalls = onStateChange.mock.calls.filter((call) => call[2] === "idle");
      expect(idleCalls.length).toBe(0);

      // Agent resumes work — output refreshes lastActivityTimestamp, pattern refreshes hold
      visibleLines = ["Running tool... (esc to interrupt)"];
      monitor.onData("Running next tool...\n");
      vi.advanceTimersByTime(500);

      // Should remain busy and hold window is now extended
      expect(monitor.getState()).toBe("busy");

      // Another inter-tool-call gap of 2.4s
      visibleLines = ["> "];
      vi.advanceTimersByTime(2400);

      // Should still be busy — hold was refreshed by working signal, and
      // prompt fast-path needs 3000ms quiet (last data was ~1600ms ago, < 3000ms)
      expect(monitor.getState()).toBe("busy");
      const idleCalls2 = onStateChange.mock.calls.filter((call) => call[2] === "idle");
      expect(idleCalls2.length).toBe(0);

      monitor.dispose();
    });

    it("should transition to idle after genuine quiet period exceeds 3s with prompt visible", () => {
      const onStateChange = vi.fn();
      let visibleLines: string[] = ["Working... (esc to interrupt)"];
      const monitor = new ActivityMonitor("test-1", 1000, onStateChange, {
        getVisibleLines: () => visibleLines,
        getCursorLine: () => visibleLines[visibleLines.length - 1],
        idleDebounceMs: 4000,
        pollingIntervalMs: 50,
        pollingMaxBootMs: 0,
      });

      monitor.startPolling();
      vi.advanceTimersByTime(100);
      expect(monitor.getState()).toBe("busy");

      // Simulate final output right before agent finishes
      vi.advanceTimersByTime(900);
      monitor.onData("Done.\n");
      onStateChange.mockClear();

      // Agent finishes — prompt appears (quiet starts at 1000ms from lastActivityTimestamp)
      visibleLines = ["> "];

      // At 2800ms after last data: below 3000ms fast-path quiet threshold
      vi.advanceTimersByTime(2800);
      expect(monitor.getState()).toBe("busy");

      // At 3100ms after last data: exceeds 3000ms quiet threshold
      vi.advanceTimersByTime(300);
      expect(monitor.getState()).toBe("idle");
      const idleCalls = onStateChange.mock.calls.filter((call) => call[2] === "idle");
      expect(idleCalls.length).toBeGreaterThan(0);

      monitor.dispose();
    });

    it("resets the configured waiting quiet window on tiny output while prompt is visible", () => {
      vi.setSystemTime(0);
      const onStateChange = vi.fn();
      let visibleLines: string[] = ["Working..."];
      const monitor = new ActivityMonitor("agent-quiet-reset", 1000, onStateChange, {
        getVisibleLines: () => visibleLines,
        getCursorLine: () => visibleLines[visibleLines.length - 1],
        initialState: "busy",
        skipInitialStateEmit: true,
        idleDebounceMs: 6000,
        promptFastPathMinQuietMs: 6000,
        pollingIntervalMs: 100,
        pollingMaxBootMs: 0,
      });

      monitor.onData("initial output\n");
      monitor.startPolling();
      visibleLines = ["> "];
      onStateChange.mockClear();

      vi.advanceTimersByTime(5900);
      expect(monitor.getState()).toBe("busy");
      expect(onStateChange.mock.calls.some((call) => call[2] === "idle")).toBe(false);

      monitor.onData(".");
      vi.advanceTimersByTime(5900);
      expect(monitor.getState()).toBe("busy");
      expect(onStateChange.mock.calls.some((call) => call[2] === "idle")).toBe(false);

      vi.advanceTimersByTime(200);
      expect(monitor.getState()).toBe("idle");
      expect(onStateChange.mock.calls.some((call) => call[2] === "idle")).toBe(true);

      monitor.dispose();
    });

    it("should recover from idle to busy with explicit short recovery delay", () => {
      const onStateChange = vi.fn();
      let visibleLines: string[] = ["> "];
      const monitor = new ActivityMonitor("test-1", 1000, onStateChange, {
        getVisibleLines: () => visibleLines,
        getCursorLine: () => visibleLines[visibleLines.length - 1],
        idleDebounceMs: 4000,
        pollingIntervalMs: 50,
        workingRecoveryDelayMs: 300,
        pollingMaxBootMs: 0,
      });

      monitor.startPolling();
      // Boot immediately exits (pollingMaxBootMs: 0), then idle after 3000ms prompt fast-path quiet
      vi.advanceTimersByTime(3200);
      expect(monitor.getState()).toBe("idle");
      onStateChange.mockClear();

      // Agent starts working — working pattern appears
      visibleLines = ["Working... (esc to interrupt)"];

      // Brief noise below 300ms should not trigger recovery
      vi.advanceTimersByTime(200);
      visibleLines = ["> "];
      vi.advanceTimersByTime(50);

      // Should still be idle — noise was too brief
      expect(monitor.getState()).toBe("idle");

      // Sustained working signal for >300ms
      visibleLines = ["Working... (esc to interrupt)"];
      vi.advanceTimersByTime(350);

      // Should have recovered to busy
      expect(monitor.getState()).toBe("busy");

      monitor.dispose();
    });

    it("should transition to working on the first post-wait output chunk", () => {
      const onStateChange = vi.fn();
      let visibleLines: string[] = ["> "];
      const monitor = new ActivityMonitor("test-1", 1000, onStateChange, {
        getVisibleLines: () => visibleLines,
        getCursorLine: () => visibleLines[visibleLines.length - 1],
        idleDebounceMs: 4000,
        pollingIntervalMs: 50,
        pollingMaxBootMs: 0,
        // No explicit workingRecoveryDelayMs — uses the new 1500ms default
      });

      monitor.startPolling();
      // Boot exits immediately, then idle after prompt fast-path quiet
      vi.advanceTimersByTime(3200);
      expect(monitor.getState()).toBe("idle");
      onStateChange.mockClear();

      // Simulate layout-shift burst: working patterns appear for ~300ms
      // with onData() to simulate terminal content changes
      visibleLines = ["Working... (esc to interrupt)"];
      monitor.onData("Working... (esc to interrupt)\r\n");
      vi.advanceTimersByTime(150);
      monitor.onData(" ");
      vi.advanceTimersByTime(150);

      // Layout shift ends — prompt reappears
      visibleLines = ["> "];
      vi.advanceTimersByTime(50);

      // Any non-protocol PTY output means the agent is working again.
      expect(monitor.getState()).toBe("busy");
      expect(onStateChange.mock.calls.filter((call) => call[2] === "busy")).toHaveLength(1);

      // Now simulate sustained agent work for >1500ms with periodic data
      onStateChange.mockClear();
      visibleLines = ["Working... (esc to interrupt)"];
      for (let i = 0; i < 16; i++) {
        monitor.onData(".");
        vi.advanceTimersByTime(100);
      }

      // Should have recovered to busy
      expect(monitor.getState()).toBe("busy");

      monitor.dispose();
    });
  });
});
