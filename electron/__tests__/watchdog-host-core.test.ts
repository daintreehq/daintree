import { describe, it, expect, vi } from "vitest";
import {
  availableMemoryRatio,
  buildWatchdogKillPayload,
  createWatchdog,
  parseMainPid,
  writeWatchdogKillFlag,
  HEARTBEAT_INTERVAL_MS,
  LATE_TICK_GAP_MS,
  LOW_AVAILABLE_MEMORY_RATIO,
  MAX_MISSED,
  MAX_MISSED_UNDER_PRESSURE,
  STALL_EVIDENCE_MS,
  WATCHDOG_KILL_FLAG_NAME,
} from "../watchdog-host-core.js";

describe("parseMainPid", () => {
  it("extracts a valid pid from --main-pid=<pid>", () => {
    expect(parseMainPid(["node", "watchdog", "--main-pid=12345"])).toBe(12345);
  });

  it("returns null when the flag is missing", () => {
    expect(parseMainPid(["node", "watchdog"])).toBeNull();
  });

  it("returns null when the value is non-numeric", () => {
    expect(parseMainPid(["--main-pid=abc"])).toBeNull();
  });

  it("returns null when the value is zero or negative", () => {
    expect(parseMainPid(["--main-pid=0"])).toBeNull();
    expect(parseMainPid(["--main-pid=-1"])).toBeNull();
  });

  it("returns null when the value is empty", () => {
    expect(parseMainPid(["--main-pid="])).toBeNull();
  });

  it("rejects partial-numeric inputs (parseInt would silently truncate)", () => {
    expect(parseMainPid(["--main-pid=123abc"])).toBeNull();
    expect(parseMainPid(["--main-pid=1.9"])).toBeNull();
    expect(parseMainPid(["--main-pid= 42"])).toBeNull();
    expect(parseMainPid(["--main-pid=42 "])).toBeNull();
  });
});

