import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  ActivityMonitor,
  FSM_IDLE_BACKOFF_SETTLE_MS,
  FSM_IDLE_BACKOFF_POLLING_INTERVAL_MS,
  QUIET_POLLING_INTERVAL_MS,
  WAITING_WATCHDOG_INTERVAL_MS,
} from "../ActivityMonitor.js";
import { resetPtyPowerLevelForTesting, setPtyPowerLevel } from "../pty/ptyPowerPolicy.js";

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
  });

  describe("idle-agent polling backoff (#10906)", () => {
    // Builds a simple-output agent monitor that starts already idle (the
    // restored-session shape), so startPolling() arms the settle timer.
    function createIdleAgent(pollingIntervalMs = 50) {
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("agent-1", 1000, onStateChange, {
        simpleOutputState: true,
        getVisibleLines: () => ["> "],
        getCursorLine: () => "> ",
        initialState: "idle",
        skipInitialStateEmit: true,
        pollingIntervalMs,
      });
      return { monitor, onStateChange };
    }

    it("drops to the backoff cadence after a settled idle agent stays silent", () => {
      const setIntervalSpy = vi.spyOn(global, "setInterval");
      const { monitor } = createIdleAgent(50);

      monitor.startPolling();
      setIntervalSpy.mockClear();

      // Still silent through the settle window → swap to the backoff cadence.
      vi.advanceTimersByTime(FSM_IDLE_BACKOFF_SETTLE_MS);

      expect(setIntervalSpy).toHaveBeenCalledWith(
        expect.any(Function),
        FSM_IDLE_BACKOFF_POLLING_INTERVAL_MS
      );

      monitor.dispose();
    });

    it("debounces on the last idle byte: keeps resetting while data trickles in, backs off after silence", () => {
      const setIntervalSpy = vi.spyOn(global, "setInterval");
      const { monitor } = createIdleAgent(50);

      monitor.startPolling();
      setIntervalSpy.mockClear();

      // A byte every 1500ms (< the 3000ms settle) keeps re-arming the timer, so
      // it never fires while the agent stays idle-but-trickling.
      for (let i = 0; i < 4; i++) {
        vi.advanceTimersByTime(1500);
        monitor.onData("x");
      }
      expect(monitor.getState()).toBe("idle");
      expect(setIntervalSpy).not.toHaveBeenCalledWith(
        expect.any(Function),
        FSM_IDLE_BACKOFF_POLLING_INTERVAL_MS
      );

      // Silence past the settle window after the last byte → backoff engages.
      vi.advanceTimersByTime(FSM_IDLE_BACKOFF_SETTLE_MS);
      expect(setIntervalSpy).toHaveBeenCalledWith(
        expect.any(Function),
        FSM_IDLE_BACKOFF_POLLING_INTERVAL_MS
      );

      monitor.dispose();
    });

    it("restores the requested cadence on wake, not a hardcoded 50ms", () => {
      const setIntervalSpy = vi.spyOn(global, "setInterval");
      const { monitor } = createIdleAgent(50);

      monitor.startPolling();
      vi.advanceTimersByTime(FSM_IDLE_BACKOFF_SETTLE_MS); // backoff engages

      // A visibility change arrives while backed off — recorded, not applied live.
      monitor.setPollingInterval(500);
      setIntervalSpy.mockClear();

      // Wake on data → restore the latest requested interval (500), never 50.
      monitor.onData("x");

      expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 500);
      expect(setIntervalSpy).not.toHaveBeenCalledWith(expect.any(Function), 50);

      monitor.dispose();
    });

    it("does not apply a visibility change live while backed off", () => {
      const setIntervalSpy = vi.spyOn(global, "setInterval");
      const { monitor } = createIdleAgent(50);

      monitor.startPolling();
      vi.advanceTimersByTime(FSM_IDLE_BACKOFF_SETTLE_MS); // backoff engages (2000ms live)
      setIntervalSpy.mockClear();

      // While backed off, a background-tier request must not swap the live timer.
      monitor.setPollingInterval(500);

      expect(setIntervalSpy).not.toHaveBeenCalled();

      monitor.dispose();
    });

    it("restarts at the requested cadence after stop, not the stale backoff value", () => {
      const setIntervalSpy = vi.spyOn(global, "setInterval");
      const { monitor } = createIdleAgent(50);

      monitor.startPolling();
      vi.advanceTimersByTime(FSM_IDLE_BACKOFF_SETTLE_MS); // backoff engages

      monitor.stopPolling();
      setIntervalSpy.mockClear();
      monitor.startPolling();

      expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 50);
      expect(setIntervalSpy).not.toHaveBeenCalledWith(
        expect.any(Function),
        FSM_IDLE_BACKOFF_POLLING_INTERVAL_MS
      );

      monitor.dispose();
    });

    it("clears the pending settle timer on dispose", () => {
      const setIntervalSpy = vi.spyOn(global, "setInterval");
      const { monitor } = createIdleAgent(50);

      monitor.startPolling();
      // Dispose before the settle timer fires.
      vi.advanceTimersByTime(FSM_IDLE_BACKOFF_SETTLE_MS - 500);
      monitor.dispose();
      setIntervalSpy.mockClear();

      vi.advanceTimersByTime(FSM_IDLE_BACKOFF_SETTLE_MS * 2);

      expect(setIntervalSpy).not.toHaveBeenCalledWith(
        expect.any(Function),
        FSM_IDLE_BACKOFF_POLLING_INTERVAL_MS
      );
    });

    it("backs off again after a busy→idle round trip", () => {
      const setIntervalSpy = vi.spyOn(global, "setInterval");
      const { monitor } = createIdleAgent(50);

      monitor.startPolling();
      vi.advanceTimersByTime(FSM_IDLE_BACKOFF_SETTLE_MS); // backoff engages

      // Wake, go busy, then settle back to idle — a fresh backoff must arm.
      monitor.onData("x");
      monitor.notifyExternalPromotion();
      expect(monitor.getState()).toBe("busy");
      setIntervalSpy.mockClear();

      // Return to idle via the simple-output idle gate: quiet past IDLE_DEBOUNCE_MS.
      vi.advanceTimersByTime(9000);
      expect(monitor.getState()).toBe("idle");

      // Then silent through another settle window → backoff re-engages.
      setIntervalSpy.mockClear();
      vi.advanceTimersByTime(FSM_IDLE_BACKOFF_SETTLE_MS);
      expect(setIntervalSpy).toHaveBeenCalledWith(
        expect.any(Function),
        FSM_IDLE_BACKOFF_POLLING_INTERVAL_MS
      );

      monitor.dispose();
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

    it("should not keep busy from echoed typing while prompt is visible", () => {
      const onStateChange = vi.fn();
      let typed = "";
      let visibleLines = ["Working (esc to interrupt)", "> "];
      const monitor = new ActivityMonitor("test-1", 1000, onStateChange, {
        getVisibleLines: () => visibleLines,
        getCursorLine: () => visibleLines[visibleLines.length - 1],
        idleDebounceMs: 400,
      });

      monitor.startPolling();
      vi.advanceTimersByTime(100);
      expect(monitor.getState()).toBe("busy");
      onStateChange.mockClear();

      for (const ch of ["h", "e", "l", "l", "o"]) {
        typed += ch;
        visibleLines = ["Working (esc to interrupt)", `> ${typed}`];
        monitor.onInput(ch);
        monitor.onData(ch);
        vi.advanceTimersByTime(120);
      }

      // Wait long enough for working hold to expire (set ~100ms into polling)
      // and idle debounce (400ms) to be satisfied
      vi.advanceTimersByTime(2000);

      expect(monitor.getState()).toBe("idle");
      const busyCalls = onStateChange.mock.calls.filter((call) => call[2] === "busy");
      expect(busyCalls.length).toBe(0);

      monitor.dispose();
    });
  });

  describe("Cosmetic redraw filtering (Issue #3189 / #6365)", () => {
    // #3189 introduced cosmetic-redraw classification so spinner-only output
    // wouldn't escalate idle→busy on its own (becomeBusy gate). #6365 corrected
    // the over-broad consequence: spinner ticks ARE liveness evidence and must
    // reset the debounce timer when the agent is already busy. Tests below
    // exercise both contracts.

    it("should keep busy state alive across Ink cursor-up redraws (#6365)", () => {
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("test-1", 1000, onStateChange, {
        idleDebounceMs: 300,
      });

      monitor.onInput("run\r");
      expect(monitor.getState()).toBe("busy");
      onStateChange.mockClear();

      // Ink-style cursor-up + erase-line + spinner (Claude Code / Gemini CLI)
      for (let i = 0; i < 10; i++) {
        monitor.onData("\x1b[1A\x1b[2K✽ Deliberating… (esc to interrupt)");
        vi.advanceTimersByTime(100);
      }

      expect(monitor.getState()).toBe("busy");

      monitor.dispose();
    });

    it("should still count non-cosmetic CR rewrites as activity", () => {
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("test-1", 1000, onStateChange, {
        idleDebounceMs: 300,
      });

      monitor.onInput("run\r");
      expect(monitor.getState()).toBe("busy");
      onStateChange.mockClear();

      // Send CR-based output that does NOT match any status pattern
      // (e.g. a build tool writing real content on the same line)
      for (let i = 0; i < 5; i++) {
        monitor.onData("\rCompiling module-" + i + ".ts...");
        vi.advanceTimersByTime(100);
      }

      // Debounce should have been reset by each real output — still busy
      expect(monitor.getState()).toBe("busy");

      monitor.dispose();
    });

    it("should keep busy state alive across Gemini CLI tool-use status lines (#6365)", () => {
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("test-1", 1000, onStateChange, {
        idleDebounceMs: 300,
      });

      monitor.onInput("run\r");
      expect(monitor.getState()).toBe("busy");
      onStateChange.mockClear();

      for (let i = 0; i < 10; i++) {
        monitor.onData("\r✦ Using ReadFile...");
        vi.advanceTimersByTime(100);
      }

      expect(monitor.getState()).toBe("busy");

      monitor.dispose();
    });

    it("should go idle once spinner stream stops and debounce expires (#6365)", () => {
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("test-1", 1000, onStateChange, {
        idleDebounceMs: 300,
      });

      monitor.onInput("run\r");
      expect(monitor.getState()).toBe("busy");
      onStateChange.mockClear();

      // Spinner ticks for 1s — state stays busy
      for (let i = 0; i < 10; i++) {
        monitor.onData("\r⠙ Working (esc to interrupt)");
        vi.advanceTimersByTime(100);
      }
      expect(monitor.getState()).toBe("busy");

      // Stream stops — last reset was at the final tick, debounce(300ms) fires
      vi.advanceTimersByTime(400);
      expect(monitor.getState()).toBe("idle");

      monitor.dispose();
    });

    it("should not escalate idle→busy from spinner-only output (#3189)", () => {
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("test-1", 1000, onStateChange, {
        idleDebounceMs: 300,
      });

      // Monitor starts idle. Spinner output alone must NOT escalate to busy —
      // spinner is liveness evidence only when already in a busy cycle.
      expect(monitor.getState()).toBe("idle");
      onStateChange.mockClear();

      for (let i = 0; i < 10; i++) {
        monitor.onData("\r⠙ Working (esc to interrupt)");
        vi.advanceTimersByTime(100);
      }

      expect(monitor.getState()).toBe("idle");
      expect(onStateChange).not.toHaveBeenCalled();

      monitor.dispose();
    });

    it("should stay busy when real output follows cosmetic redraws", () => {
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("test-1", 1000, onStateChange, {
        idleDebounceMs: 300,
      });

      monitor.onInput("run\r");
      expect(monitor.getState()).toBe("busy");
      onStateChange.mockClear();

      // Send cosmetic spinner frames for 200ms (within debounce window)
      for (let i = 0; i < 2; i++) {
        monitor.onData("\r⠙ Working (esc to interrupt)");
        vi.advanceTimersByTime(100);
      }

      // Now send real semantic output — this should reset the debounce timer
      monitor.onData("\nFile created: src/index.ts\n");
      vi.advanceTimersByTime(200);

      // Should still be busy because the real output reset the debounce
      expect(monitor.getState()).toBe("busy");

      // After full debounce window with no more output, should go idle
      vi.advanceTimersByTime(300);
      expect(monitor.getState()).toBe("idle");

      monitor.dispose();
    });

    it("should not escalate idle→busy from idle-noise sequences (#6365)", () => {
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("test-1", 1000, onStateChange, {
        idleDebounceMs: 300,
        outputActivityDetection: {
          enabled: true,
          activationThreshold: 200,
          maxBytesPerFrame: 120,
          leakRatePerMs: 0.1,
        },
      });

      // Monitor is idle. A stream of pure DECSET/OSC/CPR noise must not
      // trigger volume-based idle→busy escalation — these sequences are
      // stripped by stripIdleTerminalSequences before reaching the detector.
      expect(monitor.getState()).toBe("idle");
      onStateChange.mockClear();

      for (let i = 0; i < 20; i++) {
        monitor.onData("\x1b[?25h\x1b]133;A\x07\x1b[24;80R\x1b[?25l");
        vi.advanceTimersByTime(50);
      }

      expect(monitor.getState()).toBe("idle");
      expect(onStateChange).not.toHaveBeenCalled();

      monitor.dispose();
    });

    it("should NOT keep busy alive forever from pure protocol noise (#6365)", () => {
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("test-1", 1000, onStateChange, {
        idleDebounceMs: 300,
      });

      monitor.onInput("run\r");
      expect(monitor.getState()).toBe("busy");
      onStateChange.mockClear();

      // After agent completion the shell may emit OSC 133 / DECSET noise on
      // prompt redisplay. These bytes are NOT classified as cosmetic redraw
      // (no \r + spinner pattern), so the older fix would have hit the broad
      // `state === "busy"` debounce reset and held busy until MAX_WORKING_SILENCE_MS.
      for (let i = 0; i < 30; i++) {
        monitor.onData("\x1b[?25h\x1b]133;A\x07\x1b[24;80R\x1b[?25l");
        vi.advanceTimersByTime(50);
      }

      // Total elapsed: 1500ms — well past 300ms debounce. Pure protocol noise
      // must not have reset the timer. State must transition to idle.
      expect(monitor.getState()).toBe("idle");

      monitor.dispose();
    });

    it("should not escalate idle→busy from OSC 2 window-title bursts (#6365)", () => {
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("test-1", 1000, onStateChange, {
        idleDebounceMs: 300,
        outputActivityDetection: {
          enabled: true,
          activationThreshold: 200,
          maxBytesPerFrame: 120,
          leakRatePerMs: 0.1,
        },
      });

      expect(monitor.getState()).toBe("idle");
      onStateChange.mockClear();

      // Some agents/shells set the window title via OSC 2 every prompt redraw.
      // These must be filtered as idle-noise, not counted toward volume gates.
      for (let i = 0; i < 10; i++) {
        monitor.onData("\x1b]2;Claude — Working\x07");
        vi.advanceTimersByTime(100);
      }

      expect(monitor.getState()).toBe("idle");
      expect(onStateChange).not.toHaveBeenCalled();

      monitor.dispose();
    });

    it("should not escalate idle→busy from a single unfiltered noise frame (#6365)", () => {
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("test-1", 1000, onStateChange, {
        idleDebounceMs: 300,
        outputActivityDetection: {
          enabled: true,
          activationThreshold: 200,
          maxBytesPerFrame: 120,
          leakRatePerMs: 0.1,
        },
      });

      expect(monitor.getState()).toBe("idle");
      onStateChange.mockClear();

      // A single chunk that gets past the filter (e.g. an OSC variant we
      // don't recognize) must not escalate idle→busy on its own — the
      // maxBytesPerFrame cap is the per-chunk noise gate.
      monitor.onData("\x1b]999;some-experimental-payload\x07");

      expect(monitor.getState()).toBe("idle");
      expect(onStateChange).not.toHaveBeenCalled();

      monitor.dispose();
    });
  });
});

