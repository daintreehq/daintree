import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  DEMO_SPRING_FIXED_DT,
  DEMO_SPRING_MAX_FRAME_DT,
  DEMO_SPRING_SETTLE_ERROR,
  DEMO_SPRING_SETTLE_VELOCITY,
  accumulateSpring,
  isSpringSettled,
  runSpringLoop,
  stepSpring,
  type DemoSpringAxisState,
} from "../demoSpring";

const atRest = (current: number): DemoSpringAxisState => ({ current, velocity: 0 });

/** Drive a single axis to rest by feeding fixed-size frames; return the trace. */
function simulate(
  start: number,
  target: number,
  frameDt: number,
  maxFrames = 100_000
): { final: DemoSpringAxisState; maxOvershoot: number; frames: number; settled: boolean } {
  let axes = { v: atRest(start) };
  const targets = { v: target };
  let accumulator = 0;
  let maxOvershoot = 0;
  let frames = 0;
  let settled = false;
  for (; frames < maxFrames; frames++) {
    const r = accumulateSpring(axes, targets, frameDt, accumulator);
    axes = r.axes;
    accumulator = r.accumulator;
    // overshoot = how far past the target we travelled (0 if monotonic from below)
    maxOvershoot = Math.max(maxOvershoot, axes.v.current - target);
    if (r.settled) {
      settled = true;
      frames++;
      break;
    }
  }
  return { final: axes.v, maxOvershoot, frames, settled };
}

describe("stepSpring", () => {
  it("is pure — does not mutate its input state", () => {
    const state = { current: 10, velocity: 5 };
    stepSpring(state, 100, 0.016);
    expect(state).toEqual({ current: 10, velocity: 5 });
  });

  it("is deterministic for identical inputs", () => {
    const a = stepSpring({ current: 0, velocity: 0 }, 100, 0.016);
    const b = stepSpring({ current: 0, velocity: 0 }, 100, 0.016);
    expect(a).toEqual(b);
  });

  it("accelerates toward the target from rest", () => {
    const next = stepSpring(atRest(0), 100, DEMO_SPRING_FIXED_DT);
    // force is positive (target above current) → velocity and position both rise
    expect(next.velocity).toBeGreaterThan(0);
    expect(next.current).toBeGreaterThan(0);
    expect(next.current).toBeLessThan(100);
  });
});

describe("isSpringSettled", () => {
  it("is settled only when both velocity and position error are within threshold", () => {
    expect(isSpringSettled({ current: 100, velocity: 0 }, 100)).toBe(true);
    // position close but still moving fast → not settled
    expect(isSpringSettled({ current: 100, velocity: DEMO_SPRING_SETTLE_VELOCITY + 1 }, 100)).toBe(
      false
    );
    // at rest but far from target → not settled
    expect(
      isSpringSettled({ current: 100 - (DEMO_SPRING_SETTLE_ERROR + 1), velocity: 0 }, 100)
    ).toBe(false);
  });
});

describe("accumulateSpring convergence", () => {
  it("converges to the target and reports settled", () => {
    const { final, settled } = simulate(0, 100, 1 / 60);
    expect(settled).toBe(true);
    expect(Math.abs(final.current - 100)).toBeLessThan(DEMO_SPRING_SETTLE_ERROR);
    expect(Math.abs(final.velocity)).toBeLessThan(DEMO_SPRING_SETTLE_VELOCITY);
  });

  it("does not overshoot the target (overdamped)", () => {
    const { maxOvershoot } = simulate(0, 100, 1 / 60);
    // a sliver of tolerance for floating-point dust; a real overshoot would be many px
    expect(maxOvershoot).toBeLessThan(0.5);
  });

  it("leaves the input axes untouched (returns fresh state)", () => {
    const axes = { v: atRest(0) };
    accumulateSpring(axes, { v: 100 }, 1 / 60, 0);
    expect(axes.v).toEqual({ current: 0, velocity: 0 });
  });
});

