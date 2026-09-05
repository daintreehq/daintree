import { performance } from "node:perf_hooks";
import { percentile } from "./stats";

/**
 * How responsive the rest of the process stayed while something else ran.
 *
 * Daintree's promise is not that twelve agents can run. It is that the
 * thirteenth foreground action stays responsive while they do — so a background
 * operation getting 10% faster is not an improvement if it doubles the pause the
 * user feels in the terminal they are typing into. Every heavy background
 * workflow therefore deserves two readings: how fast it finished, and what it
 * cost the foreground. This is the second one.
 *
 * WHAT IT MEASURES
 *   A fixed-cadence timer, and how late it actually fired. A Node timer cannot
 *   fire while synchronous work holds the loop, so the gap between consecutive
 *   observations IS main-thread starvation, in milliseconds, with no modelling
 *   in between. That is the same quantity that turns into dropped frames and
 *   late keystrokes in the renderer.
 *
 * WHAT IT DOES NOT MEASURE
 *   Keystroke-to-paint. There is no Chromium scheduler, no compositor and no
 *   xterm here, so this is main-thread availability and not perceived latency.
 *   The painted number belongs to the `interactivity` journey. Read a reading
 *   from this file as "the loop was unavailable for N ms", never as "typing lag
 *   was N ms".
 *
 * THE PREDICATE TRAP
 *   A bystander reading is the one metric class that a DEAD subject scores
 *   perfectly on: a workload that does nothing blocks nothing and posts the best
 *   numbers this file can produce. So a scenario using this MUST also declare a
 *   predicate proving the workload actually happened — `tokenizeMisses`,
 *   `bundleFileMisses`, whatever reads the work's real output. `probeMisses`
 *   here only proves the PROBE stayed alive; it says nothing about the subject.
 *
 * PAIR IT WITH A CONTROL
 *   A stall figure alone is a property of the machine as much as of the code, so
 *   a reading is only interpretable next to a control measured the same way on
 *   the same machine. The control can be an idle window taken BEFORE the
 *   workload on a settled heap (PERF-163 uses a fixed 150ms one) or the paired
 *   arm the workload is being compared against (PERF-395's worker arm is the
 *   control for its in-thread arm). Either way the reportable quantity is the
 *   DIFFERENCE, which is the part a change can actually move.
 *
 *   Order matters as much as existence. A control taken AFTER the workload
 *   inherits its garbage collection and reports stall on an untouched loop, and
 *   an arm that runs third inherits the two before it — that mistake made
 *   PERF-395's worker arm look 33% slower than in-thread until a forced
 *   collection was put in front of each arm.
 */
