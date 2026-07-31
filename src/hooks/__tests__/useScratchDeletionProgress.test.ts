// @vitest-environment jsdom
/**
 * useScratchDeletionProgress — the long-wait state behind the single-scratch
 * delete confirmation (#11522).
 *
 * Two clocks, both owned here: the Doherty gate that keeps a fast delete from
 * flashing anything, and the long-wait mark past which a label alone stops
 * reassuring. What these specs pin is their ORDER and their cleanup — the hook
 * deliberately narrates no backend phase, because the backend exposes no
 * boundary to narrate (see the hook's own docblock).
 */
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useScratchDeletionProgress } from "../useScratchDeletionProgress";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

/** Fire the next scheduled timer, whichever clock it belongs to. */
function advanceToNextMilestone() {
  act(() => {
    vi.advanceTimersToNextTimer();
  });
}

/**
 * Every state the hook passes through, one entry per scheduled timer plus the
 * opening frame.
 *
 * Assertions read positions out of this rather than advancing a fixed number of
 * times, so they pin ordering rather than the hook's private clock count. The
 * iteration cap is a deadlock guard: a hook that rescheduled from inside a timer
 * callback would otherwise spin here forever instead of failing.
 */
function traceMilestones(read: () => { isVisible: boolean; isStillWorking: boolean }) {
  const trace = [{ ...read() }];
  for (let i = 0; vi.getTimerCount() > 0; i++) {
    if (i >= 10) throw new Error(`timers never drained (${vi.getTimerCount()} left)`);
    advanceToNextMilestone();
    trace.push({ ...read() });
  }
  return trace;
}

describe("visibility gate", () => {
  it("stays silent until the Doherty gate clears, then shows", () => {
    const { result } = renderHook(() => useScratchDeletionProgress(true));

    // A delete that lands inside the gate must never have flashed.
    expect(result.current.isVisible).toBe(false);

    advanceToNextMilestone();

    expect(result.current.isVisible).toBe(true);
  });

  it("goes quiet again once the deletion stops", () => {
    const { result, rerender } = renderHook(
      ({ isDeleting }) => useScratchDeletionProgress(isDeleting),
      { initialProps: { isDeleting: true } }
    );

    advanceToNextMilestone();
    expect(result.current.isVisible).toBe(true);

    rerender({ isDeleting: false });

    expect(result.current.isVisible).toBe(false);
  });

  it("shows nothing at all when no deletion is running", () => {
    const { result } = renderHook(() => useScratchDeletionProgress(false));

    // Paired with the specs above: without it, a hook hardwired to `false`
    // would still look correct on the gate.
    expect(vi.getTimerCount()).toBe(0);
    expect(result.current.isVisible).toBe(false);
    expect(result.current.isStillWorking).toBe(false);
  });
});

describe("long wait", () => {
  it("raises the long-wait note only after the run is already visible", () => {
    const { result } = renderHook(() => useScratchDeletionProgress(true));

    const trace = traceMilestones(() => result.current);

    // Ordering, not timing: the note is the last milestone, so it can never be
    // the first thing the user sees.
    expect(trace[0]!.isStillWorking).toBe(false);
    expect(trace.at(-1)!.isStillWorking).toBe(true);
    expect(trace.findIndex((step) => step.isVisible)).toBeLessThan(
      trace.findIndex((step) => step.isStillWorking)
    );
  });

  it("starts a retry's clock over rather than opening on the last run's state", () => {
    const { result, rerender } = renderHook(
      ({ isDeleting }) => useScratchDeletionProgress(isDeleting),
      { initialProps: { isDeleting: true } }
    );

    traceMilestones(() => result.current);
    expect(result.current.isStillWorking).toBe(true);

    // A failure re-arms the dialog's button; the retry is a fresh run and must
    // not open already claiming it has been slow.
    rerender({ isDeleting: false });
    rerender({ isDeleting: true });

    expect(result.current.isStillWorking).toBe(false);
    expect(result.current.isVisible).toBe(false);
  });
});

describe("cleanup", () => {
  it("leaves no timer of its own running after unmount", () => {
    const baseline = vi.getTimerCount();
    const { unmount } = renderHook(() => useScratchDeletionProgress(true));

    expect(vi.getTimerCount()).toBeGreaterThan(baseline);

    unmount();

    // Measured against the pre-render baseline rather than zero, so an unrelated
    // timer from the harness can't turn this into a flake. A survivor here would
    // fire setState on an unmounted hook.
    expect(vi.getTimerCount()).toBe(baseline);
  });

  it("drops the pending milestones when the deletion resolves early", () => {
    const baseline = vi.getTimerCount();
    const { rerender } = renderHook(({ isDeleting }) => useScratchDeletionProgress(isDeleting), {
      initialProps: { isDeleting: true },
    });

    expect(vi.getTimerCount()).toBeGreaterThan(baseline);

    rerender({ isDeleting: false });

    expect(vi.getTimerCount()).toBe(baseline);
  });
});
