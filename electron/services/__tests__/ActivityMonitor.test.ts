import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  ActivityMonitor,
  FSM_IDLE_BACKOFF_SETTLE_MS,
  FSM_IDLE_BACKOFF_POLLING_INTERVAL_MS,
} from "../ActivityMonitor.js";
import { AGENT_OUTPUT_ACTIVITY_LINE_COUNT } from "../pty/AgentActivityTemperature.js";
import { buildActivityMonitorOptions } from "../pty/terminalActivityPatterns.js";
import {
  createVisibleCellContentSnapshot,
  createVisibleContentSnapshot,
  type VisibleContentCell,
} from "../pty/SustainedChangeTracker.js";

function visibleCell(partial: Partial<VisibleContentCell> = {}): VisibleContentCell {
  const chars = partial.chars ?? "●";
  return {
    chars,
    code: partial.code ?? chars.codePointAt(0) ?? 0,
    width: partial.width ?? 1,
    fgColorMode: partial.fgColorMode ?? 0,
    fgColor: partial.fgColor ?? 0,
    attributes: partial.attributes ?? 0,
  };
}

function visibleRow(text: string, partial: Partial<VisibleContentCell> = {}): VisibleContentCell[] {
  return Array.from(text).map((chars) =>
    visibleCell({
      ...partial,
      chars,
      code: chars.codePointAt(0) ?? 0,
    })
  );
}

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

    it("should transition to idle once spinner stream stops and debounce expires (#3189 / #6365)", () => {
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("test-1", 1000, onStateChange, {
        idleDebounceMs: 200,
      });

      monitor.onInput("run\r");
      expect(monitor.getState()).toBe("busy");
      onStateChange.mockClear();

      // Spinner ticks reset the debounce timer (#6365), so the agent stays busy
      // throughout the stream.
      for (let i = 0; i < 5; i++) {
        monitor.onData("\r⠋ Working (esc to interrupt)");
        vi.advanceTimersByTime(100);
      }
      expect(monitor.getState()).toBe("busy");

      // Stream stops — last reset was at the final tick. After debounce(200ms)
      // expires with no further data, state goes idle.
      vi.advanceTimersByTime(300);

      expect(monitor.getState()).toBe("idle");

      monitor.dispose();
    });
  });

  describe("Cosmetic redraw filtering (Issue #3189 / #6365)", () => {
    // #3189 introduced cosmetic-redraw classification so spinner-only output
    // wouldn't escalate idle→busy on its own (becomeBusy gate). #6365 corrected
    // the over-broad consequence: spinner ticks ARE liveness evidence and must
    // reset the debounce timer when the agent is already busy. Tests below
    // exercise both contracts.

    it("should keep busy state alive across a Braille spinner stream (#6365)", () => {
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("test-1", 1000, onStateChange, {
        idleDebounceMs: 300,
      });

      monitor.onInput("run\r");
      expect(monitor.getState()).toBe("busy");
      onStateChange.mockClear();

      // Spinner ticks every 100ms across 1s — well past the 300ms debounce.
      // Each tick must reset the debounce so state stays busy mid-thought.
      for (let i = 0; i < 10; i++) {
        monitor.onData("\r⠙ Working (esc to interrupt)");
        vi.advanceTimersByTime(100);
      }

      expect(monitor.getState()).toBe("busy");

      monitor.dispose();
    });

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

  describe("Simple output-driven agent state", () => {
    it("requires sustained visible changes before recovering to working", () => {
      const onStateChange = vi.fn();
      let visible = "waiting 0";
      const monitor = new ActivityMonitor("agent-simple-1", 1000, onStateChange, {
        agentId: "claude",
        getVisibleLines: () => [visible],
        getCursorLine: () => visible,
        initialState: "idle",
        skipInitialStateEmit: true,
      });

      monitor.startPolling();

      vi.advanceTimersByTime(100);
      visible = "tick 1";
      vi.advanceTimersByTime(50);
      expect(monitor.getState()).toBe("idle");

      vi.advanceTimersByTime(650);
      visible = "tick 2";
      vi.advanceTimersByTime(50);
      expect(monitor.getState()).toBe("idle");

      vi.advanceTimersByTime(650);
      visible = "tick 3";
      vi.advanceTimersByTime(50);
      expect(monitor.getState()).toBe("idle");

      vi.advanceTimersByTime(650);
      visible = "tick 4";
      vi.advanceTimersByTime(50);

      expect(monitor.getState()).toBe("busy");
      expect(onStateChange).toHaveBeenCalledWith("agent-simple-1", 1000, "busy", {
        trigger: "output",
      });

      vi.advanceTimersByTime(5999);
      expect(monitor.getState()).toBe("busy");

      vi.advanceTimersByTime(200);
      expect(monitor.getState()).toBe("idle");
      expect(onStateChange).toHaveBeenCalledWith("agent-simple-1", 1000, "idle", {
        trigger: "timeout",
        waitingReason: "prompt",
      });

      monitor.dispose();
    });

    it("ignores line-wrap-only reflows while idle", () => {
      const onStateChange = vi.fn();
      let visibleLines = ["Claude Code is waiting for input"];
      const monitor = new ActivityMonitor("agent-simple-reflow", 1000, onStateChange, {
        agentId: "claude",
        getVisibleLines: () => visibleLines,
        getCursorLine: () => visibleLines[visibleLines.length - 1],
        initialState: "idle",
        skipInitialStateEmit: true,
      });

      monitor.startPolling();
      vi.advanceTimersByTime(100);
      onStateChange.mockClear();

      visibleLines = ["Claude Code", "is waiting", "for input"];
      vi.advanceTimersByTime(3000);

      expect(monitor.getState()).toBe("idle");
      expect(onStateChange).not.toHaveBeenCalled();

      monitor.dispose();
    });

    it("ignores repeated separator width changes in visual snapshots", () => {
      const onStateChange = vi.fn();
      let separatorLength = 5;
      const getVisibleContentSnapshot = vi.fn((count: number) => {
        expect(count).toBe(AGENT_OUTPUT_ACTIVITY_LINE_COUNT);
        return createVisibleContentSnapshot("-".repeat(separatorLength));
      });
      const monitor = new ActivityMonitor("agent-simple-separator-resize", 1000, onStateChange, {
        agentId: "claude",
        getVisibleLines: () => ["-----"],
        getVisibleContentSnapshot,
        initialState: "idle",
        skipInitialStateEmit: true,
      });

      monitor.startPolling();
      vi.advanceTimersByTime(100);
      onStateChange.mockClear();

      for (const length of [10, 20, 40, 8]) {
        separatorLength = length;
        vi.advanceTimersByTime(700);
      }

      expect(getVisibleContentSnapshot).toHaveBeenCalled();
      expect(monitor.getState()).toBe("idle");
      expect(onStateChange).not.toHaveBeenCalled();

      monitor.dispose();
    });

    it("samples only the visible tail for simple output recovery", () => {
      const onStateChange = vi.fn();
      let visibleLines = Array.from({ length: 30 }, (_, i) => `historical line ${i + 1}`);
      const getVisibleLines = vi.fn((count: number) => visibleLines.slice(-count));
      const monitor = new ActivityMonitor("agent-simple-tail", 1000, onStateChange, {
        agentId: "claude",
        getVisibleLines,
        getCursorLine: () => visibleLines[visibleLines.length - 1],
        initialState: "idle",
        skipInitialStateEmit: true,
      });

      monitor.startPolling();
      expect(getVisibleLines).toHaveBeenCalledWith(AGENT_OUTPUT_ACTIVITY_LINE_COUNT);
      getVisibleLines.mockClear();

      vi.advanceTimersByTime(100);
      onStateChange.mockClear();

      for (let i = 0; i < 4; i += 1) {
        visibleLines = [...visibleLines];
        visibleLines[i] = `rewritten historical line ${i + 1}`;
        monitor.onData(visibleLines[i]!);
        vi.advanceTimersByTime(700);
      }

      expect(monitor.getState()).toBe("idle");
      expect(onStateChange).not.toHaveBeenCalled();
      expect(getVisibleLines).toHaveBeenCalledWith(AGENT_OUTPUT_ACTIVITY_LINE_COUNT);

      for (let i = 0; i < 4; i += 1) {
        visibleLines = [...visibleLines];
        visibleLines[visibleLines.length - 1] = `visible activity ${i + 1}`;
        monitor.onData(visibleLines[visibleLines.length - 1]!);
        vi.advanceTimersByTime(700);
      }

      expect(monitor.getState()).toBe("busy");
      expect(onStateChange).toHaveBeenCalledWith("agent-simple-tail", 1000, "busy", {
        trigger: "output",
      });

      monitor.dispose();
    });

    it("recovers from sustained color-only visual cell changes", () => {
      const onStateChange = vi.fn();
      let fgColor = 1;
      const monitor = new ActivityMonitor("agent-simple-color-spinner", 1000, onStateChange, {
        agentId: "claude",
        getVisibleLines: () => ["●●●"],
        getVisibleContentSnapshot: () =>
          createVisibleCellContentSnapshot([visibleRow("●●●", { fgColorMode: 1, fgColor })]),
        initialState: "idle",
        skipInitialStateEmit: true,
      });

      monitor.startPolling();
      vi.advanceTimersByTime(100);
      fgColor = 2;
      vi.advanceTimersByTime(50);
      expect(monitor.getState()).toBe("idle");

      vi.advanceTimersByTime(650);
      fgColor = 3;
      vi.advanceTimersByTime(50);
      expect(monitor.getState()).toBe("idle");

      vi.advanceTimersByTime(650);
      fgColor = 4;
      vi.advanceTimersByTime(50);
      expect(monitor.getState()).toBe("idle");

      vi.advanceTimersByTime(650);
      fgColor = 5;
      vi.advanceTimersByTime(50);

      expect(monitor.getState()).toBe("busy");
      expect(onStateChange).toHaveBeenCalledWith("agent-simple-color-spinner", 1000, "busy", {
        trigger: "output",
      });

      monitor.dispose();
    });

    it("treats resize as suppressed baseline reseed before simple output recovery", () => {
      const onStateChange = vi.fn();
      let visible = "waiting";
      const monitor = new ActivityMonitor("agent-simple-resize", 1000, onStateChange, {
        agentId: "claude",
        getVisibleLines: () => [visible],
        getCursorLine: () => visible,
        initialState: "idle",
        skipInitialStateEmit: true,
      });

      monitor.startPolling();
      vi.advanceTimersByTime(100);
      onStateChange.mockClear();

      monitor.notifyResize(1000);
      visible = "resize reflow";
      vi.advanceTimersByTime(500);
      expect(monitor.getState()).toBe("idle");
      expect(onStateChange).not.toHaveBeenCalled();

      visible = "post resize baseline";
      vi.advanceTimersByTime(600);
      expect(monitor.getState()).toBe("idle");
      expect(onStateChange).not.toHaveBeenCalled();

      for (let i = 0; i < 4; i += 1) {
        visible = `post resize activity ${i + 1}`;
        monitor.onData(visible);
        vi.advanceTimersByTime(700);
      }

      expect(monitor.getState()).toBe("busy");
      expect(onStateChange).toHaveBeenCalledWith("agent-simple-resize", 1000, "busy", {
        trigger: "output",
      });

      monitor.dispose();
    });

    it("does not recover to working from resize-only reflow bursts", () => {
      const onStateChange = vi.fn();
      let visible = "waiting";
      const monitor = new ActivityMonitor("agent-simple-resize-burst", 1000, onStateChange, {
        agentId: "claude",
        getVisibleLines: () => [visible],
        getCursorLine: () => visible,
        initialState: "idle",
        skipInitialStateEmit: true,
      });

      monitor.startPolling();
      vi.advanceTimersByTime(100);
      onStateChange.mockClear();

      monitor.notifyResize(1000);
      visible = "reflow frame 1";
      vi.advanceTimersByTime(800);
      expect(monitor.getState()).toBe("idle");

      monitor.notifyResize(1000);
      visible = "reflow frame 2";
      vi.advanceTimersByTime(800);
      expect(monitor.getState()).toBe("idle");

      monitor.notifyResize(1000);
      visible = "reflow frame 3";
      vi.advanceTimersByTime(800);
      expect(monitor.getState()).toBe("idle");

      visible = "post resize baseline";
      vi.advanceTimersByTime(1000);
      expect(monitor.getState()).toBe("idle");

      vi.advanceTimersByTime(3000);
      expect(monitor.getState()).toBe("idle");
      expect(onStateChange).not.toHaveBeenCalledWith(
        "agent-simple-resize-burst",
        1000,
        "busy",
        expect.anything()
      );

      monitor.dispose();
    });

    it("recovers from a sustained one-character activity indicator", () => {
      const onStateChange = vi.fn();
      let visible = "Working |";
      const monitor = new ActivityMonitor("agent-simple-spinner", 1000, onStateChange, {
        agentId: "claude",
        getVisibleLines: () => [visible],
        getCursorLine: () => visible,
        initialState: "idle",
        skipInitialStateEmit: true,
      });

      monitor.startPolling();
      vi.advanceTimersByTime(100);

      visible = "Working /";
      vi.advanceTimersByTime(50);
      expect(monitor.getState()).toBe("idle");

      vi.advanceTimersByTime(650);
      visible = "Working -";
      vi.advanceTimersByTime(50);
      expect(monitor.getState()).toBe("idle");

      vi.advanceTimersByTime(650);
      visible = "Working \\";
      vi.advanceTimersByTime(50);
      expect(monitor.getState()).toBe("idle");

      vi.advanceTimersByTime(650);
      visible = "Working |";
      vi.advanceTimersByTime(50);

      expect(monitor.getState()).toBe("busy");
      expect(onStateChange).toHaveBeenCalledWith("agent-simple-spinner", 1000, "busy", {
        trigger: "output",
      });

      monitor.dispose();
    });

    it("ignores unchanged redraw frames while idle", () => {
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("agent-simple-redraw", 1000, onStateChange, {
        agentId: "claude",
        getVisibleLines: () => ["waiting"],
        getCursorLine: () => "waiting",
        initialState: "idle",
        skipInitialStateEmit: true,
      });

      monitor.startPolling();
      vi.advanceTimersByTime(500);
      monitor.onData("\rwaiting");
      vi.advanceTimersByTime(600);

      expect(monitor.getState()).toBe("idle");
      expect(onStateChange).not.toHaveBeenCalled();

      monitor.dispose();
    });

    it("resets the 6s silence window on tiny repeated visible changes", () => {
      const onStateChange = vi.fn();
      let visible = "tick 1";
      const monitor = new ActivityMonitor("agent-simple-2", 1000, onStateChange, {
        agentId: "claude",
        getVisibleLines: () => [visible],
        getCursorLine: () => visible,
        initialState: "idle",
        skipInitialStateEmit: true,
      });

      monitor.startPolling();
      monitor.notifySubmission();
      vi.advanceTimersByTime(5900);
      visible = "tick 2";
      monitor.onData(visible);
      vi.advanceTimersByTime(50);
      vi.advanceTimersByTime(5900);

      expect(monitor.getState()).toBe("busy");

      vi.advanceTimersByTime(200);
      expect(monitor.getState()).toBe("idle");
      expect(onStateChange.mock.calls.filter((call) => call[2] === "busy")).toHaveLength(1);

      monitor.dispose();
    });

    it("reuses the cached viewport snapshot once quiet and recomputes after new data", () => {
      const onStateChange = vi.fn();
      const getVisibleContentSnapshot = vi.fn(() => createVisibleContentSnapshot("waiting"));
      const monitor = new ActivityMonitor("agent-simple-snapshot-cache", 1000, onStateChange, {
        agentId: "claude",
        getVisibleLines: () => ["waiting"],
        getVisibleContentSnapshot,
        initialState: "idle",
        skipInitialStateEmit: true,
      });

      monitor.startPolling();
      vi.advanceTimersByTime(2000);
      getVisibleContentSnapshot.mockClear();

      // Quiet past the settle window: polling must stop re-extracting the viewport
      vi.advanceTimersByTime(1000);
      expect(getVisibleContentSnapshot).not.toHaveBeenCalled();

      // New data restarts extraction on the next polls
      monitor.onData("new output");
      vi.advanceTimersByTime(100);
      expect(getVisibleContentSnapshot).toHaveBeenCalled();

      monitor.dispose();
    });

    it("keeps Enter immediate in simple agent mode", () => {
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("agent-simple-enter", 1000, onStateChange, {
        agentId: "claude",
        getVisibleLines: () => ["> "],
        getCursorLine: () => "> ",
        initialState: "idle",
        skipInitialStateEmit: true,
      });

      monitor.onInput("run\r");

      expect(monitor.getState()).toBe("busy");
      expect(onStateChange).toHaveBeenCalledWith("agent-simple-enter", 1000, "busy", {
        trigger: "input",
      });

      monitor.dispose();
    });
  });

  describe("Simple-output mode detection layers (#9873)", () => {
    const CLAUDE_WORKING = "✽ Deliberating… (esc to interrupt · 15s)";

    function driveBusyViaOutputChanges(
      monitor: ActivityMonitor,
      setVisible: (text: string) => void
    ): void {
      for (let i = 1; i <= 4; i++) {
        vi.advanceTimersByTime(650);
        setVisible(`tick ${i}`);
        vi.advanceTimersByTime(50);
      }
      expect(monitor.getState()).toBe("busy");
    }

    it("detects completion with extracted cost/tokens in simple polling", () => {
      const onStateChange = vi.fn();
      let visible = ["waiting 0"];
      const monitor = new ActivityMonitor("simple-completion", 1000, onStateChange, {
        agentId: "claude",
        getVisibleLines: () => visible,
        getCursorLine: () => visible[visible.length - 1],
        initialState: "idle",
        skipInitialStateEmit: true,
        completionPatterns: [/Total cost:/],
      });

      monitor.startPolling();
      driveBusyViaOutputChanges(monitor, (text) => {
        visible = [text];
      });
      onStateChange.mockClear();

      visible = ["All done.", "Total cost: $1.23"];
      // Quiet gate: completion must not fire while output is still fresh
      vi.advanceTimersByTime(1000);
      expect(onStateChange.mock.calls.filter((call) => call[2] === "completed")).toHaveLength(0);

      vi.advanceTimersByTime(700);
      expect(onStateChange).toHaveBeenCalledWith("simple-completion", 1000, "completed", {
        trigger: "pattern",
        patternConfidence: 0.9,
        sessionCost: 1.23,
        sessionTokens: undefined,
      });

      // Completion hold settles to idle shortly after
      vi.advanceTimersByTime(600);
      expect(monitor.getState()).toBe("idle");

      monitor.dispose();
    });

    it("does not treat a cost line as completion while output keeps flowing", () => {
      const onStateChange = vi.fn();
      let visible = ["working"];
      const monitor = new ActivityMonitor("simple-midstream", 1000, onStateChange, {
        agentId: "claude",
        getVisibleLines: () => visible,
        getCursorLine: () => visible[visible.length - 1],
        initialState: "idle",
        skipInitialStateEmit: true,
        completionPatterns: [/Total cost:/],
      });

      monitor.startPolling();
      driveBusyViaOutputChanges(monitor, (text) => {
        visible = [text];
      });
      onStateChange.mockClear();

      // Cost line scrolls past, but output keeps changing every 500ms —
      // lastActivity stays fresh, so the completion scan never fires.
      visible = ["Total cost: $0.50", "step output 0"];
      for (let i = 1; i <= 6; i++) {
        vi.advanceTimersByTime(500);
        visible = ["Total cost: $0.50", `step output ${i}`];
      }
      expect(onStateChange.mock.calls.filter((call) => call[2] === "completed")).toHaveLength(0);
      expect(monitor.getState()).toBe("busy");

      monitor.dispose();
    });

    it("blocks completion while raw bytes stream past a static viewport", () => {
      const onStateChange = vi.fn();
      let visible = ["waiting 0"];
      const monitor = new ActivityMonitor("simple-stream-quiet", 1000, onStateChange, {
        agentId: "claude",
        getVisibleLines: () => visible,
        getCursorLine: () => visible[visible.length - 1],
        initialState: "idle",
        skipInitialStateEmit: true,
        completionPatterns: [/Total cost:/],
      });

      monitor.startPolling();
      driveBusyViaOutputChanges(monitor, (text) => {
        visible = [text];
      });
      onStateChange.mockClear();

      // Viewport settles on a cost line, but raw PTY bytes keep arriving —
      // lastDataTimestamp stays fresh, so the completion scan must not fire.
      visible = ["Total cost: $2.00"];
      for (let i = 0; i < 6; i++) {
        vi.advanceTimersByTime(500);
        monitor.onData("streaming bytes that never repaint the viewport");
      }
      expect(onStateChange.mock.calls.filter((call) => call[2] === "completed")).toHaveLength(0);

      // Once the stream goes quiet, completion fires.
      vi.advanceTimersByTime(1600);
      expect(onStateChange.mock.calls.filter((call) => call[2] === "completed")).toHaveLength(1);

      monitor.dispose();
    });

    it("exits boot early when a prompt appears in visible history", () => {
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("simple-boot-prompt", 1000, onStateChange, {
        agentId: "claude",
        getVisibleLines: () => ["$", "waiting for setup"],
        getCursorLine: () => "waiting for setup",
        pollingMaxBootMs: 20000,
      });

      monitor.startPolling();
      onStateChange.mockClear();

      // History scan is locked for the first 3s — boot holds busy
      vi.advanceTimersByTime(2000);
      expect(monitor.getState()).toBe("busy");

      // Prompt in history exits boot well before the 20s timeout, so the
      // idle gate can fire at the normal 8s quiet mark
      vi.advanceTimersByTime(6300);
      expect(monitor.getState()).toBe("idle");
      expect(onStateChange).toHaveBeenCalledWith(
        "simple-boot-prompt",
        1000,
        "idle",
        expect.objectContaining({ trigger: "timeout", waitingReason: "prompt" })
      );

      monitor.dispose();
    });

    it("classifies a waiting reason when the idle transition fires", () => {
      const onStateChange = vi.fn();
      let visible = ["waiting 0"];
      const monitor = new ActivityMonitor("simple-waiting", 1000, onStateChange, {
        agentId: "claude",
        getVisibleLines: () => visible,
        getCursorLine: () => visible[visible.length - 1],
        initialState: "idle",
        skipInitialStateEmit: true,
      });

      monitor.startPolling();
      driveBusyViaOutputChanges(monitor, (text) => {
        visible = [text];
      });
      onStateChange.mockClear();

      visible = ["Should I delete the old branch?"];
      vi.advanceTimersByTime(8200);

      expect(monitor.getState()).toBe("idle");
      expect(onStateChange).toHaveBeenCalledWith("simple-waiting", 1000, "idle", {
        trigger: "timeout",
        waitingReason: "question",
      });

      monitor.dispose();
    });

    it("stays busy during boot even when output is silent past the idle gate", () => {
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("simple-boot-guard", 1000, onStateChange, {
        agentId: "claude",
        getVisibleLines: () => ["connecting to MCP servers..."],
        getCursorLine: () => "connecting to MCP servers...",
        pollingMaxBootMs: 20000,
      });

      monitor.startPolling();
      expect(monitor.getState()).toBe("busy");
      onStateChange.mockClear();

      // Well past the 8s idle gate, but still booting — must not go idle
      vi.advanceTimersByTime(12000);
      expect(monitor.getState()).toBe("busy");
      expect(onStateChange.mock.calls.filter((call) => call[2] === "idle")).toHaveLength(0);

      // Boot timeout fires; with a static screen the idle gate may now fire
      vi.advanceTimersByTime(9000);
      expect(monitor.getState()).toBe("idle");

      monitor.dispose();
    });

    it("consults compiled working patterns from the simple onData path", () => {
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("simple-patterns", 1000, onStateChange, {
        agentId: "claude",
        getVisibleLines: () => [CLAUDE_WORKING],
        getCursorLine: () => CLAUDE_WORKING,
        initialState: "idle",
        skipInitialStateEmit: true,
      });

      // Sustained pattern signal across the recovery debounce window
      monitor.onData(CLAUDE_WORKING);
      expect(monitor.getLastPatternResult()?.isWorking).toBe(true);
      vi.advanceTimersByTime(1600);
      monitor.onData(CLAUDE_WORKING);

      expect(monitor.getState()).toBe("busy");
      expect(onStateChange).toHaveBeenCalledWith(
        "simple-patterns",
        1000,
        "busy",
        expect.objectContaining({ trigger: "pattern" })
      );

      monitor.dispose();
    });

    it("does not promote idle→busy from patterns during focus suppression", () => {
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("simple-focus", 1000, onStateChange, {
        agentId: "claude",
        getVisibleLines: () => [CLAUDE_WORKING],
        getCursorLine: () => CLAUDE_WORKING,
        initialState: "idle",
        skipInitialStateEmit: true,
      });

      monitor.notifyFocus(2000);
      monitor.onData(CLAUDE_WORKING);
      vi.advanceTimersByTime(1600);
      monitor.onData(CLAUDE_WORKING);

      // Pattern buffer is fed (detection layer live) but no state change
      type MonitorInternals = { patternBuf: { getText(): string } };
      const internals = monitor as unknown as MonitorInternals;
      expect(internals.patternBuf.getText().length).toBeGreaterThan(0);
      expect(monitor.getState()).toBe("idle");

      monitor.dispose();
    });

    it("recovers waiting→working from sustained byte volume and stays working through the stream (#10664)", () => {
      const onStateChange = vi.fn();
      let visible = ["idle prompt"];
      const monitor = new ActivityMonitor("simple-volume", 1000, onStateChange, {
        agentId: "claude",
        getVisibleLines: () => visible,
        getCursorLine: () => visible[visible.length - 1],
        initialState: "idle",
        skipInitialStateEmit: true,
        simpleOutputVolumeRecovery: {
          enabled: true,
          leakRatePerMs: 0.1,
          activationThreshold: 512,
          maxBytesPerFrame: 256,
        },
      });

      monitor.startPolling();
      // Drive boot exit + a real work cycle, then let the agent settle back to
      // waiting with a static screen the polling cycle can't recover from.
      driveBusyViaOutputChanges(monitor, (text) => {
        visible = [text];
      });
      visible = ["idle prompt"];
      vi.advanceTimersByTime(8200);
      expect(monitor.getState()).toBe("idle");
      onStateChange.mockClear();

      // Heavy streaming output whose visible-content diff registers no change
      // (pure appended text). Only the byte-volume floor can recover here.
      const chunk = "investigation result ".repeat(16); // > maxBytesPerFrame
      monitor.onData(chunk);
      expect(monitor.getState()).toBe("idle"); // one frame is capped below threshold
      monitor.onData(chunk);

      expect(monitor.getState()).toBe("busy");
      expect(onStateChange).toHaveBeenCalledWith("simple-volume", 1000, "busy", {
        trigger: "output",
      });

      // The visible screen never changes, so the only thing keeping the agent
      // working is the volume floor refreshing the activity clock. Keep
      // streaming for well past WORKING_HOLD_MS (1.5s) and IDLE_DEBOUNCE_MS (8s)
      // and confirm it does not bounce back to waiting mid-stream.
      for (let i = 0; i < 60; i += 1) {
        vi.advanceTimersByTime(500);
        monitor.onData(chunk);
      }
      expect(monitor.getState()).toBe("busy");
      expect(onStateChange.mock.calls.filter((call) => call[2] === "idle")).toHaveLength(0);

      // Once the stream stops, the agent settles back to waiting after the gate.
      visible = ["idle prompt"];
      vi.advanceTimersByTime(8200);
      expect(monitor.getState()).toBe("idle");

      monitor.dispose();
    });

    it("does not recover idle→busy from byte volume during focus suppression (#10664)", () => {
      const onStateChange = vi.fn();
      let visible = ["idle prompt"];
      const monitor = new ActivityMonitor("simple-volume-focus", 1000, onStateChange, {
        agentId: "claude",
        getVisibleLines: () => visible,
        getCursorLine: () => visible[visible.length - 1],
        initialState: "idle",
        skipInitialStateEmit: true,
        simpleOutputVolumeRecovery: {
          enabled: true,
          leakRatePerMs: 0.1,
          activationThreshold: 512,
          maxBytesPerFrame: 256,
        },
      });

      monitor.startPolling();
      driveBusyViaOutputChanges(monitor, (text) => {
        visible = [text];
      });
      visible = ["idle prompt"];
      vi.advanceTimersByTime(8200);
      expect(monitor.getState()).toBe("idle");
      onStateChange.mockClear();

      // A window-focus repaint suppresses promotion (#8867). Even a volume
      // burst that crosses the threshold must not flip idle→busy.
      monitor.notifyFocus(2000);
      const chunk = "investigation result ".repeat(16);
      monitor.onData(chunk);
      monitor.onData(chunk);
      monitor.onData(chunk);

      expect(monitor.getState()).toBe("idle");
      expect(onStateChange).not.toHaveBeenCalledWith(
        "simple-volume-focus",
        1000,
        "busy",
        expect.anything()
      );

      monitor.dispose();
    });

    it("wires simpleOutputVolumeRecovery for agent terminals only (#10664)", () => {
      const agentOptions = buildActivityMonitorOptions("claude", {});
      expect(agentOptions.simpleOutputVolumeRecovery?.enabled).toBe(true);
      // Threshold must exceed the per-frame cap so a single chunk can never fire
      // the bucket on its own — recovery requires sustained volume.
      const recovery = agentOptions.simpleOutputVolumeRecovery!;
      expect(recovery.activationThreshold!).toBeGreaterThan(recovery.maxBytesPerFrame!);

      // Non-agent terminals don't get the recovery detector.
      const plainOptions = buildActivityMonitorOptions(undefined, {});
      expect(plainOptions.simpleOutputVolumeRecovery).toBeUndefined();
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
        outputActivityDetection: {
          enabled: true,
          activationThreshold: 1,
          maxBytesPerFrame: 65536,
          leakRatePerMs: 0.001,
        },
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
        outputActivityDetection: {
          enabled: true,
          activationThreshold: 1,
          maxBytesPerFrame: 65536,
          leakRatePerMs: 0.001,
        },
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

    it("should not re-emit busy when output arrives after Enter has set state to busy", () => {
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("test-1", 1000, onStateChange, {
        outputActivityDetection: {
          enabled: true,
          activationThreshold: 1,
          maxBytesPerFrame: 65536,
          leakRatePerMs: 0.001,
        },
      });

      monitor.onInput("\r");
      expect(onStateChange).toHaveBeenCalledWith("test-1", 1000, "busy", { trigger: "input" });
      onStateChange.mockClear();

      monitor.onData("agent output");

      // Already busy from input — output confirms but doesn't re-emit busy
      expect(onStateChange).not.toHaveBeenCalled();
      expect(monitor.getState()).toBe("busy");

      monitor.dispose();
    });

    it("should NOT trigger busy from output during echo window even without validator - Issue #1476", () => {
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("test-1", 1000, onStateChange, {
        outputActivityDetection: {
          enabled: true,
          activationThreshold: 1,
          maxBytesPerFrame: 65536,
          leakRatePerMs: 0.001,
        },
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

      // Send a large data burst (>2000 chars) that evicts the working indicator from the pattern buffer
      monitor.onData("x".repeat(3000));

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

  describe("Background-tier recovery (#6641)", () => {
    // The background polling tier (500ms) was unable to escape "waiting" when
    // an agent resumed producing output: the AND-gated volume detector with a
    // 1000ms window required two frames within the same window, which 500ms
    // polling rarely satisfies, and the 1500ms debouncer required three
    // consecutive cycles. Spinner ticks were also short-circuited by the
    // cosmetic-redraw early-return, so they never reached any recovery path.
    // The fix applies tier-aware thresholds (2500ms window, 600ms debouncer)
    // when polling is throttled and adds an idle-state recovery path through
    // the cosmetic-redraw branch of onData().

    it("recovers idle→busy from sustained spinner ticks at background tier", () => {
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("bg-1", 1000, onStateChange, {
        getVisibleLines: () => [],
        getCursorLine: () => null,
        pollingIntervalMs: 500,
        initialState: "idle",
        skipInitialStateEmit: true,
        backgroundWorkingRecoveryDelayMs: 600,
        idleDebounceMs: 4000,
      });

      monitor.startPolling();
      expect(monitor.getState()).toBe("idle");
      onStateChange.mockClear();

      // First spinner tick is PTY output, so it recovers immediately.
      monitor.onData("\r⠙ Working (esc to interrupt)");
      expect(monitor.getState()).toBe("busy");

      vi.advanceTimersByTime(700);
      monitor.onData("\r⠙ Working (esc to interrupt)");

      expect(monitor.getState()).toBe("busy");
      expect(onStateChange).toHaveBeenCalledWith(
        "bg-1",
        1000,
        "busy",
        expect.objectContaining({ trigger: "output" })
      );

      monitor.dispose();
    });

    it("recovers idle→busy from sparse spinner ticks WITH polling running", () => {
      // Reproduces the actual production scenario: 500ms polling cycles run
      // continuously, and sparse spinner ticks (~700ms intervals) accumulate
      // in the cosmetic-redraw recovery path. The shared workingSignalDebouncer
      // would have been reset by the polling cycle's "no signal" branch,
      // defeating recovery; the dedicated cosmeticRecoveryDebouncer survives.
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("bg-poll-1", 1000, onStateChange, {
        getVisibleLines: () => ["> ready"],
        getCursorLine: () => "> ready",
        pollingIntervalMs: 500,
        initialState: "idle",
        skipInitialStateEmit: true,
        backgroundWorkingRecoveryDelayMs: 600,
        idleDebounceMs: 4000,
      });

      monitor.startPolling();
      // Pre-fix, the polling cycle's no-signal branch would have erased the
      // cosmetic accumulator. Drive several poll cycles with no data so the
      // shared-debouncer hypothesis would have reset sustainedSince repeatedly
      // before the next spinner tick.
      vi.advanceTimersByTime(2000);
      expect(monitor.getState()).toBe("idle");
      onStateChange.mockClear();

      // Sparse ticks: each tick is 700ms apart, with 500ms polling firing
      // between them. With the dedicated debouncer, the 600ms gate fires on
      // the second tick.
      monitor.onData("\r⠙ Working (esc to interrupt)");
      vi.advanceTimersByTime(700);
      monitor.onData("\r⠙ Working (esc to interrupt)");

      expect(monitor.getState()).toBe("busy");

      monitor.dispose();
    });

    it("recovers active-tier idle→busy on the first spinner burst", () => {
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("active-1", 1000, onStateChange, {
        getVisibleLines: () => [],
        getCursorLine: () => null,
        pollingIntervalMs: 50,
        initialState: "idle",
        skipInitialStateEmit: true,
        backgroundWorkingRecoveryDelayMs: 600,
        idleDebounceMs: 4000,
      });

      monitor.startPolling();
      onStateChange.mockClear();

      // 1000ms of spinner output — well below the 1500ms active debouncer.
      for (let i = 0; i < 10; i++) {
        monitor.onData("\r⠙ Working (esc to interrupt)");
        vi.advanceTimersByTime(100);
      }

      expect(monitor.getState()).toBe("busy");
      expect(onStateChange).toHaveBeenCalledWith(
        "active-1",
        1000,
        "busy",
        expect.objectContaining({ trigger: "output" })
      );

      monitor.dispose();
    });

    it("recovers active-tier idle→busy after the full 1500ms debouncer", () => {
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("active-2", 1000, onStateChange, {
        getVisibleLines: () => [],
        getCursorLine: () => null,
        pollingIntervalMs: 50,
        bootCompletePatterns: [/booted/i],
        idleDebounceMs: 4000,
      });

      monitor.onData("\nbooted\n");
      onStateChange.mockClear();

      // First spinner is output and recovers immediately.
      monitor.onData("\r⠙ Working (esc to interrupt)");
      expect(monitor.getState()).toBe("busy");

      // 1600ms elapsed > 1500ms default active debouncer.
      vi.advanceTimersByTime(1600);
      monitor.onData("\r⠙ Working (esc to interrupt)");

      expect(monitor.getState()).toBe("busy");

      monitor.dispose();
    });

    it("does not recover when getVisibleLines is not provided (non-agent terminal)", () => {
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("plain-1", 1000, onStateChange, {
        pollingIntervalMs: 500,
        backgroundWorkingRecoveryDelayMs: 600,
        idleDebounceMs: 4000,
      });

      // Even with sustained spinner output, a non-agent terminal must not
      // false-positive into busy from cosmetic redraws alone.
      for (let i = 0; i < 6; i++) {
        monitor.onData("\r⠙ Working (esc to interrupt)");
        vi.advanceTimersByTime(500);
      }

      expect(monitor.getState()).toBe("idle");
      expect(onStateChange).not.toHaveBeenCalled();

      monitor.dispose();
    });

    it("preserves #6365: busy-state spinner ticks still reset the debounce timer", () => {
      // When the agent is already busy, the cosmetic-redraw branch must still
      // call resetDebounceTimer() — the new idle-recovery path is additive,
      // not a replacement for the busy-keepalive path.
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("bg-busy", 1000, onStateChange, {
        getVisibleLines: () => [],
        getCursorLine: () => null,
        pollingIntervalMs: 500,
        backgroundWorkingRecoveryDelayMs: 600,
        idleDebounceMs: 300,
      });

      monitor.onInput("run\r");
      expect(monitor.getState()).toBe("busy");
      onStateChange.mockClear();

      for (let i = 0; i < 10; i++) {
        monitor.onData("\r⠙ Working (esc to interrupt)");
        vi.advanceTimersByTime(100);
      }

      expect(monitor.getState()).toBe("busy");

      monitor.dispose();
    });

    it("keeps a polling agent busy while sparse cosmetic redraws continue", () => {
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("agent-cosmetic-keepalive", 1000, onStateChange, {
        getVisibleLines: () => ["booted"],
        getCursorLine: () => "booted",
        pollingIntervalMs: 100,
        bootCompletePatterns: [/booted/i],
        idleDebounceMs: 400,
      });

      monitor.startPolling();
      vi.advanceTimersByTime(100);
      expect(monitor.getState()).toBe("busy");
      onStateChange.mockClear();

      // These ticks are farther apart than LineRewriteDetector's 500ms
      // multi-rewrite window, but they are visible status-line changes. While
      // they continue, the agent should remain working; when they stop, silence
      // should take it back to waiting/idle.
      for (let i = 0; i < 6; i++) {
        monitor.onData("\r⠙ Working (esc to interrupt)");
        vi.advanceTimersByTime(300);
        expect(monitor.getState()).toBe("busy");
      }

      expect(onStateChange).not.toHaveBeenCalledWith(
        "agent-cosmetic-keepalive",
        1000,
        "idle",
        expect.anything()
      );

      vi.advanceTimersByTime(1700);
      expect(monitor.getState()).toBe("idle");
      expect(onStateChange).toHaveBeenCalledWith(
        "agent-cosmetic-keepalive",
        1000,
        "idle",
        expect.objectContaining({ trigger: "timeout" })
      );

      monitor.dispose();
    });

    it("recovers a waiting polling agent immediately on same-line timer output", () => {
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("agent-timer-output", 1000, onStateChange, {
        getVisibleLines: () => ["ready"],
        getCursorLine: () => "ready",
        pollingIntervalMs: 100,
        initialState: "idle",
        skipInitialStateEmit: true,
        idleDebounceMs: 800,
        outputActivityDetection: {
          enabled: true,
          activationThreshold: 10_000,
          leakRatePerMs: 0,
          maxBytesPerFrame: 64,
        },
      });

      monitor.startPolling();
      vi.advanceTimersByTime(100);
      expect(monitor.getState()).toBe("idle");
      onStateChange.mockClear();

      monitor.onData("\rRunning for 8m 51s");

      expect(monitor.getState()).toBe("busy");
      expect(onStateChange).toHaveBeenCalledWith(
        "agent-timer-output",
        1000,
        "busy",
        expect.objectContaining({ trigger: "output" })
      );

      monitor.dispose();
    });

    it("recovers a waiting polling agent immediately on small non-protocol output", () => {
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("agent-small-output", 1000, onStateChange, {
        getVisibleLines: () => ["ready"],
        getCursorLine: () => "ready",
        pollingIntervalMs: 100,
        initialState: "idle",
        skipInitialStateEmit: true,
        idleDebounceMs: 800,
        outputActivityDetection: {
          enabled: true,
          activationThreshold: 10_000,
          leakRatePerMs: 0,
          maxBytesPerFrame: 64,
        },
      });

      monitor.startPolling();
      vi.advanceTimersByTime(100);
      expect(monitor.getState()).toBe("idle");
      onStateChange.mockClear();

      monitor.onData(".");

      expect(monitor.getState()).toBe("busy");
      expect(onStateChange).toHaveBeenCalledWith(
        "agent-small-output",
        1000,
        "busy",
        expect.objectContaining({ trigger: "output" })
      );

      vi.advanceTimersByTime(2000);
      expect(monitor.getState()).toBe("idle");

      monitor.dispose();
    });

    it("does not keep a polling agent busy from invisible protocol noise", () => {
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("agent-protocol-noise", 1000, onStateChange, {
        getVisibleLines: () => ["booted"],
        getCursorLine: () => "booted",
        pollingIntervalMs: 100,
        bootCompletePatterns: [/booted/i],
        idleDebounceMs: 300,
      });

      monitor.startPolling();
      vi.advanceTimersByTime(100);
      expect(monitor.getState()).toBe("busy");
      onStateChange.mockClear();

      for (let i = 0; i < 20; i++) {
        monitor.onData("\x1b[?25h\x1b]133;A\x07\x1b[24;80R\x1b[?25l");
        vi.advanceTimersByTime(50);
      }
      vi.advanceTimersByTime(600);

      expect(monitor.getState()).toBe("idle");
      expect(onStateChange).toHaveBeenCalledWith(
        "agent-protocol-noise",
        1000,
        "idle",
        expect.objectContaining({ trigger: "timeout" })
      );

      monitor.dispose();
    });

    it("triggers volume recovery on sustained background-tier output (#6666)", () => {
      // The pre-#6666 windowed AND-gate required tier-specific window widening
      // because frames straddled the fixed window boundary at 500ms polling.
      // The leaky-bucket detector is sample-cadence invariant: the same byte
      // stream fires at any tier without tier-specific tuning.
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("bg-vol", 1000, onStateChange, {
        getVisibleLines: () => [],
        getCursorLine: () => null,
        pollingIntervalMs: 500,
        initialState: "idle",
        skipInitialStateEmit: true,
        outputActivityDetection: {
          enabled: true,
          activationThreshold: 200,
          maxBytesPerFrame: 120,
          leakRatePerMs: 0.1,
        },
        backgroundWorkingRecoveryDelayMs: 600,
        idleDebounceMs: 4000,
      });

      monitor.startPolling();
      onStateChange.mockClear();

      // Three 100-byte chunks at 500ms cadence (typical batched background
      // streaming): drain=50/cycle, fill=100/cycle. F1 level=100, F2=150,
      // F3=200 ≥ threshold → fire.
      monitor.onData("x".repeat(100));
      expect(monitor.getState()).toBe("busy");
      vi.advanceTimersByTime(500);
      monitor.onData("x".repeat(100));
      expect(monitor.getState()).toBe("busy");
      vi.advanceTimersByTime(500);
      monitor.onData("x".repeat(100));

      expect(monitor.getState()).toBe("busy");

      monitor.dispose();
    });

    it("restores active debouncer threshold when polling switches back to active", () => {
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("tier-switch", 1000, onStateChange, {
        getVisibleLines: () => [],
        getCursorLine: () => null,
        pollingIntervalMs: 50,
        bootCompletePatterns: [/booted/i],
        backgroundWorkingRecoveryDelayMs: 600,
        idleDebounceMs: 4000,
      });

      // Switch to background then back to active. The cosmeticRecoveryDebouncer
      // delay must track the tier round-trip — pre-fix the 600ms background
      // value would persist into the active tier and false-fire recovery.
      monitor.setPollingInterval(500);
      monitor.setPollingInterval(50);

      monitor.onData("\nbooted\n");
      onStateChange.mockClear();

      // The first spinner is output and recovers immediately regardless of tier.
      monitor.onData("\r⠙ Working (esc to interrupt)");
      vi.advanceTimersByTime(700);
      monitor.onData("\r⠙ Working (esc to interrupt)");

      expect(monitor.getState()).toBe("busy");

      monitor.dispose();
    });
  });

  describe("Structural-signal tier (Issue #6668)", () => {
    type FrameSnapshot = import("../pty/SynchronizedFrameAnalyzer.js").FrameSnapshot;

    function buildSnapshot(opts: {
      capturedAt: number;
      bottomRowText: string;
      higherRows?: string[];
      cols?: number;
      cycleAtCol?: { col: number; codes: number[]; frameIndex: number };
    }): FrameSnapshot {
      const cols = opts.cols ?? 40;
      const rows: { code: number; width: number }[][] = [];
      const higherRows = opts.higherRows ?? [];

      for (const text of higherRows) {
        const row: { code: number; width: number }[] = [];
        for (let i = 0; i < cols; i++) {
          row.push({ code: i < text.length ? text.codePointAt(i)! : 0x20, width: 1 });
        }
        rows.push(row);
      }

      const bottomRow: { code: number; width: number }[] = [];
      const text = opts.bottomRowText;
      for (let i = 0; i < cols; i++) {
        let code = i < text.length ? text.codePointAt(i)! : 0x20;
        if (opts.cycleAtCol && i === opts.cycleAtCol.col) {
          code = opts.cycleAtCol.codes[opts.cycleAtCol.frameIndex % opts.cycleAtCol.codes.length];
        }
        bottomRow.push({ code, width: 1 });
      }
      rows.push(bottomRow);

      return {
        capturedAt: opts.capturedAt,
        terminalRows: 24,
        terminalCols: cols,
        rows,
        bottomRowText: text,
        secondToBottomText: higherRows.length > 0 ? higherRows[higherRows.length - 1] : "",
      };
    }

    it("recovers idle→busy on sustained cosmetic-only frames", () => {
      vi.setSystemTime(10000);
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("struct-1", 1000, onStateChange, {
        getVisibleLines: () => ["> "],
        getCursorLine: () => "> ",
        workingRecoveryDelayMs: 800,
        idleDebounceMs: 2500,
      });

      monitor.startPolling();
      vi.advanceTimersByTime(100);
      vi.advanceTimersByTime(2500);
      expect(monitor.getState()).toBe("idle");
      onStateChange.mockClear();

      // Cosmetic-only frames are still visible output. They must not veto
      // recovery; sustained bottom-row churn means the agent is alive.
      monitor.onSynchronizedFrame(
        buildSnapshot({
          capturedAt: Date.now(),
          higherRows: ["upper line", "middle line"],
          bottomRowText: "spinner ✦",
        })
      );
      vi.advanceTimersByTime(100);
      monitor.onSynchronizedFrame(
        buildSnapshot({
          capturedAt: Date.now(),
          higherRows: ["upper line", "middle line"],
          bottomRowText: "spinner ✧",
        })
      );
      vi.advanceTimersByTime(400);
      monitor.onSynchronizedFrame(
        buildSnapshot({
          capturedAt: Date.now(),
          higherRows: ["upper line", "middle line"],
          bottomRowText: "spinner ✦",
        })
      );
      vi.advanceTimersByTime(500);
      monitor.onSynchronizedFrame(
        buildSnapshot({
          capturedAt: Date.now(),
          higherRows: ["upper line", "middle line"],
          bottomRowText: "spinner ✧",
        })
      );

      expect(monitor.getState()).toBe("busy");
      monitor.dispose();
    });

    it("recovers idle→busy on sustained spinner frames", () => {
      vi.setSystemTime(10000);
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("struct-2", 1000, onStateChange, {
        getVisibleLines: () => ["> "],
        getCursorLine: () => "> ",
        workingRecoveryDelayMs: 800,
        idleDebounceMs: 2500,
      });

      monitor.startPolling();
      vi.advanceTimersByTime(100);
      vi.advanceTimersByTime(2500);
      expect(monitor.getState()).toBe("idle");
      onStateChange.mockClear();

      // 4-item cycle × 4 = 16 frames at 100ms → 1600ms total. The spinner
      // classifier needs the ring to satisfy `length > distinct`, which
      // requires at least 5 frames (cycle revisits index 0 on frame 5).
      // After detection, the structural-recovery debouncer needs 800ms of
      // sustained signal — so recovery fires around frame 13.
      const cycle = [0x280b, 0x2819, 0x2839, 0x2838];
      for (let i = 0; i < 16; i++) {
        vi.advanceTimersByTime(100);
        monitor.onSynchronizedFrame(
          buildSnapshot({
            capturedAt: Date.now(),
            bottomRowText: " static text",
            cycleAtCol: { col: 0, codes: cycle, frameIndex: i },
          })
        );
      }

      // After the workingRecoveryDelayMs window, recovery should have fired.
      expect(monitor.getState()).toBe("busy");
      monitor.dispose();
    });

    it("recovers idle→busy on monotonic time-counter frames", () => {
      vi.setSystemTime(10000);
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("struct-3", 1000, onStateChange, {
        getVisibleLines: () => ["> "],
        getCursorLine: () => "> ",
        workingRecoveryDelayMs: 800,
        idleDebounceMs: 2500,
      });

      monitor.startPolling();
      vi.advanceTimersByTime(100);
      vi.advanceTimersByTime(2500);
      expect(monitor.getState()).toBe("idle");
      onStateChange.mockClear();

      // First two frames establish the increment streak (signal=time-counter
      // fires on frame 2 once counterStreak reaches 2). Subsequent frames
      // sustain the structural signal across the 800ms debounce window.
      monitor.onSynchronizedFrame(
        buildSnapshot({ capturedAt: Date.now(), bottomRowText: "Working… 1s" })
      );
      vi.advanceTimersByTime(200);
      monitor.onSynchronizedFrame(
        buildSnapshot({ capturedAt: Date.now(), bottomRowText: "Working… 2s" })
      );
      vi.advanceTimersByTime(400);
      monitor.onSynchronizedFrame(
        buildSnapshot({ capturedAt: Date.now(), bottomRowText: "Working… 3s" })
      );
      vi.advanceTimersByTime(500);
      monitor.onSynchronizedFrame(
        buildSnapshot({ capturedAt: Date.now(), bottomRowText: "Working… 4s" })
      );

      expect(monitor.getState()).toBe("busy");
      monitor.dispose();
    });

    it("ignores frames during resize suppression", () => {
      vi.setSystemTime(10000);
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("struct-4", 1000, onStateChange, {
        getVisibleLines: () => ["> "],
        getCursorLine: () => "> ",
        workingRecoveryDelayMs: 800,
        idleDebounceMs: 2500,
      });

      monitor.startPolling();
      vi.advanceTimersByTime(100);
      vi.advanceTimersByTime(2500);
      expect(monitor.getState()).toBe("idle");
      onStateChange.mockClear();

      monitor.notifyResize(1000);

      const cycle = [0x280b, 0x2819, 0x2839, 0x2838];
      for (let i = 0; i < 8; i++) {
        // Stop short of the 1000ms suppression window so every frame is
        // suppressed.
        vi.advanceTimersByTime(100);
        monitor.onSynchronizedFrame(
          buildSnapshot({
            capturedAt: Date.now(),
            bottomRowText: " static",
            cycleAtCol: { col: 0, codes: cycle, frameIndex: i },
          })
        );
      }

      expect(monitor.getState()).toBe("idle");
      monitor.dispose();
    });

    it("cosmetic-only frames do not block line-rewrite recovery", () => {
      vi.setSystemTime(10000);
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("struct-bypass", 1000, onStateChange, {
        getVisibleLines: () => ["> "],
        getCursorLine: () => "> ",
        workingRecoveryDelayMs: 800,
        idleDebounceMs: 2500,
      });

      monitor.startPolling();
      vi.advanceTimersByTime(100);
      vi.advanceTimersByTime(2500);
      expect(monitor.getState()).toBe("idle");
      onStateChange.mockClear();

      // Two frames classify as cosmetic-only. This used to set a suppression
      // TTL that could keep visibly active agents stuck in waiting.
      monitor.onSynchronizedFrame(
        buildSnapshot({
          capturedAt: Date.now(),
          higherRows: ["upper", "middle"],
          bottomRowText: "spinner ✦",
        })
      );
      vi.advanceTimersByTime(100);
      monitor.onSynchronizedFrame(
        buildSnapshot({
          capturedAt: Date.now(),
          higherRows: ["upper", "middle"],
          bottomRowText: "spinner ✧",
        })
      );

      // Drive cosmetic redraws through onData. Sustained status-line output
      // should recover the agent to busy instead of being structurally vetoed.
      for (let i = 0; i < 6 && monitor.getState() !== "busy"; i++) {
        vi.advanceTimersByTime(200);
        monitor.onData(`\r⠙ working tick ${i}`);
      }

      expect(monitor.getState()).toBe("busy");
      monitor.dispose();
    });

    it("recovers idle→busy from cosmetic-only frames at background tier with polling running", () => {
      vi.setSystemTime(10000);
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("struct-background", 1000, onStateChange, {
        getVisibleLines: () => ["> "],
        getCursorLine: () => "> ",
        pollingIntervalMs: 500,
        initialState: "idle",
        skipInitialStateEmit: true,
        backgroundWorkingRecoveryDelayMs: 600,
        idleDebounceMs: 2500,
      });

      monitor.startPolling();
      // Let several background poll cycles run. The structural debouncer must
      // survive these no-signal polls, just like the cosmetic-redraw debouncer.
      vi.advanceTimersByTime(1500);
      expect(monitor.getState()).toBe("idle");
      onStateChange.mockClear();

      monitor.onSynchronizedFrame(
        buildSnapshot({
          capturedAt: Date.now(),
          higherRows: ["upper", "middle"],
          bottomRowText: "status ✦",
        })
      );
      vi.advanceTimersByTime(700);
      monitor.onSynchronizedFrame(
        buildSnapshot({
          capturedAt: Date.now(),
          higherRows: ["upper", "middle"],
          bottomRowText: "status ✧",
        })
      );
      expect(monitor.getState()).toBe("idle");
      vi.advanceTimersByTime(700);
      monitor.onSynchronizedFrame(
        buildSnapshot({
          capturedAt: Date.now(),
          higherRows: ["upper", "middle"],
          bottomRowText: "status ✦",
        })
      );

      expect(monitor.getState()).toBe("busy");
      expect(onStateChange).toHaveBeenCalledWith(
        "struct-background",
        1000,
        "busy",
        expect.objectContaining({ trigger: "pattern", patternConfidence: expect.any(Number) })
      );
      monitor.dispose();
    });

    it("ignores frames before boot completes", () => {
      vi.setSystemTime(10000);
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("struct-5", 1000, onStateChange, {
        getVisibleLines: () => ["", "Booting..."],
        getCursorLine: () => "Booting...",
        workingRecoveryDelayMs: 800,
        idleDebounceMs: 2500,
      });

      monitor.startPolling();
      // Don't advance enough for boot to complete; remain in boot.
      onStateChange.mockClear();

      const cycle = [0x280b, 0x2819, 0x2839, 0x2838];
      for (let i = 0; i < 6; i++) {
        monitor.onSynchronizedFrame(
          buildSnapshot({
            capturedAt: Date.now() + i * 100,
            bottomRowText: " static",
            cycleAtCol: { col: 0, codes: cycle, frameIndex: i },
          })
        );
      }

      // No state-change calls from the structural tier during boot.
      const structuralCalls = onStateChange.mock.calls.filter(
        ([, , , metadata]) => metadata?.trigger === "pattern"
      );
      expect(structuralCalls).toHaveLength(0);
      monitor.dispose();
    });
  });

  describe("onBootComplete callback (Issue #7616)", () => {
    it("fires once when boot completion is detected via the data-path", () => {
      vi.setSystemTime(10000);
      const onStateChange = vi.fn();
      const onBootComplete = vi.fn();
      const monitor = new ActivityMonitor("boot-data", 1000, onStateChange, {
        getVisibleLines: () => ["> "],
        getCursorLine: () => "> ",
        bootCompletePatterns: [/ready/i],
        idleDebounceMs: 4000,
        onBootComplete,
      });

      monitor.startPolling();
      // The data path runs through onData() and triggers bootDetector.check
      // against the rolling pattern buffer. Back-to-back chunks inside the
      // pattern-scan throttle window are scanned by the trailing-edge timer.
      monitor.onData("starting up\nstill working\n");
      expect(onBootComplete).not.toHaveBeenCalled();

      monitor.onData("system ready\n");
      vi.advanceTimersByTime(30);
      expect(onBootComplete).toHaveBeenCalledTimes(1);
      expect(onBootComplete).toHaveBeenCalledWith(expect.any(Number));

      // Subsequent matching data must not re-fire.
      monitor.onData("ready again ready\n");
      vi.advanceTimersByTime(30);
      expect(onBootComplete).toHaveBeenCalledTimes(1);

      monitor.dispose();
    });

    it("fires once when boot completion is detected via the polling cycle", () => {
      vi.setSystemTime(10000);
      const onStateChange = vi.fn();
      const onBootComplete = vi.fn();
      // Visible lines stable; the polling cycle's bootDetector.check observes
      // the boot pattern in the joined visible text.
      const monitor = new ActivityMonitor("boot-poll", 1000, onStateChange, {
        getVisibleLines: () => ["welcome banner", "agent ready"],
        getCursorLine: () => "agent ready",
        bootCompletePatterns: [/ready/i],
        pollingIntervalMs: 50,
        idleDebounceMs: 4000,
        onBootComplete,
      });

      monitor.startPolling();
      // One polling tick is enough for the boot detector to see "ready".
      vi.advanceTimersByTime(60);
      expect(onBootComplete).toHaveBeenCalledTimes(1);

      // Further polling cycles must not re-fire.
      vi.advanceTimersByTime(500);
      expect(onBootComplete).toHaveBeenCalledTimes(1);

      monitor.dispose();
    });

    it("re-arms the one-shot guard when polling restarts on a fresh PTY", () => {
      vi.setSystemTime(10000);
      const onStateChange = vi.fn();
      const onBootComplete = vi.fn();
      let visibleText = ["agent ready"];
      const monitor = new ActivityMonitor("boot-restart", 1000, onStateChange, {
        getVisibleLines: () => visibleText,
        getCursorLine: () => visibleText[visibleText.length - 1] ?? null,
        bootCompletePatterns: [/ready/i],
        pollingIntervalMs: 50,
        idleDebounceMs: 4000,
        onBootComplete,
      });

      monitor.startPolling();
      vi.advanceTimersByTime(60);
      expect(onBootComplete).toHaveBeenCalledTimes(1);

      // Simulate a restart: stop polling, then start again. The boot path is
      // re-entered (skipInitialStateEmit is false by default), so the one-shot
      // flag must reset and the next observed boot must fire telemetry again.
      monitor.stopPolling();
      visibleText = ["restarting", "agent ready"];
      monitor.startPolling();
      vi.advanceTimersByTime(60);
      expect(onBootComplete).toHaveBeenCalledTimes(2);

      monitor.dispose();
    });

    it("does not throw if the callback throws", () => {
      vi.setSystemTime(10000);
      const onStateChange = vi.fn();
      const onBootComplete = vi.fn(() => {
        throw new Error("boom");
      });
      const monitor = new ActivityMonitor("boot-throw", 1000, onStateChange, {
        getVisibleLines: () => ["> "],
        getCursorLine: () => "> ",
        bootCompletePatterns: [/ready/i],
        idleDebounceMs: 4000,
        onBootComplete,
      });

      monitor.startPolling();
      expect(() => monitor.onData("system ready\n")).not.toThrow();
      expect(onBootComplete).toHaveBeenCalledTimes(1);

      monitor.dispose();
    });

    it("fires for agent monitors using simpleOutputState (real-world wiring)", () => {
      // Regression for #7616 review: every monitor built via
      // `buildActivityMonitorOptions(<agentId>, ...)` runs with
      // `simpleOutputState: true`, which short-circuits the regular
      // boot-detection path. The simple-output branches must also call
      // `fireBootComplete`, otherwise the entire instrumentation is a no-op
      // for real agent terminals.
      vi.setSystemTime(10000);
      const onStateChange = vi.fn();
      const onBootComplete = vi.fn();
      const monitor = new ActivityMonitor("boot-simple-data", 1000, onStateChange, {
        agentId: "claude",
        simpleOutputState: true,
        getVisibleLines: () => ["claude code v0.5.6", "Type your message"],
        getCursorLine: () => "Type your message",
        bootCompletePatterns: [/claude\s+code\s+v?\d/i],
        idleDebounceMs: 4000,
        onBootComplete,
      });

      // Data path: onData runs in simpleOutputState mode and must still detect
      // the boot pattern from the immediate chunk.
      monitor.onData("claude code v0.5.6\n");
      expect(onBootComplete).toHaveBeenCalledTimes(1);

      monitor.dispose();
    });

    it("fires from the simple-output polling path on the boot-timeout fallback", () => {
      // When the agent's banner does not match a known boot pattern, the
      // POLLING_MAX_BOOT_MS timeout still flips boot state. The
      // simpleOutputState polling branch must run that check.
      vi.setSystemTime(10000);
      const onStateChange = vi.fn();
      const onBootComplete = vi.fn();
      const monitor = new ActivityMonitor("boot-simple-timeout", 1000, onStateChange, {
        agentId: "claude",
        simpleOutputState: true,
        getVisibleLines: () => ["miscellaneous output", "no boot marker here"],
        getCursorLine: () => "no boot marker here",
        bootCompletePatterns: [/never matches/],
        pollingIntervalMs: 50,
        pollingMaxBootMs: 200,
        idleDebounceMs: 4000,
        onBootComplete,
      });

      monitor.startPolling();
      // Advance well past pollingMaxBootMs so the timeout branch fires.
      vi.advanceTimersByTime(400);
      expect(onBootComplete).toHaveBeenCalledTimes(1);

      monitor.dispose();
    });
  });

  describe("Pattern-scan throttle", () => {
    it("scans a chunk arriving inside the throttle window via the trailing-edge timer", () => {
      vi.setSystemTime(10000);
      const onBootComplete = vi.fn();
      const monitor = new ActivityMonitor("scan-trailing", 1000, vi.fn(), {
        getVisibleLines: () => ["> "],
        getCursorLine: () => "> ",
        bootCompletePatterns: [/ready/i],
        idleDebounceMs: 4000,
        onBootComplete,
      });

      monitor.startPolling();
      monitor.onData("starting up\n");
      monitor.onData("system ready\n");
      expect(onBootComplete).not.toHaveBeenCalled();

      // No further data: the deferred run must still scan the final chunk.
      vi.advanceTimersByTime(30);
      expect(onBootComplete).toHaveBeenCalledTimes(1);

      monitor.dispose();
    });

    it("dispose cancels a pending trailing-edge scan", () => {
      vi.setSystemTime(10000);
      const onBootComplete = vi.fn();
      const monitor = new ActivityMonitor("scan-dispose", 1000, vi.fn(), {
        getVisibleLines: () => ["> "],
        getCursorLine: () => "> ",
        bootCompletePatterns: [/ready/i],
        idleDebounceMs: 4000,
        onBootComplete,
      });

      monitor.startPolling();
      monitor.onData("starting up\n");
      monitor.onData("system ready\n");
      monitor.dispose();

      vi.advanceTimersByTime(100);
      expect(onBootComplete).not.toHaveBeenCalled();
    });
  });

  describe("OSC 9;4 progress signal (Issue #8701)", () => {
    it("transitions to busy from idle on a working signal even with no visible-line activity", () => {
      vi.setSystemTime(1000);
      const onStateChange = vi.fn();
      // simulate a starved viewport: getVisibleLines returns nothing useful.
      const monitor = new ActivityMonitor("osc-1", 100, onStateChange, {
        agentId: "claude",
        getVisibleLines: () => [],
        getCursorLine: () => null,
        initialState: "idle",
        skipInitialStateEmit: true,
      });
      monitor.startPolling();
      onStateChange.mockClear();

      monitor.onOscProgressWorking(1000);

      expect(monitor.getState()).toBe("busy");
      expect(onStateChange).toHaveBeenCalledWith("osc-1", 100, "busy", { trigger: "output" });

      monitor.dispose();
    });

    it("negative control: the same starved viewport goes idle after 8s WITHOUT OSC heartbeats", () => {
      // Pairs with the heartbeat test below — proves the positive test is
      // load-bearing rather than vacuous. Same setup, no OSC calls.
      vi.setSystemTime(1500);
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("osc-no-heartbeat", 100, onStateChange, {
        agentId: "claude",
        getVisibleLines: () => ["$", "waiting"],
        getCursorLine: () => "waiting",
        initialState: "busy",
        skipInitialStateEmit: true,
        pollingIntervalMs: 50,
        idleDebounceMs: 8000,
      });
      monitor.startPolling();
      onStateChange.mockClear();

      vi.advanceTimersByTime(12000);

      expect(monitor.getState()).toBe("idle");

      monitor.dispose();
    });

    it("keeps an already-busy monitor busy across the 8s IDLE_DEBOUNCE_MS even when the visible snapshot never changes", () => {
      // Reproduces #8701: a small grid tile starves the snapshot detector.
      // Without OSC heartbeat, simpleOutputState polling would fire idle at 8s.
      vi.setSystemTime(2000);
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("osc-heartbeat", 100, onStateChange, {
        agentId: "claude",
        // Two-line viewport, never changes: matches the starvation condition.
        getVisibleLines: () => ["$", "waiting"],
        getCursorLine: () => "waiting",
        initialState: "busy",
        skipInitialStateEmit: true,
        pollingIntervalMs: 50,
        idleDebounceMs: 8000,
      });
      monitor.startPolling();
      onStateChange.mockClear();

      // OSC heartbeat every 1s for 12s — longer than IDLE_DEBOUNCE_MS.
      for (let t = 2000; t <= 14000; t += 1000) {
        vi.setSystemTime(t);
        monitor.onOscProgressWorking(t);
        vi.advanceTimersByTime(1000);
      }

      expect(monitor.getState()).toBe("busy");
      // Confirm no idle transition was emitted during the 12s window.
      expect(onStateChange).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        "idle",
        expect.anything()
      );

      monitor.dispose();
    });

    it("OSC idle is advisory: a later working signal keeps the monitor busy", () => {
      vi.setSystemTime(3000);
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("osc-debounce", 100, onStateChange, {
        agentId: "claude",
        getVisibleLines: () => [],
        getCursorLine: () => null,
        initialState: "busy",
        skipInitialStateEmit: true,
      });

      monitor.onOscProgressWorking(3000);
      // OSC idle is advisory (a no-op); it never arms a timer or forces idle.
      monitor.onOscProgressIdle(3050);
      vi.setSystemTime(3100);
      monitor.onOscProgressWorking(3100);
      // Advance well past any former debounce window — state stays busy.
      vi.advanceTimersByTime(300);

      expect(monitor.getState()).toBe("busy");

      monitor.dispose();
    });

    it("OSC idle does not immediately force the monitor to idle", () => {
      vi.setSystemTime(4000);
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("osc-idle-no-force", 100, onStateChange, {
        agentId: "claude",
        getVisibleLines: () => [],
        getCursorLine: () => null,
        initialState: "busy",
        skipInitialStateEmit: true,
      });

      monitor.onOscProgressWorking(4000);
      onStateChange.mockClear();
      monitor.onOscProgressIdle(4010);
      vi.advanceTimersByTime(199);

      // OSC idle is a no-op — no transition fires (and nothing else has).
      expect(monitor.getState()).toBe("busy");
      expect(onStateChange).not.toHaveBeenCalled();

      // Advancing time changes nothing — OSC idle is advisory.
      vi.advanceTimersByTime(2);
      expect(monitor.getState()).toBe("busy");

      monitor.dispose();
    });

    it("OSC idle does not mutate activity timestamps — advisory no-op contract", () => {
      // Guards the advisory contract: state=0 must leave the natural-decay
      // inputs untouched. A future change that refreshes (or zeroes) these on
      // idle receipt would silently shift when the 8s gate fires.
      vi.setSystemTime(8000);
      const monitor = new ActivityMonitor("osc-idle-no-mutate", 100, vi.fn(), {
        agentId: "claude",
        initialState: "busy",
        skipInitialStateEmit: true,
      });

      type MonitorInternals = {
        lastActivityTimestamp: number;
        lastDataTimestamp: number;
      };
      const internals = monitor as unknown as MonitorInternals;

      monitor.onOscProgressWorking(8000);
      const activityTs = internals.lastActivityTimestamp;
      const dataTs = internals.lastDataTimestamp;

      vi.setSystemTime(8500);
      monitor.onOscProgressIdle(8500);

      expect(internals.lastActivityTimestamp).toBe(activityTs);
      expect(internals.lastDataTimestamp).toBe(dataTs);

      monitor.dispose();
    });

    it("respects MAX_WORKING_SILENCE_MS — OSC working does not bypass the safety timeout (#4974 regression)", () => {
      // Bug #4974: a working signal that never decays leaves the agent stuck.
      // The OSC heartbeat must refresh `lastDataTimestamp` like real output, so
      // the moment OSC stops, the silence timeout still fires after MAX_WORKING_SILENCE_MS.
      vi.setSystemTime(5000);
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("osc-silence", 100, onStateChange, {
        agentId: "claude",
        getVisibleLines: () => ["foo"],
        getCursorLine: () => "foo",
        initialState: "busy",
        skipInitialStateEmit: true,
        pollingIntervalMs: 50,
        idleDebounceMs: 8000,
        // Tight silence cap so the test is short.
        maxWorkingSilenceMs: 5000,
      });
      monitor.startPolling();

      // One OSC working signal at t=5000, then OSC goes silent.
      monitor.onOscProgressWorking(5000);
      // Force boot exit so the idle gate can fire (it gates on it).
      monitor.onData("Claude Code v2.0");
      onStateChange.mockClear();

      // Advance past the silence cap; the polling cycle's idle path fires
      // because lastActivityTimestamp/lastDataTimestamp are stale.
      vi.advanceTimersByTime(10000);

      expect(monitor.getState()).toBe("idle");

      monitor.dispose();
    });

    it("OSC idle decays into natural idle: heartbeats stop, lastActivityTimestamp ages out, polling fires idle", () => {
      // Strengthens coverage of the OSC idle path: after the OSC working
      // heartbeat stops (state=0 received and not re-armed), no further
      // refreshes happen — the existing 8s IDLE_DEBOUNCE_MS path should
      // fire as `lastActivityTimestamp` becomes stale.
      vi.setSystemTime(15000);
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("osc-natural-idle", 100, onStateChange, {
        agentId: "claude",
        getVisibleLines: () => ["$", "waiting"],
        getCursorLine: () => "waiting",
        initialState: "busy",
        skipInitialStateEmit: true,
        pollingIntervalMs: 50,
        idleDebounceMs: 8000,
      });
      monitor.startPolling();

      // One working heartbeat, then OSC says idle (Claude between tool calls).
      monitor.onOscProgressWorking(15000);
      monitor.onOscProgressIdle(15050);
      onStateChange.mockClear();

      // OSC idle is advisory (a no-op) — no transition fires.
      vi.advanceTimersByTime(201);
      expect(monitor.getState()).toBe("busy");

      // Now let 8s of natural decay run. No further OSC heartbeats arrive,
      // so lastActivityTimestamp ages out and the polling cycle fires idle.
      vi.advanceTimersByTime(9000);
      expect(monitor.getState()).toBe("idle");

      monitor.dispose();
    });

    it("dispose() after onOscProgressIdle does not throw", () => {
      vi.setSystemTime(6000);
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("osc-dispose", 100, onStateChange, {
        agentId: "claude",
      });

      monitor.onOscProgressIdle(6000);
      // onOscProgressIdle is a no-op; there is no timer to leave pending.
      expect(() => monitor.dispose()).not.toThrow();
      // Advancing afterwards must not throw either.
      expect(() => vi.advanceTimersByTime(500)).not.toThrow();
    });

    it("does not throw after dispose() when more OSC signals arrive", () => {
      vi.setSystemTime(7000);
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("osc-post-dispose", 100, onStateChange, {
        agentId: "claude",
      });

      monitor.dispose();
      expect(() => monitor.onOscProgressWorking(7000)).not.toThrow();
      expect(() => monitor.onOscProgressIdle(7000)).not.toThrow();
    });
  });

  describe("notifyExternalPromotion (#9875)", () => {
    it("arms the idle machinery without emitting busy, so the idle path can fire later", () => {
      vi.setSystemTime(20000);
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("ext-promo", 100, onStateChange, {
        agentId: "claude",
        getVisibleLines: () => ["hello world"],
        getCursorLine: () => "hello world",
        initialState: "idle",
        skipInitialStateEmit: true,
        pollingIntervalMs: 50,
        idleDebounceMs: 8000,
      });
      monitor.startPolling();
      vi.advanceTimersByTime(100);
      onStateChange.mockClear();

      monitor.notifyExternalPromotion();

      // Private state shadows the FSM promotion, but no state change is
      // emitted — the caller already transitioned the FSM directly.
      expect(monitor.getState()).toBe("busy");
      expect(onStateChange).not.toHaveBeenCalled();

      // After the working hold (1500ms) and idle debounce (8000ms) of
      // silence, the monitor's own idle path fires — the working→waiting
      // transition that was previously unreachable because the private
      // state was stranded at "idle".
      vi.advanceTimersByTime(9700);
      expect(monitor.getState()).toBe("idle");
      expect(onStateChange).toHaveBeenCalledWith("ext-promo", 100, "idle", {
        trigger: "timeout",
        waitingReason: "prompt",
      });

      monitor.dispose();
    });

    it("is a no-op after dispose", () => {
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("ext-promo-disposed", 100, onStateChange, {
        agentId: "claude",
        initialState: "idle",
        skipInitialStateEmit: true,
      });
      monitor.dispose();

      expect(() => monitor.notifyExternalPromotion()).not.toThrow();
      expect(monitor.getState()).toBe("idle");
      expect(onStateChange).not.toHaveBeenCalled();
    });

    it("does not arm while focus suppression is active (#8865)", () => {
      vi.setSystemTime(30000);
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("ext-promo-focus", 100, onStateChange, {
        agentId: "claude",
        initialState: "idle",
        skipInitialStateEmit: true,
      });

      monitor.notifyFocus(2000);
      monitor.notifyExternalPromotion();

      expect(monitor.getState()).toBe("idle");
      expect(onStateChange).not.toHaveBeenCalled();

      monitor.dispose();
    });

    it("does not bounce straight back to idle when promoted after a long quiet spell", () => {
      vi.setSystemTime(40000);
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("ext-promo-quiet", 100, onStateChange, {
        agentId: "claude",
        getVisibleLines: () => ["hello world"],
        getCursorLine: () => "hello world",
        initialState: "idle",
        skipInitialStateEmit: true,
        pollingIntervalMs: 50,
        idleDebounceMs: 8000,
      });
      monitor.startPolling();

      // Let the agent sit quiet long past the temperature's 6s waiting dwell
      // so its quiet clock is stale when the external promotion arrives.
      vi.advanceTimersByTime(10000);
      onStateChange.mockClear();

      monitor.notifyExternalPromotion();
      expect(monitor.getState()).toBe("busy");

      // The stale quiet clock must not flip the monitor back to idle right
      // after the 1.5s working hold expires.
      vi.advanceTimersByTime(2000);
      expect(monitor.getState()).toBe("busy");
      expect(onStateChange).not.toHaveBeenCalled();

      // With continued silence the idle path still fires eventually.
      vi.advanceTimersByTime(7700);
      expect(monitor.getState()).toBe("idle");
      expect(onStateChange).toHaveBeenCalledWith("ext-promo-quiet", 100, "idle", {
        trigger: "timeout",
        waitingReason: "prompt",
      });

      monitor.dispose();
    });

    it("repeated promotions extend the idle deadline", () => {
      vi.setSystemTime(50000);
      const onStateChange = vi.fn();
      // No polling sources: the debounce timer is the only idle driver, so
      // the test isolates the lastActivityTimestamp refresh.
      const monitor = new ActivityMonitor("ext-promo-extend", 100, onStateChange, {
        agentId: "claude",
        initialState: "idle",
        skipInitialStateEmit: true,
        idleDebounceMs: 8000,
      });

      monitor.notifyExternalPromotion();
      vi.advanceTimersByTime(6000);
      expect(monitor.getState()).toBe("busy");

      // A second promotion refreshes lastActivityTimestamp and re-arms the
      // 8s debounce window from now.
      monitor.notifyExternalPromotion();
      vi.advanceTimersByTime(7900);
      expect(monitor.getState()).toBe("busy");

      vi.advanceTimersByTime(200);
      expect(monitor.getState()).toBe("idle");
      expect(onStateChange).toHaveBeenCalledWith("ext-promo-extend", 100, "idle", {
        trigger: "timeout",
      });

      monitor.dispose();
    });

    it("never emits busy from this path, even when called repeatedly while already busy", () => {
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("ext-promo-busy", 100, onStateChange, {
        agentId: "claude",
        initialState: "busy",
        skipInitialStateEmit: true,
      });
      onStateChange.mockClear();

      monitor.notifyExternalPromotion();
      monitor.notifyExternalPromotion();

      expect(monitor.getState()).toBe("busy");
      const busyCalls = onStateChange.mock.calls.filter((call) => call[2] === "busy");
      expect(busyCalls.length).toBe(0);

      monitor.dispose();
    });
  });

  describe("once-per-second indicator recovery (Issue #9874)", () => {
    it("recovers idle→busy from a 1Hz status-line countdown in simple-output polling mode", () => {
      vi.setSystemTime(10000);
      const onStateChange = vi.fn();
      let statusLine = "Retrying in 9s · 100 tokens";
      const monitor = new ActivityMonitor("indicator-1hz", 100, onStateChange, {
        agentId: "kimi",
        simpleOutputState: true,
        getVisibleLines: () => ["$ agent run", statusLine],
        getCursorLine: () => statusLine,
        initialState: "idle",
        skipInitialStateEmit: true,
        pollingIntervalMs: 50,
      });
      monitor.startPolling();
      onStateChange.mockClear();

      // 1Hz countdown: each second the agent rewrites its status line with a
      // CR + erase-line sequence (matches isStatusLineRewrite).
      for (let i = 1; i <= 6 && monitor.getState() !== "busy"; i += 1) {
        vi.advanceTimersByTime(1000);
        statusLine = `Retrying in ${9 - i}s · ${100 + i * 137} tokens`;
        monitor.onData(`\r\x1b[2K${statusLine}`);
      }

      expect(monitor.getState()).toBe("busy");
      expect(onStateChange).toHaveBeenCalledWith("indicator-1hz", 100, "busy", {
        trigger: "output",
      });

      monitor.dispose();
    });

    it("expires the status-rewrite latch so later plain content is not indicator-classified", () => {
      vi.setSystemTime(10000);
      const onStateChange = vi.fn();
      let statusLine = "Retrying in 9s · 100 tokens";
      const monitor = new ActivityMonitor("latch-expiry", 100, onStateChange, {
        agentId: "kimi",
        simpleOutputState: true,
        getVisibleLines: () => ["$ agent run", statusLine],
        getCursorLine: () => statusLine,
        initialState: "idle",
        skipInitialStateEmit: true,
        pollingIntervalMs: 50,
      });
      monitor.startPolling();
      onStateChange.mockClear();

      // One status-line rewrite latches lastStatusRewriteAt…
      statusLine = "Retrying in 8s · 237 tokens";
      monitor.onData(`\r\x1b[2K${statusLine}`);

      // …but the agent then emits only plain newline-terminated content at
      // 1Hz. Once the 1500ms latch expires, changes classify as content and
      // the strict 900ms gap keeps resetting the evidence window.
      for (let i = 1; i <= 8; i += 1) {
        vi.advanceTimersByTime(1000);
        statusLine = `layout pass ${i * 137}`;
        monitor.onData(`${statusLine}\n`);
      }

      expect(monitor.getState()).toBe("idle");

      monitor.dispose();
    });

    it("negative control: 1Hz non-indicator content changes do not recover idle→busy", () => {
      vi.setSystemTime(10000);
      const onStateChange = vi.fn();
      let bodyLine = "layout pass 0";
      const monitor = new ActivityMonitor("content-1hz", 100, onStateChange, {
        agentId: "kimi",
        simpleOutputState: true,
        getVisibleLines: () => ["$ agent run", bodyLine],
        getCursorLine: () => bodyLine,
        initialState: "idle",
        skipInitialStateEmit: true,
        pollingIntervalMs: 50,
      });
      monitor.startPolling();
      onStateChange.mockClear();

      // Same cadence, but plain newline-terminated output — no status-line
      // rewrite sequences, so the strict 900ms content gap still applies.
      for (let i = 1; i <= 8; i += 1) {
        vi.advanceTimersByTime(1000);
        bodyLine = `layout pass ${i * 137}`;
        monitor.onData(`${bodyLine}\n`);
      }

      expect(monitor.getState()).toBe("idle");

      monitor.dispose();
    });
  });
});