export interface BystanderReading {
  /** Timer observations recorded across the window. */
  ticksObserved: number;
  /**
   * 1 unless the apparatus was proven sound at the moment the window opened.
   *
   * Two independent facts, both established BEFORE the workload runs and
   * neither readable from the window's own tick count: the timer fired at least
   * once during arming, and a fresh timer was pending when the window opened.
   * The second is what stops the first from becoming decorative — an arming
   * latch alone would keep reporting 0 through a `reopen()` that scheduled
   * nothing, so the timed generation would go unchecked. Two wrong versions were considered and rejected:
   *
   * "ticks the cadence called for that did not arrive" is the stall itself. A
   * 500ms block owes ~60 ticks, so that predicate reports misses on precisely
   * the healthy runs this probe exists to describe.
   *
   * "the window observed at least one tick" is subtler and just as wrong: a
   * workload that is one fully synchronous block from `start()` to `stop()`
   * lets no timer callback run at all, so the predicate fires BECAUSE the
   * subject blocked hard — the very condition under measurement moving the exit
   * code under `--enforce-integrity`. Expectation-anchored catch-up cannot
   * rescue it, because there is no loop turn left after `stop()`.
   *
   * So arming is a separate phase that waits for a real tick and then discards
   * it. This reading proves the APPARATUS was working when the window opened,
   * and says nothing at all about the subject.
   *
   * An arming attempt that TIMED OUT latches to 1 and stays there. A later tick
   * must not quietly erase the evidence that arming never completed.
   */
  probeMisses: number;
  /**
   * The longest the loop went unobserved anywhere in the window — the worst
   * freeze.
   *
   * Boundary-inclusive: the gap from the window opening to the first
   * observation, and from the last observation to `stop()`, count alongside the
   * gaps between observations. Both matter. A workload that blocks immediately
   * produces no leading observation, and one still blocking when it finishes
   * produces no trailing one, so measuring only between observations would
   * discard the largest gap in exactly the two cases worth catching.
   */
  longestStallMs: number;
  /**
   * Accumulated stall: for every gap wider than twice the cadence, the amount
   * by which it exceeded ONE cadence, summed.
   *
   * The excess rather than the whole gap, because one cadence of every gap was
   * always going to be spent waiting — charging it to the workload would report
   * an idle loop as partly blocked. The floor at twice the cadence is what keeps
   * ordinary timer jitter out of the total; it does mean a gap just above the
   * floor contributes a full cadence where one just below contributes nothing,
   * which is a threshold artifact worth knowing about and far smaller than the
   * blocks this is built to see.
   *
   * A single number for "how much of this window was the main thread
   * unavailable", which a median cannot express and a max hides the frequency of.
   */
  blockedMs: number;
  /**
   * 95th percentile of the OBSERVED GAPS, boundary-inclusive.
   *
   * The gap distribution rather than its extreme: `longestStallMs` reports the
   * single worst freeze, which one unlucky collection can own, and `blockedMs`
   * sums excess without saying how any individual pause looked.
   *
   * Read it as exactly what it is — a percentile over this window's gaps — and
   * nothing more. It is NOT a caller's waiting-time distribution, and it is not
   * a rate: among 100 gaps, one 100ms freeze beside 99 ordinary 4ms gaps has a
   * p95 of 4ms, because the freeze is a single sample. Catch-up scheduling
   * (`schedule()` anchors to absolute expected times) adds short gaps after a
   * block, which pulls the distribution further from timer lateness.
   *
   * So it needs a control measured the same way on the same machine, like every
   * other reading in this file — more so, because a window that is mostly idle
   * puts the 95th percentile among idle gaps, where the workload cannot move it.
   */
  p95StallMs: number;
  /**
   * The same percentile over gaps with one cadence subtracted, floored at zero.
   *
   * One cadence of every gap was always going to be spent waiting, so removing
   * it makes two arms measured at the SAME cadence comparable — an idle loop
   * reads ~0 here and a full cadence in {@link p95StallMs}. It is a percentile
   * of excess gap, not an attribution of that excess to the workload: the
   * caveats on {@link p95StallMs} apply unchanged.
   */
  p95DelayMs: number;
  /** Wall clock the probe covered. */
  windowMs: number;
  /** Share of the window spent blocked, 0..1. */
  blockedFraction: number;
}

export interface BystanderProbe {
  /**
   * Stops the timer and returns the reading. Idempotent — a second call returns
   * a reading over the same window rather than one extended to now, so a
   * `finally` block that stops a probe an earlier line already stopped cannot
   * silently widen it.
   */
  stop(): BystanderReading;
}

export interface BystanderOptions {
  /**
   * Target interval between observations.
   *
   * 4ms is the floor worth asking for: Node clamps nested timers and the
   * observation itself costs something, so a cadence below that measures the
   * probe. 8ms is roughly one frame and is the default for that reason.
   */
  cadenceMs?: number;
}

/**
 * Start watching main-thread availability. Call `stop()` when the workload ends.
 *
 * Scheduling is anchored to an absolute expected time rather than "now +
 * cadence", so a long block is followed by a catch-up burst rather than a
 * silently reduced tick count.
 *
 * Prefer {@link armBystanderProbe} whenever the reading feeds a declared
 * correctness predicate. A probe started here has not been proven to fire, so
 * its `probeMisses` can read 1 for a workload that simply blocked from the
 * first line to the last — the subject moving a predicate that is supposed to
 * describe only the apparatus.
 */
