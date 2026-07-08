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
    it("should clear debounce timer on dispose", () => {
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("test-1", 1000, onStateChange);

      monitor.onInput("\r");
      monitor.dispose();

      vi.advanceTimersByTime(1500);

      // 2 calls: busy from input + idle from dispose
      expect(onStateChange).toHaveBeenCalledTimes(2);
      expect(onStateChange).toHaveBeenLastCalledWith("test-1", 1000, "idle", {
        trigger: "dispose",
      });
    });

    it("should transition to idle on dispose when busy", () => {
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("test-1", 1000, onStateChange, {
        outputActivityDetection: {
          enabled: true,
          activationThreshold: 1,
          maxBytesPerFrame: 65536,
          leakRatePerMs: 0.001,
        },
      });

      // Press Enter to enter busy state
      monitor.onInput("\r");
      expect(monitor.getState()).toBe("busy");

      monitor.dispose();

      // Dispose emits idle to prevent renderer from staying stuck in "working"
      expect(monitor.getState()).toBe("idle");
      expect(onStateChange).toHaveBeenLastCalledWith("test-1", 1000, "idle", {
        trigger: "dispose",
      });
    });

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

    it("should make dispose idempotent", () => {
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("test-1", 1000, onStateChange);

      monitor.onInput("\r");

      // Multiple dispose calls should not throw
      monitor.dispose();
      monitor.dispose();
      monitor.dispose();

      // First dispose transitions to idle, subsequent calls are no-ops
      expect(monitor.getState()).toBe("idle");
      // Only 2 calls: busy from input + idle from first dispose
      expect(onStateChange).toHaveBeenCalledTimes(2);
    });
  });

  describe("Process state validation", () => {
    it("should work without processStateValidator (backwards compatible)", () => {
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("test-1", 1000, onStateChange, {
        idleDebounceMs: 2500,
      });

      monitor.onInput("\r");
      // Debounce is 2500ms
      vi.advanceTimersByTime(2500);

      expect(onStateChange).toHaveBeenCalledTimes(2);
      expect(onStateChange).toHaveBeenNthCalledWith(2, "test-1", 1000, "idle");

      monitor.dispose();
    });

    it("should trigger busy from Enter key regardless of process state", () => {
      const onStateChange = vi.fn();
      const processStateValidator = {
        hasActiveChildren: vi.fn().mockReturnValue(false),
      };
      const monitor = new ActivityMonitor("test-1", 1000, onStateChange, {
        processStateValidator,
      });

      monitor.onInput("\r");

      expect(onStateChange).toHaveBeenCalledWith("test-1", 1000, "busy", { trigger: "input" });
      expect(monitor.getState()).toBe("busy");

      monitor.dispose();
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
    it("should recover from idle when output occurs without recent user input", () => {
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

      // Wait past the echo window (1000ms) so output is not considered an echo
      vi.advanceTimersByTime(1100);

      // Agent produces autonomous output - should recover to busy
      monitor.onData("agent output starts flowing");

      expect(monitor.getState()).toBe("busy");
      expect(onStateChange).toHaveBeenCalledWith("test-1", 1000, "busy", { trigger: "output" });

      monitor.dispose();
    });

    it("should NOT recover from idle when output is likely a character echo", () => {
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

      // User types a character (sets lastUserInputAt)
      monitor.onInput("h");

      // Echo comes back within echo window - should NOT trigger busy
      monitor.onData("h");

      expect(monitor.getState()).toBe("idle");
      expect(onStateChange).not.toHaveBeenCalled();

      monitor.dispose();
    });

    it("should recover via pattern detection in polling mode without recent input", () => {
      const onStateChange = vi.fn();
      let visibleLines = ["> "];
      const monitor = new ActivityMonitor("test-1", 1000, onStateChange, {
        getVisibleLines: () => visibleLines,
        getCursorLine: () => visibleLines[visibleLines.length - 1],
        idleDebounceMs: 2000,
        workingRecoveryDelayMs: 1500, // Default debounce delay
      });

      monitor.startPolling();
      // Boot completes once prompt is detected
      vi.advanceTimersByTime(100);

      // Go idle by advancing past debounce with prompt visible
      vi.advanceTimersByTime(2200);
      expect(monitor.getState()).toBe("idle");
      onStateChange.mockClear();

      // No recent user input - wait past echo window
      vi.advanceTimersByTime(1100);

      // Agent resumes working - pattern appears and output activity begins
      visibleLines = ["Working... (esc to interrupt)"];
      monitor.onData("agent output chunk 1");
      vi.advanceTimersByTime(50);
      monitor.onData("agent output chunk 2");
      vi.advanceTimersByTime(50);

      // Output activity is enough to recover immediately.
      expect(monitor.getState()).toBe("busy");

      // Continue emitting output to sustain the working signal
      monitor.onData("agent output chunk 3");
      vi.advanceTimersByTime(50);
      monitor.onData("agent output chunk 4");
      vi.advanceTimersByTime(50);
      monitor.onData("agent output chunk 5");
      vi.advanceTimersByTime(50);

      expect(monitor.getState()).toBe("busy");

      // Advance to exceed debounce delay and emit more output
      vi.advanceTimersByTime(1300); // Total ~1550ms sustained (enough to cross 1500ms threshold)
      monitor.onData("agent output chunk 6");
      vi.advanceTimersByTime(50);

      expect(monitor.getState()).toBe("busy");

      monitor.dispose();
    });

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

    it("should recover from brief working pattern output", () => {
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

      // Pattern appears briefly
      visibleLines = ["Working (esc to interrupt)"];
      monitor.onData("brief output");
      vi.advanceTimersByTime(500); // Only 500ms, less than 1500ms threshold

      expect(monitor.getState()).toBe("busy");

      // Pattern disappears
      visibleLines = ["> "];
      vi.advanceTimersByTime(100);

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

    it("should reset debounce timer when working signal disappears", () => {
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

      // Working pattern appears
      visibleLines = ["Working (esc to interrupt)"];
      monitor.onData("output 1");
      vi.advanceTimersByTime(800); // 800ms sustained

      // Pattern disappears (e.g., prompt returns)
      visibleLines = ["> "];
      vi.advanceTimersByTime(200);

      // Pattern reappears
      visibleLines = ["Working again (esc to interrupt)"];
      monitor.onData("output 2");
      vi.advanceTimersByTime(800); // Another 800ms, but timer was reset

      expect(monitor.getState()).toBe("busy");

      // Now sustain for full 1500ms from the reset
      for (let i = 0; i < 15; i++) {
        monitor.onData(`output ${i + 3}`);
        vi.advanceTimersByTime(50);
      }

      // Now should be busy
      expect(monitor.getState()).toBe("busy");

      monitor.dispose();
    });

    it("should use configurable workingRecoveryDelayMs", () => {
      const onStateChange = vi.fn();
      let visibleLines = ["> "];
      const monitor = new ActivityMonitor("test-1", 1000, onStateChange, {
        getVisibleLines: () => visibleLines,
        getCursorLine: () => visibleLines[visibleLines.length - 1],
        workingRecoveryDelayMs: 2000, // Custom 2 second delay
        idleDebounceMs: 2500,
      });

      monitor.startPolling();
      vi.advanceTimersByTime(100); // Boot completes
      vi.advanceTimersByTime(2500); // Go idle
      expect(monitor.getState()).toBe("idle");

      // Sustained working pattern for 1.5 seconds (not enough with 2s threshold)
      visibleLines = ["Working (esc to interrupt)"];
      for (let i = 0; i < 30; i++) {
        monitor.onData(`output ${i}`);
        vi.advanceTimersByTime(50); // 1500ms total
      }

      expect(monitor.getState()).toBe("busy");

      // Continue for another 600ms (total 2100ms)
      for (let i = 0; i < 12; i++) {
        monitor.onData(`output ${i + 30}`);
        vi.advanceTimersByTime(50);
      }

      // Now should be busy
      expect(monitor.getState()).toBe("busy");

      monitor.dispose();
    });
  });

  describe("isHighOutputActivity helper", () => {
    it("should return false when disabled", () => {
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("test-1", 1000, onStateChange, {
        highOutputThreshold: { enabled: false },
      });

      monitor.onData("x".repeat(10000));
      expect(monitor.isHighOutputActivity()).toBe(false);

      monitor.dispose();
    });

    it("should return false when no data has been received", () => {
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("test-1", 1000, onStateChange, {
        highOutputThreshold: { enabled: true, windowMs: 500, bytesPerSecond: 2048 },
      });

      expect(monitor.isHighOutputActivity()).toBe(false);

      monitor.dispose();
    });

    it("should return false when window has expired", () => {
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("test-1", 1000, onStateChange, {
        highOutputThreshold: { enabled: true, windowMs: 500, bytesPerSecond: 2048 },
      });

      monitor.onData("x".repeat(10000));
      vi.advanceTimersByTime(600); // Window expires

      expect(monitor.isHighOutputActivity()).toBe(false);

      monitor.dispose();
    });

    it("should return true when output rate exceeds threshold", () => {
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("test-1", 1000, onStateChange, {
        highOutputThreshold: { enabled: true, windowMs: 500, bytesPerSecond: 2048 },
      });

      // 4KB in short time = high rate
      monitor.onData("x".repeat(4096));
      vi.advanceTimersByTime(100);

      expect(monitor.isHighOutputActivity()).toBe(true);

      monitor.dispose();
    });

    it("should return false when output rate is below threshold", () => {
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("test-1", 1000, onStateChange, {
        highOutputThreshold: { enabled: true, windowMs: 500, bytesPerSecond: 2048 },
      });

      // Small amount of data
      monitor.onData("small");
      vi.advanceTimersByTime(400);

      expect(monitor.isHighOutputActivity()).toBe(false);

      monitor.dispose();
    });
  });
});
