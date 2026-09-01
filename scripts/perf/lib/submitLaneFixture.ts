import { performance } from "node:perf_hooks";
import { WriteQueue } from "../../../electron/services/pty/WriteQueue";

/**
 * The real `WriteQueue` serialising real submits against a recording PTY sink.
 *
 * WHY THIS EXISTS
 *   #11875: a submit that stopped making progress used to lose the lane to a
 *   `Promise.race`, so its trailing Enter landed AFTER the next submit's body
 *   and two prompts were sent to the agent as one merged message. Every
 *   latency number in this repository was green through that bug, because the
 *   defect is not slowness — it is ordering. A benchmark that measures how fast
 *   the queue drains and grades nothing about WHAT it wrote would be green
 *   through it too, and would stay green through a "fast" queue that dropped
 *   the serialisation entirely.
 *
 *   So the oracle is a byte tape. Every write the queue causes is appended with
 *   the submit that caused it, and the tape is then graded against what the
 *   fixture asked for — not against anything the queue reports about itself.
 *
 * THE TWO-SIDED TEST
 *   Doing nothing fails: `deliveryMisses` counts submits whose body never
 *   reached the tape. Doing too much fails: `interleaveMisses` counts submits
 *   whose body and Enter were separated by another submit's bytes, which is the
 *   exact #11875 symptom and the exact thing a queue "optimised" by dropping the
 *   lane would produce. Duplicates, reorders and extra Enters each have their
 *   own accumulator, because one aggregate can stay at zero while one operation
 *   disappears.
 */

/** What the production submit path writes: the body, then a bare CR. */
const ENTER = "\r";

/**
 * A held-open submit must wait at least this share of `maxWaitMs`.
 *
 * Not 1.0: the wait polls, so it lands a poll interval either side of the bound
 * and a strict comparison would report scheduler jitter as a defect. Half is far
 * below any real wait and far above a wait that did not happen.
 */
const SETTLE_FLOOR_FRACTION = 0.5;

/**
 * Debounce a held-open submit waits against, relative to its own `maxWaitMs`.
 *
 * ABOVE the bound, so the debounce can never be satisfied before `maxWaitMs`
 * fires and the arm is bounded by construction rather than by luck. An earlier
 * version used a fixed 8ms, which only made the race unlikely: a scheduler
 * pause longer than the debounce still lets a held submit settle early.
 *
 * The race is real and was found by `perf calibrate`. `waitForOutputSettle`
 * reads the clock twice per poll, once through `lastOutputTime()` and once for
 * `Date.now()`, and `Date.now()` has millisecond granularity — so at a 1ms
 * debounce those two reads can straddle a tick, `timeSinceOutput` comes back as
 * 1, and a submit whose output is still flowing returns as settled. It surfaced
 * as `settleShortfallMisses` reading 1 in one round out of five on an untouched
 * tree. That is a fixture parameter choice, not a product defect: production
 * debounces are orders of magnitude above the clock's resolution.
 *
 * Ordinary submits keep the small debounce and stay quick, where settling early
 * is exactly what they are supposed to do.
 */
function heldSubmitDebounceMs(maxWaitMs: number): number {
  return maxWaitMs + 1;
}

/**
 * How long the whole burst may take before the watchdog calls it stuck.
 *
 * VERY generous on purpose. This is not a latency assertion — the drain time is
 * already reported as `drainMs` and judged there. It is only the difference
 * between reporting a failure and hanging, so the only bad calibration is one
 * tight enough to fire on a machine that is merely busy: that turns a loaded
 * CI box into a correctness miss, which is a false accusation against the
 * subject and exactly the kind of noise that gets a predicate deleted.
 *
 * The first cut was 4x the serial floor plus a second, and it tripped inside a
 * full 2,481-file test run where the fast arm's 24 submits share a machine with
 * everything else. Ten times the floor plus ten seconds still converts a
 * genuinely wedged lane into a named miss inside ~15s, which is all that is
 * asked of it.
 */
function drainBudgetMs(options: SubmitLaneOptions): number {
  if (options.drainBudgetOverrideMs !== undefined) return options.drainBudgetOverrideMs;
  const perSubmitMs = Math.max(options.maxWaitMs, options.debounceMs);
  return (options.submits * perSubmitMs + (options.holdFirstSubmitMs ?? 0)) * 10 + 10_000;
}