export function startBystanderProbe(options: BystanderOptions = {}): BystanderProbe {
  return start(options);
}

/**
 * Start a probe and wait until it has demonstrably fired once, then discard
 * that tick and open the measured window.
 *
 * This is what makes `probeMisses` a statement about the apparatus rather than
 * about the workload. Use it in preference to {@link startBystanderProbe}
 * wherever the reading feeds a declared correctness predicate.
 *
 * Bounded: if no tick arrives within a generous multiple of the cadence the
 * probe is returned unarmed, and reports `probeMisses: 1` — which is the honest
 * outcome, because a timer that will not fire before the workload has even
 * started cannot describe what the workload did to the loop.
 */
export async function armBystanderProbe(options: BystanderOptions = {}): Promise<BystanderProbe> {
  const probe = start(options);
  // The result is LATCHED, not discarded. An arming attempt that timed out has
  // to survive to `stop()`: reading the live `everFired` instead would let a
  // tick arriving later erase the one piece of evidence that the probe was not
  // working when the window opened.
  const armed = await probe.armed;
  probe.reopen(armed);
  return probe;
}

interface InternalProbe extends BystanderProbe {
  /** Resolves true once a tick has been observed, false if arming timed out. */
  armed: Promise<boolean>;
  /**
   * Discards observations and restarts the window clock at now.
   *
   * `armedSuccessfully` carries the latched outcome of the arming phase into
   * the window, so a timeout cannot be overwritten by a later tick.
   */
  reopen(armedSuccessfully: boolean): void;
}

/** Ceiling on arming, as a multiple of the cadence. */
const ARM_TIMEOUT_CADENCES = 50;

