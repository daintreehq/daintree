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

  describe("Boot detection with Claude Code banner", () => {
    it("should detect Claude Code v2.x.x banner and transition to waiting after working hold expires", () => {
      const onStateChange = vi.fn();
      const visibleLines = [
        "           Claude Code v2.1.37",
        " ▐▛███▜▌   Opus 4.6 · Claude Max",
        "▝▜█████▛▘  ~/Projects/Daintree/daintree-electron",
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

      // Verify no idle transition before working hold (1500ms) expires
      let idleCalls = onStateChange.mock.calls.filter((call) => call[2] === "idle");
      expect(idleCalls.length).toBe(0);

      // Should transition to idle after working hold expires + prompt fast-path quiet threshold
      vi.advanceTimersByTime(3100);

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

      // Advance through boot detection and past working hold + prompt fast-path quiet
      vi.advanceTimersByTime(50);
      vi.advanceTimersByTime(3100);

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

      // Advance through boot detection and past working hold + prompt fast-path quiet
      vi.advanceTimersByTime(50);
      vi.advanceTimersByTime(3100);

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

      // Boot should complete after working hold + prompt fast-path quiet threshold
      vi.advanceTimersByTime(3100);

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

      // Advance past boot completion and working hold
      vi.advanceTimersByTime(3100);

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

  describe("Focus suppression (Issue #8865)", () => {
    it("does NOT promote idle→busy from agent redraw inside the focus suppression window", () => {
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("focus-test", 1000, onStateChange, {
        highOutputThreshold: {
          enabled: true,
          windowMs: 500,
          bytesPerSecond: 2048,
          recoveryEnabled: true,
          recoveryDelayMs: 500,
        },
      });

      monitor.notifyFocus();

      // Simulate a slow agent redraw arriving 1.5s after focus (past the 1s
      // INPUT_ECHO_WINDOW_MS but within the 2s notifyFocus window).
      vi.advanceTimersByTime(1500);
      for (let i = 0; i < 30; i++) {
        monitor.onData("x".repeat(500));
        vi.advanceTimersByTime(10);
      }

      expect(monitor.getState()).toBe("idle");
      const busyCalls = onStateChange.mock.calls.filter((call) => call[2] === "busy");
      expect(busyCalls.length).toBe(0);

      monitor.dispose();
    });

    it("promotes idle→busy from output AFTER the focus suppression window expires", () => {
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("focus-test-2", 1000, onStateChange, {
        highOutputThreshold: {
          enabled: true,
          windowMs: 500,
          bytesPerSecond: 2048,
          recoveryEnabled: true,
          recoveryDelayMs: 500,
        },
      });

      monitor.notifyFocus(200);
      vi.advanceTimersByTime(250);

      for (let i = 0; i < 30; i++) {
        monitor.onData("x".repeat(500));
        vi.advanceTimersByTime(20);
      }

      expect(monitor.getState()).toBe("busy");

      monitor.dispose();
    });

    it("rapid successive focus events extend the suppression window", () => {
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("focus-test-3", 1000, onStateChange, {
        highOutputThreshold: {
          enabled: true,
          windowMs: 500,
          bytesPerSecond: 2048,
          recoveryEnabled: true,
          recoveryDelayMs: 500,
        },
      });

      monitor.notifyFocus(500);
      vi.advanceTimersByTime(400);
      monitor.notifyFocus(500);
      vi.advanceTimersByTime(400);

      // Still within the second window — bytes should be suppressed
      for (let i = 0; i < 20; i++) {
        monitor.onData("x".repeat(500));
        vi.advanceTimersByTime(5);
      }

      expect(monitor.getState()).toBe("idle");

      monitor.dispose();
    });

    it("suppresses pattern-based busy promotion during the focus window", () => {
      const onStateChange = vi.fn();
      const getVisibleLines = vi.fn(() => ["> "]);
      const monitor = new ActivityMonitor("focus-test-4", 1000, onStateChange, {
        getVisibleLines,
        getCursorLine: () => "> ",
        pollingIntervalMs: 50,
        idleDebounceMs: 200,
        bootCompletePatterns: [/ready/i],
        pollingMaxBootMs: 100,
        workingRecoveryDelayMs: 200,
      });

      monitor.startPolling();
      vi.advanceTimersByTime(150);
      onStateChange.mockClear();

      // Transition to idle
      vi.advanceTimersByTime(3000);
      expect(monitor.getState()).toBe("idle");
      onStateChange.mockClear();

      // Focus event, then agent redraws working pattern content
      monitor.notifyFocus(2000);
      getVisibleLines.mockReturnValue(["  esc to interrupt  "]);

      vi.advanceTimersByTime(1500);

      // Should remain idle — pattern recovery suppressed during focus window
      expect(monitor.getState()).toBe("idle");

      monitor.dispose();
    });

    it("dispose() clears the focus suppression window", () => {
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("focus-test-5", 1000, onStateChange);

      monitor.notifyFocus(5000);
      monitor.dispose();

      // After dispose, internal state is reset. Creating a new monitor with
      // a fresh ID should behave normally — the disposed monitor's focus
      // window must not bleed across instances (it can't via shared state,
      // but we still assert dispose() doesn't throw with a pending window).
      expect(monitor.getState()).toBe("idle");
    });

    it("does not affect an already-busy terminal — focus does not flip busy→idle", () => {
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("focus-test-6", 1000, onStateChange);

      monitor.onInput("hello\r");
      expect(monitor.getState()).toBe("busy");
      onStateChange.mockClear();

      monitor.notifyFocus(2000);
      expect(monitor.getState()).toBe("busy");

      monitor.dispose();
    });

    it("suppresses idle→busy from OSC 9;4 progress during the focus window (#8865)", () => {
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("focus-test-7", 1000, onStateChange);

      monitor.notifyFocus(2000);
      monitor.onOscProgressWorking();

      expect(monitor.getState()).toBe("idle");
      const busyCalls = onStateChange.mock.calls.filter((call) => call[2] === "busy");
      expect(busyCalls.length).toBe(0);

      monitor.dispose();
    });

    it("isFocusSuppressed() reflects window state and clears after expiry", () => {
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("focus-test-8", 1000, onStateChange);

      expect(monitor.isFocusSuppressed()).toBe(false);
      monitor.notifyFocus(500);
      expect(monitor.isFocusSuppressed()).toBe(true);
      vi.advanceTimersByTime(600);
      expect(monitor.isFocusSuppressed()).toBe(false);

      monitor.dispose();
    });
  });

  describe("Mouse-report input suppression (Issue #10925)", () => {
    it("does NOT promote idle→busy from redraws that coincide with recent scroll input", () => {
      const onStateChange = vi.fn();
      let visible = "waiting 0";
      const monitor = new ActivityMonitor("agent-mouse-1", 1000, onStateChange, {
        agentId: "claude",
        getVisibleLines: () => [visible],
        getCursorLine: () => visible,
        initialState: "idle",
        skipInitialStateEmit: true,
      });

      monitor.startPolling();
      vi.advanceTimersByTime(100);
      onStateChange.mockClear();

      // Each wheel tick forwards an SGR mouse-report sequence (stamping
      // lastUserInputAt via InputTracker) and the mouse-reporting TUI redraws
      // its alt-screen. This is the exact sustained-tail-change rhythm that
      // promotes idle→busy in "samples only the visible tail", but every redraw
      // lands inside the 1s input-echo window, so the agent must stay idle. The
      // companion recovery test below runs the same rhythm without recent input
      // and reaches busy, proving this suppression isn't passing trivially.
      const wheel = "\x1b[<64;10;5M";
      for (let i = 1; i <= 4; i++) {
        monitor.onInput(wheel);
        visible = `redraw ${i}`;
        monitor.onData(visible);
        vi.advanceTimersByTime(700);
      }

      expect(monitor.getState()).toBe("idle");
      const busyCalls = onStateChange.mock.calls.filter((call) => call[2] === "busy");
      expect(busyCalls.length).toBe(0);

      monitor.dispose();
    });

    it("still promotes idle→busy from sustained output once scrolling stops and the echo window expires", () => {
      const onStateChange = vi.fn();
      let visible = "waiting 0";
      const monitor = new ActivityMonitor("agent-mouse-2", 1000, onStateChange, {
        agentId: "claude",
        getVisibleLines: () => [visible],
        getCursorLine: () => visible,
        initialState: "idle",
        skipInitialStateEmit: true,
      });

      monitor.startPolling();
      vi.advanceTimersByTime(100);
      onStateChange.mockClear();

      // User scrolls briefly (two wheel ticks), then stops.
      const wheel = "\x1b[<64;10;5M";
      for (let i = 1; i <= 2; i++) {
        monitor.onInput(wheel);
        visible = `scroll ${i}`;
        monitor.onData(visible);
        vi.advanceTimersByTime(700);
      }
      expect(monitor.getState()).toBe("idle");

      // Scrolling stopped: let the input-echo window lapse (>1s since the last
      // wheel tick, which also resets the temperature change-gap), then genuine
      // sustained agent output must still recover. The fix suppresses
      // scroll-driven redraws, not real work that follows a scroll.
      vi.advanceTimersByTime(1100);
      for (let i = 1; i <= 4; i++) {
        visible = `real work ${i}`;
        monitor.onData(visible);
        vi.advanceTimersByTime(700);
      }

      expect(monitor.getState()).toBe("busy");
      expect(onStateChange).toHaveBeenCalledWith("agent-mouse-2", 1000, "busy", {
        trigger: "output",
      });

      monitor.dispose();
    });

    it("isRecentUserInput() reflects input-echo window state and clears after expiry", () => {
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("agent-mouse-3", 1000, onStateChange, {
        agentId: "claude",
      });

      expect(monitor.isRecentUserInput()).toBe(false);
      monitor.onInput("\x1b[<64;10;5M");
      expect(monitor.isRecentUserInput()).toBe(true);
      vi.advanceTimersByTime(1100);
      expect(monitor.isRecentUserInput()).toBe(false);

      monitor.dispose();
    });
  });

  describe("Working silence timeout", () => {
    it("should transition polling terminal to idle after silence exceeds maxWorkingSilenceMs", () => {
      const onStateChange = vi.fn();
      const getVisibleLines = vi.fn(() => ["some content"]);
      const monitor = new ActivityMonitor("test-1", 1000, onStateChange, {
        getVisibleLines,
        pollingIntervalMs: 100,
        idleDebounceMs: 10000,
        maxWorkingSilenceMs: 5000,
        bootCompletePatterns: [/ready/],
      });

      monitor.startPolling();

      // Boot: emit data with boot pattern to exit boot state
      monitor.onData("ready");
      vi.advanceTimersByTime(100);

      // Now in busy state, post-boot
      expect(monitor.getState()).toBe("busy");
      onStateChange.mockClear();

      // Just before threshold — should still be busy (100 + 4800 = 4900 < 5000)
      vi.advanceTimersByTime(4800);
      expect(monitor.getState()).toBe("busy");

      // Cross the threshold (4900 + 200 = 5100 > 5000)
      vi.advanceTimersByTime(200);

      expect(monitor.getState()).toBe("idle");
      const timeoutCall = onStateChange.mock.calls.find(
        (c: unknown[]) =>
          c[2] === "idle" && (c[3] as Record<string, unknown>)?.trigger === "timeout"
      );
      expect(timeoutCall).toBeDefined();

      monitor.dispose();
    });

    it("should transition non-polling terminal to idle after silence exceeds maxWorkingSilenceMs", () => {
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("test-1", 1000, onStateChange, {
        maxWorkingSilenceMs: 5000,
        idleDebounceMs: 2000,
        patternConfig: {
          primaryPatterns: [/working/i],
          scanLineCount: 10,
        },
      });

      // Make busy via input
      monitor.onInput("hello\r");
      // Working pattern keeps lastPatternResult.isWorking=true so the debounce
      // chain reschedules each cycle until the silence timeout fires. The
      // trailing \n keeps onData from treating the output as user echo.
      monitor.onData("working on it\n");
      expect(monitor.getState()).toBe("busy");
      onStateChange.mockClear();

      // The debounce timer fires at 2000ms but reschedules (working pattern fresh).
      // After 5000ms of silence (no fresh PTY data), the timeout check fires.
      vi.advanceTimersByTime(6000);

      expect(monitor.getState()).toBe("idle");
      const timeoutCall = onStateChange.mock.calls.find(
        (c: unknown[]) =>
          c[2] === "idle" && (c[3] as Record<string, unknown>)?.trigger === "timeout"
      );
      expect(timeoutCall).toBeDefined();

      monitor.dispose();
    });

    it("should not timeout when periodic output resets the silence clock", () => {
      const onStateChange = vi.fn();
      const getVisibleLines = vi.fn(() => ["some content"]);
      const monitor = new ActivityMonitor("test-1", 1000, onStateChange, {
        getVisibleLines,
        pollingIntervalMs: 100,
        maxWorkingSilenceMs: 5000,
        bootCompletePatterns: [/ready/],
      });

      monitor.startPolling();
      monitor.onData("ready");
      vi.advanceTimersByTime(100);
      expect(monitor.getState()).toBe("busy");

      // Send data every 2 seconds for 12 seconds total (well past 5s threshold)
      for (let i = 0; i < 6; i++) {
        vi.advanceTimersByTime(2000);
        monitor.onData("output chunk");
      }

      // Should still be busy — periodic output prevents timeout
      expect(monitor.getState()).toBe("busy");

      monitor.dispose();
    });

    it("should not timeout during boot phase", () => {
      const onStateChange = vi.fn();
      const getVisibleLines = vi.fn(() => ["loading..."]);
      const monitor = new ActivityMonitor("test-1", 1000, onStateChange, {
        getVisibleLines,
        pollingIntervalMs: 100,
        maxWorkingSilenceMs: 5000,
        bootCompletePatterns: [/ready/],
        pollingMaxBootMs: 60000,
      });

      monitor.startPolling();
      expect(monitor.getState()).toBe("busy");

      // Advance past silence timeout but don't trigger boot completion
      vi.advanceTimersByTime(10000);

      // Should still be busy — boot phase exempts from silence timeout
      expect(monitor.getState()).toBe("busy");

      monitor.dispose();
    });

    it("should reset silence clock on new busy cycle", () => {
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("test-1", 1000, onStateChange, {
        maxWorkingSilenceMs: 5000,
        idleDebounceMs: 2000,
        patternConfig: {
          primaryPatterns: [/working/i],
          scanLineCount: 10,
        },
      });

      // Make busy via input + working pattern so the debounce chain reschedules.
      // Trailing \n keeps onData from treating output as echo of recent input.
      monitor.onInput("hello\r");
      monitor.onData("working...\n");
      expect(monitor.getState()).toBe("busy");

      // Advance close to timeout (4500ms)
      vi.advanceTimersByTime(4500);
      expect(monitor.getState()).toBe("busy");

      // Refresh the working pattern timestamp so it stays within TTL,
      // then start a new busy cycle via input — this resets lastDataTimestamp
      monitor.onData("working...\n");
      monitor.onInput("make build\r");
      expect(monitor.getState()).toBe("busy");
      onStateChange.mockClear();

      // Advance another 4500ms — would have timed out under the old timestamp
      vi.advanceTimersByTime(4500);

      // Should still be busy — the new busy cycle reset the clock
      expect(monitor.getState()).toBe("busy");

      monitor.dispose();
    });
  });

  describe("prompt lexeme fallback heuristic", () => {
    it("detects prompt lexeme after the idle debounce stall when no pattern matches", () => {
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("test-lex", 100, onStateChange, {
        getVisibleLines: () => ["Which file should I modify?"],
        getCursorLine: () => "Which file should I modify?",
        pollingIntervalMs: 100,
        pollingMaxBootMs: 0,
        initialState: "busy",
        promptPatterns: [],
        promptHintPatterns: [],
      });

      monitor.onData("Which file should I modify?");
      monitor.startPolling();
      onStateChange.mockClear();

      vi.advanceTimersByTime(4100);

      const idleCall = onStateChange.mock.calls.find(
        (c: unknown[]) =>
          c[2] === "idle" && (c[3] as Record<string, unknown> | undefined)?.trigger === "pattern"
      );
      expect(idleCall).toBeDefined();
      expect((idleCall![3] as Record<string, unknown>).patternConfidence).toBe(0.7);

      monitor.dispose();
    });

    it("detects [y/N] bracket confirmation", () => {
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("test-lex2", 100, onStateChange, {
        getVisibleLines: () => ["Proceed? [y/N]"],
        getCursorLine: () => "Proceed? [y/N]",
        pollingIntervalMs: 100,
        pollingMaxBootMs: 0,
        initialState: "busy",
        promptPatterns: [],
        promptHintPatterns: [],
      });

      monitor.onData("Proceed? [y/N]");
      monitor.startPolling();
      onStateChange.mockClear();

      vi.advanceTimersByTime(4100);

      const idleCall = onStateChange.mock.calls.find(
        (c: unknown[]) =>
          c[2] === "idle" &&
          (c[3] as Record<string, unknown> | undefined)?.patternConfidence === 0.7
      );
      expect(idleCall).toBeDefined();

      monitor.dispose();
    });

    it("does NOT fire before the prompt-lexeme stall threshold", () => {
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("test-lex3", 100, onStateChange, {
        getVisibleLines: () => ["Continue?"],
        getCursorLine: () => "Continue?",
        pollingIntervalMs: 100,
        pollingMaxBootMs: 0,
        initialState: "busy",
        promptPatterns: [],
        promptHintPatterns: [],
      });

      monitor.onData("Continue?");
      monitor.startPolling();
      onStateChange.mockClear();

      vi.advanceTimersByTime(2000);

      const idleCall = onStateChange.mock.calls.find(
        (c: unknown[]) =>
          c[2] === "idle" &&
          (c[3] as Record<string, unknown> | undefined)?.patternConfidence === 0.7
      );
      expect(idleCall).toBeUndefined();

      monitor.dispose();
    });

    it("does NOT fire when no lexeme present", () => {
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("test-lex4", 100, onStateChange, {
        getVisibleLines: () => ["Building project..."],
        getCursorLine: () => "Building project...",
        pollingIntervalMs: 100,
        pollingMaxBootMs: 0,
        initialState: "busy",
        promptPatterns: [],
        promptHintPatterns: [],
      });

      monitor.onData("Building project...");
      monitor.startPolling();
      onStateChange.mockClear();

      vi.advanceTimersByTime(5000);

      const idleCall = onStateChange.mock.calls.find(
        (c: unknown[]) =>
          c[2] === "idle" &&
          (c[3] as Record<string, unknown> | undefined)?.patternConfidence === 0.7
      );
      expect(idleCall).toBeUndefined();

      monitor.dispose();
    });

    it("does NOT fire when existing prompt pattern matches (fast-path takes priority)", () => {
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("test-lex5", 100, onStateChange, {
        getVisibleLines: () => ["$ "],
        getCursorLine: () => "$ ",
        pollingIntervalMs: 100,
        pollingMaxBootMs: 0,
        initialState: "busy",
      });

      monitor.onData("$ ");
      monitor.startPolling();
      onStateChange.mockClear();

      vi.advanceTimersByTime(3500);

      const lexemeCall = onStateChange.mock.calls.find(
        (c: unknown[]) =>
          c[2] === "idle" &&
          (c[3] as Record<string, unknown> | undefined)?.patternConfidence === 0.7
      );
      expect(lexemeCall).toBeUndefined();

      monitor.dispose();
    });

    it("falls back to last visible line when cursorLine is empty", () => {
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("test-lex6", 100, onStateChange, {
        getVisibleLines: () => ["some output", "Enter password:"],
        getCursorLine: () => "",
        pollingIntervalMs: 100,
        pollingMaxBootMs: 0,
        initialState: "busy",
        promptPatterns: [],
        promptHintPatterns: [],
      });

      monitor.onData("Enter password:");
      monitor.startPolling();
      onStateChange.mockClear();

      vi.advanceTimersByTime(4100);

      const idleCall = onStateChange.mock.calls.find(
        (c: unknown[]) =>
          c[2] === "idle" &&
          (c[3] as Record<string, unknown> | undefined)?.patternConfidence === 0.7
      );
      expect(idleCall).toBeDefined();

      monitor.dispose();
    });
  });
});