export interface TapeEntry {
  /** Index of the submit the write belongs to, per the fixture's own record. */
  submit: number;
  kind: "body" | "enter";
  text: string;
}

export interface SubmitLaneGrade {
  /** Submits whose body never reached the sink. A dead queue scores here. */
  deliveryMisses: number;
  /** Submits whose body and Enter were split by another submit's bytes (#11875). */
  interleaveMisses: number;
  /** Submits that did not arrive in the order they were queued. */
  orderMisses: number;
  /** Deviation from exactly one Enter per submit, summed over submits. */
  enterCountMisses: number;
  /** Bodies that arrived more than once, or arrived altered. */
  bodyIntegrityMisses: number;
  /** Writes attributed to a submit the fixture never made. */
  strayWriteMisses: number;
  /**
   * Submits whose `performSubmit` was entered while another was still running.
   *
   * The direct, structural form of the lane invariant, and the one that does
   * not depend on the tape happening to record an ordering violation. A queue
   * that released the lane early trips this even when the two submits' writes
   * interleave in an order that looks innocent.
   */
  concurrentSubmitMisses: number;
  /**
   * Held-open submits whose in-flight time fell below the window they were
   * supposed to wait out.
   *
   * Without it, a `waitForOutputSettle` reduced to `return` produces a perfect
   * tape and a much faster result — the settle is an operation inside the timed
   * bracket with no other term against it.
   */
  settleShortfallMisses: number;
  /** The drain did not finish inside its bound; the rest of the grade is partial. */
  drainTimeoutMisses: number;
}

export interface SubmitLaneResult {
  grade: SubmitLaneGrade;
  /**
   * Submit-lane status transitions the REAL queue reported.
   *
   * Read from `onSubmitStatus`, the production reporting sink, so a held arm can
   * show that it genuinely crossed the threshold rather than merely intending to.
   */
  statusEvents: string[];
  /** Wall clock from the first `submit()` to the queue going idle. */
  drainMs: number;
  submitsRequested: number;
  bytesWritten: number;
  /** Submits whose settle wait was bounded by `maxWaitMs` rather than debounce. */
  slowSubmits: number;
  /** Submits that rejected. A healthy run is 0; the grade catches them anyway. */
  failedSubmits: number;
  /** The drain hit its watchdog. Everything else in the result is partial. */
  timedOut: boolean;
}

/** Miss count for a held arm that never reached the queue's reporting threshold. */
export function heldLaneStatusMisses(result: SubmitLaneResult, expectStatus: boolean): number {
  if (!expectStatus) return 0;
  // The arm claims to hold a submit past the shipped slow threshold. If the
  // real reporting timer never fired, it did not — and the whole reason this
  // arm costs seconds is to be the one place that threshold is actually
  // crossed, so an arm that quietly missed it is worth failing on.
  return result.statusEvents.includes("slow") ? 0 : 1;
}

export interface SubmitLaneOptions {
  /** How many submits to queue in one burst. */
  submits: number;
  /** Every Nth submit keeps output flowing so its settle wait binds on maxWaitMs. */
  slowEvery: number;
  /** Passed straight to the real `waitForOutputSettle`. */
  debounceMs: number;
  maxWaitMs: number;
  pollMs: number;
  /**
   * Hold the FIRST submit open for this long, overriding `maxWaitMs` for it
   * alone, with the rest of the burst queued behind it.
   *
   * The point is to cross the queue's real reporting threshold. Everything else
   * here runs in tens of milliseconds, far below the shipped 3000ms, so the
   * production `slow` timer can never fire — which means the literal #11875
   * implementation (a `Promise.race` that lost the lane when that timer won)
   * could be reintroduced and every fast arm would stay green. This arm is
   * expensive by construction and runs in `nightly` only.
   */
  holdFirstSubmitMs?: number;
  /**
   * Make this submit's `performSubmit` reject after it has written its body and
   * armed the output flow.
   *
   * A fault injector, and the only way to drive the lane's failure path from a
   * test. It exercises three things nothing else reaches: that the queue calls
   * `onWriteError` exactly once so the drain still settles, that `inFlight` and
   * `outputFlowing` are released in a `finally` rather than on the success path
   * — a rejection used to poison both for the rest of the run — and that the
   * grade reports a missing Enter rather than the fixture hanging.
   *
   * Never set by a scenario. Benchmarks measure the healthy path.
   */
  rejectSubmitIndex?: number;
  /**
   * Make this submit never settle, so the drain can only end at the watchdog.
   *
   * The other half of the fault injector. Without it the watchdog is
   * unreachable from a test: its real budget is tens of seconds by design, so a
   * wedged lane inside Vitest would hit the runner's own timeout first and fail
   * as "the test hung" — which is exactly the outcome the watchdog exists to
   * replace with a named miss. Pair it with {@link drainBudgetOverrideMs}.
   *
   * Never set by a scenario.
   */
  stallSubmitIndex?: number;
  /**
   * Override the watchdog budget, in milliseconds.
   *
   * Test-only, and the reason is the same: the shipped budget is generous
   * because a benchmark must never call a merely-busy machine a failure, which
   * makes it far too slow to assert against directly.
   */
  drainBudgetOverrideMs?: number;
}

