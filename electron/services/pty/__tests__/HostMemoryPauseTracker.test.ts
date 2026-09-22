import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostMemoryPauseSnapshot } from "../../../../shared/types/pty-host.js";
import { HOST_MEMORY_STALL_MS, HostMemoryPauseTracker } from "../HostMemoryPauseTracker.js";

// ResourceGovernor timings the scenarios below replay: a 2s check tick, and a
// forced resume on the first tick past its 10s pause bound.
const TICK_MS = 2_000;
const FORCED_PAUSE_MS = 12_000;

function createTracker() {
  const changes: HostMemoryPauseSnapshot[] = [];
  const tracker = new HostMemoryPauseTracker({ onChange: (snapshot) => changes.push(snapshot) });
  return { tracker, changes };
}

function pause(tracker: HostMemoryPauseTracker, shard = "main"): void {
  tracker.recordThrottle(shard, { isThrottled: true, timestamp: Date.now() });
}

function resume(tracker: HostMemoryPauseTracker, forced: boolean, shard = "main"): void {
  tracker.recordThrottle(shard, { isThrottled: false, forced, timestamp: Date.now() });
}

function warn(tracker: HostMemoryPauseTracker, isWarning: boolean, shard = "main"): void {
  tracker.recordMemoryWarning(shard, isWarning);
}

