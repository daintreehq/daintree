/**
 * Pointer transit detection: telling a deliberate hover apart from a pointer
 * merely passing through.
 *
 * Ported from the marketing site's `hover-settle`, which stands CSS `:hover`
 * down during transit. Here the thing being stood down is a state setter, so
 * this module is DOM-free and reports its suppression state to a caller that
 * owns the listeners. `createPointerIntent`'s forward projection is
 * deliberately not ported: it exists to hold a ~700px panel open while the
 * cursor travels toward it, and the best published endpoint prediction is off
 * by 39px at 90% through a gesture — more than one row of a list.
 */

const MIN_DT = 2;

export interface PointerSample {
  x: number;
  y: number;
  t: number;
}

export function createSampler(windowMs: number) {
  let samples: PointerSample[] = [];

  return {
    // `t` must come from event.timeStamp, never performance.now() read inside
    // the handler. Same time origin, but one is when the pointer moved and the
    // other is when the main thread got around to saying so. Under contention
    // the handler runs late, dt inflates, and a real sweep reads as a slow one.
    push(x: number, y: number, t: number): void {
      samples.push({ x, y, t });
      const cutoff = t - windowMs;
      while (samples.length > 2 && samples[0]!.t < cutoff) samples.shift();
    },
    // Velocity across the whole window, not the last two samples. This is what
    // makes it tremor-tolerant: involuntary oscillation runs 3-12Hz around a
    // point, so net displacement across the window is near zero even while
    // consecutive samples are far apart. A two-sample delta reads that as fast
    // movement and strips the highlight off someone who has firmly landed.
    speed(): number | null {
      if (samples.length < 2) return null;
      const first = samples[0]!;
      const last = samples[samples.length - 1]!;
      const dt = Math.max(last.t - first.t, MIN_DT);
      return Math.hypot(last.x - first.x, last.y - first.y) / dt;
    },
    // Last two samples only, one frame. The window cannot answer "has a flick
    // just started" until it has filled, which is a whole window of rows
    // flashing before suppression engages.
    recentSpeed(): number | null {
      if (samples.length < 2) return null;
      const a = samples[samples.length - 2]!;
      const b = samples[samples.length - 1]!;
      const dt = Math.max(b.t - a.t, MIN_DT);
      return Math.hypot(b.x - a.x, b.y - a.y) / dt;
    },
    clear(): void {
      samples = [];
    },
  };
}

/**
 * Which gesture currently owns suppression. Pointer and scroll are separate
 * authorities and neither may release the other: a scroll offers no
 * deceleration to read, so letting a stray pointer sample end it means two
 * samples release, the next scroll event re-engages, and the list strobes
 * through the whole gesture.
 */
export type HoverSuppressionSource = "pointer" | "scroll";

/** The fields this module reads off a `PointerEvent`, and nothing more. */
export interface PointerTransitEvent {
  pointerType: string;
  clientX: number;
  clientY: number;
  timeStamp: number;
}

export interface HoverSettleOptions {
  /** Windowed px/ms at which a move reads as transit rather than a choice. */
  sweepSpeed?: number;
  /** Single-frame px/ms no oscillation could produce, so it engages instantly. */
  instantSweepSpeed?: number;
  /** Windowed px/ms below which the pointer has homed in. */
  releaseSpeed?: number;
  /** Fraction of the peak that counts as braking. */
  brakeRatio?: number;
  /** Peak below which halving is noise rather than a decision. */
  brakeMinPeak?: number;
  /** Floor holding the instant path up while its window is still cold. */
  minSuppressMs?: number;
  /** Backstop for a gesture that simply stops producing events. */
  settleMs?: number;
  sampleWindowMs?: number;
}

/**
 * Tuned against ~32px rows. Every one of these is load-bearing — read the
 * comments at each use site before changing a number.
 */
const DEFAULTS = {
  sweepSpeed: 0.5,
  instantSweepSpeed: 1.5,
  releaseSpeed: 0.28,
  brakeRatio: 0.5,
  brakeMinPeak: 1.5,
  minSuppressMs: 50,
  settleMs: 60,
  sampleWindowMs: 50,
} as const;

export interface HoverSettleController {
  pointerMove(event: PointerTransitEvent): void;
  pointerLeave(event: PointerTransitEvent): void;
  /** The rows moved under the pointer, by any means. */
  listMoved(): void;
  /** Null while the pointer's position is a statement of intent. */
  suppressionSource(): HoverSuppressionSource | null;
  destroy(): void;
}

