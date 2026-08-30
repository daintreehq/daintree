import { describe, expect, it } from "vitest";
import { buildMarkdownReport } from "../report/generate";
import { classifyMetric, comparabilityMarker } from "../lib/comparability";
import type { MetricStat, PerfRunSummary, ScenarioAggregate } from "../types";

function stat(overrides: Partial<MetricStat> = {}): MetricStat {
  return { mean: 1, max: 1, min: 1, sum: 1, count: 1, ...overrides };
}

function aggregate(overrides: Partial<ScenarioAggregate> = {}): ScenarioAggregate {
  return {
    id: "PERF-001",
    name: "scenario",
    description: "a scenario",
    tier: "fast",
    runs: 16,
    p50Ms: 12.5,
    p95Ms: 41.25,
    p99Ms: 58,
    maxMs: 60,
    meanMs: 15,
    stdDevMs: 4.5,
    metricAverages: {},
    metricStats: {},
    outsideReference: false,
    measurementIssues: [],
    notes: [],
    ...overrides,
  };
}

function summary(overrides: Partial<PerfRunSummary> = {}): PerfRunSummary {
  return {
    generatedAt: "2026-08-30T10:00:00.000Z",
    mode: "ci",
    nodeVersion: "v22.13.0",
    platform: "darwin",
    environment: {
      machineLabel: "greg-macbook",
      platform: "darwin",
      arch: "arm64",
      cpuModel: "Apple M3 Max",
      cpuCount: 16,
      totalMemoryMb: 65536,
      osRelease: "24.0.0",
      nodeVersion: "v22.13.0",
    },
    scenarioCount: 1,
    scenariosOutsideReference: [],
    aggregates: [aggregate()],
    ...overrides,
  };
}

function row(report: string, ...leading: string[]): string {
  const prefix = leading.join(" | ");
  const found = report.split("\n").find((line) => line.startsWith(`${prefix} |`));
  if (!found) throw new Error(`no row starting "${prefix}" in report:\n${report}`);
  return found;
}

function cells(line: string): string[] {
  return line.split(/(?<!\\)\|/).map((part) => part.trim());
}

