import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  ActivityMonitor,
  FSM_IDLE_BACKOFF_SETTLE_MS,
  QUIET_POLLING_INTERVAL_MS,
  WAITING_WATCHDOG_INTERVAL_MS,
} from "../ActivityMonitor.js";
import { resetPtyPowerLevelForTesting, setPtyPowerLevel } from "../pty/ptyPowerPolicy.js";

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
