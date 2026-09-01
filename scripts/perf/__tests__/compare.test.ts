import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildComparison, loadSummary, renderComparison, UsageError } from "../compare";
import type { MetricStat, PerfRunSummary, RunEnvironment, ScenarioAggregate } from "../types";

const perfDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const repoRoot = path.resolve(perfDir, "..", "..");

const MAC: RunEnvironment = {
  machineLabel: "greg-macbook",
  platform: "darwin",
  arch: "arm64",
  cpuModel: "Apple M3 Max",
  cpuCount: 16,
  totalMemoryMb: 65536,
  osRelease: "24.0.0",
  nodeVersion: "v22.13.0",
  electronVersion: "42.0.0",
  gitVersion: "2.45.2",
  sourceSha: "0dbb0b4",
};

const WINDOWS: RunEnvironment = {
  ...MAC,
  machineLabel: "greg-thinkpad",
  platform: "win32",
  arch: "x64",
  cpuModel: "Intel Core Ultra 7",
  osRelease: "10.0.22631",
};

function stat(overrides: Partial<MetricStat> & Pick<MetricStat, "max" | "sum">): MetricStat {
  return {
    mean: overrides.sum / (overrides.count ?? 8),
    min: 0,
    count: 8,
    ...overrides,
  };
}

function scenario(
  id: string,
  p50Ms: number,
  metricStats: Record<string, MetricStat>,
  overrides: Partial<ScenarioAggregate> = {}
): ScenarioAggregate {
  return {
    id,
    name: `${id} scenario`,
    description: "fixture",
    tier: "fast",
    runs: 8,
    p50Ms,
    p95Ms: p50Ms * 1.5,
    p99Ms: p50Ms * 1.8,
    maxMs: p50Ms * 2,
    meanMs: p50Ms,
    stdDevMs: 1,
    metricAverages: {},
    metricStats,
    outsideReference: false,
    measurementIssues: [],
    notes: [],
    ...overrides,
  };
}

function summary(
  label: string,
  environment: RunEnvironment,
  aggregates: ScenarioAggregate[],
  overrides: Partial<PerfRunSummary> = {}
): PerfRunSummary {
  return {
    generatedAt: "2026-08-30T10:00:00.000Z",
    mode: "smoke",
    nodeVersion: "v22.13.0",
    platform: environment.platform,
    label,
    environment,
    // Both sides default to the same protocol so a fixture pair is comparable
    // unless a test deliberately overrides it — the machine/protocol refusals
    // are what several of these cases are about.
    protocol: { iterations: null, warmups: null, scenarioSelection: null },
    scenarioCount: aggregates.length,
    scenariosOutsideReference: [],
    scenariosSkipped: [],
    aggregates,
    ...overrides,
  };
}

function render(before: PerfRunSummary, after: PerfRunSummary): string {
  return renderComparison(
    buildComparison(before, after),
    { path: "before.json", summary: before },
    { path: "after.json", summary: after }
  );
}

/** Cells of the first rendered table row whose first cell is `id`. */
function rowCells(output: string, id: string): string[][] {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith(`| ${id} |`))
    .map((line) =>
      line
        .split("|")
        .slice(1, -1)
        .map((cell) => cell.trim())
    );
}

const beforeMac = summary("before", MAC, [
  scenario("PERF-105", 200, { gitSpawns: stat({ max: 12, sum: 40 }) }),
]);
const afterMac = summary("after", MAC, [
  scenario("PERF-105", 150, { gitSpawns: stat({ max: 3, sum: 10 }) }),
]);

