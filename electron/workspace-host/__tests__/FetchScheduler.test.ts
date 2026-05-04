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
    expect(host.onExecuteFetch).toHaveBeenCalledWith(false);
  });

  it("uses focused cadence (30-45s) when isCurrent is true", async () => {
    const host = makeHost({ isCurrent: true });
    const scheduler = new FetchScheduler(host as FetchSchedulerHost);

    scheduler.schedule(false);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(host.onExecuteFetch).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(15_002);
    expect(host.onExecuteFetch).toHaveBeenCalledTimes(1);
  });

  it("uses background cadence (5-10min) when isCurrent is false", async () => {
    const host = makeHost({ isCurrent: false });
    const scheduler = new FetchScheduler(host as FetchSchedulerHost);

    scheduler.schedule(false);
    await vi.advanceTimersByTimeAsync(4 * 60_000);
    expect(host.onExecuteFetch).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(7 * 60_000);
    expect(host.onExecuteFetch).toHaveBeenCalledTimes(1);
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
    expect(host.onExecuteFetch).toHaveBeenCalledWith(true);
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
    expect(host.onExecuteFetch).toHaveBeenCalledWith(false);

    // Trigger force while the first is in-flight — should defer.
    const forced = scheduler.triggerNow();
    expect(host.onExecuteFetch).toHaveBeenCalledTimes(1); // Still just the first

    // Resolve the first; the deferred force should now run.
    resolveFirst();
    await forced;
    expect(host.onExecuteFetch).toHaveBeenCalledTimes(2);
    expect(host.onExecuteFetch).toHaveBeenLastCalledWith(true);
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
    expect(host.onExecuteFetch).toHaveBeenCalledWith(false);

    // While in-flight, a second triggerNow defers (sets _pendingForceFetch).
    const forced = scheduler.triggerNow();
    // Synchronously, we still see only one call — defer hasn't fired.
    expect(host.onExecuteFetch).toHaveBeenCalledTimes(1);

    resolveFirst();
    await forced;
    // Now the deferred force ran exactly once after the first completed.
    expect(host.onExecuteFetch).toHaveBeenCalledTimes(2);
    expect(host.onExecuteFetch).toHaveBeenLastCalledWith(true);
  });

  it("dispose() prevents further fetches even if a timer fires", async () => {
    const host = makeHost();
    const scheduler = new FetchScheduler(host as FetchSchedulerHost);

    scheduler.schedule(true);
    scheduler.dispose();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(host.onExecuteFetch).not.toHaveBeenCalled();
  });

  it("dispose() prevents post-completion rescheduling", async () => {
    const host = makeHost();
    const scheduler = new FetchScheduler(host as FetchSchedulerHost);

    const triggered = scheduler.triggerNow();
    scheduler.dispose();
    await triggered;

    // After completion + dispose, no new timer should be armed.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(host.onExecuteFetch).toHaveBeenCalledTimes(1);
  });

  it("after a completed fetch, automatically schedules the next round", async () => {
    const host = makeHost({ isCurrent: true });
    const scheduler = new FetchScheduler(host as FetchSchedulerHost);

    // Initial fetch runs at 2-5s.
    scheduler.schedule(true);
    await vi.advanceTimersByTimeAsync(6_000);
    expect(host.onExecuteFetch).toHaveBeenCalledTimes(1);

    // After completion, the next focused-tier fetch should be scheduled.
    await vi.advanceTimersByTimeAsync(46_000);
    expect(host.onExecuteFetch).toHaveBeenCalledTimes(2);
  });

  it("recovers from a rejected onExecuteFetch — emits update + reschedules", async () => {
    const host = makeHost({
      onExecuteFetch: vi.fn().mockRejectedValue(new Error("network down")),
    });
    const scheduler = new FetchScheduler(host as FetchSchedulerHost);

    await scheduler.triggerNow();
    // Two update emits: in-flight start, and post-completion.
    expect(host.onUpdate).toHaveBeenCalledTimes(2);
    // No throw escapes — failure is swallowed.

    // After the rejected fetch resolves, the next-cadence timer is armed.
    // (Focused tier 30-45s.)
    await vi.advanceTimersByTimeAsync(46_000);
    expect(host.onExecuteFetch).toHaveBeenCalledTimes(2);
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