function start(options: BystanderOptions): InternalProbe {
  const cadenceMs = Math.max(4, options.cadenceMs ?? 8);
  let startedAt = performance.now();
  let observations: number[] = [];
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  let tick = 0;
  let everFired = false;
  let endedAt: number | undefined;
  /**
   * Whether the apparatus was sound when the measured window opened.
   *
   * `undefined` until a window opens. For a probe that was never armed this
   * stays undefined and `stop()` falls back to the live `everFired`, which is
   * the old — and, for a predicate, unsafe — behaviour that
   * `startBystanderProbe` documents.
   */
  let windowApparatusSound: boolean | undefined;
  /**
   * The analysed reading, computed once.
   *
   * `stop()` sorts the gap list twice to produce percentiles. That work is not
   * the subject of any scenario, so it must not be repeated by a second
   * `stop()` in a `finally`, and callers should capture their workload's end
   * timestamp BEFORE the first one.
   */
  let closedReading: BystanderReading | undefined;

  let resolveArmed: (value: boolean) => void = () => {};
  const armed = new Promise<boolean>((resolve) => {
    resolveArmed = resolve;
  });
  let armTimer: NodeJS.Timeout | undefined = setTimeout(() => {
    armTimer = undefined;
    resolveArmed(false);
  }, cadenceMs * ARM_TIMEOUT_CADENCES);

  /**
   * Cleared the moment arming settles, not at `stop()`.
   *
   * Left running, it fires roughly 400ms into a measurement window at the
   * default cadence — an unrelated callback landing inside the very window this
   * probe exists to keep clean.
   */
  const settleArming = (value: boolean): void => {
    if (armTimer !== undefined) {
      clearTimeout(armTimer);
      armTimer = undefined;
    }
    resolveArmed(value);
  };

  const schedule = (): void => {
    if (stopped) return;
    tick += 1;
    const expected = startedAt + tick * cadenceMs;
    const wait = Math.max(0, expected - performance.now());
    timer = setTimeout(() => {
      if (stopped) return;
      everFired = true;
      settleArming(true);
      observations.push(performance.now());
      schedule();
    }, wait);
  };

  schedule();

  return {
    armed,
    reopen(armedSuccessfully: boolean): void {
      // Set BEFORE anything can return early. The fallback in `stop()` reads
      // the pre-arm `everFired`, which by definition is already true on the
      // armed path — so a `reopen()` that returned without doing anything would
      // inherit a clean 0 and leave the timed generation unchecked, which is
      // the exact hole this field exists to close.
      windowApparatusSound = false;
      // Nothing to reopen once the reading is closed. Reachable only through
      // `InternalProbe`, which callers do not hold, but a reopen after `stop()`
      // would mutate a snapshot that has already been reported.
      if (stopped) return;
      // The armed window starts here, so the tick that proved the timer works
      // is not counted as an observation of the workload — and, more
      // importantly, the gap that preceded it is not charged to the workload as
      // a stall it did not cause.
      //
      // The pending timer is cleared first. Without that, `schedule()` starts a
      // second chain alongside the one already in flight and every subsequent
      // tick is counted twice, which halves every gap and makes a blocked loop
      // look half as blocked.
      if (timer) clearTimeout(timer);
      observations = [];
      tick = 0;
      startedAt = performance.now();
      timer = undefined;
      schedule();
      // BOTH facts, recorded at the instant the window opens. Arming proves the
      // timer mechanism works; a pending timer proves this window has one. An
      // arming latch on its own would keep reporting a clean 0 through a
      // `reopen()` that scheduled nothing at all, leaving the timed generation
      // — the only part that matters — unchecked.
      windowApparatusSound = armedSuccessfully && timer !== undefined;
    },
    stop(): BystanderReading {
      // Both timers are cleared here rather than `unref`'d at creation, and the
      // difference is not cosmetic. An unref'd probe does not hold the loop
      // open, so a process with nothing else pending can EXIT between the call
      // to `armBystanderProbe` and the probe's first tick — the await never
      // resolves, the scenario never returns, and the run ends silently at exit
      // code 0 having measured nothing. Clearing on stop gives the same
      // guarantee the unref was reaching for (the probe never outlives its
      // results) without that hole.
      if (!stopped) {
        stopped = true;
        endedAt = performance.now();
        if (timer) clearTimeout(timer);
        settleArming(everFired);
      }
      if (closedReading) return closedReading;

      const closedAt = endedAt ?? performance.now();
      const windowMs = closedAt - startedAt;

      let longestStallMs = 0;
      let blockedMs = 0;
      const gaps: number[] = [];
      const stallFloor = cadenceMs * 2;
      let previous = startedAt;
      // The tail counts: a block that is still running when the workload
      // finishes produces no final observation, so measuring only between
      // observations would discard the largest gap in the window.
      for (const at of [...observations, closedAt]) {
        const gap = at - previous;
        gaps.push(gap);
        if (gap > longestStallMs) longestStallMs = gap;
        if (gap > stallFloor) blockedMs += gap - cadenceMs;
        previous = at;
      }

      closedReading = {
        ticksObserved: observations.length,
        probeMisses: (windowApparatusSound ?? everFired) ? 0 : 1,
        longestStallMs,
        blockedMs,
        p95StallMs: percentile(gaps, 95),
        p95DelayMs: percentile(
          gaps.map((gap) => Math.max(0, gap - cadenceMs)),
          95
        ),
        windowMs,
        blockedFraction: windowMs > 0 ? blockedMs / windowMs : 0,
      };
      return closedReading;
    },
  };
}

/**
 * Flatten a reading into scenario metrics under a per-arm prefix.
 *
 * `probeMisses` is summed across arms by the caller rather than prefixed, so one
 * scenario declares one predicate for the probe regardless of how many arms it
 * runs — a per-arm predicate name would have to be declared per arm, and an
 * undeclared one is invisible.
 */
export function bystanderMetrics(
  prefix: string,
  reading: BystanderReading
): Record<string, number> {
  return {
    [`${prefix}LongestStallMs`]: reading.longestStallMs,
    [`${prefix}BlockedMs`]: reading.blockedMs,
    [`${prefix}BlockedPct`]: reading.blockedFraction * 100,
    [`${prefix}P95StallMs`]: reading.p95StallMs,
    [`${prefix}P95DelayMs`]: reading.p95DelayMs,
    [`${prefix}ProbeTicks`]: reading.ticksObserved,
  };
}