describe("createWatchdog", () => {
  it("does not fire kill before the first ping arms the watchdog (startup grace)", () => {
    const killMain = vi.fn();
    const wd = createWatchdog({ killMain, logError: () => {} });

    // Simulate many ticks before any ping is received.
    for (let i = 0; i < MAX_MISSED * 2; i++) wd.tick();

    expect(killMain).not.toHaveBeenCalled();
    expect(wd.state.isArmed).toBe(false);
  });

  it("fires kill when missedBeats reaches MAX_MISSED after arm", () => {
    const killMain = vi.fn();
    const wd = createWatchdog({ killMain, logError: () => {} });
    wd.handleMessage({ type: "ping" });

    for (let i = 0; i < MAX_MISSED - 1; i++) wd.tick();
    expect(killMain).not.toHaveBeenCalled();
    expect(wd.state.missedBeats).toBe(MAX_MISSED - 1);

    wd.tick(); // crosses threshold
    expect(killMain).toHaveBeenCalledTimes(1);
  });

  it("disarms after firing so a single deadlock doesn't loop SIGKILL", () => {
    const killMain = vi.fn();
    const wd = createWatchdog({ killMain, logError: () => {} });
    wd.handleMessage({ type: "ping" });

    for (let i = 0; i < MAX_MISSED; i++) wd.tick();
    expect(killMain).toHaveBeenCalledTimes(1);
    expect(wd.state.isArmed).toBe(false);

    // More ticks must NOT trigger another kill.
    for (let i = 0; i < MAX_MISSED * 2; i++) wd.tick();
    expect(killMain).toHaveBeenCalledTimes(1);
  });

  it("a fresh ping after a kill re-arms the watchdog", () => {
    const killMain = vi.fn();
    const wd = createWatchdog({ killMain, logError: () => {} });
    wd.handleMessage({ type: "ping" });

    for (let i = 0; i < MAX_MISSED; i++) wd.tick();
    expect(killMain).toHaveBeenCalledTimes(1);

    // CrashRecoveryService relaunches main; first ping should re-arm.
    wd.handleMessage({ type: "ping" });
    expect(wd.state.isArmed).toBe(true);
    expect(wd.state.missedBeats).toBe(0);

    for (let i = 0; i < MAX_MISSED; i++) wd.tick();
    expect(killMain).toHaveBeenCalledTimes(2);
  });

  it("subsequent pings reset the missed counter (steady-state ping/pong)", () => {
    const killMain = vi.fn();
    const wd = createWatchdog({ killMain, logError: () => {} });
    wd.handleMessage({ type: "ping" });

    for (let i = 0; i < 100; i++) {
      wd.tick();
      wd.handleMessage({ type: "ping" });
    }

    expect(killMain).not.toHaveBeenCalled();
    expect(wd.state.missedBeats).toBe(0);
  });

  it("sleep suppresses kill across many ticks without losing arm state", () => {
    const killMain = vi.fn();
    const wd = createWatchdog({ killMain, logError: () => {} });
    wd.handleMessage({ type: "ping" });

    wd.handleMessage({ type: "sleep" });
    expect(wd.state.isPaused).toBe(true);

    for (let i = 0; i < MAX_MISSED * 5; i++) wd.tick();
    expect(killMain).not.toHaveBeenCalled();
    expect(wd.state.missedBeats).toBe(0);
  });

  it("wake clears the missed counter and resumes counting", () => {
    const killMain = vi.fn();
    let now = 1000;
    const wd = createWatchdog({ killMain, logError: () => {}, now: () => now });
    wd.handleMessage({ type: "ping" });

    wd.handleMessage({ type: "sleep" });
    for (let i = 0; i < MAX_MISSED * 5; i++) wd.tick();

    wd.handleMessage({ type: "wake" });
    expect(wd.state.isPaused).toBe(false);
    expect(wd.state.missedBeats).toBe(0);

    // Advance past the wake-grace window so missed-beat counting resumes
    // (the grace exists to absorb queued-during-sleep tick bursts).
    now += HEARTBEAT_INTERVAL_MS;
    for (let i = 0; i < MAX_MISSED; i++) wd.tick();
    expect(killMain).toHaveBeenCalledTimes(1);
  });

  it("dispose disarms the watchdog so an in-flight tick can't fire", () => {
    const killMain = vi.fn();
    const wd = createWatchdog({ killMain, logError: () => {} });
    wd.handleMessage({ type: "ping" });

    // Drive missedBeats up to MAX_MISSED - 1 (just below threshold).
    for (let i = 0; i < MAX_MISSED - 1; i++) wd.tick();
    expect(killMain).not.toHaveBeenCalled();

    wd.handleMessage({ type: "dispose" });
    expect(wd.state.isArmed).toBe(false);

    // Any ticks after dispose must not fire.
    for (let i = 0; i < MAX_MISSED * 2; i++) wd.tick();
    expect(killMain).not.toHaveBeenCalled();
  });

  it("disarm() works as a direct teardown helper", () => {
    const killMain = vi.fn();
    const wd = createWatchdog({ killMain, logError: () => {} });
    wd.handleMessage({ type: "ping" });
    wd.disarm();
    expect(wd.state.isArmed).toBe(false);
    for (let i = 0; i < MAX_MISSED * 2; i++) wd.tick();
    expect(killMain).not.toHaveBeenCalled();
  });

  it("ignores malformed messages", () => {
    const wd = createWatchdog({ killMain: vi.fn(), logError: () => {} });
    expect(wd.handleMessage(null)).toBe(false);
    expect(wd.handleMessage(undefined)).toBe(false);
    expect(wd.handleMessage({ type: "unknown" } as unknown as { type: "ping" })).toBe(false);
    expect(wd.state.isArmed).toBe(false);
  });

  it("swallows errors from killMain so a throwing kill doesn't crash the watchdog", () => {
    const killMain = vi.fn().mockImplementation(() => {
      throw new Error("kill failed");
    });
    const wd = createWatchdog({ killMain, logError: () => {} });
    wd.handleMessage({ type: "ping" });

    expect(() => {
      for (let i = 0; i < MAX_MISSED; i++) wd.tick();
    }).not.toThrow();
    expect(killMain).toHaveBeenCalledTimes(1);
    // Even though kill threw, the watchdog disarms so the next tick is inert.
    expect(wd.state.isArmed).toBe(false);
  });

  describe("wake-grace (monotonic-clock stale-tick suppression)", () => {
    // The OS schedules `setInterval` callbacks during sleep and delivers them
    // as a burst at wake — without the grace, those queued ticks would each
    // increment `missedBeats` and cross the kill threshold before the
    // arming ping has a chance to reset the counter.
    it("suppresses ticks fired within HEARTBEAT_INTERVAL_MS of the most recent wake", () => {
      const killMain = vi.fn();
      const now = 1000;
      const wd = createWatchdog({ killMain, logError: () => {}, now: () => now });
      wd.handleMessage({ type: "ping" });

      // Burst-fire ticks immediately after wake — the kernel has queued
      // several intervals during sleep and they all land at once.
      wd.handleMessage({ type: "sleep" });
      wd.handleMessage({ type: "wake" });
      for (let i = 0; i < MAX_MISSED * 5; i++) wd.tick();

      expect(killMain).not.toHaveBeenCalled();
      expect(wd.state.missedBeats).toBe(0);
    });

    it("resumes normal missed-beat counting once the grace window elapses", () => {
      const killMain = vi.fn();
      let now = 1000;
      const wd = createWatchdog({ killMain, logError: () => {}, now: () => now });
      wd.handleMessage({ type: "ping" });
      wd.handleMessage({ type: "wake" });

      // Advance the clock past one heartbeat interval — grace expires.
      now += HEARTBEAT_INTERVAL_MS;
      for (let i = 0; i < MAX_MISSED; i++) wd.tick();

      expect(killMain).toHaveBeenCalledTimes(1);
    });

    it("does not engage on startup before any wake has been observed", () => {
      // `lastWakeTimestamp` starts at 0 — the grace must not suppress the
      // very first ticks after boot, otherwise a stuck-at-boot main would
      // escape detection.
      const killMain = vi.fn();
      const wd = createWatchdog({ killMain, logError: () => {}, now: () => 1000 });
      wd.handleMessage({ type: "ping" });

      for (let i = 0; i < MAX_MISSED; i++) wd.tick();
      expect(killMain).toHaveBeenCalledTimes(1);
    });

    it("grace boundary is strict `<` — tick at exactly HEARTBEAT_INTERVAL_MS counts", () => {
      // Off-by-one guard: if the comparison were `<=`, the very first tick
      // after the grace window expires would still be suppressed, delaying
      // detection by one extra interval. Verify the boundary is `<`.
      const killMain = vi.fn();
      let now = 1000;
      const wd = createWatchdog({ killMain, logError: () => {}, now: () => now });
      wd.handleMessage({ type: "ping" });
      wd.handleMessage({ type: "wake" });

      // At `lastWakeTimestamp + HEARTBEAT_INTERVAL_MS - 1` the grace still applies.
      now += HEARTBEAT_INTERVAL_MS - 1;
      for (let i = 0; i < MAX_MISSED; i++) wd.tick();
      expect(killMain).not.toHaveBeenCalled();

      // At `lastWakeTimestamp + HEARTBEAT_INTERVAL_MS` the grace lifts.
      now = 1000 + HEARTBEAT_INTERVAL_MS;
      for (let i = 0; i < MAX_MISSED; i++) wd.tick();
      expect(killMain).toHaveBeenCalledTimes(1);
    });

    it("defaults the clock to `performance.now` when `deps.now` is omitted", () => {
      // Smoke-check that the default seam is wired — `lastWakeTimestamp`
      // should land in the same monotonic frame as `performance.now()`.
      const wd = createWatchdog({ killMain: vi.fn(), logError: () => {} });
      const before = performance.now();
      wd.handleMessage({ type: "wake" });
      const after = performance.now();
      expect(wd.state.lastWakeTimestamp).toBeGreaterThanOrEqual(before);
      expect(wd.state.lastWakeTimestamp).toBeLessThanOrEqual(after);
    });
  });

  describe("memory-pressure deferral (#13528)", () => {
    function makeWatchdog() {
      const killMain = vi.fn();
      const logs: string[] = [];
      let now = 1000;
      const wd = createWatchdog({ killMain, logError: (msg) => logs.push(msg), now: () => now });
      const tickAfter = (ms: number) => {
        now += ms;
        wd.tick();
      };
      const ticks = (count: number) => {
        for (let i = 0; i < count; i++) tickAfter(HEARTBEAT_INTERVAL_MS);
      };
      return { wd, killMain, logs, tickAfter, ticks, advance: (ms: number) => (now += ms) };
    }

    const deferralLogs = (logs: string[]) => logs.filter((l) => l.includes("Deferring kill"));
    const cancelLogs = (logs: string[]) =>
      logs.filter((l) => l.includes("deferred kill cancelled"));

    it("holds the kill until MAX_MISSED_UNDER_PRESSURE when the last ping reported pressure", () => {
      const { wd, killMain, logs, ticks } = makeWatchdog();
      let beatsAtKill = 0;
      killMain.mockImplementation(() => (beatsAtKill = wd.state.missedBeats));
      wd.handleMessage({ type: "ping", memoryPressure: true });

      ticks(MAX_MISSED_UNDER_PRESSURE - 1);
      expect(killMain).not.toHaveBeenCalled();
      expect(wd.state.killDeferred).toBe(true);
      expect(deferralLogs(logs)).toHaveLength(1);

      ticks(1);
      expect(killMain).toHaveBeenCalledTimes(1);
      // The kill flag records the beats the kill fired at.
      expect(beatsAtKill).toBe(MAX_MISSED_UNDER_PRESSURE);
      expect(wd.state.isArmed).toBe(false);
      expect(wd.state.killDeferred).toBe(false);

      // A relaunched main that reads the machine as clear gets the normal deadline.
      wd.handleMessage({ type: "ping", memoryPressure: false });
      ticks(MAX_MISSED);
      expect(killMain).toHaveBeenCalledTimes(2);
    });

    it("gives a main with no fresh pressure reading the longer deadline too", () => {
      const { wd, killMain, logs, ticks } = makeWatchdog();
      wd.handleMessage({ type: "ping", memoryPressure: null });

      ticks(MAX_MISSED_UNDER_PRESSURE - 1);
      expect(killMain).not.toHaveBeenCalled();
      expect(deferralLogs(logs)[0]).toContain("no memory-pressure reading");
      ticks(1);
      expect(killMain).toHaveBeenCalledTimes(1);
    });

    it("keeps the normal threshold when the last ping reported none", () => {
      const malformed = ["true", 1, {}] as unknown as boolean[];
      for (const memoryPressure of [false, undefined, ...malformed]) {
        const { wd, killMain, ticks } = makeWatchdog();
        wd.handleMessage({ type: "ping", memoryPressure: true });
        wd.handleMessage({ type: "ping", memoryPressure });

        ticks(MAX_MISSED);
        expect(killMain).toHaveBeenCalledTimes(1);
      }
    });

    it("cancels a deferred kill on the first ping of a recovery burst, and starts the next silence fresh", () => {
      const { wd, killMain, logs, ticks } = makeWatchdog();
      const answerOnTime = (beats: number) => {
        for (let i = 0; i < beats; i++) {
          ticks(1);
          wd.handleMessage({ type: "ping", memoryPressure: false });
        }
      };
      wd.handleMessage({ type: "ping", memoryPressure: true });
      ticks(MAX_MISSED + 2);
      expect(wd.state.killDeferred).toBe(true);

      // A stalled main's queued pings land as a burst once it recovers.
      wd.handleMessage({ type: "ping", memoryPressure: true });
      expect(cancelLogs(logs)).toHaveLength(1);
      expect(wd.state.killDeferred).toBe(false);
      expect(wd.state.missedBeats).toBe(0);

      wd.handleMessage({ type: "ping", memoryPressure: false });
      expect(cancelLogs(logs)).toHaveLength(1);

      // The recovery ping itself arrived late, so a silence right after it is
      // still given the longer deadline (#13636)…
      expect(wd.state.lastLatePingAt).not.toBeNull();
      // …until main has answered on time for longer than that evidence lasts.
      answerOnTime(STALL_EVIDENCE_MS / HEARTBEAT_INTERVAL_MS);
      ticks(MAX_MISSED);
      expect(killMain).toHaveBeenCalledTimes(1);
      expect(cancelLogs(logs)).toHaveLength(1);
    });

    it("counts a long stall of its own during a deferral as one beat, not as elapsed time", () => {
      const { wd, killMain, tickAfter, ticks } = makeWatchdog();
      wd.handleMessage({ type: "ping", memoryPressure: true });
      ticks(MAX_MISSED);
      expect(wd.state.killDeferred).toBe(true);

      tickAfter(MAX_MISSED_UNDER_PRESSURE * HEARTBEAT_INTERVAL_MS * 2);
      expect(wd.state.missedBeats).toBe(MAX_MISSED + 1);
      expect(killMain).not.toHaveBeenCalled();

      ticks(MAX_MISSED_UNDER_PRESSURE - MAX_MISSED - 2);
      expect(killMain).not.toHaveBeenCalled();
      ticks(1);
      expect(killMain).toHaveBeenCalledTimes(1);
    });

    it("never fires the kill on a late tick, so pings queued behind its own stall are read first", () => {
      const queued = makeWatchdog();
      queued.wd.handleMessage({ type: "ping", memoryPressure: true });
      queued.ticks(MAX_MISSED_UNDER_PRESSURE - 1);
      queued.tickAfter(LATE_TICK_GAP_MS);
      expect(queued.killMain).not.toHaveBeenCalled();
      queued.wd.handleMessage({ type: "ping", memoryPressure: true });
      queued.ticks(MAX_MISSED);
      expect(queued.killMain).not.toHaveBeenCalled();

      // Still silent a beat later: the hold is one beat, even if that tick is late too.
      const silent = makeWatchdog();
      silent.wd.handleMessage({ type: "ping", memoryPressure: true });
      silent.ticks(MAX_MISSED_UNDER_PRESSURE - 1);
      silent.tickAfter(LATE_TICK_GAP_MS);
      silent.tickAfter(LATE_TICK_GAP_MS);
      expect(silent.killMain).toHaveBeenCalledTimes(1);
    });

    it("treats a late tick of its own as evidence of a machine-wide stall", () => {
      const { wd, killMain, logs, tickAfter, ticks } = makeWatchdog();
      wd.handleMessage({ type: "ping" });

      // After ordinary ticks, so the gap is measured from the last tick.
      ticks(1);
      wd.handleMessage({ type: "ping" });
      tickAfter(LATE_TICK_GAP_MS);
      ticks(MAX_MISSED - 1);
      expect(killMain).not.toHaveBeenCalled();
      expect(deferralLogs(logs)[0]).toContain("the watchdog itself stalled");

      ticks(MAX_MISSED_UNDER_PRESSURE - MAX_MISSED);
      expect(killMain).toHaveBeenCalledTimes(1);
    });

    it("does not count a tick just under the late threshold as a stall", () => {
      const { wd, killMain, tickAfter, ticks } = makeWatchdog();
      wd.handleMessage({ type: "ping" });

      tickAfter(LATE_TICK_GAP_MS - 1);
      ticks(MAX_MISSED - 1);
      expect(killMain).toHaveBeenCalledTimes(1);
    });

    it("still credits a stall seen just before main went quiet", () => {
      const { wd, killMain, logs, tickAfter, ticks, advance } = makeWatchdog();
      wd.handleMessage({ type: "ping" });
      // Main keeps pinging on time; only the watchdog's own tick is late.
      advance(HEARTBEAT_INTERVAL_MS);
      wd.handleMessage({ type: "ping" });
      tickAfter(LATE_TICK_GAP_MS - HEARTBEAT_INTERVAL_MS);
      wd.handleMessage({ type: "ping" });
      expect(wd.state.lastLatePingAt).toBeNull();

      ticks(MAX_MISSED);
      expect(killMain).not.toHaveBeenCalled();
      expect(wd.state.killDeferred).toBe(true);
      expect(deferralLogs(logs)[0]).toContain("the watchdog itself stalled");
    });

    it("lets stall evidence expire, but never pulls in a deadline it already granted", () => {
      const stale = makeWatchdog();
      stale.wd.handleMessage({ type: "ping" });
      stale.tickAfter(LATE_TICK_GAP_MS);
      // Main keeps answering, on time, for as long as the evidence lasts.
      for (let i = 0; i < STALL_EVIDENCE_MS / HEARTBEAT_INTERVAL_MS; i++) {
        stale.ticks(1);
        stale.wd.handleMessage({ type: "ping" });
      }
      stale.ticks(MAX_MISSED);
      expect(stale.killMain).toHaveBeenCalledTimes(1);

      const granted = makeWatchdog();
      granted.wd.handleMessage({ type: "ping" });
      granted.tickAfter(LATE_TICK_GAP_MS);
      granted.ticks(MAX_MISSED - 1);
      expect(granted.wd.state.killDeferred).toBe(true);
      // The evidence ages out long before this, and the deferral still holds.
      granted.ticks(MAX_MISSED_UNDER_PRESSURE - MAX_MISSED - 1);
      expect(granted.killMain).not.toHaveBeenCalled();
      granted.ticks(1);
      expect(granted.killMain).toHaveBeenCalledTimes(1);
    });

    it("reads neither a disarmed gap nor a suspend as the watchdog stalling", () => {
      const disarmed = makeWatchdog();
      disarmed.tickAfter(LATE_TICK_GAP_MS * 10);
      disarmed.wd.handleMessage({ type: "ping" });
      disarmed.ticks(MAX_MISSED);
      expect(disarmed.killMain).toHaveBeenCalledTimes(1);

      const suspended = makeWatchdog();
      suspended.wd.handleMessage({ type: "ping" });
      suspended.tickAfter(LATE_TICK_GAP_MS);
      expect(suspended.wd.state.lastLateTickAt).not.toBeNull();
      suspended.wd.handleMessage({ type: "ping" });
      suspended.wd.handleMessage({ type: "sleep" });
      const lateBeforeSleep = suspended.wd.state.lastLateTickAt;
      suspended.tickAfter(LATE_TICK_GAP_MS * 10);
      expect(suspended.wd.state.lastLateTickAt).toBe(lateBeforeSleep);

      // Wake drops the pre-sleep stall, and the suspend gap is not a new one.
      suspended.advance(LATE_TICK_GAP_MS * 10);
      suspended.wd.handleMessage({ type: "wake" });
      expect(suspended.wd.state.lastLateTickAt).toBeNull();
      suspended.ticks(MAX_MISSED);
      expect(suspended.wd.state.lastLateTickAt).toBeNull();
      expect(suspended.killMain).toHaveBeenCalledTimes(1);
    });

    it("defers when main's pings slowed before it went quiet, though its last reading was clear (#13636)", () => {
      const { wd, killMain, logs, ticks, advance } = makeWatchdog();
      wd.handleMessage({ type: "ping", memoryPressure: false });
      ticks(1);
      // Pressure builds after the clear sample: a ping lands a beat late while
      // the watchdog itself keeps ticking on time.
      ticks(1);
      advance(1);
      wd.handleMessage({ type: "ping", memoryPressure: false });

      ticks(MAX_MISSED);
      expect(killMain).not.toHaveBeenCalled();
      expect(deferralLogs(logs)[0]).toContain("pings were already arriving late");
      ticks(MAX_MISSED_UNDER_PRESSURE - MAX_MISSED - 1);
      expect(killMain).not.toHaveBeenCalled();
      ticks(1);
      expect(killMain).toHaveBeenCalledTimes(1);
    });

    it("gives a silence straight after a deferred stall's recovery the longer deadline too", () => {
      const { wd, killMain, ticks } = makeWatchdog();
      wd.handleMessage({ type: "ping", memoryPressure: true });
      ticks(MAX_MISSED + 2);
      wd.handleMessage({ type: "ping", memoryPressure: false });
      expect(wd.state.missedBeats).toBe(0);
      expect(wd.state.killDeferred).toBe(false);

      ticks(MAX_MISSED);
      expect(wd.state.killDeferred).toBe(true);
      ticks(MAX_MISSED_UNDER_PRESSURE - MAX_MISSED - 1);
      expect(killMain).not.toHaveBeenCalled();
      ticks(1);
      expect(killMain).toHaveBeenCalledTimes(1);
    });

    it("does not count a ping just under a beat late as main slowing", () => {
      const { wd, killMain, ticks, advance } = makeWatchdog();
      wd.handleMessage({ type: "ping" });
      // Time passes on the watchdog's own beat, so it never ticks late.
      ticks(1);
      advance(LATE_TICK_GAP_MS - HEARTBEAT_INTERVAL_MS - 1);
      wd.handleMessage({ type: "ping" });
      expect(wd.state.lastLatePingAt).toBeNull();
      ticks(MAX_MISSED);
      expect(killMain).toHaveBeenCalledTimes(1);
    });

    it("reads neither a disarmed nor a suspended gap between pings as main slowing", () => {
      const relaunched = makeWatchdog();
      relaunched.wd.handleMessage({ type: "ping", memoryPressure: true });
      relaunched.ticks(2);
      relaunched.wd.handleMessage({ type: "ping", memoryPressure: true });
      expect(relaunched.wd.state.lastLatePingAt).not.toBeNull();
      relaunched.ticks(MAX_MISSED_UNDER_PRESSURE);
      expect(relaunched.killMain).toHaveBeenCalledTimes(1);
      // The kill drops the evidence along with the baseline.
      expect(relaunched.wd.state.lastLatePingAt).toBeNull();
      relaunched.advance(LATE_TICK_GAP_MS);
      relaunched.wd.handleMessage({ type: "ping" });
      expect(relaunched.wd.state.lastLatePingAt).toBeNull();

      const suspended = makeWatchdog();
      suspended.wd.handleMessage({ type: "ping" });
      suspended.ticks(2);
      suspended.wd.handleMessage({ type: "ping" });
      expect(suspended.wd.state.lastLatePingAt).not.toBeNull();
      suspended.wd.handleMessage({ type: "sleep" });
      suspended.advance(LATE_TICK_GAP_MS * 10);
      suspended.wd.handleMessage({ type: "wake" });
      expect(suspended.wd.state.lastLatePingAt).toBeNull();
      suspended.ticks(1);
      suspended.wd.handleMessage({ type: "ping" });
      expect(suspended.wd.state.lastLatePingAt).toBeNull();
      suspended.ticks(MAX_MISSED);
      expect(suspended.killMain).toHaveBeenCalledTimes(1);

      // A ping that lands while paused sets no baseline for the next one.
      const paused = makeWatchdog();
      paused.wd.handleMessage({ type: "ping" });
      paused.wd.handleMessage({ type: "sleep" });
      paused.wd.handleMessage({ type: "ping" });
      paused.advance(LATE_TICK_GAP_MS * 10);
      paused.wd.handleMessage({ type: "ping" });
      expect(paused.wd.state.lastLatePingAt).toBeNull();

      for (const teardown of ["disarm", "dispose"] as const) {
        const disposed = makeWatchdog();
        disposed.wd.handleMessage({ type: "ping" });
        if (teardown === "disarm") disposed.wd.disarm();
        else disposed.wd.handleMessage({ type: "dispose" });
        disposed.advance(LATE_TICK_GAP_MS * 10);
        disposed.wd.handleMessage({ type: "ping" });
        expect(disposed.wd.state.lastLatePingAt).toBeNull();
      }
    });

    it("credits a late ping for exactly STALL_EVIDENCE_MS, while main keeps answering on time", () => {
      const silenceAt = (extraMs: number) => {
        const { wd, killMain, ticks, advance } = makeWatchdog();
        wd.handleMessage({ type: "ping" });
        ticks(LATE_TICK_GAP_MS / HEARTBEAT_INTERVAL_MS);
        wd.handleMessage({ type: "ping" });
        expect(wd.state.lastLatePingAt).not.toBeNull();
        // On-time answers until the silence's MAX_MISSED decision lands
        // STALL_EVIDENCE_MS (+ extraMs) after the late ping.
        const onTime =
          (STALL_EVIDENCE_MS - MAX_MISSED * HEARTBEAT_INTERVAL_MS) / HEARTBEAT_INTERVAL_MS;
        for (let i = 0; i < onTime; i++) {
          ticks(1);
          wd.handleMessage({ type: "ping" });
        }
        advance(extraMs);
        ticks(MAX_MISSED);
        expect(wd.state.lastLateTickAt).toBeNull();
        return { wd, killMain };
      };

      const atLimit = silenceAt(0);
      expect(atLimit.killMain).not.toHaveBeenCalled();
      expect(atLimit.wd.state.killDeferred).toBe(true);

      const past = silenceAt(1);
      expect(past.killMain).toHaveBeenCalledTimes(1);
    });

    describe("the watchdog's own available-memory read", () => {
      function makeReadingWatchdog(read: () => number | null) {
        const killMain = vi.fn();
        const logs: string[] = [];
        const readAvailableMemoryRatio = vi.fn(read);
        let now = 1000;
        const wd = createWatchdog({
          killMain,
          logError: (msg) => logs.push(msg),
          now: () => now,
          readAvailableMemoryRatio,
        });
        const ticks = (count: number) => {
          for (let i = 0; i < count; i++) {
            now += HEARTBEAT_INTERVAL_MS;
            wd.tick();
          }
        };
        return { wd, killMain, logs, ticks, readAvailableMemoryRatio };
      }

      it("defers when memory is nearly exhausted, reading only once the silence reaches MAX_MISSED", () => {
        const { wd, killMain, logs, ticks, readAvailableMemoryRatio } = makeReadingWatchdog(
          () => LOW_AVAILABLE_MEMORY_RATIO / 2
        );
        wd.handleMessage({ type: "ping", memoryPressure: false });
        ticks(MAX_MISSED - 1);
        expect(readAvailableMemoryRatio).not.toHaveBeenCalled();

        ticks(1);
        expect(killMain).not.toHaveBeenCalled();
        expect(logs.find((l) => l.includes("Deferring kill"))).toContain("of memory is available");
        ticks(MAX_MISSED_UNDER_PRESSURE - MAX_MISSED - 1);
        expect(killMain).not.toHaveBeenCalled();
        ticks(1);
        expect(killMain).toHaveBeenCalledTimes(1);
        // Latched: one read decides the silence.
        expect(readAvailableMemoryRatio).toHaveBeenCalledTimes(1);
      });

      it("keeps the normal deadline when the read is ample, missing, malformed or throws", () => {
        const reads: Array<() => number | null> = [
          () => LOW_AVAILABLE_MEMORY_RATIO,
          () => null,
          () => Number.NaN,
          () => -1,
          () => {
            throw new Error("no reading");
          },
        ];
        for (const read of reads) {
          const { wd, killMain, ticks, readAvailableMemoryRatio } = makeReadingWatchdog(read);
          wd.handleMessage({ type: "ping", memoryPressure: false });
          ticks(MAX_MISSED - 1);
          expect(killMain).not.toHaveBeenCalled();
          ticks(1);
          expect(killMain).toHaveBeenCalledTimes(1);
          expect(readAvailableMemoryRatio).toHaveBeenCalledTimes(1);
        }
      });

      it("skips the read when other evidence already defers the kill", () => {
        for (const memoryPressure of [true, null]) {
          const { wd, killMain, ticks, readAvailableMemoryRatio } = makeReadingWatchdog(
            () => LOW_AVAILABLE_MEMORY_RATIO / 2
          );
          wd.handleMessage({ type: "ping", memoryPressure });
          ticks(MAX_MISSED);
          expect(wd.state.killDeferred).toBe(true);
          expect(killMain).not.toHaveBeenCalled();
          expect(readAvailableMemoryRatio).not.toHaveBeenCalled();
        }
      });
    });

    it("drops a deferral on sleep, and keeps main's pressure report through the wake", () => {
      const { wd, killMain, ticks } = makeWatchdog();
      wd.handleMessage({ type: "ping", memoryPressure: true });
      ticks(MAX_MISSED);
      expect(wd.state.killDeferred).toBe(true);

      wd.handleMessage({ type: "sleep" });
      expect(wd.state.killDeferred).toBe(false);
      wd.handleMessage({ type: "wake" });
      // Main's report stands until its next ping replaces it.
      ticks(MAX_MISSED_UNDER_PRESSURE - 1);
      expect(killMain).not.toHaveBeenCalled();
      ticks(1);
      expect(killMain).toHaveBeenCalledTimes(1);
    });
  });
});