describe("frame-rate independence (the regression guard for #10136)", () => {
  // The bug: clamping per-step dt couples simulated time to frame rate, so a
  // glide recorded below ~31fps runs in slow motion. With the accumulator the
  // same total wall-clock must produce the same physical state regardless of how
  // that time is chunked into frames.
  function stateAfter(totalSeconds: number, frameDt: number): DemoSpringAxisState {
    let axes = { v: atRest(0) };
    const targets = { v: 1000 };
    let accumulator = 0;
    // Feed exactly `totalSeconds` of wall-clock in `frameDt` chunks; the final
    // chunk is partial so every frame rate consumes the same total time (a plain
    // round(total/frameDt) underfeeds when the frame count isn't an integer).
    let elapsed = 0;
    while (elapsed < totalSeconds - 1e-9) {
      const dt = Math.min(frameDt, totalSeconds - elapsed);
      const r = accumulateSpring(axes, targets, dt, accumulator);
      axes = r.axes;
      accumulator = r.accumulator;
      elapsed += dt;
    }
    return axes.v;
  }

  it("reaches the same position at 120fps, 60fps and 20fps for equal wall-clock", () => {
    const SECONDS = 0.25; // mid-flight, before settle, where divergence would show
    const fast = stateAfter(SECONDS, 1 / 120);
    const mid = stateAfter(SECONDS, 1 / 60);
    const slow = stateAfter(SECONDS, 1 / 20); // ~31fps-style starvation under 4K capture

    expect(Math.abs(fast.current - mid.current)).toBeLessThan(1);
    expect(Math.abs(fast.current - slow.current)).toBeLessThan(1);
    // and the same total simulated time was consumed in every case
    expect(Math.abs(fast.velocity - slow.velocity)).toBeLessThan(5);
  });

  it("a low frame rate is not slower than a high one (no slow-motion)", () => {
    const SECONDS = 0.15;
    const fast = stateAfter(SECONDS, 1 / 120).current;
    const slow = stateAfter(SECONDS, 1 / 20).current;
    // slow-motion bug would make `slow` lag well behind `fast`; they must match
    expect(slow).toBeGreaterThan(fast - 1);
  });

  it("matches the reference at non-divisor frame rates (not just 1/120 multiples)", () => {
    // 120/60/20 are exact multiples of the sub-step; an impl that resets the
    // accumulator each frame could still pass those. These rates leave a varying
    // remainder every frame, so only correct carry survives.
    //
    // Measured near settle (1.0s): mid-flight the comparison is dominated by the
    // sub-step leftover slop (≈ velocity × FIXED_DT, ~16px at peak speed), which
    // is inherent and frame-rate-dependent. Near settle the velocity is low, so a
    // tight 2px bound still proves equivalence — an accumulator-reset bug would
    // drift hundreds of px over the ~90-144 frames here.
    const ref = stateAfter(1.0, 1 / 120).current;
    for (const fps of [90, 144, 75, 29.97]) {
      const observed = stateAfter(1.0, 1 / fps).current;
      expect(Math.abs(observed - ref)).toBeLessThan(2);
    }
  });

  it("matches the reference under irregular frame pacing (carry correctness)", () => {
    const ref = stateAfter(1.0, 1 / 120).current;
    // jittery deltas (each below the spiral-of-death cap) summing to 0.25s,
    // repeated to reach the same 1.0s wall-clock as the reference.
    const base = [0.01, 0.022, 0.007, 0.031, 0.016, 0.04, 0.009, 0.025, 0.013, 0.034, 0.018, 0.025];
    const deltas = [...base, ...base, ...base, ...base];
    let axes = { v: atRest(0) };
    let accumulator = 0;
    for (const d of deltas) {
      const r = accumulateSpring(axes, { v: 1000 }, d, accumulator);
      axes = r.axes;
      accumulator = r.accumulator;
    }
    expect(Math.abs(axes.v.current - ref)).toBeLessThan(2);
  });
});

