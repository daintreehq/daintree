import { describe, expect, it } from "vitest";
import {
  addSubmitLaneGrade,
  emptySubmitLaneGrade,
  gradeTape,
  heldLaneStatusMisses,
  runSubmitLane,
  type SubmitLaneResult,
  type TapeEntry,
} from "../lib/submitLaneFixture";

/**
 * Does PERF-036's oracle actually react?
 *
 * A correctness predicate that nobody has ever seen go nonzero is a decoration.
 * Each test below feeds `gradeTape` a tape corresponding to one specific way the
 * submit lane can break — including the exact #11875 shape — and asserts that
 * the accumulator for THAT operation moves and, where it matters, that the
 * others do not. One aggregate would let a healthy operation mask a missing one,
 * which is the reason there are six of them.
 */

const BODIES = ["submit zero", "submit one", "submit two"] as const;

/** Mutable, unlike the grader's readonly parameter — these tests build tapes. */
type Tape = TapeEntry[];

function entry(submit: number, kind: "body" | "enter"): TapeEntry {
  return { submit, kind, text: kind === "body" ? (BODIES[submit] ?? "unknown") : "\r" };
}

/** Body, Enter, body, Enter, … — a lane that behaved. */
function healthyTape(): Tape {
  return BODIES.flatMap((_, index) => [entry(index, "body"), entry(index, "enter")]);
}

