import { describe, expect, it } from "vitest";
import { devPreviewScenarios } from "../scenarios/devPreview";
import {
  buildFailureStreamPlans,
  buildStartupStreamPlan,
  createDevPreviewSession,
  createSharedDevPreviewDeps,
  devPreviewPassMisses,
  disposeDevPreviewSession,
  runDevPreviewOutputPass,
  runExitClassificationPass,
  EXIT_SPEC_TABLE,
  type ExitCase,
  type SharedDevPreviewDeps,
} from "../lib/devPreviewOutputFixture";
import type { ScanResult } from "../../../electron/services/UrlDetector";

/**
 * PERF-020..024 drive real product code (`processDevPreviewOutput`,
 * `UrlDetector`, `classifyDevPreviewExit`). These tests do the thing the
 * predicate rules ask for and cannot enforce: they break the subject on
 * purpose, in each direction a URL detector can plausibly break, and assert the
 * predicate goes non-zero.
 */

const CONTEXT = { mode: "ci" as const, now: () => performance.now() };

/** A detector that finds nothing. The cheapest wrong answer there is. */
function blindDetector(): SharedDevPreviewDeps {
  const shared = createSharedDevPreviewDeps();
  return {
    ...shared,
    detector: {
      scanOutput: (data: string, buffer: string): ScanResult => ({
        url: null,
        error: null,
        buffer: (buffer + data).slice(-8192),
        readyMarker: false,
        compileMarker: false,
      }),
    },
  };
}

/** A detector that answers with a URL for every chunk. The other wrong answer. */
function greedyDetector(): SharedDevPreviewDeps {
  const shared = createSharedDevPreviewDeps();
  let counter = 0;
  return {
    ...shared,
    detector: {
      scanOutput: (data: string, buffer: string): ScanResult => {
        counter += 1;
        return {
          url: `http://localhost:${9000 + (counter % 7)}/`,
          error: null,
          buffer: (buffer + data).slice(-8192),
          readyMarker: false,
          compileMarker: false,
        };
      },
    },
  };
}

describe("dev-preview scenarios", () => {
  for (const id of ["PERF-020", "PERF-021", "PERF-022", "PERF-023", "PERF-024"]) {
    it(`${id} emits every declared predicate and reports zero misses`, async () => {
      const scenario = devPreviewScenarios.find((candidate) => candidate.id === id);
      expect(scenario).toBeDefined();

      const sample = await scenario!.run(CONTEXT);
      const metrics = sample.metrics ?? {};
      for (const name of scenario!.correctness ?? []) {
        expect(name in metrics, `${id} did not emit ${name}`).toBe(true);
        expect(metrics[name], `${id} reported ${name}=${metrics[name]}`).toBe(0);
      }
    });
  }

  it("drives real product code rather than a harness regex", async () => {
    // The defect these scenarios were rewritten for: the previous version
    // matched a `/https?:\/\/localhost:\d{2,5}/` the harness owned. The real
    // detector normalises the loopback wildcard, which no such regex does.
    const plan = buildStartupStreamPlan({
      segments: 2,
      firstPort: 5101,
      noisePerSegment: 1,
      seed: 1,
    });
    const wildcardFrame = plan.frames.find((frame) => frame.text.includes("0.0.0.0"));
    expect(wildcardFrame).toBeDefined();
    expect(wildcardFrame!.expectsUrl).toBe("http://localhost:5102/");

    const session = createDevPreviewSession("panel", "project");
    const result = runDevPreviewOutputPass(plan, session, createSharedDevPreviewDeps());
    disposeDevPreviewSession(session);
    expect(result.polledUrls).toContain("http://localhost:5102/");
  });
});