describe("spiral-of-death guard", () => {
  it("caps a huge frame gap at MAX_FRAME_DT worth of catch-up", () => {
    const axes = { v: atRest(0) };
    const targets = { v: 1000 };
    // a 10-second stall and a single capped frame must advance identically
    const huge = accumulateSpring(axes, targets, 10, 0);
    const capped = accumulateSpring(axes, targets, DEMO_SPRING_MAX_FRAME_DT, 0);
    expect(huge.axes.v).toEqual(capped.axes.v);
    expect(huge.accumulator).toBeCloseTo(capped.accumulator, 10);
  });

  it("does not teleport to the target in a single post-stall frame", () => {
    // one absurd 100s frame must not settle or jump to the target — the cap means
    // only ~7 sub-steps run, so the cutout stays far from the destination.
    const r = accumulateSpring({ v: atRest(0) }, { v: 1000 }, 100, 0);
    expect(r.settled).toBe(false);
    expect(r.axes.v.current).toBeLessThan(1000);
  });
});

describe("multi-axis lock-step", () => {
  it("advances every axis with the same sub-step schedule", () => {
    // two axes with identical dynamics must stay identical frame to frame
    let axes = { x: atRest(0), y: atRest(0) };
    const targets = { x: 100, y: 100 };
    let accumulator = 0;
    for (let i = 0; i < 30; i++) {
      const r = accumulateSpring(axes, targets, 1 / 45, accumulator);
      axes = r.axes;
      accumulator = r.accumulator;
    }
    expect(axes.x).toEqual(axes.y);
  });
});

describe("runSpringLoop orchestration", () => {
  // Manual rAF driver: runSpringLoop schedules one frame at a time and reads
  // performance.now() / requestAnimationFrame from globals at call time, so we
  // can drive it deterministically without fake timers.
  let now = 0;
  let pending: FrameRequestCallback | null = null;

  function tick(deltaMs: number) {
    now += deltaMs;
    const cb = pending;
    pending = null;
    cb?.(now);
  }

  /** Drive frames until nothing is scheduled (settle/abort) or a safety cap. */
  function drain(deltaMs = 16, maxFrames = 100_000) {
    let n = 0;
    while (pending && n++ < maxFrames) tick(deltaMs);
  }

  beforeEach(() => {
    now = 0;
    pending = null;
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      pending = cb;
      return 1;
    });
    vi.stubGlobal("performance", { now: () => now });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("calls onSettled exactly once with the exact targets and stops scheduling", () => {
    const onUpdate = vi.fn();
    const onSettled = vi.fn();
    runSpringLoop({ v: { current: 0, velocity: 0 } }, { v: 100 }, onUpdate, onSettled);
    drain();
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(onSettled).toHaveBeenCalledWith({ v: 100 });
    expect(onUpdate).toHaveBeenCalled();
    expect(pending).toBeNull(); // no orphaned rAF after settle
  });

  it("cancel() before the first frame prevents any callback", () => {
    const onUpdate = vi.fn();
    const onSettled = vi.fn();
    const handle = runSpringLoop(
      { v: { current: 0, velocity: 0 } },
      { v: 1000 },
      onUpdate,
      onSettled
    );
    handle.cancel();
    tick(16);
    expect(onUpdate).not.toHaveBeenCalled();
    expect(onSettled).not.toHaveBeenCalled();
    expect(pending).toBeNull();
  });

  it("cancel() mid-flight stops further frames", () => {
    const onUpdate = vi.fn();
    const onSettled = vi.fn();
    const handle = runSpringLoop(
      { v: { current: 0, velocity: 0 } },
      { v: 1000 },
      onUpdate,
      onSettled
    );
    tick(16);
    expect(onUpdate).toHaveBeenCalledTimes(1);
    handle.cancel();
    drain();
    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(onSettled).not.toHaveBeenCalled();
  });

  it("onUpdate returning false aborts the loop without settling", () => {
    const onSettled = vi.fn();
    const onUpdate = vi
      .fn<(axes: Record<"v", DemoSpringAxisState>) => boolean | void>()
      .mockReturnValueOnce(undefined)
      .mockReturnValue(false);
    runSpringLoop({ v: { current: 0, velocity: 0 } }, { v: 1000 }, onUpdate, onSettled);
    tick(16); // frame 1 → undefined → keep going
    tick(16); // frame 2 → false → abort
    expect(onUpdate).toHaveBeenCalledTimes(2);
    expect(onSettled).not.toHaveBeenCalled();
    expect(pending).toBeNull();
  });
});