describe("submit lane oracle", () => {
  it("scores a well-behaved lane at zero on every term", () => {
    expect(gradeTape(healthyTape(), [...BODIES])).toEqual({
      deliveryMisses: 0,
      interleaveMisses: 0,
      orderMisses: 0,
      enterCountMisses: 0,
      bodyIntegrityMisses: 0,
      strayWriteMisses: 0,
      concurrentSubmitMisses: 0,
      settleShortfallMisses: 0,
      drainTimeoutMisses: 0,
    });
  });

  it("catches the #11875 shape: a late Enter landing after the next body", () => {
    // Submit 0 loses the lane mid-flight, submit 1 writes its body, then submit
    // 0's trailing Enter arrives — so ONE Enter submits both bodies as a single
    // merged prompt. Every count in this tape is correct: three bodies, three
    // Enters, in order. Only the span check sees it.
    const tape: Tape = [
      entry(0, "body"),
      entry(1, "body"),
      entry(0, "enter"),
      entry(1, "enter"),
      entry(2, "body"),
      entry(2, "enter"),
    ];
    const grade = gradeTape(tape, [...BODIES]);
    // Two, not one: the violation is mutual. Submit 0's span contains submit
    // 1's body, and submit 1's span contains submit 0's Enter. Both spans are
    // genuinely broken, and collapsing them to one would mean the accumulator
    // is counting incidents rather than affected submits.
    expect(grade.interleaveMisses).toBe(2);
    expect(grade.deliveryMisses).toBe(0);
    expect(grade.enterCountMisses).toBe(0);
    expect(grade.orderMisses).toBe(0);
  });

  it("catches a dead lane that wrote nothing", () => {
    const grade = gradeTape([], [...BODIES]);
    expect(grade.deliveryMisses).toBe(3);
    // A missing submit is reported once, not once per term it also fails.
    expect(grade.enterCountMisses).toBe(0);
    expect(grade.interleaveMisses).toBe(0);
  });

  it("catches a submit that never got its Enter", () => {
    const tape = healthyTape().filter((item) => !(item.submit === 1 && item.kind === "enter"));
    expect(gradeTape(tape, [...BODIES]).enterCountMisses).toBe(1);
  });

  it("catches a doubled Enter", () => {
    const tape = healthyTape();
    tape.splice(4, 0, entry(1, "enter"));
    expect(gradeTape(tape, [...BODIES]).enterCountMisses).toBe(1);
  });

  it("catches a body written twice", () => {
    const tape = healthyTape();
    tape.splice(2, 0, entry(0, "body"));
    expect(gradeTape(tape, [...BODIES]).bodyIntegrityMisses).toBe(1);
  });

  it("catches an altered body", () => {
    const tape = healthyTape();
    tape[0] = { submit: 0, kind: "body", text: "submit zero (truncated" };
    expect(gradeTape(tape, [...BODIES]).bodyIntegrityMisses).toBe(1);
  });

  it("catches submits arriving out of order", () => {
    const tape: Tape = [
      entry(1, "body"),
      entry(1, "enter"),
      entry(0, "body"),
      entry(0, "enter"),
      entry(2, "body"),
      entry(2, "enter"),
    ];
    expect(gradeTape(tape, [...BODIES]).orderMisses).toBe(1);
  });

  it("catches a write attributed to a submit nobody made", () => {
    const tape = healthyTape();
    tape.push({ submit: 7, kind: "body", text: "phantom" });
    expect(gradeTape(tape, [...BODIES]).strayWriteMisses).toBe(1);
  });

  it("finishes rather than hanging when a submit rejects", async () => {
    // The lane waits on submits SETTLING, not completing. `drainSubmitQueue`
    // catches a rejection and moves on, so a fixture waiting only on successes
    // would hang forever on the exact case worth measuring.
    const grade = gradeTape(
      [entry(0, "body"), entry(0, "enter"), entry(1, "body"), entry(2, "body"), entry(2, "enter")],
      [...BODIES]
    );
    // Submit 1 wrote its body and then rejected before its Enter.
    expect(grade.enterCountMisses).toBe(1);
    expect(grade.deliveryMisses).toBe(0);
  });

  it("catches an Enter that arrived before its own body", () => {
    // Submits an empty composer and then types into it. Every count in this
    // tape is right — one body, one Enter, in submit order — so before the
    // position check this scored zero on every term, which is the shape of hole
    // that lets a benchmark stay green through a real defect.
    const tape: Tape = [
      entry(0, "enter"),
      entry(0, "body"),
      entry(1, "body"),
      entry(1, "enter"),
      entry(2, "body"),
      entry(2, "enter"),
    ];
    const grade = gradeTape(tape, [...BODIES]);
    expect(grade.orderMisses).toBe(1);
    expect(grade.enterCountMisses).toBe(0);
  });

  it("catches an Enter carrying the wrong bytes", () => {
    // "\r\n" instead of "\r" changes what the agent receives. A grader that
    // only counted Enters would call it healthy.
    const tape = healthyTape();
    tape[1] = { submit: 0, kind: "enter", text: "\r\n" };
    expect(gradeTape(tape, [...BODIES]).bodyIntegrityMisses).toBe(1);
  });

  it("catches two submits running at once, structurally", async () => {
    // The lane invariant in the form that does not depend on the tape happening
    // to record an ordering violation. Driven by asking the real queue to run a
    // burst and asserting it never overlapped.
    const result = await runSubmitLane({
      submits: 8,
      slowEvery: 2,
      debounceMs: 1,
      maxWaitMs: 10,
      pollMs: 2,
    });
    expect(result.grade.concurrentSubmitMisses).toBe(0);
    expect(result.grade.settleShortfallMisses).toBe(0);
  });

  it("catches a held-open submit that did not actually wait", () => {
    // The settle is work inside the timed bracket, and until this term existed
    // nothing graded it: `waitForOutputSettle` reduced to `return` produced a
    // perfect tape and a much faster number. Asserted on the accumulator's
    // arithmetic rather than by stubbing the production queue, which the
    // fixture deliberately does not allow.
    const grade = emptySubmitLaneGrade();
    grade.settleShortfallMisses += 1;
    expect(addSubmitLaneGrade(emptySubmitLaneGrade(), grade).settleShortfallMisses).toBe(1);
  });

  it("reports rather than hangs when the queue stops accepting submits", async () => {
    // The failure the watchdog exists for. `idle` resolves on submits settling,
    // so a lane that silently drops one resolves nothing: under Vitest that
    // hangs to the suite timeout, and in a bare Node process an unresolved
    // promise with no referenced handles lets the process exit reporting
    // nothing at all. Both are worse than a named miss.
    const grade = emptySubmitLaneGrade();
    grade.drainTimeoutMisses += 1;
    grade.deliveryMisses += 3;
    const summed = addSubmitLaneGrade(emptySubmitLaneGrade(), grade);
    expect(summed.drainTimeoutMisses).toBe(1);
    expect(summed.deliveryMisses).toBe(3);
  });

  it("recovers the lane after a submit rejects, and settles exactly once", async () => {
    // The failure path, driven end to end through the real queue. Three things
    // used to break here and none of them showed up as a test failure:
    //
    //   `inFlight` was decremented only on success, so after a rejection every
    //   later submit reported a concurrency miss that never happened — one real
    //   failure turned into a cascade of invented ones that buries its own cause.
    //
    //   `outputFlowing` was likewise left armed, so every later submit's settle
    //   bound on maxWaitMs instead of its debounce: the fixture quietly running
    //   a different workload from the one it claims.
    //
    //   And the drain settles on `onWriteError` for the rejected submit, so if
    //   the queue ever called it twice — or not at all — `idle` would resolve
    //   early or never. Never is the dangerous one: it hangs.
    const result = await runSubmitLane({
      submits: 4,
      slowEvery: 0,
      debounceMs: 1,
      maxWaitMs: 20,
      pollMs: 2,
      rejectSubmitIndex: 1,
    });

    expect(result.timedOut).toBe(false);
    expect(result.failedSubmits).toBe(1);

    // Exactly the injected failure, and nothing invented on top of it.
    expect(result.grade.concurrentSubmitMisses).toBe(0);
    expect(result.grade.settleShortfallMisses).toBe(0);
    expect(result.grade.drainTimeoutMisses).toBe(0);
    expect(result.grade.deliveryMisses).toBe(0);
    expect(result.grade.strayWriteMisses).toBe(0);

    // The rejected submit wrote its body and never its Enter. That IS the
    // symptom a user would see, so the grade must name it.
    expect(result.grade.enterCountMisses).toBe(1);

    // And the lane kept working: the submits behind it ran and completed.
    expect(result.bytesWritten).toBeGreaterThan(0);
  });

  it("converts a wedged lane into a named miss instead of hanging", async () => {
    // The failure the watchdog exists for, driven for real. `idle` resolves on
    // submits SETTLING, so a lane that never settles resolves nothing: under
    // Vitest that hangs to the runner's timeout, and in a bare Node process an
    // unresolved promise with no referenced handles lets the process exit
    // reporting nothing at all. Both are worse than a named miss.
    //
    // The budget is overridden because the shipped one is tens of seconds — it
    // has to be, so a merely-busy machine is never called a failure — which
    // makes it unassertable at unit speed.
    const result = await runSubmitLane({
      submits: 3,
      slowEvery: 0,
      debounceMs: 1,
      maxWaitMs: 10,
      pollMs: 2,
      stallSubmitIndex: 0,
      drainBudgetOverrideMs: 250,
    });

    expect(result.timedOut).toBe(true);
    expect(result.grade.drainTimeoutMisses).toBe(1);
    // And the grade still says WHAT was lost: the wedged submit wrote its body
    // and never its Enter, and the two behind it never ran at all.
    expect(result.grade.enterCountMisses).toBeGreaterThan(0);
    expect(result.grade.deliveryMisses).toBe(2);
  }, 15_000);

  it("fails a held arm that never reached the queue's reporting threshold", () => {
    // The nightly arm exists to be the ONE place the shipped 3000ms threshold is
    // crossed. An arm that quietly missed it — a machine so loaded the settle
    // returned early, a threshold raised in production — would report a clean
    // tape and cover nothing, so it is graded on evidence from the real
    // `onSubmitStatus` sink rather than on its own intent. Asserted on the pure
    // function: driving it for real costs 3.5 seconds and belongs in nightly.
    const result = (events: string[]) => ({ statusEvents: events }) as SubmitLaneResult;

    expect(heldLaneStatusMisses(result(["slow", "settled"]), true)).toBe(0);
    expect(heldLaneStatusMisses(result([]), true)).toBe(1);
    expect(heldLaneStatusMisses(result(["settled"]), true)).toBe(1);
    // An arm that did not claim to hold anything is not graded on it.
    expect(heldLaneStatusMisses(result([]), false)).toBe(0);
  });

  it("drives the real WriteQueue to a clean tape under a held-open submit", async () => {
    const result = await runSubmitLane({
      submits: 6,
      slowEvery: 2,
      debounceMs: 1,
      maxWaitMs: 12,
      pollMs: 2,
    });
    expect(result.grade).toEqual({
      deliveryMisses: 0,
      interleaveMisses: 0,
      orderMisses: 0,
      enterCountMisses: 0,
      bodyIntegrityMisses: 0,
      strayWriteMisses: 0,
      concurrentSubmitMisses: 0,
      settleShortfallMisses: 0,
      drainTimeoutMisses: 0,
    });
    expect(result.timedOut).toBe(false);
    expect(result.slowSubmits).toBe(3);
    expect(result.failedSubmits).toBe(0);
    // The held-open submits really did hold the lane: three of them bounded at
    // maxWaitMs cannot drain in less than that.
    expect(result.drainMs).toBeGreaterThan(12);
    expect(result.bytesWritten).toBeGreaterThan(0);
  });
});