describe("buildComparison", () => {
  it("reports a count improvement as a negative delta", () => {
    const row = buildComparison(beforeMac, afterMac).independentMetricRows[0];

    expect(row.metric).toBe("gitSpawns");
    expect(row.cls).toBe("count");
    expect(row.max.absolute).toBe(-9);
    expect(row.max.percentChange).toBe(-75);
    expect(row.secondaryKind).toBe("sum");
    expect(row.secondary.percentChange).toBe(-75);
  });

  it("uses the same sign convention when a number grows", () => {
    const report = buildComparison(afterMac, beforeMac);
    expect(report.independentMetricRows[0].max.percentChange).toBe(300);
    expect(report.durationRows[0].median.absolute).toBe(50);
  });

  it("compares durations on the same machine, headlining the median", () => {
    const report = buildComparison(beforeMac, afterMac);
    const row = report.durationRows[0];

    expect(report.machineDependentComparable).toBe(true);
    expect(report.incomparabilityReason).toBeNull();
    expect(row.median.absolute).toBe(-50);
    expect(row.median.percentChange).toBe(-25);
    expect(row.p95.percentChange).toBe(-25);
    // 8 iterations is well under the floor where a p95 stops being tail-ish.
    expect(row.p95Exploratory).toBe(true);
  });

  it("summarises a level with its mean and a tally with its sum", () => {
    const before = summary("before", MAC, [
      scenario("PERF-105", 200, {
        gitSpawns: stat({ max: 12, sum: 40 }),
        rendererHeapMb: stat({ max: 812, sum: 6000 }),
      }),
    ]);
    const after = summary("after", MAC, [
      scenario("PERF-105", 200, {
        gitSpawns: stat({ max: 3, sum: 10 }),
        rendererHeapMb: stat({ max: 790, sum: 5800 }),
      }),
    ]);
    const report = buildComparison(before, after);

    expect(report.independentMetricRows[0].secondaryKind).toBe("sum");
    // Summed per-iteration heap readings mean nothing; the mean of them does.
    expect(report.dependentMetricRows[0].secondaryKind).toBe("mean");
    expect(report.dependentMetricRows[0].secondary.before).toBe(6000 / 8);
  });
});

describe("cross-machine refusal", () => {
  const beforeCross = summary("before", MAC, [
    scenario("PERF-105", 200, {
      gitSpawns: stat({ max: 12, sum: 40 }),
      rendererHeapMb: stat({ max: 812, sum: 6000 }),
    }),
  ]);
  const afterWindows = summary("after", WINDOWS, [
    scenario("PERF-105", 340, {
      gitSpawns: stat({ max: 34, sum: 90 }),
      rendererHeapMb: stat({ max: 940, sum: 7100 }),
    }),
  ]);

  it("computes no machine-dependent delta at all", () => {
    const report = buildComparison(beforeCross, afterWindows);

    expect(report.machineDependentComparable).toBe(false);
    expect(report.incomparabilityReason).toContain("greg-macbook");
    expect(report.incomparabilityReason).toContain("greg-thinkpad");

    // The invariant: a refused delta is never computed, so no consumer of the
    // report — this renderer or a future one — can display it by accident.
    const duration = report.durationRows[0];
    expect(duration.median.absolute).toBeNull();
    expect(duration.median.percentChange).toBeNull();
    expect(duration.p95.absolute).toBeNull();
    expect(duration.median.withheldReason).toBe(report.incomparabilityReason);

    const heap = report.dependentMetricRows[0];
    expect(heap.cls).toBe("memory");
    expect(heap.max.absolute).toBeNull();
    expect(heap.secondary.absolute).toBeNull();

    // Counts survive the refusal — that cross-machine comparison is the point.
    const spawns = report.independentMetricRows[0];
    expect(spawns.max.absolute).toBe(22);
    expect(spawns.max.percentChange).toBeCloseTo(183.333, 3);
  });

  it("renders REFUSED in every machine-dependent delta cell and nowhere else", () => {
    const output = render(beforeCross, afterWindows);

    // Duration row: N | median pair | Δ median | Δ% median | p95 pair | Δ% p95 | notes
    const [countRow, heapRow, durationRow] = rowCells(output, "PERF-105");
    expect(durationRow.slice(3, 5)).toEqual(["REFUSED", "REFUSED"]);
    expect(durationRow[6]).toBe("REFUSED");
    expect(durationRow[2]).toBe("200 → 340");
    expect(durationRow[7]).toContain("different machines");

    // Metric rows: scenario | metric | class | max pair | Δ max | Δ% max | 2nd | N | notes
    expect(heapRow[1]).toBe("rendererHeapMb");
    expect(heapRow.slice(4, 6)).toEqual(["REFUSED", "REFUSED"]);
    expect(heapRow[6]).toContain("REFUSED");

    expect(countRow[1]).toBe("gitSpawns");
    expect(countRow[4]).toBe("+22");
    expect(countRow[5]).toBe("+183.3%");
    expect(countRow[8]).toBe("");
  });
});

