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

  describe("Output-driven activity", () => {
    it("should NOT trigger busy from output alone (requires Enter first) - Issue #1476", () => {
      const onStateChange = vi.fn();
      const processStateValidator = {
        hasActiveChildren: vi.fn().mockReturnValue(true),
      };
      const monitor = new ActivityMonitor("test-1", 1000, onStateChange, {
        processStateValidator,
        outputActivityDetection: { enabled: true, minFrames: 1, minBytes: 1 },
      });

      // Output alone should NOT trigger busy - only Enter should
      monitor.onData("some output");

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

    it("should NOT trigger busy from output alone even without validator - Issue #1476", () => {
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("test-1", 1000, onStateChange, {
        outputActivityDetection: { enabled: true, minFrames: 1, minBytes: 1 },
      });

      // Output alone should NOT trigger busy - need Enter first
      monitor.onData("output");

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

    it("should enter busy after non-empty input even if prompt stays visible", () => {
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

      vi.advanceTimersByTime(350);
      expect(onStateChange).not.toHaveBeenCalledWith("test-1", 1000, "busy", {
        trigger: "input",
      });

      vi.advanceTimersByTime(200);
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

    it("should NOT re-enter busy from idle via output alone - Issue #1476", () => {
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("test-1", 1000, onStateChange, {
        outputActivityDetection: { enabled: true, minFrames: 1, minBytes: 1 },
      });

      monitor.onInput("\r");
      expect(onStateChange).toHaveBeenCalledWith("test-1", 1000, "busy", { trigger: "input" });

      // Debounce is 2500ms
      vi.advanceTimersByTime(2500);
      expect(onStateChange).toHaveBeenNthCalledWith(2, "test-1", 1000, "idle");

      // After going idle, output alone should NOT re-trigger busy
      // User must press Enter again to start a new work cycle
      monitor.onData("agent output");

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
});
