import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { buildSpreads, describePredicateInstability } from "../calibrate";
import { REGISTRY } from "../registry";
import type { MetricStat, ScenarioAggregate } from "../types";

/**
 * `perf calibrate` answers the question every threshold depends on and nobody
 * had measured: how much does this number move when nothing changed?
 *
 * The CLI surface is what is asserted here rather than a full run, which spawns
 * a scenario several times and belongs in the hands of whoever is reading the
 * spread. What matters mechanically is that a bad invocation is refused rather
 * than silently producing a figure from the wrong scenario or too few rounds.
 */

const execFileAsync = promisify(execFile);
const perfDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(perfDir, "..", "..");

async function calibrate(args: string[]): Promise<{ code: number; stderr: string }> {
  try {
    const { stderr } = await execFileAsync(
      process.execPath,
      ["--import", "tsx", path.join(perfDir, "calibrate.ts"), ...args],
      { cwd: repoRoot }
    );
    return { code: 0, stderr };
  } catch (error) {
    const failure = error as { code?: number; stderr?: string };
    return { code: failure.code ?? -1, stderr: failure.stderr ?? "" };
  }
}

function stat(max: number): MetricStat {
  return { mean: max, min: max, max, sum: max, count: 8 };
}

/** One round's aggregate, carrying only what the spread code reads. */
function round_(p50Ms: number, metricStats: Record<string, MetricStat>): ScenarioAggregate {
  return {
    id: "PERF-036",
    name: "fixture",
    description: "fixture",
    tier: "fast",
    runs: 8,
    p50Ms,
    p95Ms: p50Ms,
    p99Ms: p50Ms,
    maxMs: p50Ms,
    meanMs: p50Ms,
    stdDevMs: 0,
    metricAverages: {},
    metricStats,
    outsideReference: false,
    measurementIssues: [],
    notes: [],
  };
}

describe("a metric a round never emitted", () => {
  /**
   * The failure this guards is the one `lib/gate.ts` already refuses to make:
   * a reading that is missing read as a reading of 0. Here it would report a
   * predicate that stopped being emitted mid-calibration as perfectly stable,
   * and would widen every spread with a sample nothing measured.
   */
  it("is reported as absent rather than as a clean zero", () => {
    const rounds = [
      round_(10, { parseMisses: stat(0) }),
      round_(10, {}),
      round_(10, { parseMisses: stat(0) }),
    ];

    const findings = describePredicateInstability(rounds, 3);

    expect(findings).toEqual(["parseMisses not emitted in 1/3 rounds"]);
  });

  it("is still found when it is the FIRST round that lacks it", () => {
    // Reading the key set off round one alone would see no predicate at all.
    const findings = describePredicateInstability(
      [round_(10, {}), round_(10, { aMisses: stat(2) })],
      2
    );

    expect(findings).toEqual([
      "aMisses not emitted in 1/2 rounds",
      "aMisses nonzero in 1/2 rounds",
    ]);
  });

  it("says nothing when every round read a clean zero", () => {
    expect(
      describePredicateInstability(
        [round_(10, { aMisses: stat(0) }), round_(10, { aMisses: stat(0) })],
        2
      )
    ).toEqual([]);
  });

  it("contributes no sample to the spread it is missing from", () => {
    // A fabricated 0 would put the range at 40 and the rangePct at 100%, and
    // that range is the effect-size reference the guide sets thresholds from.
    const spreads = buildSpreads([
      round_(10, { gitSpawns: stat(40) }),
      round_(10, {}),
      round_(10, { gitSpawns: stat(40) }),
    ]);
    const gitSpawns = spreads.find((spread) => spread.name === "gitSpawns")!;

    expect(gitSpawns.samples).toEqual([40, 40]);
    expect(gitSpawns.absentRounds).toBe(1);
    expect(gitSpawns.range).toBe(0);
  });

  it("leaves the duration spread alone, which is never absent", () => {
    const spreads = buildSpreads([round_(10, {}), round_(14, {})]);

    expect(spreads[0]!.name).toBe("p50Ms");
    expect(spreads[0]!.absentRounds).toBe(0);
    expect(spreads[0]!.range).toBe(4);
  });
});

describe("perf calibrate", () => {
  it("is reachable from the dispatcher", () => {
    // A benchmark tool nobody can find is one nobody uses — the same rule the
    // registry coverage test enforces for the specs.
    expect(REGISTRY.calibrate).toBeDefined();
    expect(REGISTRY.calibrate!.kind).toBe("diagnostic");
  });

  it("requires a scenario, like every other command here", { timeout: 60_000 }, async () => {
    const { code, stderr } = await calibrate([]);
    expect(code).toBe(1);
    expect(stderr).toContain("--scenario is required");
  });

  it("refuses too few rounds to show a spread", { timeout: 60_000 }, async () => {
    // Quartiles from four samples are two samples wearing a statistical name,
    // and a range from two runs is both of them.
    for (const rounds of ["2", "4"]) {
      const { code, stderr } = await calibrate(["--scenario", "PERF-036", "--rounds", rounds]);
      expect(code).toBe(1);
      expect(stderr).toContain("cannot show a spread");
    }
  });

  it("rejects an unknown flag rather than ignoring it", { timeout: 60_000 }, async () => {
    // Same stance as `run.ts`: a typo'd flag must never look like a clean run.
    const { code, stderr } = await calibrate(["--scenario", "PERF-036", "--round", "5"]);
    expect(code).toBe(1);
    expect(stderr).toContain("unknown flag");
  });

  it("rejects an unknown mode", { timeout: 60_000 }, async () => {
    const { code, stderr } = await calibrate(["--scenario", "PERF-036", "--mode", "hourly"]);
    expect(code).toBe(1);
    expect(stderr).toContain("unknown --mode");
  });
});