describe("protocol refusal", () => {
  // Same machine is necessary but not sufficient. A `--warmups 0` run still
  // carries cold-start cost a warmed run has already paid, so pairing them
  // reports a difference in how the benchmark was driven as though it were a
  // difference in the code. Both sides can report the same `runs`, so the
  // measured iteration count cannot reveal it.
  const cold = summary("before", MAC, [scenario("PERF-1", 10, {})], {
    protocol: { iterations: 2, warmups: 0, scenarioSelection: null },
  });
  const warm = summary("after", MAC, [scenario("PERF-1", 5, {})], {
    protocol: { iterations: 2, warmups: null, scenarioSelection: null },
  });

  it("refuses machine-dependent rows when warmups differ on the same machine", () => {
    const report = buildComparison(cold, warm);
    expect(report.machineDependentComparable).toBe(false);
    expect(report.incomparabilityReason).toContain("warmup");
  });

  it("refuses when the iteration override differs", () => {
    const other = summary("after", MAC, [scenario("PERF-1", 5, {})], {
      protocol: { iterations: 8, warmups: 0, scenarioSelection: null },
    });
    expect(buildComparison(cold, other).incomparabilityReason).toContain("iteration");
  });

  it("refuses a summary that predates protocol recording rather than assuming", () => {
    // Absence is exactly the case where a protocol difference goes unnoticed,
    // so it must not read as agreement.
    const legacy = summary("before", MAC, [scenario("PERF-1", 10, {})], {
      protocol: undefined as unknown as PerfRunSummary["protocol"],
    });
    expect(buildComparison(legacy, warm).incomparabilityReason).toContain("predates");
  });

  it("still compares machine-independent counts across a protocol mismatch", () => {
    // A tally does not care how many warmups preceded it.
    const withCount = (label: string, value: number, warmups: number | null) =>
      summary(
        label,
        MAC,
        [scenario("PERF-1", 10, { gitSpawns: stat({ max: value, sum: value }) })],
        {
          protocol: { iterations: 2, warmups, scenarioSelection: null },
        }
      );
    const report = buildComparison(withCount("before", 8, 0), withCount("after", 2, null));
    expect(report.machineDependentComparable).toBe(false);
    expect(report.independentMetricRows.length).toBeGreaterThan(0);
    expect(report.independentMetricRows[0]?.max.absolute).not.toBeNull();
  });
});

