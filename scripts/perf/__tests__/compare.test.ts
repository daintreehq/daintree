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
    scenarioCount: aggregates.length,
    scenariosOutsideReference: [],
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
});