describe("buildMarkdownReport", () => {
  it("reports each metric's max and sum, not just the mean that hides a spike", () => {
    // Twenty spawns in one iteration among fifteen quiet ones. The mean of 1.25
    // reads as "about one spawn"; max and sum are what make the storm visible.
    const report = buildMarkdownReport(
      summary({
        aggregates: [
          aggregate({
            metricStats: { gitSpawns: stat({ mean: 1.25, max: 20, min: 0, sum: 20, count: 16 }) },
          }),
        ],
      })
    );

    const header = cells(row(report, "Scenario", "Metric"));
    const values = cells(row(report, "PERF-001", "gitSpawns"));
    expect(values[header.indexOf("max")]).toBe("20");
    expect(values[header.indexOf("sum")]).toBe("20");
    expect(values[header.indexOf("mean")]).toBe("1.25");
    expect(values[header.indexOf("Samples")]).toBe("16");
  });

  it("marks a count as cross-machine comparable and a duration as not", () => {
    const report = buildMarkdownReport(
      summary({
        aggregates: [
          aggregate({
            metricStats: { gitSpawns: stat({ max: 4, sum: 4 }), applyMs: stat({ max: 9, sum: 9 }) },
          }),
        ],
      })
    );

    const header = cells(row(report, "Scenario", "Metric"));
    const column = header.indexOf("Comparable");
    const countCell = cells(row(report, "PERF-001", "gitSpawns"))[column];
    const durationCell = cells(row(report, "PERF-001", "applyMs"))[column];

    // The marker must come from the shared classifier rather than being guessed
    // per report, so a reclassification in comparability.ts reaches the table.
    expect(countCell).toContain(comparabilityMarker(classifyMetric("gitSpawns")));
    expect(countCell).toContain(classifyMetric("gitSpawns"));
    expect(durationCell).toContain(classifyMetric("applyMs"));
    expect(countCell).not.toBe(durationCell);
  });

  it("carries the machine identity a latency number can only be read against", () => {
    const report = buildMarkdownReport(summary());
    const machineLine = report.split("\n").find((line) => line.startsWith("- Machine:")) as string;

    expect(machineLine).toContain("greg-macbook");
    expect(machineLine).toContain("darwin");
    expect(machineLine).toContain("arm64");
    expect(report).toContain("Apple M3 Max");
    expect(report).toContain("65536");
    expect(report).toContain("24.0.0");
    // The latency table has to name the machine too: a reader who scrolls past
    // the header must still be told what these durations may be compared to.
    const latencyHeading = report.indexOf("## Latency");
    expect(report.slice(latencyHeading, latencyHeading + 400)).toContain("greg-macbook");
  });

  it("shows the run label only when the run carries one", () => {
    expect(buildMarkdownReport(summary({ label: "after" }))).toContain("- Label: after");
    expect(buildMarkdownReport(summary())).not.toContain("- Label:");
  });

  it("separates measurement issues from ordinary rows and puts them first", () => {
    const report = buildMarkdownReport(
      summary({
        scenarioCount: 2,
        aggregates: [
          aggregate({
            id: "PERF-BROKEN",
            measurementIssues: ["gitSpawns has a configured reference but was not emitted"],
          }),
          aggregate({ id: "PERF-FINE" }),
        ],
      })
    );

    const issues = report.indexOf("## Measurement issues");
    expect(issues).toBeGreaterThan(-1);
    expect(issues).toBeLessThan(report.indexOf("## Latency"));

    const section = report.slice(issues, report.indexOf("## Latency"));
    expect(section).toContain("PERF-BROKEN");
    expect(section).toContain("was not emitted");
    expect(section).not.toContain("PERF-FINE");

    expect(report).toContain("- Measurement issues: 1");

    // The row itself must not read clean either: a reader who jumps to the
    // table sees a scenario whose numbers mean nothing, and `outsideReference`
    // is deliberately false for a broken measurement.
    const header = cells(row(report, "ID", "Runs"));
    const column = header.indexOf("Annotation");
    expect(cells(row(report, "PERF-BROKEN", "16"))[column]).toBe("measurement issue");
    expect(cells(row(report, "PERF-FINE", "16"))[column]).not.toBe("measurement issue");
  });

  it("omits the measurement-issues section when the apparatus is intact", () => {
    const report = buildMarkdownReport(summary());
    expect(report).not.toContain("## Measurement issues");
    expect(report).toContain("- Measurement issues: 0");
  });

  it("annotates a scenario outside its reference without judging it", () => {
    const report = buildMarkdownReport(
      summary({
        scenariosOutsideReference: ["PERF-001"],
        aggregates: [
          aggregate({
            outsideReference: true,
            referenceNotes: "p95 41ms above the recorded reference of 30ms",
          }),
        ],
      })
    );

    const header = cells(row(report, "ID", "Runs"));
    const values = cells(row(report, "PERF-001", "16"));
    expect(values[header.indexOf("Annotation")]).toBe("outside reference");
    expect(values[header.indexOf("Notes")]).toContain("above the recorded reference");
    expect(report).toContain("- Outside a reference value: 1 (PERF-001)");
  });

  it("uses no pass/fail vocabulary anywhere it writes the words itself", () => {
    const report = buildMarkdownReport(
      summary({
        scenariosOutsideReference: ["PERF-001"],
        aggregates: [
          aggregate({
            outsideReference: true,
            referenceNotes: "above the recorded reference",
            measurementIssues: ["a metric stopped being emitted"],
            metricStats: { gitSpawns: stat() },
            notes: ["warmed up"],
          }),
        ],
      })
    );

    expect(report).not.toMatch(/\b(pass|passes|passed|fail|fails|failed|budget|budgets)\b/i);
  });

  it("leads the latency table with the median and keeps p95 as detail", () => {
    const header = cells(row(buildMarkdownReport(summary()), "ID", "Runs"));
    const median = header.indexOf("median (ms)");
    expect(median).toBeGreaterThan(-1);
    expect(median).toBeLessThan(header.indexOf("p95 (ms)"));
    expect(header.indexOf("p95 (ms)")).toBeLessThan(header.indexOf("p99 (ms)"));
  });

  it("keeps a non-finite measurement visible instead of dressing it as absent", () => {
    const report = buildMarkdownReport(
      summary({
        aggregates: [
          aggregate({
            p95Ms: Number.NaN,
            metricStats: { spawnCount: stat({ mean: Number.NaN, max: Number.NaN, sum: 3 }) },
          }),
        ],
      })
    );

    const latency = cells(row(report, "PERF-001", "16"));
    const metric = cells(row(report, "PERF-001", "spawnCount"));
    expect(latency).toContain("NaN");
    expect(metric).toContain("NaN");
    // "n/a" would read as "this scenario does not report that number", which is
    // the reassuring reading of the two and the wrong one.
    expect([...latency, ...metric]).not.toContain("n/a");

    // The producer only inspects p95 and metrics carrying a configured
    // reference, so nothing upstream flagged this run at all.
    const header = cells(row(report, "ID", "Runs"));
    expect(latency[header.indexOf("Annotation")]).toBe("measurement issue");
    const issues = report.slice(report.indexOf("## Measurement issues"));
    expect(issues).toContain("p95");
    expect(issues).toContain("spawnCount");
    expect(report).not.toContain("- Measurement issues: 0");
  });

  it("keeps scenario text inside its own table cell", () => {
    const report = buildMarkdownReport(
      summary({ aggregates: [aggregate({ notes: ["a | b\nc"] })] })
    );

    const line = row(report, "PERF-001", "16");
    expect(line).toContain("a \\| b c");
    expect(cells(line)).toHaveLength(cells(row(report, "ID", "Runs")).length);
  });

  it("says so explicitly when no scenario reported a metric", () => {
    expect(buildMarkdownReport(summary())).toContain("No scenario reported a metric value.");
  });

  it("renders without the comparison argument the caller may no longer pass", () => {
    expect(() => buildMarkdownReport(summary())).not.toThrow();
    expect(buildMarkdownReport(summary())).not.toContain("A/B comparison");
  });

  it("escapes a pipe in an id or a metric name so the columns cannot shift", () => {
    const report = buildMarkdownReport(
      summary({
        aggregates: [
          aggregate({ id: "PERF|001", metricStats: { "cache|hits": stat({ max: 5, sum: 5 }) } }),
        ],
      })
    );

    const width = cells(row(report, "Scenario", "Metric")).length;
    expect(cells(row(report, "PERF\\|001", "cache\\|hits"))).toHaveLength(width);
    expect(cells(row(report, "PERF\\|001", "16"))).toHaveLength(
      cells(row(report, "ID", "Runs")).length
    );
  });
});