describe("scenario-selection refusal", () => {
  // A scenario measured alone and the same scenario measured beside the rest of
  // the matrix ran in different process conditions — heap occupancy, GC
  // pressure, page cache, thermal headroom. The per-scenario numbers look
  // pairable, which is what makes this one worth refusing rather than noting.
  const selected = (label: string, p50: number, selection: string[] | null) =>
    summary(label, MAC, [scenario("PERF-105", p50, { gitSpawns: stat({ max: 6, sum: 24 }) })], {
      protocol: { iterations: null, warmups: null, scenarioSelection: selection },
    });

  it("refuses machine-dependent rows when a filtered run meets a full one", () => {
    const report = buildComparison(
      selected("before", 200, null),
      selected("after", 150, ["PERF-105"])
    );

    expect(report.machineDependentComparable).toBe(false);
    expect(report.incomparabilityReason).toContain("scenario selection");
    expect(report.incomparabilityReason).toContain("the whole matrix");
    expect(report.incomparabilityReason).toContain("PERF-105");
    expect(report.durationRows[0].median.absolute).toBeNull();
    // The count is unaffected: a tally inside PERF-105 does not care what else
    // the run executed, which is why refusing the durations costs nothing real.
    expect(report.independentMetricRows[0].max.absolute).toBe(0);
  });

  it("refuses two different filters even when both contain the compared scenario", () => {
    const report = buildComparison(
      selected("before", 200, ["PERF-105"]),
      selected("after", 150, ["PERF-105", "PERF-106"])
    );

    expect(report.incomparabilityReason).toContain("scenario selection");
  });

  it("accepts the same selection typed in a different order", () => {
    // `run.ts` records the ids as typed and runs them in registry order, so the
    // array order is not part of the protocol.
    const report = buildComparison(
      selected("before", 200, ["PERF-106", "PERF-105"]),
      selected("after", 150, ["PERF-105", "PERF-106"])
    );

    expect(report.machineDependentComparable).toBe(true);
    expect(report.incomparabilityReason).toBeNull();
    expect(report.warnings).toEqual([]);
  });

  it("names the mismatch in the warnings even when another refusal fires first", () => {
    // `refusalReason` reports only its first finding, so without this a reader
    // who fixed the machine would meet the selection mismatch on attempt two.
    const beforeFull = selected("before", 200, null);
    const afterFiltered = summary(
      "after",
      WINDOWS,
      [scenario("PERF-105", 150, { gitSpawns: stat({ max: 6, sum: 24 }) })],
      { protocol: { iterations: null, warmups: null, scenarioSelection: ["PERF-105"] } }
    );
    const report = buildComparison(beforeFull, afterFiltered);

    expect(report.incomparabilityReason).toContain("different machines");
    expect(report.warnings.join("\n")).toContain("scenario selection differs");
  });

  it("puts the refusal and the mismatch in the rendered output", () => {
    const output = render(selected("before", 200, null), selected("after", 150, ["PERF-105"]));

    expect(output).toContain("Machine-dependent comparison REFUSED");
    expect(output).toContain("different scenario selections");
    expect(output).toContain("scenario selection differs");
    expect(rowCells(output, "PERF-105")[1].slice(3, 5)).toEqual(["REFUSED", "REFUSED"]);
  });
});

describe("withheld comparisons", () => {
  it("withholds both metric readings when the reporting iteration counts differ", () => {
    const before = summary("before", MAC, [
      scenario("PERF-105", 200, { gitSpawns: stat({ max: 4, sum: 8, count: 2 }) }),
    ]);
    const after = summary("after", MAC, [
      scenario("PERF-105", 200, { gitSpawns: stat({ max: 9, sum: 16, count: 8 }) }),
    ]);
    const row = buildComparison(before, after).independentMetricRows[0];

    // More iterations means more chances to draw a high max, so max is no more
    // comparable here than the sum is.
    expect(row.max.absolute).toBeNull();
    expect(row.secondary.absolute).toBeNull();
    expect(row.max.withheldReason).toContain("reported iterations differ");
  });

  it("withholds a duration row built on a zero median rather than dividing by it", () => {
    const before = summary("before", MAC, [scenario("PERF-105", 0, {})]);
    const after = summary("after", MAC, [scenario("PERF-105", 150, {})]);
    const row = buildComparison(before, after).durationRows[0];

    expect(row.degenerateDuration).toBe(true);
    expect(row.median.absolute).toBeNull();
    expect(row.p95.absolute).toBeNull();
    expect(render(before, after)).toContain("degenerate aggregate");
  });

  it("keeps the direction of change when the baseline is negative", () => {
    const before = summary("before", MAC, [
      scenario("PERF-105", 200, { heapDeltaMb: stat({ max: -10, sum: -40 }) }),
    ]);
    const after = summary("after", MAC, [
      scenario("PERF-105", 200, { heapDeltaMb: stat({ max: -5, sum: -20 }) }),
    ]);
    // -10 → -5 is a rise of 5 on a baseline of magnitude 10, i.e. +50%, not -50%.
    expect(buildComparison(before, after).dependentMetricRows[0].max.percentChange).toBe(50);
  });
});

