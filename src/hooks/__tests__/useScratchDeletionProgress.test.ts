// @vitest-environment jsdom
/**
 * useScratchDeletionProgress — the phase narration behind the single-scratch
 * delete confirmation (#11522).
 *
 * Main runs the delete as two opaque awaits, so the phase is inferred from
 * elapsed time. What matters is the ORDER of the milestones and which of them
 * apply to a given target — never the constants themselves, which is why every
 * assertion advances to the next scheduled timer rather than restating 4000/5000.
 */
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SCRATCH_DELETION_PHASES, useScratchDeletionProgress } from "../useScratchDeletionProgress";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

/** Fire the next scheduled timer, whichever milestone it belongs to. */
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
 * times: the hook owns three clocks (the Doherty gate plus two milestones) and a
 * spec that counted advances would be pinned to that arrangement instead of to
 * the ordering it actually cares about.
 */
function traceMilestones(read: () => { phase: string; isStillWorking: boolean }) {
  const trace = [{ ...read() }];
  while (vi.getTimerCount() > 0) {
    advanceToNextMilestone();
    trace.push({ ...read() });
  }
  return trace;
}

describe("visibility gate", () => {
  it("stays silent until the Doherty gate clears, then narrates", () => {
    const { result } = renderHook(() => useScratchDeletionProgress(true, true));

    // A delete that lands inside the gate must never have flashed a phase.
    expect(result.current.isVisible).toBe(false);

    advanceToNextMilestone();

    expect(result.current.isVisible).toBe(true);
  });

  it("keeps naming a phase even while the gate hides it", () => {
    const { result } = renderHook(() => useScratchDeletionProgress(true, true));

    // The label is state truth and exists from the first frame; only its
    // painting is gated. Reading the gate as "no phase yet" is the #10083 trap.
    expect(result.current.phase).toBe(SCRATCH_DELETION_PHASES.terminals);
    expect(result.current.isVisible).toBe(false);
  });

  it("goes quiet again once the deletion stops", () => {
    const { result, rerender } = renderHook(
      ({ isDeleting }) => useScratchDeletionProgress(isDeleting, true),
      { initialProps: { isDeleting: true } }
    );

    advanceToNextMilestone();
    expect(result.current.isVisible).toBe(true);

    rerender({ isDeleting: false });

    expect(result.current.isVisible).toBe(false);
  });
});

describe("phase ordering", () => {
  it("names the terminal phase first, then the folder phase", () => {
    const { result } = renderHook(() => useScratchDeletionProgress(true, true));

    const phases = traceMilestones(() => result.current).map((step) => step.phase);

    // The terminal phase leads and is left exactly once — a run that flipped
    // back would be reporting a boundary the backend never crosses twice.
    expect(phases[0]).toBe(SCRATCH_DELETION_PHASES.terminals);
    expect(phases.at(-1)).toBe(SCRATCH_DELETION_PHASES.folder);
    expect(phases.lastIndexOf(SCRATCH_DELETION_PHASES.terminals)).toBeLessThan(
      phases.indexOf(SCRATCH_DELETION_PHASES.folder)
    );
  });

  it("skips the terminal phase for a scratch with nothing running", () => {
    const { result } = renderHook(() => useScratchDeletionProgress(true, false));

    // Main awaits the teardown either way, but with no processes it returns at
    // once — claiming otherwise would misreport the wait on the common path.
    const phases = traceMilestones(() => result.current).map((step) => step.phase);

    expect(phases).not.toContain(SCRATCH_DELETION_PHASES.terminals);
    expect(new Set(phases)).toEqual(new Set([SCRATCH_DELETION_PHASES.folder]));
  });

  it("raises the long-wait note only after the phase has already moved on", () => {
    const { result } = renderHook(() => useScratchDeletionProgress(true, true));

    const trace = traceMilestones(() => result.current);

    // Ordering, not timing: the note is the last milestone, so it can never be
    // the thing that first replaces a phase label.
    expect(trace[0]!.isStillWorking).toBe(false);
    expect(trace.at(-1)!.isStillWorking).toBe(true);
    expect(trace.findIndex((step) => step.phase === SCRATCH_DELETION_PHASES.folder)).toBeLessThan(
      trace.findIndex((step) => step.isStillWorking)
    );
  });
});

describe("retry", () => {
  it("narrates a second attempt from the first phase again", () => {
    const { result, rerender } = renderHook(
      ({ isDeleting }) => useScratchDeletionProgress(isDeleting, true),
      { initialProps: { isDeleting: true } }
    );

    traceMilestones(() => result.current);
    expect(result.current.phase).toBe(SCRATCH_DELETION_PHASES.folder);
    expect(result.current.isStillWorking).toBe(true);

    // A failure re-arms the dialog's button; the retry is a fresh run and must
    // not open on the previous run's last phase.
    rerender({ isDeleting: false });
    rerender({ isDeleting: true });

    expect(result.current.phase).toBe(SCRATCH_DELETION_PHASES.terminals);
    expect(result.current.isStillWorking).toBe(false);
  });
});

describe("cleanup", () => {
  it("leaves no timer running after unmount", () => {
    const { unmount } = renderHook(() => useScratchDeletionProgress(true, true));

    expect(vi.getTimerCount()).toBeGreaterThan(0);

    unmount();

    // Measured against zero rather than a delta: a surviving timeout would fire
    // setState on an unmounted hook.
    expect(vi.getTimerCount()).toBe(0);
  });

  it("drops the pending milestones when the deletion resolves early", () => {
    const { rerender } = renderHook(
      ({ isDeleting }) => useScratchDeletionProgress(isDeleting, true),
      { initialProps: { isDeleting: true } }
    );

    expect(vi.getTimerCount()).toBeGreaterThan(0);

    rerender({ isDeleting: false });

    expect(vi.getTimerCount()).toBe(0);
  });
});
