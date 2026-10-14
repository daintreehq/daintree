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

  describe("Disposal", () => {
    it("should stop recursive debounce chain after dispose", () => {
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("test-1", 1000, onStateChange, {
        idleDebounceMs: 1000,
        patternConfig: {
          primaryPatterns: [/working/i],
          scanLineCount: 10,
        },
      });

      // Enter busy → starts debounce chain
      monitor.onInput("\r");
      expect(monitor.getState()).toBe("busy");

      // Working pattern keeps lastPatternResult.isWorking=true, so resetDebounceTimer
      // reschedules instead of firing idle. WORKING_INDICATOR_TTL_MS is 5000ms.
      // Trailing \n keeps onData from treating output as echo of recent input.
      monitor.onData("Working on task...\n");
      expect(monitor.getLastPatternResult()?.isWorking).toBe(true);

      // First debounce fires at 1000ms, reschedules due to fresh working pattern
      vi.advanceTimersByTime(1000);
      expect(monitor.getState()).toBe("busy");

      // Dispose mid-chain — emits idle then stops
      monitor.dispose();
      expect(onStateChange).toHaveBeenLastCalledWith("test-1", 1000, "idle", {
        trigger: "dispose",
      });
      const callCountAfterDispose = onStateChange.mock.calls.length;

      // Advance well past multiple debounce cycles — no further state changes
      vi.advanceTimersByTime(10000);
      expect(onStateChange.mock.calls.length).toBe(callCountAfterDispose);
    });

    it("should ignore onData and onInput calls after dispose", () => {
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("test-1", 1000, onStateChange, {
        outputActivityDetection: {
          enabled: true,
          activationThreshold: 1,
          maxBytesPerFrame: 65536,
          leakRatePerMs: 0.002,
        },
      });

      monitor.dispose();

      // These should be no-ops after disposal — onInput triggers busy,
      // onData with volume detection triggers busy, notifySubmission triggers busy
      monitor.onInput("\r");
      monitor.onData("x".repeat(100));
      monitor.notifySubmission();

      vi.advanceTimersByTime(10000);

      // No state changes should have occurred
      expect(onStateChange).not.toHaveBeenCalled();
    });

    it("should stop polling cycle effects after dispose", () => {
      const onStateChange = vi.fn();
      const getVisibleLines = vi.fn(() => ["$ "]);
      const monitor = new ActivityMonitor("test-1", 1000, onStateChange, {
        getVisibleLines,
        pollingIntervalMs: 50,
      });

      monitor.startPolling();

      // Let a few polling cycles run
      vi.advanceTimersByTime(150);
      const callsBeforeDispose = getVisibleLines.mock.calls.length;
      expect(callsBeforeDispose).toBeGreaterThan(0);

      monitor.dispose();

      // Advance timers — no more getVisibleLines calls
      vi.advanceTimersByTime(500);
      expect(getVisibleLines.mock.calls.length).toBe(callsBeforeDispose);
    });
  });

  describe("High output activity prevention (Issue #1498)", () => {
    it("should prevent idle transition when high output activity is detected", () => {
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("test-1", 1000, onStateChange, {
        highOutputThreshold: {
          enabled: true,
          windowMs: 500,
          bytesPerSecond: 2048,
        },
      });

      // Enter busy state
      monitor.onInput("\r");
      expect(onStateChange).toHaveBeenCalledWith("test-1", 1000, "busy", { trigger: "input" });
      onStateChange.mockClear();

      // Simulate high output (4KB in first call, more than 2KB/sec threshold)
      const highOutput = "x".repeat(4096);
      monitor.onData(highOutput);

      // Advance time but not past the window
      vi.advanceTimersByTime(200);

      // More output to keep the rate high
      monitor.onData(highOutput);

      // Advance to when debounce would normally fire (2500ms)
      vi.advanceTimersByTime(2300);

      // Should still be busy because of high output
      expect(monitor.getState()).toBe("busy");
      // Should NOT have transitioned to idle
      expect(onStateChange).not.toHaveBeenCalledWith("test-1", 1000, "idle");

      monitor.dispose();
    });

    it("should transition to idle when output drops below threshold", () => {
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("test-1", 1000, onStateChange, {
        highOutputThreshold: {
          enabled: true,
          windowMs: 500,
          bytesPerSecond: 2048,
        },
        idleDebounceMs: 2500,
      });

      // Enter busy state
      monitor.onInput("\r");
      onStateChange.mockClear();

      // Send some initial output
      monitor.onData("small output");

      // Advance past the debounce time without more output
      vi.advanceTimersByTime(2600);

      // Should have transitioned to idle (low output)
      expect(monitor.getState()).toBe("idle");
      expect(onStateChange).toHaveBeenCalledWith("test-1", 1000, "idle");

      monitor.dispose();
    });

    it("should maintain busy state as long as high output continues", () => {
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("test-1", 1000, onStateChange, {
        highOutputThreshold: {
          enabled: true,
          windowMs: 500,
          bytesPerSecond: 1024, // 1KB/sec threshold
        },
      });

      // Enter busy state
      monitor.onInput("\r");
      onStateChange.mockClear();

      // Simulate continuous high output over multiple windows
      for (let i = 0; i < 10; i++) {
        monitor.onData("x".repeat(1024)); // 1KB per iteration
        vi.advanceTimersByTime(400); // Less than window duration
      }

      // Should still be busy after 4 seconds of continuous high output
      expect(monitor.getState()).toBe("busy");
      expect(onStateChange).not.toHaveBeenCalled();

      monitor.dispose();
    });

    it("should NOT affect idle transition when high output detection is disabled", () => {
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("test-1", 1000, onStateChange, {
        highOutputThreshold: { enabled: false },
        idleDebounceMs: 2500,
      });

      // Enter busy state
      monitor.onInput("\r");
      onStateChange.mockClear();

      // Send high output
      monitor.onData("x".repeat(10000));

      // Advance past debounce
      vi.advanceTimersByTime(2600);

      // Should have transitioned to idle (feature disabled)
      expect(monitor.getState()).toBe("idle");

      monitor.dispose();
    });

    it("should check high output in polling cycle and prevent idle transition", () => {
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("test-1", 1000, onStateChange, {
        getVisibleLines: () => ["> "],
        getCursorLine: () => "> ",
        highOutputThreshold: {
          enabled: true,
          windowMs: 500,
          bytesPerSecond: 2048,
        },
        initialState: "busy",
        skipInitialStateEmit: true,
        idleDebounceMs: 2000,
      });

      monitor.startPolling();
      expect(monitor.getState()).toBe("busy");

      // Keep sending high output during idle debounce window
      // Each call keeps the high output window active
      for (let i = 0; i < 6; i++) {
        monitor.onData("x".repeat(4096));
        vi.advanceTimersByTime(400); // Keep within window
      }

      // Should still be busy because of high output activity
      expect(monitor.getState()).toBe("busy");
      // Should NOT have transitioned to idle
      expect(onStateChange).not.toHaveBeenCalledWith("test-1", 1000, "idle");

      monitor.dispose();
    });
  });

  describe("High output recovery (Issue #1498)", () => {
    it("should recover from idle state when sustained high output is detected", () => {
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("test-1", 1000, onStateChange, {
        highOutputThreshold: {
          enabled: true,
          windowMs: 500,
          bytesPerSecond: 2048,
          recoveryEnabled: true,
          recoveryDelayMs: 400, // Use shorter delay for testing
        },
        idleDebounceMs: 2500,
      });

      // Enter busy state
      monitor.onInput("\r");
      vi.advanceTimersByTime(2600); // Go idle
      expect(monitor.getState()).toBe("idle");
      onStateChange.mockClear();

      // Start sending sustained high output
      // We need continuous high output that keeps the window fresh
      // and exceeds recoveryDelayMs (400ms)
      const highOutput = "x".repeat(4096);

      // First call starts the tracking
      monitor.onData(highOutput);
      vi.advanceTimersByTime(150);

      // Keep sending data within window to maintain high output rate
      monitor.onData(highOutput);
      vi.advanceTimersByTime(150);

      monitor.onData(highOutput);
      vi.advanceTimersByTime(150); // Total 450ms > recoveryDelayMs of 400ms

      // This call should trigger recovery
      monitor.onData(highOutput);

      // Should have recovered to busy state
      expect(monitor.getState()).toBe("busy");
      expect(onStateChange).toHaveBeenCalledWith("test-1", 1000, "busy", { trigger: "output" });

      monitor.dispose();
    });

    it("should NOT recover when recovery is disabled", () => {
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("test-1", 1000, onStateChange, {
        highOutputThreshold: {
          enabled: true,
          windowMs: 500,
          bytesPerSecond: 2048,
          recoveryEnabled: false, // Disabled
          recoveryDelayMs: 500,
        },
        idleDebounceMs: 2500,
      });

      // Enter busy state then go idle
      monitor.onInput("\r");
      vi.advanceTimersByTime(2600);
      expect(monitor.getState()).toBe("idle");
      onStateChange.mockClear();

      // Send sustained high output
      for (let i = 0; i < 10; i++) {
        monitor.onData("x".repeat(4096));
        vi.advanceTimersByTime(100);
      }

      // Should still be idle (recovery disabled)
      expect(monitor.getState()).toBe("idle");
      expect(onStateChange).not.toHaveBeenCalledWith("test-1", 1000, "busy", { trigger: "output" });

      monitor.dispose();
    });

    it("should NOT recover from brief high output spikes", () => {
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("test-1", 1000, onStateChange, {
        highOutputThreshold: {
          enabled: true,
          windowMs: 500,
          bytesPerSecond: 2048,
          recoveryEnabled: true,
          recoveryDelayMs: 500, // Requires 500ms sustained
        },
        idleDebounceMs: 2500,
      });

      // Enter busy state then go idle
      monitor.onInput("\r");
      vi.advanceTimersByTime(2600);
      expect(monitor.getState()).toBe("idle");
      onStateChange.mockClear();

      // Brief high output spike (less than recovery delay)
      monitor.onData("x".repeat(4096));
      vi.advanceTimersByTime(200);
      monitor.onData("x".repeat(4096));
      vi.advanceTimersByTime(200);
      // Only 400ms of high output, below 500ms threshold

      // Window expires - no more output
      vi.advanceTimersByTime(600);

      // Should still be idle (spike was too brief)
      expect(monitor.getState()).toBe("idle");

      monitor.dispose();
    });

    it("should reset recovery tracking when window expires", () => {
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("test-1", 1000, onStateChange, {
        highOutputThreshold: {
          enabled: true,
          windowMs: 300,
          bytesPerSecond: 2048,
          recoveryEnabled: true,
          recoveryDelayMs: 200, // Shorter than window for easier testing
        },
        idleDebounceMs: 2500,
      });

      // Enter busy state then go idle
      monitor.onInput("\r");
      vi.advanceTimersByTime(2600);
      expect(monitor.getState()).toBe("idle");

      // Send high output that almost reaches recovery delay
      monitor.onData("x".repeat(4096));
      vi.advanceTimersByTime(100);
      monitor.onData("x".repeat(4096));
      vi.advanceTimersByTime(50); // 150ms sustained - just under 200ms threshold

      // Should still be idle (not sustained long enough)
      expect(monitor.getState()).toBe("idle");

      // Wait for window to expire - this resets sustainedHighOutputSince
      vi.advanceTimersByTime(400);

      // Resume high output - sustainedHighOutputSince starts from 0 again
      // First call establishes new window
      monitor.onData("x".repeat(4096));
      vi.advanceTimersByTime(100);

      // Not enough time yet (only 100ms into new tracking)
      expect(monitor.getState()).toBe("idle");

      // Continue to exceed recovery delay in new window
      monitor.onData("x".repeat(4096));
      vi.advanceTimersByTime(120); // Now 220ms > 200ms threshold

      // Next call should trigger recovery
      monitor.onData("x".repeat(4096));

      // Should recover now
      expect(monitor.getState()).toBe("busy");

      monitor.dispose();
    });

    it("should recover in polling mode with sustained high output", () => {
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("test-1", 1000, onStateChange, {
        getVisibleLines: () => ["> "],
        getCursorLine: () => "> ",
        highOutputThreshold: {
          enabled: true,
          windowMs: 500,
          bytesPerSecond: 2048,
          recoveryEnabled: true,
          recoveryDelayMs: 500,
        },
        initialState: "idle",
        skipInitialStateEmit: true,
        idleDebounceMs: 2000,
      });

      monitor.startPolling();
      expect(monitor.getState()).toBe("idle");
      onStateChange.mockClear();

      // Send sustained high output over recovery delay
      const highOutput = "x".repeat(4096);
      for (let i = 0; i < 8; i++) {
        monitor.onData(highOutput);
        vi.advanceTimersByTime(100);
      }

      // Should have recovered to busy state
      expect(monitor.getState()).toBe("busy");
      expect(onStateChange).toHaveBeenCalledWith("test-1", 1000, "busy", { trigger: "output" });

      monitor.dispose();
    });
  });

  describe("Idle→busy recovery from autonomous output (Issue #2185)", () => {
    it("should NOT recover via pattern when user is actively typing (echo window)", () => {
      const onStateChange = vi.fn();
      const visibleLines = ["✽ Deliberating (esc to interrupt)", "> "];
      const monitor = new ActivityMonitor("test-1", 1000, onStateChange, {
        getVisibleLines: () => visibleLines,
        getCursorLine: () => visibleLines[visibleLines.length - 1],
        initialState: "idle",
        skipInitialStateEmit: true,
        idleDebounceMs: 2000,
      });

      monitor.startPolling();
      expect(monitor.getState()).toBe("idle");
      onStateChange.mockClear();

      // User is typing (sets lastUserInputAt)
      monitor.onInput("h");
      monitor.onData("h"); // Echo

      // Stale working pattern visible + recent input = should NOT trigger busy
      vi.advanceTimersByTime(100);

      expect(monitor.getState()).toBe("idle");

      monitor.dispose();
    });

    it("should recover after echo window expires even if user typed recently", () => {
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

      // Enter busy, then go idle
      monitor.onInput("\r");
      vi.advanceTimersByTime(2600);
      expect(monitor.getState()).toBe("idle");
      onStateChange.mockClear();

      // User types
      monitor.onInput("h");

      // Wait past echo window
      vi.advanceTimersByTime(1100);

      // Now agent output should trigger recovery
      monitor.onData("autonomous agent output");

      expect(monitor.getState()).toBe("busy");
      expect(onStateChange).toHaveBeenCalledWith("test-1", 1000, "busy", { trigger: "output" });

      monitor.dispose();
    });
  });

  describe("Working signal recovery debouncing (Issue #2215)", () => {
    it("should recover from a single non-protocol output event", () => {
      const onStateChange = vi.fn();
      const visibleLines = ["> "];
      const monitor = new ActivityMonitor("test-1", 1000, onStateChange, {
        getVisibleLines: () => visibleLines,
        getCursorLine: () => visibleLines[visibleLines.length - 1],
        workingRecoveryDelayMs: 1500,
        idleDebounceMs: 2500,
      });

      monitor.startPolling();
      vi.advanceTimersByTime(100); // Boot completes
      vi.advanceTimersByTime(2500); // Go idle
      expect(monitor.getState()).toBe("idle");

      // Single ANSI escape sequence (e.g., from terminal reflow)
      monitor.onData("\x1b[0m");
      vi.advanceTimersByTime(200);

      expect(monitor.getState()).toBe("busy");

      monitor.dispose();
    });

    it("should recover from sustained working signal (1.5+ seconds)", () => {
      const onStateChange = vi.fn();
      let visibleLines = ["> "];
      const monitor = new ActivityMonitor("test-1", 1000, onStateChange, {
        getVisibleLines: () => visibleLines,
        getCursorLine: () => visibleLines[visibleLines.length - 1],
        workingRecoveryDelayMs: 1500,
        idleDebounceMs: 2500,
      });

      monitor.startPolling();
      vi.advanceTimersByTime(100); // Boot completes
      vi.advanceTimersByTime(2500); // Go idle
      expect(monitor.getState()).toBe("idle");
      onStateChange.mockClear();

      // Sustained working pattern
      visibleLines = ["Processing (esc to interrupt)"];
      for (let i = 0; i < 35; i++) {
        monitor.onData(`output chunk ${i}`);
        vi.advanceTimersByTime(50); // 35 * 50 = 1750ms total
      }

      // Should now be busy after sustained signal
      expect(monitor.getState()).toBe("busy");
      expect(onStateChange).toHaveBeenCalledWith("test-1", 1000, "busy", {
        trigger: "output",
      });

      monitor.dispose();
    });

    it("should NOT apply debouncing during initial boot phase", () => {
      const onStateChange = vi.fn();
      const visibleLines = ["Starting (esc to interrupt)"];
      const monitor = new ActivityMonitor("test-1", 1000, onStateChange, {
        getVisibleLines: () => visibleLines,
        getCursorLine: () => visibleLines[visibleLines.length - 1],
        workingRecoveryDelayMs: 1500,
      });

      monitor.startPolling();

      // During boot, even a single poll cycle with working signal should trigger busy immediately
      vi.advanceTimersByTime(50);

      // Should be busy immediately (no debouncing during boot)
      expect(monitor.getState()).toBe("busy");

      monitor.dispose();
    });
  });
});