describe("structural differences", () => {
  it("names scenarios present on only one side instead of dropping them", () => {
    const before = summary("before", MAC, [
      scenario("PERF-105", 200, {}),
      scenario("PERF-999", 50, {}),
    ]);
    const after = summary("after", MAC, [
      scenario("PERF-105", 200, {}),
      scenario("PERF-777", 5, {}),
    ]);
    const report = buildComparison(before, after);

    expect(report.scenariosOnlyInBefore).toEqual(["PERF-999"]);
    expect(report.scenariosOnlyInAfter).toEqual(["PERF-777"]);
    expect(report.durationRows).toHaveLength(1);

    const output = render(before, after);
    expect(output).toContain("Scenarios only in before: PERF-999");
    expect(output).toContain("Scenarios only in after: PERF-777");
  });

  it("names metrics present on only one side", () => {
    const before = summary("before", MAC, [
      scenario("PERF-105", 200, { gitSpawns: stat({ max: 4, sum: 8 }) }),
    ]);
    const after = summary("after", MAC, [
      scenario("PERF-105", 200, { ipcMessages: stat({ max: 9, sum: 20 }) }),
    ]);
    const report = buildComparison(before, after);

    expect(report.independentMetricRows).toHaveLength(0);
    expect(report.metricsOnlyInOne).toEqual([
      { scenarioId: "PERF-105", metric: "gitSpawns", side: "before" },
      { scenarioId: "PERF-105", metric: "ipcMessages", side: "after" },
    ]);
    expect(render(before, after)).toContain("only in after");
  });
});

describe("warnings", () => {
  it("flags both shapes of a vanished count, and leaves an ordinary drop alone", () => {
    const before = summary("before", MAC, [
      scenario("PERF-105", 200, {
        gitSpawns: stat({ max: 34, sum: 120 }),
        watcherRearms: stat({ max: 5, sum: 20 }),
      }),
    ]);
    const zeroed = summary("after", MAC, [
      scenario("PERF-105", 200, {
        gitSpawns: stat({ max: 0, sum: 0 }),
        watcherRearms: stat({ max: 5, sum: 20 }),
      }),
    ]);
    const dropped = summary("after", MAC, [
      scenario("PERF-105", 200, { watcherRearms: stat({ max: 5, sum: 20 }) }),
    ]);

    expect(buildComparison(before, zeroed).warnings.join("\n")).toContain("fell to zero");
    expect(buildComparison(before, dropped).warnings.join("\n")).toContain("is no longer emitted");
    // A count that merely shrank is an ordinary row, not a warning.
    expect(buildComparison(beforeMac, afterMac).warnings).toEqual([]);
  });

  it("warns about mismatched iteration counts, modes and argument order", () => {
    const before = summary("before", MAC, [scenario("PERF-105", 200, {}, { runs: 4 })], {
      generatedAt: "2026-08-30T12:00:00.000Z",
    });
    const after = summary("after", MAC, [scenario("PERF-105", 200, {}, { runs: 20 })], {
      mode: "ci",
      generatedAt: "2026-08-30T09:00:00.000Z",
    });
    const warnings = buildComparison(before, after).warnings.join("\n");

    expect(warnings).toContain("iteration counts differ");
    expect(warnings).toContain("run modes differ");
    expect(warnings).toContain("check the argument order");
  });

  it("warns about a toolchain change without refusing the comparison", () => {
    // A git upgrade moves subprocess counts on its own, but the refusal path is
    // the wrong instrument: it withholds machine-dependent rows, and a spawn
    // count is machine-INdependent and would sail straight through it.
    const newerGit = summary("after", { ...MAC, gitVersion: "2.48.0", electronVersion: "43.0.0" }, [
      scenario("PERF-105", 150, { gitSpawns: stat({ max: 3, sum: 10 }) }),
    ]);
    const report = buildComparison(beforeMac, newerGit);
    const warnings = report.warnings.join("\n");

    expect(warnings).toContain("git version differs (2.45.2 vs 2.48.0)");
    expect(warnings).toContain("Electron version differs (42.0.0 vs 43.0.0)");
    expect(report.machineDependentComparable).toBe(true);
    expect(report.independentMetricRows[0].max.absolute).toBe(-9);
  });

  it("never refuses or warns on a differing commit, which is the point of the tool", () => {
    const other = summary("after", { ...MAC, sourceSha: "deadbee" }, [
      scenario("PERF-105", 150, { gitSpawns: stat({ max: 3, sum: 10 }) }),
    ]);
    const report = buildComparison(beforeMac, other);

    expect(report.machineDependentComparable).toBe(true);
    expect(report.warnings).toEqual([]);
  });

  it("stays quiet when one side simply did not record a version", () => {
    // A null is "not recorded", not a change. Warning on it would fire against
    // every older file and train the reader to skip the section.
    const unrecorded = summary("after", { ...MAC, gitVersion: null }, [
      scenario("PERF-105", 150, { gitSpawns: stat({ max: 3, sum: 10 }) }),
    ]);
    expect(buildComparison(beforeMac, unrecorded).warnings).toEqual([]);
  });

  it("surfaces recorded measurement issues from both sides", () => {
    const before = summary("before", MAC, [
      scenario("PERF-105", 200, {}, { measurementIssues: ["gitSpawns stopped being emitted"] }),
    ]);
    const after = summary("after", MAC, [scenario("PERF-105", 200, {})]);
    const report = buildComparison(before, after);

    expect(report.measurementIssues).toEqual([
      { scenarioId: "PERF-105", side: "before", issue: "gitSpawns stopped being emitted" },
    ]);
    expect(render(before, after)).toContain("Measurement issues recorded by the runs");
  });
});