describe("availableMemoryRatio", () => {
  const GB = 1024 ** 3;

  it("divides by physical memory when there is no constraint", () => {
    expect(availableMemoryRatio(4 * GB, 4 * GB, 16 * GB, 0)).toBe(0.25);
  });

  it("caps the total at a positive constraint, but never above physical memory", () => {
    expect(availableMemoryRatio(1 * GB, 8 * GB, 16 * GB, 2 * GB)).toBe(0.5);
    // libuv may report an unlimited constraint as a huge figure.
    expect(availableMemoryRatio(4 * GB, 4 * GB, 16 * GB, Number.MAX_SAFE_INTEGER)).toBe(0.25);
  });

  it("reports the host's share when a roomy limit hides a starved host", () => {
    expect(availableMemoryRatio(7 * GB, 0.25 * GB, 16 * GB, 8 * GB)).toBe(1 / 64);
  });

  it("returns null when there is nothing sound to divide", () => {
    expect(availableMemoryRatio(1 * GB, 1 * GB, 0, 0)).toBeNull();
    expect(availableMemoryRatio(Number.NaN, Number.NaN, 16 * GB, 0)).toBeNull();
  });
});

describe("buildWatchdogKillPayload", () => {
  it("captures missedBeats and mainPid plus a fresh killedAt timestamp", () => {
    const before = Date.now();
    const payload = buildWatchdogKillPayload(MAX_MISSED, 4242);
    const after = Date.now();

    expect(payload.missedBeats).toBe(MAX_MISSED);
    expect(payload.mainPid).toBe(4242);
    expect(payload.killedAt).toBeGreaterThanOrEqual(before);
    expect(payload.killedAt).toBeLessThanOrEqual(after);
  });
});

