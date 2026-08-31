import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import {
  BACKOFF_POLICY,
  CRASH_CASES,
  FOREIGN_SERVICE_NAME,
  gradeBackoffSchedule,
  isFreshGeneration,
  runWatchdogLadder,
  type BackoffPass,
  type CrashCase,
} from "../lib/supervisionFixture";
import { supervisionScenarios } from "../scenarios/supervision";
import { classifyMetric } from "../lib/comparability";

/**
 * Unit coverage for the ORACLES, not the scenarios.
 *
 * PERF-260..262 and PERF-264 fork a child that remaps `electron` and replaces
 * the process's timers; they are exercised by `npm run perf`, not by vitest.
 * What is worth testing here is whether their expectation tables can actually
 * fail — a predicate graded against a table that everything satisfies is
 * decoration that reports zero forever.
 *
 * PERF-263 is the exception and is run for real below: `watchdog-host-core` is
 * plain Node with injected deps, so the scenario needs no fixture at all.
 */

/** What a supervisor that classifies on the exit code alone would answer. */
function exitCodeOnlyVerdict(probe: CrashCase): { crashType: string; reportedCode: number } {
  const code = probe.exitCode;
  if (code === 0) return { crashType: "CLEAN_EXIT", reportedCode: code };
  if (code === 137) return { crashType: "OUT_OF_MEMORY", reportedCode: code };
  if (code === 134) return { crashType: "ASSERTION_FAILURE", reportedCode: code };
  if (code > 128 && process.platform !== "win32") {
    return { crashType: "SIGNAL_TERMINATED", reportedCode: code };
  }
  return { crashType: "UNKNOWN_CRASH", reportedCode: code };
}

/** What a supervisor that consumes any reason on the bus would answer. */
function unfilteredGoneVerdict(probe: CrashCase): { crashType: string; reportedCode: number } {
  if (!probe.gone) return exitCodeOnlyVerdict(probe);
  const map: Record<string, string> = {
    oom: "OUT_OF_MEMORY",
    "memory-eviction": "OUT_OF_MEMORY",
    killed: "SIGNAL_TERMINATED",
    "clean-exit": "CLEAN_EXIT",
  };
  return {
    crashType: map[probe.gone.reason] ?? "UNKNOWN_CRASH",
    reportedCode: probe.gone.exitCode,
  };
}

function graded(
  verdict: (probe: CrashCase) => { crashType: string; reportedCode: number },
  cases: readonly CrashCase[]
): number {
  let misses = 0;
  for (const probe of cases) {
    const answer = verdict(probe);
    if (
      answer.crashType !== probe.expectedCrashType ||
      answer.reportedCode !== probe.expectedReportedCode
    ) {
      misses += 1;
    }
  }
  return misses;
}

describe("crash-classification expectation table", () => {
  const gradedCases = CRASH_CASES.filter((probe) => !probe.crossAttribution);
  const crossAttribution = CRASH_CASES.filter((probe) => probe.crossAttribution);

  it("has exactly one cross-attribution case, carrying a sibling's service name", () => {
    expect(crossAttribution).toHaveLength(1);
    expect(crossAttribution[0]!.gone?.foreign).toBe(true);
    expect(FOREIGN_SERVICE_NAME).not.toBe("");
  });

  it("fails a supervisor that classifies on the exit code alone", () => {
    // The ordering race is the whole point of the one-tick defer in
    // `PtyHostLifecycle.handleExit`. If the table could be satisfied without
    // consuming the deferred reason, `classificationMisses` would be free.
    expect(graded(exitCodeOnlyVerdict, gradedCases)).toBeGreaterThanOrEqual(4);
  });

  it("fails a supervisor that consumes any reason on the bus", () => {
    expect(graded(unfilteredGoneVerdict, crossAttribution)).toBe(1);
  });

  it("passes a supervisor that prefers its own deferred reason", () => {
    // The reference verdict: use the reason when it is ours, the exit code
    // otherwise. Anything less than this must miss, and this must not.
    const correct = (probe: CrashCase): { crashType: string; reportedCode: number } =>
      probe.gone && !probe.gone.foreign ? unfilteredGoneVerdict(probe) : exitCodeOnlyVerdict(probe);
    expect(graded(correct, CRASH_CASES)).toBe(0);
  });

  it("covers a clean exit, every heuristic exit code, and a payload-free verdict", () => {
    const types = new Set(CRASH_CASES.map((probe) => probe.expectedCrashType));
    expect([...types]).toContain("CLEAN_EXIT");
    expect([...types]).toContain("OUT_OF_MEMORY");
    expect([...types]).toContain("ASSERTION_FAILURE");
    expect([...types]).toContain("UNKNOWN_CRASH");
    // A crash payload must exist for every verdict except a clean exit; that
    // pairing is what the probe grades alongside the verdict itself.
    for (const probe of CRASH_CASES) {
      expect(probe.expectPayload).toBe(probe.expectedCrashType !== "CLEAN_EXIT");
    }
  });
});