describe("loadSummary", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "perf-compare-"));

  function fixture(name: string, data: unknown): string {
    const filePath = path.join(dir, name);
    writeFileSync(filePath, JSON.stringify(data), "utf8");
    return filePath;
  }

  it("accepts a well-formed summary", () => {
    expect(loadSummary(fixture("ok.json", beforeMac), "before").mode).toBe("smoke");
  });

  it("rejects a blank machine label rather than letting two blanks match", () => {
    const blank = fixture("blank.json", {
      ...beforeMac,
      environment: { ...MAC, machineLabel: "   " },
    });
    expect(() => loadSummary(blank, "before")).toThrow(/machineLabel/);
  });

  it("rejects a summary with no platform or arch", () => {
    const partial = fixture("partial.json", {
      ...beforeMac,
      environment: { machineLabel: "greg-macbook" },
    });
    expect(() => loadSummary(partial, "before")).toThrow(/environment\.platform/);
  });

  it("rejects a file that is not a run summary", () => {
    expect(() => loadSummary(fixture("junk.json", { hello: "world" }), "after")).toThrow(
      UsageError
    );
  });
});

describe("cli", () => {
  function run(...args: string[]) {
    return spawnSync(
      process.execPath,
      ["--import", "tsx", path.join(perfDir, "compare.ts"), ...args],
      {
        cwd: repoRoot,
        encoding: "utf8",
      }
    );
  }

  it("exits 1 on a usage error and says how to invoke it", () => {
    const result = run(path.join(repoRoot, "no-such-file.json"));

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("usage:");
  });

  it("exits 0 on a refusal, and says so loudly enough that nobody reads it as a pass", () => {
    // The suite never fails a build for a number, so a refusal cannot use the
    // exit code. That makes the *output* the whole signal, and a caller that
    // checks only the status must not be able to mistake this for a comparison.
    const dir = mkdtempSync(path.join(tmpdir(), "perf-compare-cli-"));
    const write = (name: string, data: PerfRunSummary) => {
      const filePath = path.join(dir, name);
      writeFileSync(filePath, JSON.stringify(data), "utf8");
      return filePath;
    };
    const filtered = summary("after", MAC, [scenario("PERF-105", 150, {})], {
      protocol: { iterations: null, warmups: null, scenarioSelection: ["PERF-105"] },
    });
    const result = run(write("before.json", beforeMac), write("after.json", filtered));

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Machine-dependent comparison REFUSED");
    expect(result.stdout).toContain("different scenario selections");
    expect(result.stdout).toContain("REFUSED");
  });
});

