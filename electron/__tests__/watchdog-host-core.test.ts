import { describe, it, expect, vi } from "vitest";
import {
  buildWatchdogKillPayload,
  createWatchdog,
  parseMainPid,
  writeWatchdogKillFlag,
  HEARTBEAT_INTERVAL_MS,
  MAX_MISSED,
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

  it("arms on first ping and resets missedBeats", () => {
    const wd = createWatchdog({ killMain: vi.fn(), logError: () => {} });
    wd.handleMessage({ type: "ping" });
    expect(wd.state.isArmed).toBe(true);
    expect(wd.state.missedBeats).toBe(0);
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
    const wd = createWatchdog({ killMain, logError: () => {} });
    wd.handleMessage({ type: "ping" });

    wd.handleMessage({ type: "sleep" });
    for (let i = 0; i < MAX_MISSED * 5; i++) wd.tick();

    wd.handleMessage({ type: "wake" });
    expect(wd.state.isPaused).toBe(false);
    expect(wd.state.missedBeats).toBe(0);

    // After wake, normal counting resumes.
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

  it("HEARTBEAT_INTERVAL_MS × MAX_MISSED gives the conservative ~15s threshold", () => {
    expect(HEARTBEAT_INTERVAL_MS * MAX_MISSED).toBe(15000);
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

  it("produces a JSON-serialisable object (the host writes it to disk)", () => {
    const payload = buildWatchdogKillPayload(3, 1234);
    const round = JSON.parse(JSON.stringify(payload));
    expect(round).toEqual({
      killedAt: payload.killedAt,
      missedBeats: 3,
      mainPid: 1234,
    });
  });

  it("uses a stable flag filename (writer/reader must agree)", () => {
    expect(WATCHDOG_KILL_FLAG_NAME).toBe("watchdog-kill.flag");
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
