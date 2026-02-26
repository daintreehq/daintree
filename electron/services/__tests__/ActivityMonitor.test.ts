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

  describe("setPollingInterval", () => {
    it("should reschedule polling without resetting state", () => {
      const onStateChange = vi.fn();
      const getVisibleLines = vi.fn(() => []);
      const monitor = new ActivityMonitor("test-1", 100, onStateChange, {
        getVisibleLines,
        pollingIntervalMs: 100,
      });

      monitor.startPolling();

      // Initial polling should be at 100ms
      vi.advanceTimersByTime(100);
      const initialCallCount = getVisibleLines.mock.calls.length;

      // Change polling to 500ms
      monitor.setPollingInterval(500);

      // Verify polling continues at new interval
      vi.advanceTimersByTime(500);
      expect(getVisibleLines.mock.calls.length).toBeGreaterThan(initialCallCount);
    });

    it("should short-circuit if interval unchanged", () => {
      const onStateChange = vi.fn();
      const getVisibleLines = vi.fn(() => []);
      const monitor = new ActivityMonitor("test-1", 100, onStateChange, {
        getVisibleLines,
        pollingIntervalMs: 100,
      });

      monitor.startPolling();

      // Spy on clearInterval to verify it's not called
      const clearIntervalSpy = vi.spyOn(global, "clearInterval");

      // Set same interval
      monitor.setPollingInterval(100);

      expect(clearIntervalSpy).not.toHaveBeenCalled();
    });

    it("should apply tier-driven polling changes (50ms active, 500ms background)", () => {
      const onStateChange = vi.fn();
      const getVisibleLines = vi.fn(() => []);
      const monitor = new ActivityMonitor("test-1", 50, onStateChange, {
        getVisibleLines,
        pollingIntervalMs: 50,
      });

      monitor.startPolling();

      // Active tier: 50ms polling
      vi.advanceTimersByTime(50);

      // Switch to background tier: 500ms polling
      monitor.setPollingInterval(500);
      getVisibleLines.mockClear();

      // Verify new interval takes effect
      vi.advanceTimersByTime(500);
      expect(getVisibleLines).toHaveBeenCalled();
    });
  });

  describe("Input-driven activity", () => {
    it("should transition to busy on Enter key", () => {
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("test-1", 1000, onStateChange);

      monitor.onInput("\r");

      expect(onStateChange).toHaveBeenCalledWith("test-1", 1000, "busy", { trigger: "input" });
    });

    it("should transition to busy on newline", () => {
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("test-1", 1000, onStateChange);

      monitor.onInput("\n");

      expect(onStateChange).toHaveBeenCalledWith("test-1", 1000, "busy", { trigger: "input" });
    });

    it("should ignore bracketed paste sequences", () => {
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("test-1", 1000, onStateChange);

      monitor.onInput("\x1b[200~");
      monitor.onInput("pasted\ntext\n");
      monitor.onInput("\x1b[201~");

      expect(onStateChange).not.toHaveBeenCalled();
    });

    it("should trigger busy after paste ends on next Enter", () => {
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("test-1", 1000, onStateChange);

      monitor.onInput("\x1b[200~");
      monitor.onInput("pasted\n");
      monitor.onInput("\x1b[201~");
      monitor.onInput("\r");

      expect(onStateChange).toHaveBeenCalledWith("test-1", 1000, "busy", { trigger: "input" });
    });

    it("should ignore configured input sequences", () => {
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("test-1", 1000, onStateChange, {
        ignoredInputSequences: ["\x1b\r"],
      });

      monitor.onInput("\x1b\r");

      expect(onStateChange).not.toHaveBeenCalled();
    });

    it("should detect Enter after escape sequences", () => {
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("test-1", 1000, onStateChange);

      monitor.onInput("\x1b[A\r");

      expect(onStateChange).toHaveBeenCalledWith("test-1", 1000, "busy", { trigger: "input" });
    });

    it("should ignore split ignored input sequences", () => {
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("test-1", 1000, onStateChange, {
        ignoredInputSequences: ["\x1b\r"],
      });

      monitor.onInput("\x1b");
      monitor.onInput("\r");

      expect(onStateChange).not.toHaveBeenCalled();
    });

    it("should NOT trigger busy on typing without Enter", () => {
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("test-1", 1000, onStateChange);

      // Type several characters without pressing Enter
      monitor.onInput("h");
      monitor.onInput("e");
      monitor.onInput("l");
      monitor.onInput("l");
      monitor.onInput("o");

      expect(onStateChange).not.toHaveBeenCalled();
      expect(monitor.getState()).toBe("idle");

      monitor.dispose();
    });

    it("should NOT trigger busy on typing a full word without Enter", () => {
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("test-1", 1000, onStateChange);

      // Type a full command string without pressing Enter
      monitor.onInput("npm run test");

      expect(onStateChange).not.toHaveBeenCalled();
      expect(monitor.getState()).toBe("idle");

      monitor.dispose();
    });

    it("should trigger busy only when Enter is pressed after typing", () => {
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("test-1", 1000, onStateChange);

      // Type without Enter - should not trigger
      monitor.onInput("hello world");
      expect(onStateChange).not.toHaveBeenCalled();

      // Press Enter - should trigger
      monitor.onInput("\r");
      expect(onStateChange).toHaveBeenCalledWith("test-1", 1000, "busy", { trigger: "input" });

      monitor.dispose();
    });

    it("should NOT trigger busy on empty Enter submission (polling mode)", () => {
      const onStateChange = vi.fn();
      const showPrompt = true;
      const monitor = new ActivityMonitor("test-1", 1000, onStateChange, {
        getVisibleLines: () => (showPrompt ? ["> "] : [""]),
        getCursorLine: () => (showPrompt ? "> " : ""),
        initialState: "idle",
        skipInitialStateEmit: true,
      });

      monitor.startPolling();

      // Press Enter with no prior text input (empty submission)
      monitor.onInput("\r");

      // Prompt is still visible, empty submission should NOT trigger busy
      vi.advanceTimersByTime(1200);

      expect(onStateChange).not.toHaveBeenCalledWith("test-1", 1000, "busy", {
        trigger: "input",
      });

      monitor.dispose();
    });

    it("should NOT trigger busy on Shift+Enter (soft newline ESC+CR)", () => {
      const onStateChange = vi.fn();
      // Configure with ESC+CR as ignored (Claude/Gemini style)
      const monitor = new ActivityMonitor("test-1", 1000, onStateChange, {
        ignoredInputSequences: ["\x1b\r"],
      });

      // Type some text
      monitor.onInput("line 1");
      // Press Shift+Enter (ESC+CR) - should NOT trigger busy
      monitor.onInput("\x1b\r");
      // Type more text
      monitor.onInput("line 2");

      expect(onStateChange).not.toHaveBeenCalled();
      expect(monitor.getState()).toBe("idle");

      monitor.dispose();
    });

    it("should NOT trigger busy on Shift+Enter (soft newline LF for Codex)", () => {
      const onStateChange = vi.fn();
      // Configure with LF and ESC+CR as ignored (Codex style)
      const monitor = new ActivityMonitor("test-1", 1000, onStateChange, {
        ignoredInputSequences: ["\n", "\x1b\r"],
      });

      // Type some text
      monitor.onInput("line 1");
      // Press Shift+Enter (LF) - should NOT trigger busy for Codex
      monitor.onInput("\n");
      // Type more text
      monitor.onInput("line 2");

      expect(onStateChange).not.toHaveBeenCalled();
      expect(monitor.getState()).toBe("idle");

      monitor.dispose();
    });

    it("should trigger busy on CR Enter but not on LF soft newline (Codex style)", () => {
      const onStateChange = vi.fn();
      // Configure with LF and ESC+CR as ignored (Codex style)
      const monitor = new ActivityMonitor("test-1", 1000, onStateChange, {
        ignoredInputSequences: ["\n", "\x1b\r"],
      });

      // Type some text
      monitor.onInput("command");
      // Use soft newline (LF) - should NOT trigger busy
      monitor.onInput("\n");
      expect(onStateChange).not.toHaveBeenCalled();

      // Type more text
      monitor.onInput("more text");
      // Press Enter (CR) - SHOULD trigger busy
      monitor.onInput("\r");
      expect(onStateChange).toHaveBeenCalledWith("test-1", 1000, "busy", { trigger: "input" });

      monitor.dispose();
    });

    it("should ignore Shift+Enter with default configuration (ESC+CR)", () => {
      const onStateChange = vi.fn();
      // Use default configuration which includes ESC+CR in ignored sequences
      const monitor = new ActivityMonitor("test-1", 1000, onStateChange);

      // Type some text
      monitor.onInput("first line");
      // Press Shift+Enter with default config - should NOT trigger busy
      monitor.onInput("\x1b\r");
      // Type more text
      monitor.onInput("second line");

      expect(onStateChange).not.toHaveBeenCalled();
      expect(monitor.getState()).toBe("idle");

      monitor.dispose();
    });

    it("should NOT trigger busy on typing in polling mode", () => {
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("test-1", 1000, onStateChange, {
        getVisibleLines: () => ["> "],
        getCursorLine: () => "> ",
        initialState: "idle",
        skipInitialStateEmit: true,
      });

      monitor.startPolling();

      // Type characters without Enter - should NOT trigger busy even with polling
      monitor.onInput("h");
      monitor.onInput("e");
      monitor.onInput("l");
      monitor.onInput("l");
      monitor.onInput("o");

      vi.advanceTimersByTime(100);

      expect(onStateChange).not.toHaveBeenCalled();
      expect(monitor.getState()).toBe("idle");

      monitor.dispose();
    });
  });

  describe("notifySubmission (hybrid input bar)", () => {
    it("should immediately transition to busy on submission (Issue #2185)", () => {
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("test-1", 1000, onStateChange, {
        getVisibleLines: () => ["> "],
        getCursorLine: () => "> ",
        initialState: "idle",
        skipInitialStateEmit: true,
      });

      monitor.startPolling();

      // Simulate hybrid input bar submit - should immediately go busy
      monitor.notifySubmission();

      expect(onStateChange).toHaveBeenCalledWith("test-1", 1000, "busy", { trigger: "input" });
      expect(monitor.getState()).toBe("busy");

      monitor.dispose();
    });

    it("should work without polling enabled", () => {
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("test-1", 1000, onStateChange);

      monitor.notifySubmission();

      expect(onStateChange).toHaveBeenCalledWith("test-1", 1000, "busy", { trigger: "input" });
      expect(monitor.getState()).toBe("busy");

      monitor.dispose();
    });

    it("should not fire duplicate busy when already busy", () => {
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("test-1", 1000, onStateChange);

      monitor.notifySubmission();
      monitor.notifySubmission();

      expect(onStateChange).toHaveBeenCalledTimes(1);

      monitor.dispose();
    });
  });

  describe("Output-driven activity", () => {
    it("should NOT trigger busy from output during typing echo window - Issue #1476", () => {
      const onStateChange = vi.fn();
      const processStateValidator = {
        hasActiveChildren: vi.fn().mockReturnValue(true),
      };
      const monitor = new ActivityMonitor("test-1", 1000, onStateChange, {
        processStateValidator,
        outputActivityDetection: { enabled: true, minFrames: 1, minBytes: 1 },
      });

      // User types (sets recent input timestamp)
      monitor.onInput("h");

      // Output during echo window should NOT trigger busy
      monitor.onData("h");

      expect(onStateChange).not.toHaveBeenCalled();
      expect(monitor.getState()).toBe("idle");

      monitor.dispose();
    });

    it("should trigger busy from output when there is pending input (Enter pressed)", () => {
      const onStateChange = vi.fn();
      const processStateValidator = {
        hasActiveChildren: vi.fn().mockReturnValue(true),
      };
      const monitor = new ActivityMonitor("test-1", 1000, onStateChange, {
        processStateValidator,
        outputActivityDetection: { enabled: true, minFrames: 1, minBytes: 1 },
      });

      // Press Enter first to set pending input
      monitor.onInput("\r");
      expect(onStateChange).toHaveBeenCalledWith("test-1", 1000, "busy", { trigger: "input" });

      // Reset to test output confirmation
      onStateChange.mockClear();
      monitor.onData("agent output");

      // Already busy, output just confirms - no duplicate call
      expect(onStateChange).not.toHaveBeenCalled();
      expect(monitor.getState()).toBe("busy");

      monitor.dispose();
    });

    it("should not trigger busy from output when no CPU activity (user typing)", () => {
      const onStateChange = vi.fn();
      const processStateValidator = {
        hasActiveChildren: vi.fn().mockReturnValue(false),
      };
      const monitor = new ActivityMonitor("test-1", 1000, onStateChange, {
        processStateValidator,
        outputActivityDetection: { enabled: true, minFrames: 1, minBytes: 1 },
      });

      // Even with Enter, CPU check should prevent busy from output
      monitor.onInput("\r");
      expect(onStateChange).toHaveBeenCalledWith("test-1", 1000, "busy", { trigger: "input" });

      // After going busy from input, output with no CPU won't extend/retrigger
      expect(monitor.getState()).toBe("busy");

      monitor.dispose();
    });

    it("should NOT trigger busy from output during echo window even without validator - Issue #1476", () => {
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("test-1", 1000, onStateChange, {
        outputActivityDetection: { enabled: true, minFrames: 1, minBytes: 1 },
      });

      // User types (sets recent input timestamp)
      monitor.onInput("x");

      // Output during echo window should NOT trigger busy
      monitor.onData("x");

      expect(onStateChange).not.toHaveBeenCalled();
      expect(monitor.getState()).toBe("idle");

      monitor.dispose();
    });

    it("should not trigger on empty data", () => {
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("test-1", 1000, onStateChange);

      monitor.onData();
      monitor.onData(undefined);

      expect(onStateChange).not.toHaveBeenCalled();
    });
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

      expect(onStateChange).toHaveBeenCalledWith("test-1", 1000, "idle");

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

      expect(onStateChange).toHaveBeenCalledWith("test-1", 1000, "idle");

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

      expect(onStateChange).toHaveBeenCalledWith("test-1", 1000, "idle");

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

      expect(onStateChange).toHaveBeenCalledWith("test-1", 1000, "idle");

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

      // Debounce is 2500ms
      vi.advanceTimersByTime(2500);

      expect(onStateChange).toHaveBeenCalledTimes(2);
      expect(onStateChange).toHaveBeenNthCalledWith(2, "test-1", 1000, "idle");

      monitor.dispose();
    });

    it("should reset debounce timer on continued output while busy", () => {
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("test-1", 1000, onStateChange);

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
        outputActivityDetection: { enabled: true, minFrames: 1, minBytes: 1 },
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
  });

  describe("Mixed input and output activity", () => {
    it("should maintain busy state with mixed input and output", () => {
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("test-1", 1000, onStateChange);

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
        outputActivityDetection: { enabled: true, minFrames: 1, minBytes: 1 },
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
        outputActivityDetection: { enabled: true, minFrames: 1, minBytes: 1 },
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

  describe("Disposal", () => {
    it("should clear debounce timer on dispose", () => {
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("test-1", 1000, onStateChange);

      monitor.onInput("\r");
      monitor.dispose();

      vi.advanceTimersByTime(1500);

      expect(onStateChange).toHaveBeenCalledTimes(1);
    });

    it("should preserve state on dispose", () => {
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("test-1", 1000, onStateChange, {
        outputActivityDetection: { enabled: true, minFrames: 1, minBytes: 1 },
      });

      // Press Enter to enter busy state
      monitor.onInput("\r");
      expect(monitor.getState()).toBe("busy");

      monitor.dispose();

      // State is preserved, only timers are cleared
      expect(monitor.getState()).toBe("busy");
    });
  });

  describe("Process state validation", () => {
    it("should extend busy state when process has active children", () => {
      const onStateChange = vi.fn();
      const processStateValidator = {
        hasActiveChildren: vi.fn().mockReturnValue(true),
      };
      const monitor = new ActivityMonitor("test-1", 1000, onStateChange, {
        processStateValidator,
      });

      monitor.onInput("\r");
      expect(onStateChange).toHaveBeenCalledWith("test-1", 1000, "busy", { trigger: "input" });

      // Debounce is 2500ms
      vi.advanceTimersByTime(2500);

      expect(processStateValidator.hasActiveChildren).toHaveBeenCalled();
      expect(monitor.getState()).toBe("busy");

      processStateValidator.hasActiveChildren.mockReturnValue(false);
      vi.advanceTimersByTime(2500);

      expect(onStateChange).toHaveBeenNthCalledWith(2, "test-1", 1000, "idle");

      monitor.dispose();
    });

    it("should transition to idle when no active children exist", () => {
      const onStateChange = vi.fn();
      const processStateValidator = {
        hasActiveChildren: vi.fn().mockReturnValue(false),
      };
      const monitor = new ActivityMonitor("test-1", 1000, onStateChange, {
        processStateValidator,
      });

      monitor.onInput("\r");
      expect(onStateChange).toHaveBeenCalledWith("test-1", 1000, "busy", { trigger: "input" });

      // Debounce is 2500ms
      vi.advanceTimersByTime(2500);

      expect(processStateValidator.hasActiveChildren).toHaveBeenCalled();
      expect(onStateChange).toHaveBeenNthCalledWith(2, "test-1", 1000, "idle");

      monitor.dispose();
    });

    it("should work without processStateValidator (backwards compatible)", () => {
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("test-1", 1000, onStateChange);

      monitor.onInput("\r");
      // Debounce is 2500ms
      vi.advanceTimersByTime(2500);

      expect(onStateChange).toHaveBeenCalledTimes(2);
      expect(onStateChange).toHaveBeenNthCalledWith(2, "test-1", 1000, "idle");

      monitor.dispose();
    });

    it("should trigger busy from Enter key even when no CPU activity", () => {
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

  describe("System sleep/wake detection", () => {
    it("should detect system wake and revalidate state", () => {
      const onStateChange = vi.fn();
      const processStateValidator = {
        hasActiveChildren: vi.fn().mockReturnValue(false),
      };
      const monitor = new ActivityMonitor("test-1", 1000, onStateChange, {
        processStateValidator,
      });

      monitor.onInput("\r");
      expect(monitor.getState()).toBe("busy");

      vi.advanceTimersByTime(6000);

      monitor.onData("wake output");

      expect(processStateValidator.hasActiveChildren).toHaveBeenCalled();
      expect(monitor.getState()).toBe("idle");
      expect(onStateChange).toHaveBeenLastCalledWith("test-1", 1000, "idle");

      monitor.dispose();
    });

    it("should keep busy state after wake if process still has children", () => {
      const onStateChange = vi.fn();
      const processStateValidator = {
        hasActiveChildren: vi.fn().mockReturnValue(true),
      };
      const monitor = new ActivityMonitor("test-1", 1000, onStateChange, {
        processStateValidator,
      });

      monitor.onInput("\r");
      expect(monitor.getState()).toBe("busy");

      vi.advanceTimersByTime(6000);

      monitor.onData("wake output");

      expect(monitor.getState()).toBe("busy");
      expect(onStateChange).toHaveBeenCalledTimes(1);

      monitor.dispose();
    });

    it("should not trigger wake detection for short gaps", () => {
      const onStateChange = vi.fn();
      const processStateValidator = {
        hasActiveChildren: vi.fn().mockReturnValue(false),
      };
      const monitor = new ActivityMonitor("test-1", 1000, onStateChange, {
        processStateValidator,
      });

      monitor.onInput("\r");
      processStateValidator.hasActiveChildren.mockClear();

      vi.advanceTimersByTime(1000);
      monitor.onData("some output");

      expect(processStateValidator.hasActiveChildren).not.toHaveBeenCalled();
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
        outputActivityDetection: { enabled: true, minFrames: 1, minBytes: 1 },
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
        outputActivityDetection: { enabled: true, minFrames: 1, minBytes: 1 },
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

      // Pattern detected but not sustained yet - should still be idle
      expect(monitor.getState()).toBe("idle");

      // Continue emitting output to sustain the working signal
      monitor.onData("agent output chunk 3");
      vi.advanceTimersByTime(50);
      monitor.onData("agent output chunk 4");
      vi.advanceTimersByTime(50);
      monitor.onData("agent output chunk 5");
      vi.advanceTimersByTime(50);

      // Still not sustained long enough (250ms total)
      expect(monitor.getState()).toBe("idle");

      // Advance to exceed debounce delay and emit more output
      vi.advanceTimersByTime(1300); // Total ~1550ms sustained (enough to cross 1500ms threshold)
      monitor.onData("agent output chunk 6");
      vi.advanceTimersByTime(50);

      // Now sustained long enough - polling cycle should trigger recovery
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
        outputActivityDetection: { enabled: true, minFrames: 1, minBytes: 1 },
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
    it("should NOT recover from single output event (terminal reflow)", () => {
      const onStateChange = vi.fn();
      const visibleLines = ["> "];
      const monitor = new ActivityMonitor("test-1", 1000, onStateChange, {
        getVisibleLines: () => visibleLines,
        getCursorLine: () => visibleLines[visibleLines.length - 1],
        workingRecoveryDelayMs: 1500,
      });

      monitor.startPolling();
      vi.advanceTimersByTime(100); // Boot completes
      vi.advanceTimersByTime(2500); // Go idle
      expect(monitor.getState()).toBe("idle");

      // Single ANSI escape sequence (e.g., from terminal reflow)
      monitor.onData("\x1b[0m");
      vi.advanceTimersByTime(200);

      // Should still be idle - single event doesn't trigger recovery
      expect(monitor.getState()).toBe("idle");

      monitor.dispose();
    });

    it("should NOT recover from brief working pattern appearance", () => {
      const onStateChange = vi.fn();
      let visibleLines = ["> "];
      const monitor = new ActivityMonitor("test-1", 1000, onStateChange, {
        getVisibleLines: () => visibleLines,
        getCursorLine: () => visibleLines[visibleLines.length - 1],
        workingRecoveryDelayMs: 1500,
      });

      monitor.startPolling();
      vi.advanceTimersByTime(100); // Boot completes
      vi.advanceTimersByTime(2500); // Go idle
      expect(monitor.getState()).toBe("idle");

      // Pattern appears briefly
      visibleLines = ["Working (esc to interrupt)"];
      monitor.onData("brief output");
      vi.advanceTimersByTime(500); // Only 500ms, less than 1500ms threshold

      // Should still be idle
      expect(monitor.getState()).toBe("idle");

      // Pattern disappears
      visibleLines = ["> "];
      vi.advanceTimersByTime(100);

      // Still idle - pattern wasn't sustained
      expect(monitor.getState()).toBe("idle");

      monitor.dispose();
    });

    it("should recover from sustained working signal (1.5+ seconds)", () => {
      const onStateChange = vi.fn();
      let visibleLines = ["> "];
      const monitor = new ActivityMonitor("test-1", 1000, onStateChange, {
        getVisibleLines: () => visibleLines,
        getCursorLine: () => visibleLines[visibleLines.length - 1],
        workingRecoveryDelayMs: 1500,
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
        trigger: "pattern",
        patternConfidence: 0.9,
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

      // Should still be idle because timer was reset when pattern disappeared
      expect(monitor.getState()).toBe("idle");

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

      // Should still be idle (1500ms < 2000ms threshold)
      expect(monitor.getState()).toBe("idle");

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

  describe("Boot detection with Claude Code banner", () => {
    it("should detect Claude Code v2.x.x banner and transition to waiting within 200ms", () => {
      const onStateChange = vi.fn();
      const visibleLines = [
        "           Claude Code v2.1.37",
        " ▐▛███▜▌   Opus 4.6 · Claude Max",
        "▝▜█████▛▘  ~/Projects/Canopy/canopy-electron",
        "  ▘▘ ▝▝    Opus 4.6 is here · $50 free extra usage",
        "",
        "─────────────────────────────────────────────────────────────────",
        '❯ Try "how does TerminalInstanceService.ts work?"',
        "─────────────────────────────────────────────────────────────────",
        "  ⏵⏵ bypass permissions on (shift+tab to cycle)",
      ];

      const monitor = new ActivityMonitor("test-1", 1000, onStateChange, {
        getVisibleLines: () => visibleLines,
        getCursorLine: () => visibleLines[visibleLines.length - 1],
        bootCompletePatterns: [/claude\s+code\s+v?\d/i],
        promptPatterns: [/^\s*❯\s*/],
        pollingIntervalMs: 50,
        idleDebounceMs: 200,
      });

      monitor.startPolling();

      // Boot detection should complete within first polling cycle (50ms)
      vi.advanceTimersByTime(50);

      // Verify no idle transition before 200ms debounce
      let idleCalls = onStateChange.mock.calls.filter((call) => call[2] === "idle");
      expect(idleCalls.length).toBe(0);

      // Should transition to idle after 200ms debounce with prompt visible
      vi.advanceTimersByTime(200);

      // Verify idle transition occurred
      idleCalls = onStateChange.mock.calls.filter((call) => call[2] === "idle");
      expect(idleCalls.length).toBeGreaterThan(0);

      monitor.dispose();
    });

    it("should detect Claude Code v3.x.x banner with different version format", () => {
      const onStateChange = vi.fn();
      const visibleLines = [
        "           Claude Code v3.0.0",
        " ▐▛███▜▌   Opus 5.0 · Claude Max",
        "❯ Ready",
      ];

      const monitor = new ActivityMonitor("test-1", 1000, onStateChange, {
        getVisibleLines: () => visibleLines,
        getCursorLine: () => visibleLines[visibleLines.length - 1],
        bootCompletePatterns: [/claude\s+code\s+v?\d/i],
        promptPatterns: [/^\s*❯\s*/],
        pollingIntervalMs: 50,
        idleDebounceMs: 200,
      });

      monitor.startPolling();

      // Advance through boot detection and debounce
      vi.advanceTimersByTime(50);
      vi.advanceTimersByTime(200);

      // Verify final state is idle
      expect(monitor.getState()).toBe("idle");

      monitor.dispose();
    });

    it("should detect boot banner with ANSI escape codes", () => {
      const onStateChange = vi.fn();
      const visibleLines = [
        "\x1b[1m           Claude Code v2.1.37\x1b[0m",
        "\x1b[36m ▐▛███▜▌   Opus 4.6 · Claude Max\x1b[0m",
        "❯ Try something",
      ];

      const monitor = new ActivityMonitor("test-1", 1000, onStateChange, {
        getVisibleLines: () => visibleLines,
        getCursorLine: () => visibleLines[visibleLines.length - 1],
        bootCompletePatterns: [/claude\s+code\s+v?\d/i],
        promptPatterns: [/^\s*❯\s*/],
        pollingIntervalMs: 50,
        idleDebounceMs: 200,
      });

      monitor.startPolling();

      // Advance through boot detection and debounce
      vi.advanceTimersByTime(50);
      vi.advanceTimersByTime(200);

      // Verify final state is idle
      expect(monitor.getState()).toBe("idle");

      monitor.dispose();
    });

    it("should scan 50 lines during boot to catch banner near top of viewport", () => {
      const onStateChange = vi.fn();
      const getVisibleLines = vi.fn((count: number) => {
        // Banner is at line 30 (beyond the normal 15-line scan)
        const lines = Array(count).fill("");
        if (count >= 30) {
          lines[29] = "Claude Code v2.1.37";
          lines[count - 1] = "❯ Ready";
        }
        return lines;
      });

      const monitor = new ActivityMonitor("test-1", 1000, onStateChange, {
        getVisibleLines,
        getCursorLine: () => "❯ Ready",
        bootCompletePatterns: [/claude\s+code\s+v?\d/i],
        promptPatterns: [/^\s*❯\s*/],
        promptScanLineCount: 10,
        idleDebounceMs: 200,
      });

      monitor.startPolling();
      vi.advanceTimersByTime(100);

      // Should have scanned 50 lines during boot (not just 10 or 15)
      expect(getVisibleLines).toHaveBeenCalledWith(50);

      // Boot should complete after debounce
      vi.advanceTimersByTime(250);

      // Verify final state is idle
      expect(monitor.getState()).toBe("idle");

      monitor.dispose();
    });

    it("should reduce scan to 15 lines after boot completes", () => {
      const onStateChange = vi.fn();
      const getVisibleLines = vi.fn(() => ["Claude Code v2.1.37", "❯ Ready"]);

      const monitor = new ActivityMonitor("test-1", 1000, onStateChange, {
        getVisibleLines,
        getCursorLine: () => "❯ Ready",
        bootCompletePatterns: [/claude\s+code\s+v?\d/i],
        promptPatterns: [/^\s*❯\s*/],
        promptScanLineCount: 10,
        idleDebounceMs: 200,
      });

      monitor.startPolling();

      // First poll: boot phase, should scan 50 lines
      vi.advanceTimersByTime(100);
      expect(getVisibleLines).toHaveBeenCalledWith(50);

      getVisibleLines.mockClear();

      // Advance past boot completion
      vi.advanceTimersByTime(250);

      // Next poll: post-boot, should scan max(10, 15) = 15 lines
      vi.advanceTimersByTime(100);
      expect(getVisibleLines).toHaveBeenCalledWith(15);

      monitor.dispose();
    });

    it("should complete boot via banner detection alone (without prompt)", () => {
      const onStateChange = vi.fn();
      const getVisibleLines = vi.fn(() => [
        "           Claude Code v2.1.37",
        " ▐▛███▜▌   Opus 4.6 · Claude Max",
        "Loading configuration...",
      ]);

      const monitor = new ActivityMonitor("test-1", 1000, onStateChange, {
        getVisibleLines,
        getCursorLine: () => "Loading configuration...",
        bootCompletePatterns: [/claude\s+code\s+v?\d/i],
        promptPatterns: [/^\s*❯\s*/], // No prompt in visible lines
        pollingIntervalMs: 50,
        idleDebounceMs: 2000,
      });

      monitor.startPolling();

      // First poll: boot phase, should scan 50 lines and detect banner
      vi.advanceTimersByTime(50);
      expect(getVisibleLines).toHaveBeenCalledWith(50);

      getVisibleLines.mockClear();

      // Second poll: boot should have completed, scan should reduce to 15
      vi.advanceTimersByTime(50);
      expect(getVisibleLines).toHaveBeenCalledWith(15);

      monitor.dispose();
    });

    it("should not transition to idle before boot detection timeout if no banner", () => {
      const onStateChange = vi.fn();
      const visibleLines = ["Starting up...", "Loading..."];

      const monitor = new ActivityMonitor("test-1", 1000, onStateChange, {
        getVisibleLines: () => visibleLines,
        getCursorLine: () => visibleLines[visibleLines.length - 1],
        bootCompletePatterns: [/claude\s+code\s+v?\d/i],
        pollingMaxBootMs: 15000,
        idleDebounceMs: 200,
      });

      monitor.startPolling();

      // Should remain busy during boot timeout
      vi.advanceTimersByTime(5000);
      expect(onStateChange).toHaveBeenCalledWith("test-1", 1000, "busy", expect.anything());

      // Verify no idle calls occurred
      const idleCalls = onStateChange.mock.calls.filter((call) => call[2] === "idle");
      expect(idleCalls.length).toBe(0);

      monitor.dispose();
    });
  });

  describe("Resize suppression (Issue #2364)", () => {
    it("should NOT trigger busy from high output bytes during resize suppression window", () => {
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("test-1", 1000, onStateChange, {
        highOutputThreshold: {
          enabled: true,
          windowMs: 500,
          bytesPerSecond: 2048,
          recoveryEnabled: true,
          recoveryDelayMs: 500,
        },
      });

      // Notify resize — starts suppression window
      monitor.notifyResize(1000);

      // Simulate high-output reflow bytes within suppression window
      for (let i = 0; i < 20; i++) {
        monitor.onData("x".repeat(500));
        vi.advanceTimersByTime(30);
      }

      // Should remain idle — reflow bytes suppressed
      expect(monitor.getState()).toBe("idle");
      const busyCalls = onStateChange.mock.calls.filter((call) => call[2] === "busy");
      expect(busyCalls.length).toBe(0);

      monitor.dispose();
    });

    it("should trigger busy from high output bytes AFTER suppression window expires", () => {
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("test-1", 1000, onStateChange, {
        highOutputThreshold: {
          enabled: true,
          windowMs: 500,
          bytesPerSecond: 2048,
          recoveryEnabled: true,
          recoveryDelayMs: 500,
        },
      });

      // Notify resize with short suppression
      monitor.notifyResize(200);

      // Advance past the suppression window
      vi.advanceTimersByTime(250);

      // Now send sustained high output — should trigger recovery
      for (let i = 0; i < 30; i++) {
        monitor.onData("x".repeat(500));
        vi.advanceTimersByTime(20);
      }

      expect(monitor.getState()).toBe("busy");

      monitor.dispose();
    });

    it("should suppress pattern-based recovery in polling cycle during resize", () => {
      const onStateChange = vi.fn();
      const getVisibleLines = vi.fn(() => ["  esc to interrupt  "]);
      const monitor = new ActivityMonitor("test-1", 1000, onStateChange, {
        getVisibleLines,
        getCursorLine: () => "  esc to interrupt  ",
        pollingIntervalMs: 50,
        idleDebounceMs: 200,
        bootCompletePatterns: [/ready/i],
        pollingMaxBootMs: 100,
        workingRecoveryDelayMs: 200,
      });

      monitor.startPolling();

      // Exit boot state
      vi.advanceTimersByTime(150);
      onStateChange.mockClear();

      // Transition to idle
      getVisibleLines.mockReturnValue(["> "]);
      vi.advanceTimersByTime(3000);
      expect(monitor.getState()).toBe("idle");
      onStateChange.mockClear();

      // Notify resize — start suppression
      monitor.notifyResize(1000);

      // Return working pattern lines (simulating redrawn content after resize)
      getVisibleLines.mockReturnValue(["  esc to interrupt  "]);

      // Advance polling cycles within the suppression window
      vi.advanceTimersByTime(800);

      // Should remain idle — pattern recovery suppressed during resize
      expect(monitor.getState()).toBe("idle");

      monitor.dispose();
    });

    it("should reset suppression window on rapid successive resizes", () => {
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("test-1", 1000, onStateChange, {
        highOutputThreshold: {
          enabled: true,
          windowMs: 500,
          bytesPerSecond: 2048,
          recoveryEnabled: true,
          recoveryDelayMs: 500,
        },
      });

      // First resize
      monitor.notifyResize(500);
      vi.advanceTimersByTime(400);

      // Second resize extends the window
      monitor.notifyResize(500);
      vi.advanceTimersByTime(400);

      // Still within the second suppression window — bytes should be suppressed
      for (let i = 0; i < 20; i++) {
        monitor.onData("x".repeat(500));
        vi.advanceTimersByTime(5);
      }

      expect(monitor.getState()).toBe("idle");

      monitor.dispose();
    });

    it("should not affect already-busy terminals during resize", () => {
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("test-1", 1000, onStateChange);

      // Make terminal busy via input
      monitor.onInput("hello\r");
      expect(monitor.getState()).toBe("busy");
      onStateChange.mockClear();

      // Notify resize while busy
      monitor.notifyResize(1000);

      // Output during suppression still resets the debounce timer (keeps busy alive)
      // because the early return in onData is only in the output-tracking section,
      // after the busy-state debounce reset
      monitor.onData("some output");
      expect(monitor.getState()).toBe("busy");

      monitor.dispose();
    });
  });
});