describe("HostMemoryPauseTracker", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("opens an episode on pause and publishes the release when pressure clears", () => {
    const { tracker, changes } = createTracker();

    warn(tracker, true);
    pause(tracker);
    expect(tracker.getSnapshot()).toEqual({ active: true, paused: true, stalled: false });

    vi.advanceTimersByTime(TICK_MS * 2);
    // The governor clears the warning on the same tick an unforced resume fires.
    warn(tracker, false);
    resume(tracker, false);

    expect(changes).toEqual([
      { active: true, paused: true, stalled: false },
      { active: false, paused: false, stalled: false },
    ]);
    tracker.dispose();
  });

  it("closes the episode on an unforced resume even while the host still warns", () => {
    const { tracker } = createTracker();

    warn(tracker, true);
    pause(tracker);
    resume(tracker, false);

    expect(tracker.getSnapshot().active).toBe(false);
    tracker.dispose();
  });

  it("keeps the episode open across a forced resume while the host still warns", () => {
    const { tracker, changes } = createTracker();

    warn(tracker, true);
    pause(tracker);
    vi.advanceTimersByTime(FORCED_PAUSE_MS);
    resume(tracker, true);
    expect(tracker.getSnapshot()).toEqual({ active: true, paused: false, stalled: false });

    warn(tracker, false);
    expect(tracker.getSnapshot()).toEqual({ active: false, paused: false, stalled: false });
    expect(changes).toHaveLength(3);
    tracker.dispose();
  });

  it("closes the episode on a forced resume once the warning already cleared", () => {
    const { tracker } = createTracker();

    warn(tracker, true);
    pause(tracker);
    warn(tracker, false);
    vi.advanceTimersByTime(FORCED_PAUSE_MS);
    resume(tracker, true);

    expect(tracker.getSnapshot().active).toBe(false);
    tracker.dispose();
  });

  it("never opens an episode for a memory warning alone", () => {
    const { tracker, changes } = createTracker();

    warn(tracker, true);
    vi.advanceTimersByTime(HOST_MEMORY_STALL_MS * 2);
    warn(tracker, false);

    expect(changes).toEqual([]);
    tracker.dispose();
  });

  it("holds one episode through the critical re-pause cycle and stalls it at the bound", () => {
    const { tracker, changes } = createTracker();

    warn(tracker, true);
    pause(tracker);
    vi.advanceTimersByTime(FORCED_PAUSE_MS);
    resume(tracker, true);
    vi.advanceTimersByTime(TICK_MS);
    pause(tracker);
    vi.advanceTimersByTime(FORCED_PAUSE_MS);
    resume(tracker, true);
    vi.advanceTimersByTime(TICK_MS);
    pause(tracker);

    // Five transitions, but the episode never closed.
    expect(changes.every((snapshot) => snapshot.active)).toBe(true);
    expect(tracker.getSnapshot().stalled).toBe(false);

    // No event lands at the bound itself — the deadline publishes on its own.
    vi.advanceTimersByTime(HOST_MEMORY_STALL_MS - Date.now() - 1);
    expect(tracker.getSnapshot().stalled).toBe(false);
    vi.advanceTimersByTime(1);
    expect(changes.at(-1)).toEqual({ active: true, paused: true, stalled: true });

    vi.advanceTimersByTime(FORCED_PAUSE_MS);
    resume(tracker, true);
    expect(tracker.getSnapshot()).toEqual({ active: true, paused: false, stalled: true });

    vi.advanceTimersByTime(TICK_MS);
    warn(tracker, false);
    expect(tracker.getSnapshot()).toEqual({ active: false, paused: false, stalled: false });
    tracker.dispose();
  });

  it("stalls a forced resume that leaves the host warning, with no re-pause", () => {
    const { tracker } = createTracker();

    warn(tracker, true);
    pause(tracker);
    vi.advanceTimersByTime(FORCED_PAUSE_MS);
    resume(tracker, true);

    vi.advanceTimersByTime(HOST_MEMORY_STALL_MS - FORCED_PAUSE_MS);
    expect(tracker.getSnapshot()).toEqual({ active: true, paused: false, stalled: true });
    tracker.dispose();
  });

  it("never stalls a pause that recovers normally", () => {
    const { tracker, changes } = createTracker();

    warn(tracker, true);
    pause(tracker);
    vi.advanceTimersByTime(TICK_MS * 2);
    warn(tracker, false);
    resume(tracker, false);
    vi.advanceTimersByTime(HOST_MEMORY_STALL_MS * 2);

    expect(changes.some((snapshot) => snapshot.stalled)).toBe(false);
    expect(changes).toHaveLength(2);
    tracker.dispose();
  });

  it("does not republish an unchanged snapshot", () => {
    const { tracker, changes } = createTracker();

    pause(tracker);
    pause(tracker);
    warn(tracker, true);

    expect(changes).toHaveLength(1);
    tracker.dispose();
  });

  it("stops the stall deadline on dispose", () => {
    const { tracker, changes } = createTracker();

    warn(tracker, true);
    pause(tracker);
    tracker.dispose();
    vi.advanceTimersByTime(HOST_MEMORY_STALL_MS * 2);

    expect(changes).toHaveLength(1);
    expect(tracker.getSnapshot().active).toBe(false);
  });

  describe("across shards", () => {
    it("keeps a shard's forced-resume episode open when a sibling recovers cleanly", () => {
      const { tracker } = createTracker();

      warn(tracker, true, "a");
      pause(tracker, "a");
      warn(tracker, true, "b");
      pause(tracker, "b");
      vi.advanceTimersByTime(FORCED_PAUSE_MS);
      resume(tracker, true, "a");
      expect(tracker.getSnapshot()).toEqual({ active: true, paused: true, stalled: false });

      warn(tracker, false, "b");
      resume(tracker, false, "b");
      expect(tracker.getSnapshot()).toEqual({ active: true, paused: false, stalled: false });
      tracker.dispose();
    });

    it("does not let a sibling's warning hold open a shard whose own pressure cleared", () => {
      const { tracker } = createTracker();

      warn(tracker, true, "b");
      warn(tracker, true, "a");
      pause(tracker, "a");
      warn(tracker, false, "a");
      vi.advanceTimersByTime(FORCED_PAUSE_MS);
      resume(tracker, true, "a");

      expect(tracker.getSnapshot().active).toBe(false);
      tracker.dispose();
    });

    it("ages the stall by the oldest episode still open, not one that already closed", () => {
      const { tracker } = createTracker();

      warn(tracker, true, "a");
      pause(tracker, "a");
      vi.advanceTimersByTime(10_000);
      warn(tracker, true, "b");
      pause(tracker, "b");
      vi.advanceTimersByTime(10_000);
      warn(tracker, false, "a");
      resume(tracker, false, "a");

      vi.advanceTimersByTime(10_000);
      expect(tracker.getSnapshot()).toEqual({ active: true, paused: true, stalled: false });
      vi.advanceTimersByTime(10_000);
      expect(tracker.getSnapshot()).toEqual({ active: true, paused: true, stalled: true });
      tracker.dispose();
    });

    it("releases a departed shard's episode", () => {
      const { tracker, changes } = createTracker();

      warn(tracker, true, "a");
      pause(tracker, "a");
      tracker.dropShard("a");
      expect(tracker.getSnapshot()).toEqual({ active: false, paused: false, stalled: false });

      tracker.dropShard("never-seen");
      expect(changes).toHaveLength(2);

      vi.advanceTimersByTime(HOST_MEMORY_STALL_MS * 2);
      expect(changes).toHaveLength(2);
      tracker.dispose();
    });
  });
});