describe("harness identity", () => {
  /**
   * Two runs of one scenario on one machine at one iteration count are still
   * not comparable if `scripts/perf` changed between them, and every field a
   * reader would check matches. The hash is the only evidence, so the warning
   * built on it has to appear — and has to stay a warning, because refusing
   * every comparison across an unrelated harness edit is how a check becomes
   * something people route around.
   */
  const withHarness = (label: string, hash: string | null | undefined) =>
    summary(label, MAC, [scenario("PERF-105", 200, {})], {
      protocol: {
        iterations: null,
        warmups: null,
        scenarioSelection: null,
        ...(hash === undefined ? {} : { harnessHash: hash }),
      },
    });

  it("warns when the two runs were measured by different harnesses", () => {
    const output = render(
      withHarness("before", "aaaaaaaaaaaaaaaa"),
      withHarness("after", "bbbbbbbbbbbbbbbb")
    );
    expect(output).toContain("the harness itself differs between the two runs");
    expect(output).toContain("aaaaaaaaaaaaaaaa");
    // A warning, not a refusal: the durations are still shown and judged.
    expect(output).not.toContain("Machine-dependent comparison REFUSED");
  });

  it("says nothing when both sides carry the same hash", () => {
    const output = render(
      withHarness("before", "aaaaaaaaaaaaaaaa"),
      withHarness("after", "aaaaaaaaaaaaaaaa")
    );
    expect(output).not.toContain("the harness itself differs");
    expect(output).not.toContain("could not record a harness hash");
  });

  it("distinguishes a hash that failed from one that was never recorded", () => {
    // null means the harness tried and could not; absent means the summary
    // predates the field. Only the first is worth a line, because only the
    // first describes a run this harness produced.
    expect(render(withHarness("before", null), withHarness("after", "aaaaaaaaaaaaaaaa"))).toContain(
      "could not record a harness hash"
    );
    expect(render(withHarness("before", undefined), withHarness("after", undefined))).not.toContain(
      "could not record a harness hash"
    );
  });
});

describe("benchmark class in a comparison", () => {
  it("says when a compared scenario is a floor or a simulation", () => {
    // "PERF-196 improved 18%" is true and is not a product claim: PERF-196 is a
    // declared parser floor that production does not take. Nothing else in the
    // comparison output carries that.
    const withKind = (label: string) =>
      summary(label, MAC, [{ ...scenario("PERF-196", 200, {}), kind: "diagnostic" as const }]);
    const output = render(withKind("before"), withKind("after"));
    expect(output).toContain("PERF-196");
    expect(output).toContain("classified `diagnostic`");
  });

  it("says nothing for an ordinary mechanism benchmark", () => {
    const withKind = (label: string) =>
      summary(label, MAC, [{ ...scenario("PERF-105", 200, {}), kind: "mechanism" as const }]);
    expect(render(withKind("before"), withKind("after"))).not.toContain("classified `diagnostic`");
  });

  it("does not withhold the diagnostic row", () => {
    // A floor's delta is still worth reading — it catches a parser regression.
    // The warning is a label on the number, not a refusal of it.
    const withKind = (label: string, p50: number) =>
      summary(label, MAC, [{ ...scenario("PERF-196", p50, {}), kind: "diagnostic" as const }]);
    const output = render(withKind("before", 200), withKind("after", 100));
    // Asserted on the ROW, not on the whole document: the reading guide
    // explains what a refusal looks like, so the word appears either way.
    const cells = rowCells(output, "PERF-196")[0];
    expect(cells).toBeDefined();
    expect(cells!.join(" ")).not.toContain("REFUSED");
    expect(cells!.join(" ")).toContain("-50");
  });
});