describe("restart-schedule oracle", () => {
  /** What the four real supervisors schedule, read off a PERF-260 smoke run. */
  const workspaceLow: BackoffPass = { restartsAttempted: 2, scheduledDelays: [100, 100] };
  const workspaceHigh: BackoffPass = { restartsAttempted: 2, scheduledDelays: [1999, 3999] };

  it("passes the shipped full-jitter schedule", () => {
    expect(gradeBackoffSchedule("scheduled", workspaceLow, workspaceHigh)).toBe(0);
    expect(
      gradeBackoffSchedule(
        "immediate",
        { restartsAttempted: 2, scheduledDelays: [] },
        { restartsAttempted: 2, scheduledDelays: [] }
      )
    ).toBe(0);
  });

  it("fails a supervisor that restarts instantly with no timer", () => {
    // The defect this predicate exists for: recovery, serving and give-up are
    // all unchanged by dropping the timer, so nothing else would notice.
    const none: BackoffPass = { restartsAttempted: 2, scheduledDelays: [] };
    expect(gradeBackoffSchedule("scheduled", none, none)).toBeGreaterThan(0);
  });

  it("fails a fixed delay wearing a jitter formula's name", () => {
    // Both pinned passes schedule the same total, so the delay never consulted
    // `Math.random` — every supervisor resynchronises after a shared crash.
    const fixed: BackoffPass = { restartsAttempted: 2, scheduledDelays: [500, 500] };
    expect(gradeBackoffSchedule("scheduled", fixed, fixed)).toBeGreaterThan(0);
  });

  it("fails a backoff that does not widen across successive crashes", () => {
    const flatHigh: BackoffPass = { restartsAttempted: 2, scheduledDelays: [1999, 1999] };
    expect(gradeBackoffSchedule("scheduled", workspaceLow, flatHigh)).toBeGreaterThan(0);
  });

  it("fails a spin dressed as a backoff, and a delay nobody would wait out", () => {
    const spin: BackoffPass = { restartsAttempted: 2, scheduledDelays: [1, 2] };
    expect(gradeBackoffSchedule("scheduled", workspaceLow, spin)).toBeGreaterThan(0);
    const forever: BackoffPass = { restartsAttempted: 2, scheduledDelays: [100, 600_000] };
    expect(gradeBackoffSchedule("scheduled", workspaceLow, forever)).toBeGreaterThan(0);
  });

  it("fails an immediate supervisor that started scheduling", () => {
    // Graded in both directions: the policy is the claim, not "some delay".
    expect(gradeBackoffSchedule("immediate", workspaceLow, workspaceHigh)).toBeGreaterThan(0);
  });

  it("declares a policy for every supervisor the ladder drives", () => {
    expect(Object.keys(BACKOFF_POLICY).sort()).toEqual([
      "MainProcessWatchdogClient",
      "PluginDevWorkerHost",
      "PtyHostLifecycle",
      "WorkspaceHostProcess",
    ]);
  });
});

describe("launch-generation oracle", () => {
  it("accepts a freshly minted, strictly newer stamp", () => {
    expect(isFreshGeneration(2, 1)).toBe(true);
  });

  it("rejects a replay that omitted the stamp", () => {
    // `undefined !== 1` was the old check, so an omitted stamp satisfied a
    // predicate written to prove a new one had been minted.
    expect(isFreshGeneration(undefined, 1)).toBe(false);
    expect(isFreshGeneration(null, 1)).toBe(false);
  });

  it("rejects a stale, malformed, or unmintable stamp", () => {
    expect(isFreshGeneration(1, 1)).toBe(false);
    expect(isFreshGeneration(1, 2)).toBe(false);
    expect(isFreshGeneration("2", 1)).toBe(false);
    expect(isFreshGeneration(1.5, 1)).toBe(false);
    // Nothing was stamped before the crash, so there is nothing to supersede.
    expect(isFreshGeneration(1, undefined)).toBe(false);
  });
});

describe("watchdog core ladder", () => {
  it("kills a frozen main, and nothing else", () => {
    const result = runWatchdogLadder(3);

    expect(result.beatsToKill).toBeGreaterThan(0);
    expect(result.detectionWindowMs).toBeGreaterThan(0);
    // Both directions, on one run: a watchdog that never fires fails the first
    // assertion, one that fires eagerly fails the second.
    expect(result.missedKills).toBe(0);
    expect(result.falseKills).toBe(0);
    // Every wake-burst tick in every round was absorbed.
    expect(result.suppressedWakeTicks).toBe(3 * 6);
    expect(result.flagMisses).toBe(0);
    expect(result.pidParseMisses).toBe(0);
    expect(result.watchdogDecisions).toBeGreaterThan(100);
  });
});

describe("supervision scenarios", () => {
  it("declares a miss count on every scenario, and only count-class ones", () => {
    expect(supervisionScenarios.map((scenario) => scenario.id)).toEqual([
      "PERF-260",
      "PERF-261",
      "PERF-262",
      "PERF-263",
      "PERF-264",
    ]);
    for (const scenario of supervisionScenarios) {
      expect(scenario.correctness?.length ?? 0).toBeGreaterThan(0);
      for (const name of scenario.correctness ?? []) {
        expect(classifyMetric(name)).toBe("count");
      }
    }
  });

  it("PERF-263 emits every predicate it declares, at zero", async () => {
    const scenario = supervisionScenarios.find((entry) => entry.id === "PERF-263")!;
    const sample = await scenario.run({ mode: "smoke", now: () => performance.now() });

    expect(sample.metrics).toBeDefined();
    for (const name of scenario.correctness ?? []) {
      expect(sample.metrics![name]).toBe(0);
    }
    expect(sample.metrics!.beatsToKillCount).toBeGreaterThan(0);
    expect(sample.metrics!.detectionWindowMs).toBeGreaterThan(0);
    // A hardcoded zero is a sentinel, never a measurement.
    expect(sample.durationMs).toBeGreaterThan(0);
  });
});
