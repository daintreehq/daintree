import { describe, expect, it } from "vitest";
import {
  classifyBenchmark,
  CLASSIFIED_SCENARIO_IDS,
  describeBenchmarkClass,
} from "../config/benchmarkClasses";
import { EXPECTED_SCENARIO_IDS } from "../scenarios";

/**
 * Does every scenario say what its number is allowed to mean?
 *
 * The classification is only worth having if it is complete. One unclassified
 * scenario is a row in a report with no claim beside it, which is exactly the
 * state the whole table exists to end — and the pressure on a new scenario is
 * always to skip it, because "mechanism" is both the most common answer and the
 * one that requires no thought.
 */
describe("benchmark classes", () => {
  it("classifies every scenario in the matrix, and nothing else", () => {
    expect(CLASSIFIED_SCENARIO_IDS).toEqual(EXPECTED_SCENARIO_IDS);
  });

  it("returns undefined rather than a flattering default for an unknown id", () => {
    // A default of `mechanism` would hand every future scenario the label it
    // did not earn, silently.
    expect(classifyBenchmark("PERF-999")).toBeUndefined();
  });

  it("gives every scenario a claim that states a limit", () => {
    const thin: string[] = [];
    for (const id of CLASSIFIED_SCENARIO_IDS) {
      const cls = classifyBenchmark(id);
      if (!cls) {
        thin.push(`${id}: no class`);
        continue;
      }
      // A claim that only says what the benchmark does, with no statement of
      // what it omits, is the shape that lets a mechanism number be quoted as a
      // user-experience result.
      if (cls.claim.length < 80) thin.push(`${id}: claim too short to state a limit`);
    }
    expect(thin).toEqual([]);
  });

  it("marks a journey only when the renderer and a real topology are present", () => {
    // The one rule that keeps `journey` meaningful. A journey without a renderer
    // is a mechanism benchmark wearing the label that lets it be quoted as a
    // product claim.
    const wrong: string[] = [];
    for (const id of CLASSIFIED_SCENARIO_IDS) {
      const cls = classifyBenchmark(id)!;
      if (cls.kind !== "journey") continue;
      if (cls.fidelity.renderer === "absent") wrong.push(`${id}: journey with no renderer`);
      if (cls.fidelity.processTopology === "single-process") {
        wrong.push(`${id}: journey in a single process`);
      }
      if (cls.fidelity.entryPoint === "internal-function") {
        wrong.push(`${id}: journey entered at an internal function`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it("renders a one-line fidelity description", () => {
    const cls = classifyBenchmark("PERF-074")!;
    expect(cls.kind).toBe("diagnostic");
    const description = describeBenchmarkClass(cls);
    expect(description).toContain("diagnostic");
    expect(description).toContain("transport stubbed");
    expect(description.includes("\n")).toBe(false);
  });

  it("keeps the families that were reclassified on evidence", () => {
    // These three are the reclassifications this table was built for, and each
    // is documented in scripts/perf/README.md. A silent upgrade back to
    // `mechanism` would restore the exact overstatement being corrected.
    expect(classifyBenchmark("PERF-077")!.kind).toBe("diagnostic");
    expect(classifyBenchmark("PERF-196")!.kind).toBe("diagnostic");
    expect(classifyBenchmark("PERF-035")!.kind).toBe("diagnostic");
  });
});
