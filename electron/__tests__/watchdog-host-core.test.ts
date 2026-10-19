import { describe, it, expect, vi } from "vitest";
import {
  buildWatchdogKillPayload,
  createWatchdog,
  parseMainPid,
  writeWatchdogKillFlag,
  HEARTBEAT_INTERVAL_MS,
  LATE_TICK_GAP_MS,
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

      ticks(MAX_MISSED);
      expect(killMain).toHaveBeenCalledTimes(1);
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
      const { wd, killMain, tickAfter, ticks } = makeWatchdog();
      wd.handleMessage({ type: "ping" });
      tickAfter(LATE_TICK_GAP_MS);
      wd.handleMessage({ type: "ping" });

      ticks(MAX_MISSED);
      expect(killMain).not.toHaveBeenCalled();
      expect(wd.state.killDeferred).toBe(true);
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