describe("writeWatchdogKillFlag", () => {
  function makeDeps(overrides: Partial<{ throwOnWrite: boolean }> = {}) {
    const writes: Array<{ path: string; data: string }> = [];
    const deps = {
      writeFileSync: vi.fn((p: string, data: string) => {
        if (overrides.throwOnWrite) throw new Error("disk full");
        writes.push({ path: p, data });
      }),
      joinPath: (userData: string, name: string) => `${userData}/${name}`,
    };
    return { deps, writes };
  }

  it("writes the flag at <userData>/watchdog-kill.flag with the expected payload", () => {
    const { deps, writes } = makeDeps();
    const ok = writeWatchdogKillFlag("/fake/userData", MAX_MISSED, 4242, deps);
    expect(ok).toBe(true);
    expect(writes).toHaveLength(1);
    expect(writes[0].path).toBe(`/fake/userData/${WATCHDOG_KILL_FLAG_NAME}`);
    const parsed = JSON.parse(writes[0].data);
    expect(parsed.missedBeats).toBe(MAX_MISSED);
    expect(parsed.mainPid).toBe(4242);
    expect(typeof parsed.killedAt).toBe("number");
  });

  it("returns false and writes nothing when userData is null (env missing)", () => {
    const { deps, writes } = makeDeps();
    const ok = writeWatchdogKillFlag(null, 3, 4242, deps);
    expect(ok).toBe(false);
    expect(writes).toHaveLength(0);
    expect(deps.writeFileSync).not.toHaveBeenCalled();
  });

  it("returns false (and does NOT throw) when the write itself fails — fail-open", () => {
    const { deps } = makeDeps({ throwOnWrite: true });
    // The contract is: writeWatchdogKillFlag must never propagate. The caller
    // immediately fires SIGKILL after this returns.
    const ok = writeWatchdogKillFlag("/fake/userData", 3, 4242, deps);
    expect(ok).toBe(false);
    expect(deps.writeFileSync).toHaveBeenCalledTimes(1);
  });
});
