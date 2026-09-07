/**
 * Correctness terms the UNIT SUITE does not assert to be zero, and why.
 *
 * Most expectations include "the timer had NOT fired yet", which is the one
 * shape a loaded machine can break without anything being wrong.
 * `gradeFlushCadence` waits `PORT_BATCH_THROUGHPUT_DELAY_MS * 2 + 8` for the
 * real PortBatcher cadence; under Vitest's parallel workers — 61 perf files, or
 * 2,481 across the repository — that window slips and the scenario reports a
 * miss for a subject that is fine. PERF-063's GC observation is the companion
 * case: whether V8 schedules a minor collection during the fixed allocation
 * corpus varies by runtime and heap state even though the batcher does the same
 * work. A real perf run still fails closed when there is no GC sample, because
 * its GC comparison would not be meaningful.
 *
 * They remain fully graded through `run.ts`, which is where a number is
 * actually taken and where nothing else is competing for the box. This
 * exemption is only about what is safe to assert inside the unit suite.
 *
 * IT LIVES HERE BECAUSE TWO TESTS READ IT. `scenarioLiveness.test.ts` honoured
 * it and `ptyFlowControl.test.ts` did not, so the same term was exempt when one
 * file drove the scenario and fatal when the other did — and the second one
 * failed three times across six full-suite runs, always under contention, on
 * PERF-063 and PERF-371. An exemption honoured by one reader and ignored by
 * another is not an exemption; it is a coin flip. Same reason
 * `CORRECTNESS_EXEMPT_SCENARIO_IDS` lives in `scenarios/index.ts` rather than in
 * the test that first wanted it.
 *
 * Keyed by scenario AND term, not by term alone: a future scenario that happens
 * to reuse one of these names would otherwise inherit the exemption without
 * anyone deciding to give it one.
 */
export const TIMING_DEPENDENT_TERMS: Readonly<Record<string, readonly string[]>> = {
  // The PortBatcher idle -> latency -> throughput machine, in the three
  // scenarios that drive it.
  "PERF-063": ["immediateFlushMisses", "throughputFlushMisses", "gcObservationMisses"],
  "PERF-370": ["immediateFlushMisses", "throughputFlushMisses"],
  "PERF-371": ["immediateFlushMisses", "throughputFlushMisses"],
};

/** Whether the unit suite may assert this scenario's term reads zero. */
export function isTimingDependent(scenarioId: string, term: string): boolean {
  return (TIMING_DEPENDENT_TERMS[scenarioId] ?? []).includes(term);
}
