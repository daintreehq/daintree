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
