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
  });

  describe("Output-driven activity", () => {
    it("should transition from idle to busy on any output with CPU activity", () => {
      const onStateChange = vi.fn();
      const processStateValidator = {
        hasActiveChildren: vi.fn().mockReturnValue(true),
      };
      const monitor = new ActivityMonitor("test-1", 1000, onStateChange, {
        processStateValidator,
        outputActivityDetection: { enabled: true, minFrames: 1, minBytes: 1 },
      });

      monitor.onData("some output");

      expect(processStateValidator.hasActiveChildren).toHaveBeenCalled();
      expect(onStateChange).toHaveBeenCalledWith("test-1", 1000, "busy", {
        trigger: "output",
      });
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

      monitor.onData("character echo");

      expect(processStateValidator.hasActiveChildren).toHaveBeenCalled();
      expect(onStateChange).not.toHaveBeenCalled();
      expect(monitor.getState()).toBe("idle");
    });

    it("should allow busy from output when no validator present (fail-open)", () => {
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("test-1", 1000, onStateChange, {
        outputActivityDetection: { enabled: true, minFrames: 1, minBytes: 1 },
      });

      monitor.onData("output");

      expect(onStateChange).toHaveBeenCalledWith("test-1", 1000, "busy", {
        trigger: "output",
      });
      expect(monitor.getState()).toBe("busy");

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
      });

      monitor.startPolling();

      vi.advanceTimersByTime(600);

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

    it("should not fire duplicate busy from output", () => {
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("test-1", 1000, onStateChange, {
        outputActivityDetection: { enabled: true, minFrames: 1, minBytes: 1 },
      });

      monitor.onData("output1");
      monitor.onData("output2");
      monitor.onData("output3");

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

    it("should re-enter busy from idle via output after accidental exit", () => {
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("test-1", 1000, onStateChange, {
        outputActivityDetection: { enabled: true, minFrames: 1, minBytes: 1 },
      });

      monitor.onInput("\r");
      expect(onStateChange).toHaveBeenCalledWith("test-1", 1000, "busy", { trigger: "input" });

      // Debounce is 2500ms
      vi.advanceTimersByTime(2500);
      expect(onStateChange).toHaveBeenNthCalledWith(2, "test-1", 1000, "idle");

      monitor.onData("agent output");

      expect(onStateChange).toHaveBeenCalledTimes(3);
      expect(onStateChange).toHaveBeenLastCalledWith("test-1", 1000, "busy", {
        trigger: "output",
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

      monitor.onData("some output");
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
