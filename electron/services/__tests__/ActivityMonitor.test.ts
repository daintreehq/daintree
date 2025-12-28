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

  describe("Output-driven activity (heuristic)", () => {
    it("should transition from idle to busy on high-volume output", () => {
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("test-1", 1000, onStateChange, {
        outputActivityDetection: {
          enabled: true,
          windowMs: 500,
          minFrames: 3,
          minBytes: 2048,
        },
      });

      const chunk = "x".repeat(800);
      monitor.onData(chunk);
      monitor.onData(chunk);
      monitor.onData(chunk);

      expect(onStateChange).toHaveBeenCalledWith("test-1", 1000, "busy", {
        trigger: "output-heuristic",
      });
    });

    it("should not trigger on low-volume output (background noise)", () => {
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("test-1", 1000, onStateChange, {
        outputActivityDetection: {
          enabled: true,
          windowMs: 500,
          minFrames: 3,
          minBytes: 2048,
        },
      });

      const chunk = "x".repeat(100);
      monitor.onData(chunk);
      monitor.onData(chunk);

      expect(onStateChange).not.toHaveBeenCalled();
    });

    it("should trigger on single large chunk (bytes threshold)", () => {
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("test-1", 1000, onStateChange, {
        outputActivityDetection: {
          enabled: true,
          windowMs: 500,
          minFrames: 3,
          minBytes: 2048,
        },
      });

      const chunk = "x".repeat(3000);
      monitor.onData(chunk);

      expect(onStateChange).toHaveBeenCalledWith("test-1", 1000, "busy", {
        trigger: "output-heuristic",
      });

      monitor.dispose();
    });

    it("should not trigger if bytes threshold not met", () => {
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("test-1", 1000, onStateChange, {
        outputActivityDetection: {
          enabled: true,
          windowMs: 500,
          minFrames: 3,
          minBytes: 2048,
        },
      });

      const chunk = "x".repeat(100);
      monitor.onData(chunk);
      monitor.onData(chunk);
      monitor.onData(chunk);
      monitor.onData(chunk);

      expect(onStateChange).not.toHaveBeenCalled();
    });

    it("should reset window after time expires", () => {
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("test-1", 1000, onStateChange, {
        outputActivityDetection: {
          enabled: true,
          windowMs: 500,
          minFrames: 3,
          minBytes: 2048,
        },
      });

      const chunk = "x".repeat(800);
      monitor.onData(chunk);
      monitor.onData(chunk);

      vi.advanceTimersByTime(600);

      monitor.onData(chunk);
      monitor.onData(chunk);

      expect(onStateChange).not.toHaveBeenCalled();
    });

    it("should have output detection disabled by default", () => {
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("test-1", 1000, onStateChange);

      const chunk = "x".repeat(10000);
      monitor.onData(chunk);
      monitor.onData(chunk);
      monitor.onData(chunk);

      expect(onStateChange).not.toHaveBeenCalled();
    });

    it("should respect disabled output detection", () => {
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("test-1", 1000, onStateChange, {
        outputActivityDetection: {
          enabled: false,
        },
      });

      const chunk = "x".repeat(10000);
      monitor.onData(chunk);
      monitor.onData(chunk);
      monitor.onData(chunk);

      expect(onStateChange).not.toHaveBeenCalled();
    });

    it("should not trigger busy from output when no CPU activity (user typing)", () => {
      const onStateChange = vi.fn();
      const processStateValidator = {
        hasActiveChildren: vi.fn().mockReturnValue(false),
      };
      const monitor = new ActivityMonitor("test-1", 1000, onStateChange, {
        outputActivityDetection: {
          enabled: true,
          windowMs: 500,
          minFrames: 2,
          minBytes: 32,
        },
        processStateValidator,
      });

      // Simulate character echoes that meet the output threshold
      monitor.onData("x".repeat(20));
      monitor.onData("x".repeat(20));

      // CPU check should have been called and returned false, blocking transition
      expect(processStateValidator.hasActiveChildren).toHaveBeenCalled();
      expect(onStateChange).not.toHaveBeenCalled();
      expect(monitor.getState()).toBe("idle");
    });

    it("should trigger busy from output when CPU activity detected", () => {
      const onStateChange = vi.fn();
      const processStateValidator = {
        hasActiveChildren: vi.fn().mockReturnValue(true),
      };
      const monitor = new ActivityMonitor("test-1", 1000, onStateChange, {
        outputActivityDetection: {
          enabled: true,
          windowMs: 500,
          minFrames: 2,
          minBytes: 32,
        },
        processStateValidator,
      });

      // Simulate agent output that meets the threshold
      monitor.onData("x".repeat(20));
      monitor.onData("x".repeat(20));

      // CPU check should have been called and returned true, allowing transition
      expect(processStateValidator.hasActiveChildren).toHaveBeenCalled();
      expect(onStateChange).toHaveBeenCalledWith("test-1", 1000, "busy", {
        trigger: "output-heuristic",
      });
      expect(monitor.getState()).toBe("busy");

      monitor.dispose();
    });

    it("should allow busy from output when no validator present (fail-open)", () => {
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("test-1", 1000, onStateChange, {
        outputActivityDetection: {
          enabled: true,
          windowMs: 500,
          minFrames: 2,
          minBytes: 32,
        },
      });

      // No validator, so should use fail-open behavior
      monitor.onData("x".repeat(20));
      monitor.onData("x".repeat(20));

      expect(onStateChange).toHaveBeenCalledWith("test-1", 1000, "busy", {
        trigger: "output-heuristic",
      });
      expect(monitor.getState()).toBe("busy");

      monitor.dispose();
    });
  });

  describe("Debounce timer (idle transition)", () => {
    it("should transition to idle after debounce period", () => {
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("test-1", 1000, onStateChange);

      monitor.onInput("\r");
      expect(onStateChange).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(1500);

      expect(onStateChange).toHaveBeenCalledTimes(2);
      expect(onStateChange).toHaveBeenNthCalledWith(2, "test-1", 1000, "idle");

      monitor.dispose();
    });

    it("should reset debounce timer on continued output while busy", () => {
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("test-1", 1000, onStateChange);

      monitor.onInput("\r");
      expect(onStateChange).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(1000);
      monitor.onData("some output");

      vi.advanceTimersByTime(1000);

      expect(onStateChange).toHaveBeenCalledTimes(1);

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

    it("should not fire duplicate busy from output heuristic", () => {
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("test-1", 1000, onStateChange, {
        outputActivityDetection: {
          enabled: true,
          windowMs: 500,
          minFrames: 3,
          minBytes: 2048,
        },
      });

      const chunk = "x".repeat(800);
      monitor.onData(chunk);
      monitor.onData(chunk);
      monitor.onData(chunk);

      expect(onStateChange).toHaveBeenCalledTimes(1);

      monitor.onData(chunk);
      monitor.onData(chunk);

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

      vi.advanceTimersByTime(1500);

      expect(onStateChange).toHaveBeenCalledTimes(2);
      expect(onStateChange).toHaveBeenNthCalledWith(2, "test-1", 1000, "idle");

      monitor.dispose();
    });

    it("should re-enter busy from idle via output after accidental exit", () => {
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("test-1", 1000, onStateChange, {
        outputActivityDetection: {
          enabled: true,
          windowMs: 500,
          minFrames: 3,
          minBytes: 2048,
        },
      });

      monitor.onInput("\r");
      expect(onStateChange).toHaveBeenCalledWith("test-1", 1000, "busy", { trigger: "input" });

      vi.advanceTimersByTime(1500);
      expect(onStateChange).toHaveBeenNthCalledWith(2, "test-1", 1000, "idle");

      const chunk = "x".repeat(800);
      monitor.onData(chunk);
      monitor.onData(chunk);
      monitor.onData(chunk);

      expect(onStateChange).toHaveBeenCalledTimes(3);
      expect(onStateChange).toHaveBeenLastCalledWith("test-1", 1000, "busy", {
        trigger: "output-heuristic",
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

    it("should reset output window on dispose", () => {
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("test-1", 1000, onStateChange);

      const chunk = "x".repeat(1000);
      monitor.onData(chunk);
      monitor.dispose();

      expect(monitor.getState()).toBe("idle");
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

      vi.advanceTimersByTime(1500);

      expect(processStateValidator.hasActiveChildren).toHaveBeenCalled();
      expect(monitor.getState()).toBe("busy");

      processStateValidator.hasActiveChildren.mockReturnValue(false);
      vi.advanceTimersByTime(1500);

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

      vi.advanceTimersByTime(1500);

      expect(processStateValidator.hasActiveChildren).toHaveBeenCalled();
      expect(onStateChange).toHaveBeenNthCalledWith(2, "test-1", 1000, "idle");

      monitor.dispose();
    });

    it("should work without processStateValidator (backwards compatible)", () => {
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("test-1", 1000, onStateChange);

      monitor.onInput("\r");
      vi.advanceTimersByTime(1500);

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