/**
 * `onSettle` fires only when a gesture ends on its own terms — homing, braking,
 * or the backstop expiring. A pointer that leaves the region, or a controller
 * torn down, cancels silently: there is no settled intent to act on.
 */
export interface HoverSettleCallbacks {
  onSettle: (source: HoverSuppressionSource) => void;
}

export function createHoverSettle(
  { onSettle }: HoverSettleCallbacks,
  options: HoverSettleOptions = {}
): HoverSettleController {
  const opts = { ...DEFAULTS, ...options };
  const sampler = createSampler(opts.sampleWindowMs);

  let source: HoverSuppressionSource | null = null;
  let peakSpeed = 0;
  let releasableAt = 0;
  let backstopTimer: ReturnType<typeof setTimeout> | undefined;

  function armBackstop(): void {
    clearTimeout(backstopTimer);
    backstopTimer = setTimeout(settle, opts.settleMs);
  }

  function reset(): void {
    clearTimeout(backstopTimer);
    backstopTimer = undefined;
    source = null;
    peakSpeed = 0;
    releasableAt = 0;
  }

  /** The gesture ended on its own terms, so the caller may act on where it ended. */
  function settle(): void {
    const ended = source;
    reset();
    if (ended !== null) onSettle(ended);
  }

  /** The gesture was abandoned. Same state teardown, no notification. */
  function cancel(): void {
    reset();
  }

  function engage(next: HoverSuppressionSource, windowedPeak: number, now: number): void {
    if (source === null) releasableAt = now + opts.minSuppressMs;
    source = next;
    peakSpeed = Math.max(peakSpeed, windowedPeak);
    armBackstop();
  }

  return {
    pointerMove(event) {
      if (event.pointerType !== "mouse") return;

      const now = event.timeStamp;
      sampler.push(event.clientX, event.clientY, now);

      const speed = sampler.speed();
      if (speed === null) return;

      // A scroll owns its own suppression and its own timer. Keep sampling so
      // the reading is warm when it ends, but decide nothing here.
      if (source === "scroll") return;

      if (source === null) {
        // Either signal engages: the smoothed one, or a single frame fast
        // enough that no oscillation could have produced it. Only the smoothed
        // one sets the peak — seeding it from the instant reading and testing
        // release against the windowed one compares two different rulers, and
        // collapses suppression on the next sample.
        if (speed >= opts.sweepSpeed || (sampler.recentSpeed() ?? 0) >= opts.instantSweepSpeed) {
          engage("pointer", speed, now);
        }
        return;
      }

      peakSpeed = Math.max(peakSpeed, speed);

      // The floor gates every pointer-driven release, homing included. The
      // instant path engages precisely when the window is still cold, and a
      // cold window reads slow, so without this the very next sample released
      // again.
      if (now < releasableAt) {
        armBackstop();
        return;
      }

      // Homing: whatever the pointer was doing, it is not doing it any more.
      // Release on deceleration rather than stillness — human pointing is
      // ballistic then corrective, so braking is the earliest honest evidence
      // of intent, and waiting for stillness turns this into the dwell timer it
      // replaces.
      if (speed < opts.releaseSpeed) {
        settle();
        return;
      }

      // Braking, but only from a peak high enough for halving to mean
      // something. Without the floor, windowed speeds of .80, .35, .55, .27
      // inside one continuous gesture release, re-engage and release again.
      if (
        peakSpeed >= opts.brakeMinPeak &&
        speed < opts.sweepSpeed &&
        speed <= peakSpeed * opts.brakeRatio
      ) {
        settle();
        return;
      }

      armBackstop();
    },

    pointerLeave(event) {
      if (event.pointerType !== "mouse") return;
      sampler.clear();
      cancel();
    },

    listMoved() {
      // No "is the pointer inside" precondition, unlike the source: that watches
      // every scroll on the page and needs one to tell its own list's movement
      // from the rest. The caller here only reports movement of the list itself,
      // which is the question `inside` was approximating. Suppressing while the
      // pointer is elsewhere costs one timer and, at worst, drops a row entered
      // inside the settle window — cheap next to reading the list's own movement
      // as a choice.
      //
      // Whatever the pointer was doing before the list moved is no longer a
      // reading of where it is relative to the rows.
      sampler.clear();
      if (source === null) releasableAt = 0;
      source = "scroll";
      peakSpeed = 0;
      armBackstop();
    },

    suppressionSource() {
      return source;
    },

    destroy() {
      sampler.clear();
      cancel();
    },
  };
}
