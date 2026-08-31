import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { FetchScheduler, type FetchSchedulerHost } from "../FetchScheduler.js";

interface MutableHost {
  isRunning: boolean;
  isCurrent: boolean;
  hasInitialStatus: boolean;
  hasFetchCallback: boolean;
  onExecuteFetch: ReturnType<typeof vi.fn>;
  onUpdate: ReturnType<typeof vi.fn>;
}

function makeHost(overrides: Partial<MutableHost> = {}): MutableHost {
  return {
    isRunning: true,
    isCurrent: true,
    hasInitialStatus: true,
    hasFetchCallback: true,
    onExecuteFetch: vi.fn().mockResolvedValue(undefined),
    onUpdate: vi.fn(),
    ...overrides,
  };
}

describe("FetchScheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("schedules an initial fetch within the 2-5s startup window", async () => {
    const host = makeHost();
    const scheduler = new FetchScheduler(host as FetchSchedulerHost);

    scheduler.schedule(true);
    await vi.advanceTimersByTimeAsync(5_001);

    expect(host.onExecuteFetch).toHaveBeenCalledTimes(1);
    expect(host.onExecuteFetch).toHaveBeenCalledWith(false, undefined);
  });

  it("uses focused cadence (~22-38s) when isCurrent is true", async () => {
    const host = makeHost({ isCurrent: true });
    const scheduler = new FetchScheduler(host as FetchSchedulerHost);

    // Pin random near max so the timer lands at ~37s, giving a comfortable
    // "not yet" window at 30s and a "fired" window at 40s.
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0.99);

    try {
      scheduler.schedule(false);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(host.onExecuteFetch).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(10_000);
      expect(host.onExecuteFetch).toHaveBeenCalledTimes(1);
    } finally {
      randomSpy.mockRestore();
    }
  });

  it("uses background cadence (~3.7-6.2min) when isCurrent is false", async () => {
    const host = makeHost({ isCurrent: false });
    const scheduler = new FetchScheduler(host as FetchSchedulerHost);

    // Pin random near max so the timer fires at ~6.2min. Two back-to-back
    // fetches would land at ~12.4min, safely outside the test's 8min window.
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0.99);

    try {
      scheduler.schedule(false);
      await vi.advanceTimersByTimeAsync(4 * 60_000);
      expect(host.onExecuteFetch).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(4 * 60_000);
      expect(host.onExecuteFetch).toHaveBeenCalledTimes(1);
    } finally {
      randomSpy.mockRestore();
    }
  });

  it("is idempotent — schedule() while a timer is armed does not stack timers", async () => {
    const host = makeHost();
    const scheduler = new FetchScheduler(host as FetchSchedulerHost);

    scheduler.schedule(true);
    scheduler.schedule(true);
    scheduler.schedule(true);

    await vi.advanceTimersByTimeAsync(6_000);
    expect(host.onExecuteFetch).toHaveBeenCalledTimes(1);
  });

  it("reschedule() clears the existing timer and re-arms with the new tier", async () => {
    const host = makeHost({ isCurrent: false });
    const scheduler = new FetchScheduler(host as FetchSchedulerHost);

    scheduler.schedule(false);
    // Background cadence is armed — would fire in 5-10 min.
    host.isCurrent = true;
    scheduler.reschedule(true);

    // After rescheduling with initial=true, the timer should fire within 5s.
    await vi.advanceTimersByTimeAsync(6_000);
    expect(host.onExecuteFetch).toHaveBeenCalledTimes(1);
  });

  it("does not schedule when host.isRunning is false", () => {
    const host = makeHost({ isRunning: false });
    const scheduler = new FetchScheduler(host as FetchSchedulerHost);

    scheduler.schedule(true);
    vi.advanceTimersByTime(10_000);

    expect(host.onExecuteFetch).not.toHaveBeenCalled();
  });

  it("does not schedule when host.hasFetchCallback is false", () => {
    const host = makeHost({ hasFetchCallback: false });
    const scheduler = new FetchScheduler(host as FetchSchedulerHost);

    scheduler.schedule(true);
    vi.advanceTimersByTime(10_000);

    expect(host.onExecuteFetch).not.toHaveBeenCalled();
  });

  it("triggerNow() invokes onExecuteFetch immediately with force=true", async () => {
    const host = makeHost();
    const scheduler = new FetchScheduler(host as FetchSchedulerHost);

    await scheduler.triggerNow();

    expect(host.onExecuteFetch).toHaveBeenCalledTimes(1);
    expect(host.onExecuteFetch).toHaveBeenCalledWith(true, undefined);
  });

  it("emits onUpdate twice per fetch — once on start, once on completion", async () => {
    const host = makeHost();
    const scheduler = new FetchScheduler(host as FetchSchedulerHost);

    await scheduler.triggerNow();

    expect(host.onUpdate).toHaveBeenCalledTimes(2);
  });

  it("skips onUpdate calls when host.hasInitialStatus is false", async () => {
    const host = makeHost({ hasInitialStatus: false });
    const scheduler = new FetchScheduler(host as FetchSchedulerHost);

    await scheduler.triggerNow();

    expect(host.onUpdate).not.toHaveBeenCalled();
  });

  it("isFetchInFlight reflects the in-flight promise", async () => {
    let resolveFetch: () => void = () => {};
    const host = makeHost({
      onExecuteFetch: vi.fn().mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            resolveFetch = resolve;
          })
      ),
    });
    const scheduler = new FetchScheduler(host as FetchSchedulerHost);

    expect(scheduler.isFetchInFlight).toBe(false);
    const triggered = scheduler.triggerNow();
    expect(scheduler.isFetchInFlight).toBe(true);

    resolveFetch();
    await triggered;
    expect(scheduler.isFetchInFlight).toBe(false);
  });

  it("defers a force fetch when a non-force fetch is in-flight, then runs forced after", async () => {
    let resolveFirst: () => void = () => {};
    let firstCallObserved = false;
    const host = makeHost({
      onExecuteFetch: vi.fn().mockImplementation((force: boolean) => {
        if (!firstCallObserved) {
          firstCallObserved = true;
          return new Promise<void>((resolve) => {
            resolveFirst = resolve;
          });
        }
        // Second call (the deferred force) — assert force=true.
        expect(force).toBe(true);
        return Promise.resolve();
      }),
    });
    const scheduler = new FetchScheduler(host as FetchSchedulerHost);

    // Kick off the first non-force fetch.
    scheduler.schedule(true);
    await vi.advanceTimersByTimeAsync(6_000);
    expect(host.onExecuteFetch).toHaveBeenCalledTimes(1);
    expect(host.onExecuteFetch).toHaveBeenCalledWith(false, undefined);

    // Trigger force while the first is in-flight — should defer.
    const forced = scheduler.triggerNow();
    expect(host.onExecuteFetch).toHaveBeenCalledTimes(1); // Still just the first

    // Resolve the first; the deferred force should now run.
    resolveFirst();
    await forced;
    expect(host.onExecuteFetch).toHaveBeenCalledTimes(2);
    expect(host.onExecuteFetch).toHaveBeenLastCalledWith(true, undefined);
  });

  it("triggerNow() while non-force fetch is in-flight does not stack a duplicate force call", async () => {
    let resolveFirst: () => void = () => {};
    let callCount = 0;
    const host = makeHost({
      onExecuteFetch: vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return new Promise<void>((resolve) => {
            resolveFirst = resolve;
          });
        }
        return Promise.resolve();
      }),
    });
    const scheduler = new FetchScheduler(host as FetchSchedulerHost);

    // First fetch (non-force) goes in-flight via the scheduled timer.
    scheduler.schedule(true);
    await vi.advanceTimersByTimeAsync(6_000);
    expect(host.onExecuteFetch).toHaveBeenCalledTimes(1);
    expect(host.onExecuteFetch).toHaveBeenCalledWith(false, undefined);

    // While in-flight, a second triggerNow defers (sets _pendingForceFetch).
    const forced = scheduler.triggerNow();
    // Synchronously, we still see only one call — defer hasn't fired.
    expect(host.onExecuteFetch).toHaveBeenCalledTimes(1);

    resolveFirst();
    await forced;
    // Now the deferred force ran exactly once after the first completed.
    expect(host.onExecuteFetch).toHaveBeenCalledTimes(2);
    expect(host.onExecuteFetch).toHaveBeenLastCalledWith(true, undefined);
  });

  it("threads prune through triggerNow to the host", async () => {
    const host = makeHost();
    const scheduler = new FetchScheduler(host as FetchSchedulerHost);

    await scheduler.triggerNow(false);

    expect(host.onExecuteFetch).toHaveBeenCalledWith(true, false);
  });

  it("resolves triggerNow with the result of the fetch it queued, not the in-flight one", async () => {
    // A bare pending flag resolved the caller off the ALREADY-RUNNING fetch, so
    // a user-triggered "Fetch" reported the previous fetch's outcome (#12091).
    let resolveFirst: () => void = () => {};
    let callCount = 0;
    const host = makeHost({
      onExecuteFetch: vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return new Promise<void>((resolve) => {
            resolveFirst = () => resolve();
          }).then(() => ({ status: "skipped" as const }));
        }
        return Promise.resolve({ status: "success" as const, remote: "origin" });
      }),
    });
    const scheduler = new FetchScheduler(host as FetchSchedulerHost);

    scheduler.schedule(true);
    await vi.advanceTimersByTimeAsync(6_000);

    const forced = scheduler.triggerNow(true);
    resolveFirst();

    await expect(forced).resolves.toEqual({ status: "success", remote: "origin" });
  });

  it("coalesces queued force requests and keeps the pruning one", async () => {
    // Two clicks land while a fetch is in flight. They share one deferred run,
    // and "Fetch and prune" must not be satisfied by a queued plain "Fetch".
    let resolveFirst: () => void = () => {};
    let callCount = 0;
    const host = makeHost({
      onExecuteFetch: vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return new Promise<void>((resolve) => {
            resolveFirst = resolve;
          });
        }
        return Promise.resolve();
      }),
    });
    const scheduler = new FetchScheduler(host as FetchSchedulerHost);

    scheduler.schedule(true);
    await vi.advanceTimersByTimeAsync(6_000);

    const plain = scheduler.triggerNow(false);
    const pruning = scheduler.triggerNow(true);

    resolveFirst();
    await Promise.all([plain, pruning]);

    expect(host.onExecuteFetch).toHaveBeenCalledTimes(2);
    expect(host.onExecuteFetch).toHaveBeenLastCalledWith(true, true);
  });

  it("settles a queued force request even when the scheduler stops first", async () => {
    // A stranded promise would leave the renderer's action hanging forever.
    let resolveFirst: () => void = () => {};
    let callCount = 0;
    const host = makeHost({
      onExecuteFetch: vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return new Promise<void>((resolve) => {
            resolveFirst = resolve;
          });
        }
        return Promise.resolve();
      }),
    });
    const scheduler = new FetchScheduler(host as FetchSchedulerHost);

    scheduler.schedule(true);
    await vi.advanceTimersByTimeAsync(6_000);

    const forced = scheduler.triggerNow(true);
    host.isRunning = false;
    resolveFirst();

    await expect(forced).resolves.toBeUndefined();
    expect(host.onExecuteFetch).toHaveBeenCalledTimes(1);
  });

  it("does not execute fetch when host is not running", async () => {
    const host = makeHost();
    const scheduler = new FetchScheduler(host as FetchSchedulerHost);

    host.isRunning = false;
    scheduler.schedule(true);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(host.onExecuteFetch).not.toHaveBeenCalled();
  });

  it("does not reschedule after completion when host is not running", async () => {
    const host = makeHost();
    const scheduler = new FetchScheduler(host as FetchSchedulerHost);

    const triggered = scheduler.triggerNow();
    host.isRunning = false;
    await triggered;

    // After completion with isRunning false, no new timer should be armed.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(host.onExecuteFetch).toHaveBeenCalledTimes(1);
  });

  it("after a completed fetch, automatically schedules the next round", async () => {
    const host = makeHost({ isCurrent: true });
    const scheduler = new FetchScheduler(host as FetchSchedulerHost);

    // Pin random so the 2nd fetch lands inside the advance window and a 3rd
    // can't: low rolls put min cumulative time at 2 + 22.5 + 22.5 = 47s ≤ 52s.
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0.5);

    try {
      // Initial fetch runs at 2-5s.
      scheduler.schedule(true);
      await vi.advanceTimersByTimeAsync(6_000);
      expect(host.onExecuteFetch).toHaveBeenCalledTimes(1);

      // After completion, the next focused-tier fetch should be scheduled.
      await vi.advanceTimersByTimeAsync(46_000);
      expect(host.onExecuteFetch).toHaveBeenCalledTimes(2);
    } finally {
      randomSpy.mockRestore();
    }
  });

  it("recovers from a rejected onExecuteFetch — emits update + reschedules", async () => {
    const host = makeHost({
      onExecuteFetch: vi.fn().mockRejectedValue(new Error("network down")),
    });
    const scheduler = new FetchScheduler(host as FetchSchedulerHost);

    // Pin random so the rescheduled focused-tier fetch lands at exactly 30s
    // (mid jitter window 22.5-37.5s) and a 3rd can't fire inside the 46s
    // advance: next reschedule would be at 30 + 30 = 60s > 46s.
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0.5);

    try {
      await scheduler.triggerNow();
      // Two update emits: in-flight start, and post-completion.
      expect(host.onUpdate).toHaveBeenCalledTimes(2);
      // No throw escapes — failure is swallowed.

      // After the rejected fetch resolves, the next-cadence timer is armed.
      // (Focused tier 22.5-37.5s; pinned to 30s.)
      await vi.advanceTimersByTimeAsync(46_000);
      expect(host.onExecuteFetch).toHaveBeenCalledTimes(2);
    } finally {
      randomSpy.mockRestore();
    }
  });

  it("clearTimer() cancels an armed timer without disposing", async () => {
    const host = makeHost();
    const scheduler = new FetchScheduler(host as FetchSchedulerHost);

    scheduler.schedule(true);
    scheduler.clearTimer();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(host.onExecuteFetch).not.toHaveBeenCalled();

    // Still able to reschedule afterwards.
    scheduler.schedule(true);
    await vi.advanceTimersByTimeAsync(6_000);
    expect(host.onExecuteFetch).toHaveBeenCalledTimes(1);
  });
});
