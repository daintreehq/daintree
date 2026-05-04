import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PtyHealthWatchdog } from "../PtyHealthWatchdog.js";
import type { HostCrashPayload, PtyHostRequest } from "../../../../shared/types/pty-host.js";

interface FakeChild {
  pid?: number;
}

function createWatchdog(
  opts: {
    intervalMs?: number;
    maxMissedHeartbeats?: number;
    child?: FakeChild | null;
    isInitialized?: boolean;
  } = {}
) {
  const sentRequests: PtyHostRequest[] = [];
  const crashPayloads: HostCrashPayload[] = [];
  const childRef = { current: opts.child ?? ({ pid: 555 } as FakeChild as FakeChild | null) };
  const initialized = { value: opts.isInitialized ?? true };

  const watchdog = new PtyHealthWatchdog({
    intervalMs: opts.intervalMs ?? 100,
    maxMissedHeartbeats: opts.maxMissedHeartbeats ?? 3,
    getChild: () => childRef.current as never,
    isHostInitialized: () => initialized.value,
    send: (req) => {
      sentRequests.push(req);
    },
    emitCrashDetails: (payload) => {
      crashPayloads.push(payload);
    },
  });

  return { watchdog, sentRequests, crashPayloads, childRef, initialized };
}

describe("PtyHealthWatchdog", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("sends a health-check on each tick and increments missedHeartbeats", () => {
    const { watchdog, sentRequests } = createWatchdog({ intervalMs: 100 });
    watchdog.start();

    vi.advanceTimersByTime(300);
    expect(watchdog.missedHeartbeats).toBe(3);
    expect(sentRequests.filter((r) => r.type === "health-check")).toHaveLength(3);
  });

  it("force-kills the host once missedHeartbeats reaches the threshold", () => {
    const { watchdog, crashPayloads } = createWatchdog({
      intervalMs: 100,
      maxMissedHeartbeats: 3,
    });
    const killSpy = vi
      .spyOn(process, "kill")
      .mockImplementation((() => true) as typeof process.kill);
    watchdog.start();

    // Tick 1, 2, 3 increment to 3. Tick 4 fires the watchdog.
    vi.advanceTimersByTime(400);

    expect(crashPayloads).toHaveLength(1);
    expect(crashPayloads[0]).toMatchObject({
      code: null,
      signal: "SIGKILL",
      crashType: "SIGNAL_TERMINATED",
    });
    expect(killSpy).toHaveBeenCalledWith(555, "SIGKILL");
    expect(watchdog.missedHeartbeats).toBe(0); // reset after firing
  });

  it("emits the crash event before invoking process.kill", () => {
    const { watchdog, crashPayloads } = createWatchdog({ intervalMs: 100 });
    const order: string[] = [];
    const origPush = crashPayloads.push.bind(crashPayloads);
    crashPayloads.push = ((...args: HostCrashPayload[]) => {
      order.push("event");
      return origPush(...args);
    }) as typeof crashPayloads.push;
    vi.spyOn(process, "kill").mockImplementation((() => {
      order.push("kill");
      return true;
    }) as typeof process.kill);
    watchdog.start();

    vi.advanceTimersByTime(400);
    expect(order).toEqual(["event", "kill"]);
  });

  it("recordPong resets missedHeartbeats and records an RTT sample", () => {
    const { watchdog } = createWatchdog({ intervalMs: 100 });
    watchdog.start();

    vi.advanceTimersByTime(200);
    expect(watchdog.missedHeartbeats).toBe(2);

    // Use a known offset relative to performance.now() so the RTT calc is
    // deterministic without having to fight vi.useFakeTimers() over the
    // performance.now() backing function.
    watchdog.lastPingTime = performance.now() - 50;
    watchdog.recordPong();

    expect(watchdog.missedHeartbeats).toBe(0);
    expect(watchdog.rttSamples).toHaveLength(1);
    expect(watchdog.rttSamples[0]).toBeGreaterThanOrEqual(0);
    expect(watchdog.lastPingTime).toBeNull();
  });

  it("recordPong with no in-flight ping leaves rttSamples empty", () => {
    const { watchdog } = createWatchdog({ intervalMs: 100 });
    watchdog.start();
    watchdog.lastPingTime = null;

    watchdog.recordPong();

    expect(watchdog.rttSamples).toEqual([]);
  });

  it("pause clears the interval and freezes missedHeartbeats", () => {
    const { watchdog } = createWatchdog({ intervalMs: 100 });
    watchdog.start();
    vi.advanceTimersByTime(200);
    expect(watchdog.missedHeartbeats).toBe(2);

    watchdog.pause();
    expect(watchdog.isHealthCheckPaused).toBe(true);
    expect(watchdog.healthCheckInterval).toBeNull();

    vi.advanceTimersByTime(10_000);
    expect(watchdog.missedHeartbeats).toBe(2);
  });

  it("resume sends a handshake ping and arms a 5s fallback timeout", () => {
    const { watchdog, sentRequests } = createWatchdog({ intervalMs: 1_000 });
    watchdog.start();
    watchdog.pause();

    expect(watchdog.resume()).toBe(true);
    expect(watchdog.isWaitingForHandshake).toBe(true);
    expect(sentRequests.filter((r) => r.type === "health-check")).toHaveLength(1);

    // Fallback fires after 5s and rearmed interval starts.
    vi.advanceTimersByTime(5_000);
    expect(watchdog.isWaitingForHandshake).toBe(false);
    expect(watchdog.missedHeartbeats).toBe(0);
  });

  it("recordPong during handshake clears it and arms the normal interval", () => {
    const { watchdog } = createWatchdog({ intervalMs: 100 });
    watchdog.start();
    watchdog.pause();
    watchdog.resume();
    expect(watchdog.isWaitingForHandshake).toBe(true);

    watchdog.recordPong();

    expect(watchdog.isWaitingForHandshake).toBe(false);
    expect(watchdog.missedHeartbeats).toBe(0);
    expect(watchdog.healthCheckInterval).not.toBeNull();
  });

  it("resume returns false when host is not initialized", () => {
    const { watchdog } = createWatchdog({ intervalMs: 100, isInitialized: false });
    watchdog.pause();
    expect(watchdog.resume()).toBe(false);
    expect(watchdog.isHealthCheckPaused).toBe(false); // pause() set it; resume failure clears it
  });

  it("watchdog tick is a no-op when child is null", () => {
    const { watchdog, childRef } = createWatchdog({ intervalMs: 100 });
    watchdog.start();
    childRef.current = null;
    expect(() => vi.advanceTimersByTime(500)).not.toThrow();
    expect(watchdog.missedHeartbeats).toBe(0);
  });

  it("missing pid skips the kill but still emits crash-details", () => {
    const { watchdog, crashPayloads } = createWatchdog({
      intervalMs: 100,
      child: { pid: undefined },
    });
    const killSpy = vi
      .spyOn(process, "kill")
      .mockImplementation((() => true) as typeof process.kill);
    watchdog.start();

    vi.advanceTimersByTime(400);

    expect(crashPayloads).toHaveLength(1);
    expect(killSpy).not.toHaveBeenCalled();
  });

  it("stop clears interval and resets RTT/lastPingTime state", () => {
    const { watchdog } = createWatchdog({ intervalMs: 100 });
    watchdog.start();
    watchdog.lastPingTime = 9999;
    watchdog.rttSamples = [10, 20];
    watchdog.rttSamplesSinceLastLog = 2;
    watchdog.lastRttLogTime = 12345;

    watchdog.stop();

    expect(watchdog.healthCheckInterval).toBeNull();
    expect(watchdog.lastPingTime).toBeNull();
    expect(watchdog.rttSamples).toEqual([]);
    expect(watchdog.rttSamplesSinceLastLog).toBe(0);
    expect(watchdog.lastRttLogTime).toBe(0);
  });

  it("dispose clears interval and handshake timeout", () => {
    const { watchdog } = createWatchdog({ intervalMs: 100 });
    watchdog.start();
    watchdog.pause();
    watchdog.resume();
    expect(watchdog.handshakeTimeout).not.toBeNull();

    watchdog.dispose();

    expect(watchdog.healthCheckInterval).toBeNull();
    expect(watchdog.handshakeTimeout).toBeNull();
    expect(watchdog.isWaitingForHandshake).toBe(false);
    expect(watchdog.lastPingTime).toBeNull();
  });

  it("rttSamples buffer is capped at 20 entries", () => {
    const { watchdog } = createWatchdog({ intervalMs: 100 });
    watchdog.start();

    for (let i = 0; i < 30; i++) {
      watchdog.lastPingTime = performance.now();
      watchdog.recordPong();
    }

    expect(watchdog.rttSamples).toHaveLength(20);
  });
});
