import { describe, expect, it, vi } from "vitest";

vi.mock("../ProjectStore.js", () => ({
  projectStore: {
    addProject: vi.fn(),
    removeProject: vi.fn(),
  },
}));

// The harness imports the purge delay from the lifecycle controller so the two
// can't drift. The controller reaches `electron` at module scope, which a unit
// test has no business booting — and every budget assertion below passes its own
// delay explicitly, so the value here is never the thing under test.
vi.mock("../../window/ProjectViewLifecycleController.js", () => ({
  CACHED_VIEW_PURGE_DELAY_MS: 20_000,
}));

const {
  evaluateFreezeMeasurement,
  evaluatePurgeBudget,
  longestStall,
  sumTicksInWindow,
  MIN_CONTROL_TICKS,
  MIN_FREEZE_RATIO,
} = await import("../freezeHarness.js");

const BUCKET_MS = 10;

/** Ticks laid down at a flat rate across [startMs, endMs). */
function evenBuckets(startMs: number, endMs: number, perBucket: number): [number, number][] {
  const buckets: [number, number][] = [];
  for (let t = startMs; t < endMs; t += BUCKET_MS) {
    buckets.push([Math.floor(t / BUCKET_MS), perBucket]);
  }
  return buckets;
}

describe("sumTicksInWindow", () => {
  it("counts a window that lines up exactly with bucket edges", () => {
    const buckets = evenBuckets(1000, 2000, 5);
    expect(sumTicksInWindow(buckets, 1000, 2000, "contained", BUCKET_MS)).toBe(500);
  });

  it("excludes buckets outside the window", () => {
    const buckets = evenBuckets(0, 3000, 5);
    expect(sumTicksInWindow(buckets, 1000, 2000, "contained", BUCKET_MS)).toBe(500);
  });

  it("deflates in contained mode and inflates in overlapping mode at a straddled edge", () => {
    // One bucket covering [1000,1010) with the window starting mid-bucket.
    const buckets: [number, number][] = [[100, 7]];
    expect(sumTicksInWindow(buckets, 1005, 2000, "contained", BUCKET_MS)).toBe(0);
    expect(sumTicksInWindow(buckets, 1005, 2000, "overlapping", BUCKET_MS)).toBe(7);
  });

  it("keeps quantisation biased against passing", () => {
    // The asymmetry is the point: a straddling bucket must never deflate the
    // frozen leg (overlapping) nor inflate the control leg (contained), so
    // rounding can only push the ratio down.
    const straddling: [number, number][] = [[99, 9]];
    const frozen = sumTicksInWindow(straddling, 995, 1995, "overlapping", BUCKET_MS);
    const control = sumTicksInWindow(straddling, 995, 1995, "contained", BUCKET_MS);
    expect(frozen).toBeGreaterThanOrEqual(control);
  });

  it("returns zero for an empty timeline", () => {
    expect(sumTicksInWindow([], 0, 1000, "contained", BUCKET_MS)).toBe(0);
  });
});

describe("longestStall", () => {
  it("finds the gap and its bounds", () => {
    // Live at bucket 10 and bucket 20 → gap covers [110, 200).
    const buckets: [number, number][] = [
      [10, 5],
      [20, 5],
    ];
    expect(longestStall(buckets, BUCKET_MS)).toEqual({
      startMs: 110,
      endMs: 200,
      durationMs: 90,
    });
  });

  it("reports no stall for a contiguous timeline", () => {
    expect(longestStall(evenBuckets(0, 500, 3), BUCKET_MS).durationMs).toBe(0);
  });

  it("reports no stall when fewer than two live buckets exist", () => {
    expect(longestStall([[7, 1]], BUCKET_MS).durationMs).toBe(0);
    expect(longestStall([], BUCKET_MS).durationMs).toBe(0);
  });

  it("ignores buckets recorded with a zero count", () => {
    const buckets: [number, number][] = [
      [10, 5],
      [15, 0],
      [20, 5],
    ];
    expect(longestStall(buckets, BUCKET_MS).durationMs).toBe(90);
  });
});