// Power-policy stretch of the ActivityMonitor's optional cadences (#12515).
describe("ActivityMonitor power policy", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    resetPtyPowerLevelForTesting();
    vi.useRealTimers();
    vi.clearAllTimers();
    vi.restoreAllMocks();
  });

  // A simple-output agent that starts already idle (the restored-session
  // shape), so startPolling() arms the settle timer.
  function createIdleAgent(options: { onWaitingTimeout?: () => void } = {}) {
    return new ActivityMonitor("agent-1", 1000, vi.fn(), {
      simpleOutputState: true,
      getVisibleLines: () => ["> "],
      getCursorLine: () => "> ",
      initialState: "idle",
      skipInitialStateEmit: true,
      pollingIntervalMs: 50,
      onWaitingTimeout: options.onWaitingTimeout,
    });
  }

  it.each(["active", "saving", "deep"] as const)(
    "backs a settled idle agent off to the %s quiet cadence",
    (level) => {
      // The cadence tables are indexed by the OBSERVATION level, which main
      // derives separately: a window on screen holds it at `active` however
      // narrow the raw level is. Driven directly here.
      setPtyPowerLevel(level, level);
      const setIntervalSpy = vi.spyOn(global, "setInterval");
      const monitor = createIdleAgent();

      monitor.startPolling();
      setIntervalSpy.mockClear();
      vi.advanceTimersByTime(FSM_IDLE_BACKOFF_SETTLE_MS);

      expect(setIntervalSpy).toHaveBeenCalledWith(
        expect.any(Function),
        QUIET_POLLING_INTERVAL_MS[level]
      );
      monitor.dispose();
    }
  );

  it("re-times a live backoff when the level changes, in both directions", () => {
    const setIntervalSpy = vi.spyOn(global, "setInterval");
    const monitor = createIdleAgent();
    monitor.startPolling();
    vi.advanceTimersByTime(FSM_IDLE_BACKOFF_SETTLE_MS);
    setIntervalSpy.mockClear();

    setPtyPowerLevel("deep");
    expect(setIntervalSpy).toHaveBeenCalledWith(
      expect.any(Function),
      QUIET_POLLING_INTERVAL_MS.deep
    );

    setIntervalSpy.mockClear();
    setPtyPowerLevel("active");
    expect(setIntervalSpy).toHaveBeenCalledWith(
      expect.any(Function),
      QUIET_POLLING_INTERVAL_MS.active
    );
    monitor.dispose();
  });

  it("does not touch the polling cadence on a level change when not backed off", () => {
    const monitor = createIdleAgent();
    monitor.startPolling();
    const setIntervalSpy = vi.spyOn(global, "setInterval");

    setPtyPowerLevel("saving", "saving");

    // This monitor has no watchdog and is not backed off, so a level change
    // owes it no timer at all. Asserting "not 50, not 5000" let a regression
    // through: any other interval would have passed.
    expect(setIntervalSpy).not.toHaveBeenCalled();
    monitor.dispose();
  });

  it("wakes to the requested cadence on the first output byte even when deep", () => {
    setPtyPowerLevel("deep");
    const setIntervalSpy = vi.spyOn(global, "setInterval");
    const monitor = createIdleAgent();
    monitor.startPolling();
    vi.advanceTimersByTime(FSM_IDLE_BACKOFF_SETTLE_MS);
    setIntervalSpy.mockClear();

    monitor.onData("x");

    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 50);
    monitor.dispose();
  });

  it("runs the waiting watchdog at the level's cadence and re-times it on a change", () => {
    const setIntervalSpy = vi.spyOn(global, "setInterval");
    const monitor = createIdleAgent({ onWaitingTimeout: vi.fn() });

    expect(setIntervalSpy).toHaveBeenCalledWith(
      expect.any(Function),
      WAITING_WATCHDOG_INTERVAL_MS.active
    );

    setIntervalSpy.mockClear();
    setPtyPowerLevel("deep");
    expect(setIntervalSpy).toHaveBeenCalledWith(
      expect.any(Function),
      WAITING_WATCHDOG_INTERVAL_MS.deep
    );
    monitor.dispose();
  });

  it("keeps a live waiting agent whose keepalives land between slow probes", () => {
    setPtyPowerLevel("deep");
    const onStateChange = vi.fn();
    const onWaitingTimeout = vi.fn();
    const monitor = new ActivityMonitor("agent-1", 1000, onStateChange, {
      simpleOutputState: true,
      getVisibleLines: () => ["> "],
      getCursorLine: () => "> ",
      initialState: "idle",
      skipInitialStateEmit: true,
      pollingIntervalMs: 50,
      processStateValidator: { hasActiveChildren: () => false },
      onWaitingTimeout,
      maxWaitingSilenceMs: 1000,
    });

    // An invisible title refresh 6s into every 15s probe gap: 9s old when the
    // probe runs, so only a window spanning the gap can see it.
    vi.advanceTimersByTime(6000);
    for (let i = 0; i < 6; i++) {
      monitor.onData("\x1b]0;agent\x07");
      vi.advanceTimersByTime(WAITING_WATCHDOG_INTERVAL_MS.deep);
    }

    expect(onStateChange).not.toHaveBeenCalled();
    expect(onWaitingTimeout).not.toHaveBeenCalled();
    monitor.dispose();
  });

  it("allocates no watchdog timer for a monitor with nothing to fire", () => {
    const setIntervalSpy = vi.spyOn(global, "setInterval");
    const monitor = createIdleAgent();

    setPtyPowerLevel("saving");

    expect(setIntervalSpy).not.toHaveBeenCalledWith(
      expect.any(Function),
      WAITING_WATCHDOG_INTERVAL_MS.active
    );
    expect(setIntervalSpy).not.toHaveBeenCalledWith(
      expect.any(Function),
      WAITING_WATCHDOG_INTERVAL_MS.saving
    );
    monitor.dispose();
  });

  it("keeps the active cadence for a blurred window that is still on screen", () => {
    const setIntervalSpy = vi.spyOn(global, "setInterval");
    const monitor = createIdleAgent({ onWaitingTimeout: vi.fn() });
    monitor.startPolling();
    vi.advanceTimersByTime(FSM_IDLE_BACKOFF_SETTLE_MS);
    setIntervalSpy.mockClear();

    // Clicking into another app takes the level to `saving` without taking the
    // window off screen. The sidebar this agent's badge is drawn in is still
    // being looked at, so its state has to keep confirming at full cadence.
    // Clicking into another app on AC: the raw level narrows to `saving` while
    // the observation level stays `active`, because the window the badge is
    // drawn in is still on screen.
    setPtyPowerLevel("saving", "active");

    // Asserted positively: WAITING_WATCHDOG_INTERVAL_MS.active and
    // QUIET_POLLING_INTERVAL_MS.saving are both 5000, so a "not called with
    // 5000" assertion passes and fails for the wrong reasons.
    const intervals = setIntervalSpy.mock.calls.map(([, ms]) => ms);
    expect(intervals).toContain(QUIET_POLLING_INTERVAL_MS.active);
    expect(intervals).toContain(WAITING_WATCHDOG_INTERVAL_MS.active);
    expect(intervals).not.toContain(WAITING_WATCHDOG_INTERVAL_MS.saving);
    expect(intervals).not.toContain(WAITING_WATCHDOG_INTERVAL_MS.deep);
    monitor.dispose();
  });

  it("re-times when only the observation level moves", () => {
    setPtyPowerLevel("saving", "active");
    const setIntervalSpy = vi.spyOn(global, "setInterval");
    const monitor = createIdleAgent({ onWaitingTimeout: vi.fn() });
    monitor.startPolling();
    vi.advanceTimersByTime(FSM_IDLE_BACKOFF_SETTLE_MS);
    setIntervalSpy.mockClear();

    // Unplugging while blurred: the raw level was already `saving` and stays
    // there, and only the observation level narrows. Nothing re-times if the
    // notification is gated on the raw level alone.
    setPtyPowerLevel("saving", "saving");

    const intervals = setIntervalSpy.mock.calls.map(([, ms]) => ms);
    expect(intervals).toContain(QUIET_POLLING_INTERVAL_MS.saving);
    expect(intervals).toContain(WAITING_WATCHDOG_INTERVAL_MS.saving);
    monitor.dispose();
  });

  it("stops listening for level changes once disposed", () => {
    const onChange = vi.spyOn(
      ActivityMonitor.prototype as unknown as { onPowerLevelChange: () => void },
      "onPowerLevelChange"
    );
    const monitor = createIdleAgent({ onWaitingTimeout: vi.fn() });
    monitor.dispose();

    setPtyPowerLevel("deep");

    expect(onChange).not.toHaveBeenCalled();
  });

  // Counted in callbacks actually run, not timer arguments: the levels have to
  // cost fewer wakeups, not merely name different intervals.
  it("runs fewer polls and watchdog probes for a settled agent as the level deepens", () => {
    const polls = vi.spyOn(
      ActivityMonitor.prototype as unknown as { runPollingCycle: () => void },
      "runPollingCycle"
    );
    const probes = vi.spyOn(
      ActivityMonitor.prototype as unknown as { runWaitingWatchdogCheck: (now: number) => void },
      "runWaitingWatchdogCheck"
    );
    const minuteOfWork = (level: "active" | "saving" | "deep") => {
      setPtyPowerLevel(level, level);
      const monitor = createIdleAgent({ onWaitingTimeout: vi.fn() });
      monitor.startPolling();
      vi.advanceTimersByTime(FSM_IDLE_BACKOFF_SETTLE_MS);
      polls.mockClear();
      probes.mockClear();
      vi.advanceTimersByTime(60_000);
      monitor.dispose();
      resetPtyPowerLevelForTesting();
      return { polls: polls.mock.calls.length, probes: probes.mock.calls.length };
    };

    const active = minuteOfWork("active");
    const saving = minuteOfWork("saving");
    const deep = minuteOfWork("deep");

    expect(saving.polls).toBeLessThan(active.polls);
    expect(deep.polls).toBeLessThan(saving.polls);
    expect(saving.probes).toBeLessThan(active.probes);
    expect(deep.probes).toBeLessThan(saving.probes);
  });
});