describe("dev-preview correctness predicate", () => {
  const plan = buildStartupStreamPlan({
    segments: 3,
    firstPort: 5101,
    noisePerSegment: 2,
    seed: 5,
  });

  it("scores zero against the real detector", () => {
    const shared = createSharedDevPreviewDeps();
    const session = createDevPreviewSession("panel", "project");
    const result = runDevPreviewOutputPass(plan, session, shared);
    disposeDevPreviewSession(session);
    const misses = devPreviewPassMisses(plan, result, shared.rings);
    expect(Object.values(misses).every((value) => value === 0)).toBe(true);
  });

  it("grades the real diagnostics ring, not the count of calls into it", () => {
    // The deletion this closes: `recordSessionDiagnostic` did real ring work
    // inside the measured bracket and appeared in no predicate, so dropping the
    // write was a free speedup. An empty ring map is what that pass leaves.
    const shared = createSharedDevPreviewDeps();
    const session = createDevPreviewSession("panel", "project");
    const result = runDevPreviewOutputPass(plan, session, shared);
    disposeDevPreviewSession(session);

    expect(plan.expectedDiagnostics.length).toBeGreaterThan(0);
    expect(shared.rings.get(result.ringKey)?.events.length).toBe(plan.expectedDiagnostics.length);
    expect(devPreviewPassMisses(plan, result, shared.rings).diagnosticRingMisses).toBe(0);
    // A ring that recorded nothing.
    expect(devPreviewPassMisses(plan, result, new Map()).diagnosticRingMisses).toBe(
      plan.expectedDiagnostics.length
    );
  });

  it("catches a detector that finds nothing", () => {
    const shared = blindDetector();
    const session = createDevPreviewSession("panel", "project");
    const result = runDevPreviewOutputPass(plan, session, shared);
    disposeDevPreviewSession(session);
    const misses = devPreviewPassMisses(plan, result, shared.rings);
    expect(misses.urlMisses).toBe(plan.expectedPolls.length);
    expect(misses.readyMarkerMisses).toBe(plan.expectedReadyAccelerations);
    expect(misses.compileArmMisses).toBe(plan.expectedCompileArms);
  });

  it("catches a detector that finds a URL in everything", () => {
    // The half a one-sided predicate misses entirely: every plant is
    // "covered", and the counter that has to speak is `decoyHits`.
    const shared = greedyDetector();
    const session = createDevPreviewSession("panel", "project");
    const result = runDevPreviewOutputPass(plan, session, shared);
    disposeDevPreviewSession(session);
    const misses = devPreviewPassMisses(plan, result, shared.rings);
    expect(misses.decoyHits).toBeGreaterThan(0);
    expect(misses.urlMisses).toBeGreaterThan(0);
  });

  it("catches a failure classifier that stops classifying", () => {
    const failurePlan = buildFailureStreamPlans(1)[0]!;
    const shared = blindDetector();
    const session = createDevPreviewSession("panel", "project");
    const result = runDevPreviewOutputPass(failurePlan, session, shared);
    disposeDevPreviewSession(session);
    expect(
      devPreviewPassMisses(failurePlan, result, shared.rings).errorClassMisses
    ).toBeGreaterThan(0);
  });
});

describe("exit classification spec table", () => {
  it("grades both directions", () => {
    const result = runExitClassificationPass();
    expect(result.exitClassMisses).toBe(0);
    expect(result.classifications).toBe(EXIT_SPEC_TABLE.length);
    // A one-sided table is the trap: without null rows, "always a crash" is a
    // perfect score, and without fault rows so is "always clean".
    expect(result.nullRowsGraded).toBeGreaterThan(0);
    expect(result.errorRowsGraded).toBeGreaterThan(0);
  });

  it("catches a classifier that calls every exit clean", () => {
    const alwaysClean: ExitCase[] = EXIT_SPEC_TABLE.map((row) => ({ ...row, expected: null }));
    // Grading the real product against an all-clean expectation is the same
    // arithmetic as grading an all-clean product against the real table.
    const result = runExitClassificationPass(alwaysClean);
    expect(result.exitClassMisses).toBe(
      EXIT_SPEC_TABLE.filter((row) => row.expected !== null).length
    );
  });

  it("catches a classifier that calls every exit a crash", () => {
    const alwaysCrash: ExitCase[] = EXIT_SPEC_TABLE.map((row) => ({
      ...row,
      expected: "process-crash" as const,
    }));
    const result = runExitClassificationPass(alwaysCrash);
    expect(result.exitClassMisses).toBe(
      EXIT_SPEC_TABLE.filter((row) => row.expected !== "process-crash").length
    );
  });
});