export const SUBMIT_LANE_CORRECTNESS = [
  "deliveryMisses",
  "interleaveMisses",
  "orderMisses",
  "enterCountMisses",
  "bodyIntegrityMisses",
  "strayWriteMisses",
  "concurrentSubmitMisses",
  "settleShortfallMisses",
  "drainTimeoutMisses",
] as const;

export function emptySubmitLaneGrade(): SubmitLaneGrade {
  return {
    deliveryMisses: 0,
    interleaveMisses: 0,
    orderMisses: 0,
    enterCountMisses: 0,
    bodyIntegrityMisses: 0,
    strayWriteMisses: 0,
    concurrentSubmitMisses: 0,
    settleShortfallMisses: 0,
    drainTimeoutMisses: 0,
  };
}

export function addSubmitLaneGrade(into: SubmitLaneGrade, from: SubmitLaneGrade): SubmitLaneGrade {
  into.deliveryMisses += from.deliveryMisses;
  into.interleaveMisses += from.interleaveMisses;
  into.orderMisses += from.orderMisses;
  into.enterCountMisses += from.enterCountMisses;
  into.bodyIntegrityMisses += from.bodyIntegrityMisses;
  into.strayWriteMisses += from.strayWriteMisses;
  into.concurrentSubmitMisses += from.concurrentSubmitMisses;
  into.settleShortfallMisses += from.settleShortfallMisses;
  into.drainTimeoutMisses += from.drainTimeoutMisses;
  return into;
}

function bodyFor(index: number): string {
  // Distinct per submit and per length, so a duplicated or truncated body
  // cannot pass as a different one.
  return `run task ${index} --seed ${index * 7919}`;
}

/**
 * Grade a tape against the submits the fixture actually asked for.
 *
 * Everything here is derived from `expectedBodies` — the fixture's own record —
 * and from the tape. Nothing is read back from the queue, which is what stops
 * the subject grading itself.
 */
export function gradeTape(
  tape: readonly TapeEntry[],
  expectedBodies: readonly string[]
): SubmitLaneGrade {
  const grade = emptySubmitLaneGrade();

  const bodyIndices = new Map<number, number[]>();
  const enterCounts = new Map<number, number>();

  tape.forEach((entry, position) => {
    if (entry.submit < 0 || entry.submit >= expectedBodies.length) {
      grade.strayWriteMisses += 1;
      return;
    }
    if (entry.kind === "body") {
      const seen = bodyIndices.get(entry.submit) ?? [];
      seen.push(position);
      bodyIndices.set(entry.submit, seen);
      if (entry.text !== expectedBodies[entry.submit]) grade.bodyIntegrityMisses += 1;
      return;
    }
    // The Enter's bytes are checked, not assumed. A submit path that sent
    // "\r\n", or a newline instead of a carriage return, changes what the agent
    // receives; a grader that only counted Enters would call that healthy.
    if (entry.text !== ENTER) grade.bodyIntegrityMisses += 1;
    enterCounts.set(entry.submit, (enterCounts.get(entry.submit) ?? 0) + 1);
  });

  let previousBodyPosition = -1;
  for (let index = 0; index < expectedBodies.length; index += 1) {
    const positions = bodyIndices.get(index) ?? [];
    if (positions.length === 0) {
      grade.deliveryMisses += 1;
      // No body means no span to check for interleaving and no order to check.
      // Counting those too would report one missing submit three times over.
      continue;
    }
    // A body written twice is a duplicate submission the user never made.
    grade.bodyIntegrityMisses += positions.length - 1;

    const bodyAt = positions[0]!;
    if (bodyAt < previousBodyPosition) grade.orderMisses += 1;
    previousBodyPosition = bodyAt;

    const enters = enterCounts.get(index) ?? 0;
    grade.enterCountMisses += Math.abs(1 - enters);

    // The #11875 span check: between this submit's body and its Enter, no other
    // submit may have written anything.
    const enterAt = tape.findIndex(
      (entry, position) => position > bodyAt && entry.kind === "enter" && entry.submit === index
    );
    if (enterAt === -1) {
      // No Enter AFTER the body. Either there is none at all — already counted
      // by enterCountMisses — or one arrived BEFORE it, which submits an empty
      // composer and then types into it. That case used to fall through here
      // scoring zero on every term, because the count was right and the span
      // check simply had nothing to walk.
      if ((enterCounts.get(index) ?? 0) > 0) grade.orderMisses += 1;
      continue;
    }
    for (let position = bodyAt + 1; position < enterAt; position += 1) {
      if (tape[position]!.submit !== index) {
        grade.interleaveMisses += 1;
        break;
      }
    }
  }

  return grade;
}

