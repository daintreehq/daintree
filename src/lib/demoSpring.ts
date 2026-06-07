/**
 * Frame-rate-independent spring integrator for the demo recording engine.
 *
 * The demo scroll glide (DemoCursor) and the spotlight cutout (DemoOverlay) both
 * animate a semi-implicit Euler spring inside a requestAnimationFrame loop. The
 * naive form clamps the per-frame `dt` (`Math.min(dt, 0.032)`), which silently
 * discards real elapsed time whenever a frame takes longer than the clamp. Under
 * 4K capture the renderer's rAF cadence drops below ~31fps, so each frame drops a
 * slice of wall-clock time and the spring advances slower than real time — the
 * recorded animation runs in slow motion.
 *
 * The fix is a fixed-timestep accumulator: accumulate real elapsed time, consume
 * it in fixed `FIXED_DT` sub-steps, and clamp only the per-frame *addition* (not
 * each step) as a spiral-of-death guard. The simulated time then tracks
 * wall-clock exactly regardless of the rAF rate, so a 1-second glide takes one
 * second whether the recorder runs at 120fps or 20fps.
 */

/** Spring stiffness (k). With m=1 this gives ω_n = √70 ≈ 8.37 rad/s. */
export const DEMO_SPRING_STIFFNESS = 70;
/** Spring damping (c). c=20 > critical 2√70 ≈ 16.73 → overdamped (no overshoot). */
export const DEMO_SPRING_DAMPING = 20;
/**
 * Fixed integration sub-step (seconds). 1/120 divides both 60Hz and 120Hz rAF
 * cadences cleanly and sits ~34× inside the semi-implicit Euler stability bound
 * (dt < c/k ≈ 0.285s), so the integration is exact for any real frame rate.
 */
export const DEMO_SPRING_FIXED_DT = 1 / 120;
/**
 * Per-frame wall-clock cap (seconds) — the spiral-of-death guard. After a long
 * stall (tab backgrounded, GC pause) we never replay more than ~7-8 sub-steps,
 * avoiding a jarring teleport while still keeping every normal frame exact.
 */
export const DEMO_SPRING_MAX_FRAME_DT = 0.064;
/** Settle threshold for |velocity| (px/s). */
export const DEMO_SPRING_SETTLE_VELOCITY = 0.5;
/** Settle threshold for |target − current| (px). */
export const DEMO_SPRING_SETTLE_ERROR = 0.5;

/** State of a single spring axis. */
export interface DemoSpringAxisState {
  current: number;
  velocity: number;
}

/** Result of consuming one frame's worth of elapsed time. */
export interface AccumulateSpringResult<K extends string> {
  axes: Record<K, DemoSpringAxisState>;
  accumulator: number;
  settled: boolean;
}

/** Handle returned by {@link runSpringLoop} to cancel an in-flight animation. */
export interface SpringLoopHandle {
  cancel: () => void;
}

/**
 * Advance one spring axis by exactly `dt` seconds (semi-implicit Euler). Pure:
 * returns a new state, never mutates the input.
 */
export function stepSpring(
  state: DemoSpringAxisState,
  target: number,
  dt: number,
  stiffness: number = DEMO_SPRING_STIFFNESS,
  damping: number = DEMO_SPRING_DAMPING
): DemoSpringAxisState {
  const force = -stiffness * (state.current - target) - damping * state.velocity;
  const velocity = state.velocity + force * dt;
  const current = state.current + velocity * dt;
  return { current, velocity };
}

/** Whether an axis has come to rest at its target within both thresholds. */
export function isSpringSettled(state: DemoSpringAxisState, target: number): boolean {
  return (
    Math.abs(state.velocity) < DEMO_SPRING_SETTLE_VELOCITY &&
    Math.abs(target - state.current) < DEMO_SPRING_SETTLE_ERROR
  );
}

/**
 * Consume one frame's elapsed time (`rawDt`) plus any carried `accumulator`,
 * stepping every axis in lock-step through fixed `DEMO_SPRING_FIXED_DT` sub-steps.
 * Returns the advanced axes, the leftover accumulator to carry into the next
 * frame, and whether all axes have settled. Pure and rAF-free, so the
 * integration can be tested directly without fake timers.
 *
 * `rawDt` is capped at `DEMO_SPRING_MAX_FRAME_DT` before it is added — this is the
 * only clamp, and it bounds catch-up after a stall instead of dropping time every
 * frame.
 */
export function accumulateSpring<K extends string>(
  axes: Record<K, DemoSpringAxisState>,
  targets: Record<K, number>,
  rawDt: number,
  accumulator: number,
  stiffness: number = DEMO_SPRING_STIFFNESS,
  damping: number = DEMO_SPRING_DAMPING
): AccumulateSpringResult<K> {
  // Object.keys widens to string[] and an incrementally-built Record can't be
  // typed as Record<K, V> without an assertion — both are sound here.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  const keys = Object.keys(axes) as K[];
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  const next = {} as Record<K, DemoSpringAxisState>;
  for (const key of keys) {
    next[key] = { current: axes[key].current, velocity: axes[key].velocity };
  }

  let acc = accumulator + Math.min(rawDt, DEMO_SPRING_MAX_FRAME_DT);
  while (acc >= DEMO_SPRING_FIXED_DT) {
    for (const key of keys) {
      next[key] = stepSpring(next[key], targets[key], DEMO_SPRING_FIXED_DT, stiffness, damping);
    }
    acc -= DEMO_SPRING_FIXED_DT;
  }

  let settled = true;
  for (const key of keys) {
    if (!isSpringSettled(next[key], targets[key])) {
      settled = false;
      break;
    }
  }

  return { axes: next, accumulator: acc, settled };
}

/**
 * Drive a fixed-timestep spring animation on a requestAnimationFrame loop.
 *
 * `onUpdate` runs once per frame after that frame's sub-steps with the current
 * axis values; return `false` from it to stop the loop (e.g. the target node
 * unmounted). `onSettled` runs once when every axis comes to rest and is passed
 * the exact `targets`, so callers snap to precise final values rather than the
 * sub-pixel approximation the integrator leaves behind.
 *
 * Returns a handle whose `cancel()` halts the loop before the next frame mutates
 * anything — callers that can re-trigger mid-animation must store it and cancel
 * the previous loop to avoid orphaned rAF callbacks.
 */
export function runSpringLoop<K extends string>(
  initialAxes: Record<K, DemoSpringAxisState>,
  targets: Record<K, number>,
  onUpdate: (axes: Record<K, DemoSpringAxisState>) => boolean | void,
  onSettled: (targets: Record<K, number>) => void,
  stiffness: number = DEMO_SPRING_STIFFNESS,
  damping: number = DEMO_SPRING_DAMPING
): SpringLoopHandle {
  let cancelled = false;
  let axes = initialAxes;
  let accumulator = 0;
  let lastTime = performance.now();

  function frame(now: number) {
    if (cancelled) return;
    const rawDt = (now - lastTime) / 1000;
    lastTime = now;

    const result = accumulateSpring(axes, targets, rawDt, accumulator, stiffness, damping);
    axes = result.axes;
    accumulator = result.accumulator;

    if (result.settled) {
      onSettled(targets);
      return;
    }

    if (onUpdate(axes) === false) return;
    requestAnimationFrame(frame);
  }

  requestAnimationFrame(frame);

  return {
    cancel: () => {
      cancelled = true;
    },
  };
}