describe("evaluateFreezeMeasurement", () => {
  it("passes on a real working-freeze measurement", () => {
    // Observed on macOS, Electron 42: freeze stops the renderer dead.
    const verdict = evaluateFreezeMeasurement({
      controlTicks: 54224,
      frozenTicks: 0,
      recoveredTicks: 52533,
    });
    expect(verdict.passed).toBe(true);
    expect(verdict.failures).toEqual([]);
    expect(verdict.freezeRatio).toBeGreaterThan(MIN_FREEZE_RATIO);
  });

  it("fails when freeze does not stop the renderer", () => {
    // Observed with freezeWebContents neutered: the legs are indistinguishable.
    const verdict = evaluateFreezeMeasurement({
      controlTicks: 54026,
      frozenTicks: 53875,
      recoveredTicks: 53495,
    });
    expect(verdict.passed).toBe(false);
    expect(verdict.freezeRatio).toBeCloseTo(1, 1);
    expect(verdict.failures.join("\n")).toContain("freeze did not stop the renderer");
  });

  it("fails when the positive control is dead, rather than reporting a vacuous ratio", () => {
    const verdict = evaluateFreezeMeasurement({
      controlTicks: 0,
      frozenTicks: 0,
      recoveredTicks: 0,
    });
    expect(verdict.passed).toBe(false);
    expect(verdict.failures.join("\n")).toContain("positive control is not alive");
  });

  it("fails when the view never resumes, so a dead view cannot masquerade as a frozen one", () => {
    const verdict = evaluateFreezeMeasurement({
      controlTicks: 54000,
      frozenTicks: 0,
      recoveredTicks: 0,
    });
    expect(verdict.passed).toBe(false);
    const message = verdict.failures.join("\n");
    expect(message).toContain("did not resume at a comparable rate");
  });

  it("fails when the view resumes at only a trickle", () => {
    const verdict = evaluateFreezeMeasurement({
      controlTicks: 54000,
      frozenTicks: 0,
      recoveredTicks: 100,
    });
    expect(verdict.passed).toBe(false);
    expect(verdict.failures.join("\n")).toContain("did not resume at a comparable rate");
  });

  it("does not let a zero frozen count divide by zero", () => {
    const verdict = evaluateFreezeMeasurement({
      controlTicks: 5000,
      frozenTicks: 0,
      recoveredTicks: 5000,
    });
    expect(Number.isFinite(verdict.freezeRatio)).toBe(true);
    expect(verdict.freezeRatio).toBe(5000);
  });

  it("holds the line exactly at the ratio threshold", () => {
    const atThreshold = evaluateFreezeMeasurement({
      controlTicks: MIN_FREEZE_RATIO * 10,
      frozenTicks: 10,
      recoveredTicks: MIN_FREEZE_RATIO * 10,
    });
    expect(atThreshold.freezeRatio).toBe(MIN_FREEZE_RATIO);
    expect(atThreshold.passed).toBe(true);

    const justUnder = evaluateFreezeMeasurement({
      controlTicks: MIN_FREEZE_RATIO * 10 - 10,
      frozenTicks: 10,
      recoveredTicks: MIN_FREEZE_RATIO * 10,
    });
    expect(justUnder.passed).toBe(false);
  });

  it("treats a control just under the liveness floor as not alive", () => {
    const verdict = evaluateFreezeMeasurement({
      controlTicks: MIN_CONTROL_TICKS - 1,
      frozenTicks: 0,
      recoveredTicks: MIN_CONTROL_TICKS - 1,
    });
    expect(verdict.passed).toBe(false);
    expect(verdict.failures.join("\n")).toContain("positive control is not alive");
  });
});

describe("evaluatePurgeBudget", () => {
  const base = { elapsedSinceCachedMs: 2_000, measureWindowMs: 3_000, purgeDelayMs: 20_000 };

  it("scales the remaining schedule by three windows, one per measurement leg", () => {
    // The three legs are the only window-width terms; the settles and the guard
    // are fixed. So a delta in window width must show up exactly three times.
    const narrow = evaluatePurgeBudget({ ...base, measureWindowMs: 1_000 });
    const wide = evaluatePurgeBudget({ ...base, measureWindowMs: 1_500 });
    expect(wide.plannedRemainingMs - narrow.plannedRemainingMs).toBe(3 * 500);
  });

  it("charges setup time against the same deadline, one ms for one ms", () => {
    const early = evaluatePurgeBudget(base);
    const late = evaluatePurgeBudget({ ...base, elapsedSinceCachedMs: 2_000 + 750 });
    expect(early.headroomMs - late.headroomMs).toBe(750);
    // The schedule ahead is unchanged — only where it lands moved.
    expect(late.plannedRemainingMs).toBe(early.plannedRemainingMs);
  });

  it("subtracts the guard from the purge delay rather than spending it", () => {
    const guarded = evaluatePurgeBudget({ ...base, guardMs: 1_000 });
    const unguarded = evaluatePurgeBudget({ ...base, guardMs: 0 });
    expect(unguarded.deadlineMs - guarded.deadlineMs).toBe(1_000);
    expect(guarded.headroomMs).toBe(unguarded.headroomMs - 1_000);
  });

  it("flips at the boundary its own headroom identifies", () => {
    const fitting = evaluatePurgeBudget(base);
    expect(fitting.fits).toBe(true);

    // Consume exactly the reported headroom: still fits, with nothing to spare.
    const exact = evaluatePurgeBudget({
      ...base,
      elapsedSinceCachedMs: base.elapsedSinceCachedMs + fitting.headroomMs,
    });
    expect(exact.headroomMs).toBe(0);
    expect(exact.fits).toBe(true);

    // One millisecond past it does not.
    const over = evaluatePurgeBudget({
      ...base,
      elapsedSinceCachedMs: base.elapsedSinceCachedMs + fitting.headroomMs + 1,
    });
    expect(over.fits).toBe(false);
  });

  it("rejects a window override large enough to outlast the purge", () => {
    // The failure this guard exists for: DAINTREE_FREEZE_HARNESS_WINDOW_MS is
    // free-form, and a wide window pushes the recovery leg past the purge.
    const wide = evaluatePurgeBudget({ ...base, measureWindowMs: 5_000 });
    expect(wide.fits).toBe(false);
    expect(wide.plannedFinishMs).toBeGreaterThan(wide.deadlineMs);
  });

  it("reports a finish that is the elapsed time plus everything still scheduled", () => {
    const budget = evaluatePurgeBudget(base);
    expect(budget.plannedFinishMs).toBe(base.elapsedSinceCachedMs + budget.plannedRemainingMs);
    expect(budget.headroomMs).toBe(budget.deadlineMs - budget.plannedFinishMs);
  });
});