/**
 * Queue a burst of submits through the real `WriteQueue` and grade the tape.
 *
 * The burst is queued SYNCHRONOUSLY, which is the shape that matters: it is a
 * user hitting submit again while the first one is still in flight, and it is
 * the only way the lane is put under any pressure at all.
 */
export async function runSubmitLane(options: SubmitLaneOptions): Promise<SubmitLaneResult> {
  const tape: TapeEntry[] = [];
  const expectedBodies = Array.from({ length: options.submits }, (_, index) => bodyFor(index));

  const statusEvents: string[] = [];
  let bytesWritten = 0;
  let slowSubmits = 0;
  let disposed = false;
  // Observed by the FIXTURE, never asked of the queue: how many submits are
  // inside `performSubmit` at once. This is the lane invariant in its direct
  // structural form, and it does not depend on the tape happening to record an
  // ordering violation — two overlapping submits whose writes interleave in an
  // innocent-looking order still trip it.
  let inFlight = 0;
  let concurrentSubmitMisses = 0;
  // Held-open submits that did not actually wait. Without this term,
  // `waitForOutputSettle` reduced to `return` produces a perfect tape and a much
  // faster number — the settle is work inside the bracket with nothing else
  // grading it.
  let settleShortfallMisses = 0;
  // Drives the real `waitForOutputSettle`: a "slow" submit keeps reporting
  // fresh output so the debounce never satisfies and the wait binds on
  // maxWaitMs, which is the in-flight window a second submit has to survive.
  let outputFlowing = false;

  const write = (submit: number, kind: "body" | "enter", text: string): void => {
    tape.push({ submit, kind, text });
    bytesWritten += Buffer.byteLength(text, "utf8");
  };

  let queue: WriteQueue | undefined;
  let resolveIdle: () => void = () => {};
  const idle = new Promise<void>((resolve) => {
    resolveIdle = resolve;
  });
  // Settled, not completed: a submit that REJECTS is over as far as the lane is
  // concerned — `drainSubmitQueue` catches it and moves on. Waiting only on
  // successful completions would hang the whole benchmark forever on the one
  // case worth measuring, instead of reporting it. A failed submit writes no
  // Enter, so `enterCountMisses` still catches it in the grade.
  let settled = 0;
  let failedSubmits = 0;
  const settle = (): void => {
    settled += 1;
    if (settled === options.submits) resolveIdle();
  };

  queue = new WriteQueue({
    isExited: () => disposed,
    lastOutputTime: () => (outputFlowing ? Date.now() : 0),
    performSubmit: async (text: string) => {
      const index = expectedBodies.indexOf(text);
      inFlight += 1;
      if (inFlight > 1) concurrentSubmitMisses += 1;
      // Released in a `finally`, not on the success path. A submit that REJECTS
      // would otherwise leave the counter at 1 for the rest of the run, so every
      // remaining submit would report a concurrency miss that never happened —
      // an oracle that turns one real failure into a cascade of invented ones is
      // worse than no oracle, because it buries the true first cause.
      try {
        write(index, "body", text);

        const held = index === 0 && options.holdFirstSubmitMs !== undefined;
        const slow =
          held || (index >= 0 && options.slowEvery > 0 && index % options.slowEvery === 0);
        outputFlowing = slow;
        if (slow) slowSubmits += 1;
        const maxWaitMs = held ? options.holdFirstSubmitMs! : options.maxWaitMs;
        if (index === options.stallSubmitIndex) {
          // Never resolves. The queue holds the lane, `settle()` is never
          // reached, and the only thing that can end the drain is the watchdog.
          await new Promise<never>(() => {});
        }
        if (index === options.rejectSubmitIndex) {
          // After the body and after `outputFlowing` is armed, which is what makes
          // this a test of the release path rather than of an early return.
          throw new Error(`submit lane: injected failure on submit ${index}`);
        }

        // The real settle wait from the production queue, not a sleep. The queue
        // is always constructed before it can call this, so an absent one is a
        // broken fixture rather than a state to tolerate quietly.
        if (!queue) throw new Error("submit lane: performSubmit ran before the queue existed");
        const settleStart = performance.now();
        await queue.waitForOutputSettle({
          // A held submit needs a debounce above the clock's granularity or it
          // can settle on a rounding boundary; see heldSubmitDebounceMs.
          debounceMs: slow ? heldSubmitDebounceMs(maxWaitMs) : options.debounceMs,
          maxWaitMs,
          pollMs: options.pollMs,
        });
        const waitedMs = performance.now() - settleStart;
        // A held-open submit is bounded by maxWaitMs BY CONSTRUCTION — output
        // keeps arriving, so the debounce can never be satisfied. Landing under
        // the floor means the wait did not happen, not that it finished early.
        if (slow && waitedMs < maxWaitMs * SETTLE_FLOOR_FRACTION) {
          settleShortfallMisses += 1;
        }

        // Attributed to this submit's own `index`, so the tape is a faithful
        // record of who wrote what. Concurrency is caught structurally by
        // `concurrentSubmitMisses` and, in the tape, by the span check: an Enter
        // that arrives after the NEXT submit's body puts a foreign write inside
        // this submit's span, which is the #11875 signature exactly.
        write(index, "enter", ENTER);
      } finally {
        inFlight -= 1;
        // Reset here, not on the success path. A submit that rejects after
        // arming it would leave output "flowing" for the rest of the run, so
        // every later submit's settle would bind on maxWaitMs instead of its
        // debounce — the fixture quietly changing the workload it claims to run.
        outputFlowing = false;
      }

      settle();
    },
    onWriteError: () => {
      failedSubmits += 1;
      settle();
    },
    // The production reporting sink. A held arm reads it back to show it really
    // crossed the shipped threshold, rather than asserting against a copy of a
    // constant this module cannot import.
    onSubmitStatus: (state) => {
      statusEvents.push(state);
    },
  });

  const start = performance.now();
  for (const body of expectedBodies) queue.submit(body);

  // A watchdog, not a nicety. `idle` resolves on submits SETTLING, so a queue
  // whose `submit()` became a no-op, or which dropped one queued item, or whose
  // drain loop stopped without rejecting, resolves nothing at all: under Vitest
  // that hangs to the suite timeout, and in a bare Node process an unresolved
  // promise with no referenced handles lets the process exit reporting nothing.
  // Either way the benchmark fails to say what it exists to say. The timer is
  // deliberately NOT unref'd — it has to keep the process alive long enough to
  // produce the grade that names the failure.
  const budgetMs = drainBudgetMs(options);
  let watchdog: NodeJS.Timeout | undefined;
  const timedOut = await Promise.race([
    idle.then(() => false),
    new Promise<boolean>((resolve) => {
      watchdog = setTimeout(() => resolve(true), budgetMs);
    }),
  ]);
  if (watchdog) clearTimeout(watchdog);
  const drainMs = performance.now() - start;

  disposed = true;
  queue?.dispose();

  const grade = gradeTape(tape, expectedBodies);
  grade.concurrentSubmitMisses += concurrentSubmitMisses;
  grade.settleShortfallMisses += settleShortfallMisses;
  if (timedOut) grade.drainTimeoutMisses += 1;

  return {
    grade,
    statusEvents,
    drainMs,
    timedOut,
    submitsRequested: options.submits,
    bytesWritten,
    slowSubmits,
    failedSubmits,
  };
}
