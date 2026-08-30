// Diff two `PerfRunSummary` files into a comparability-aware delta table.
//
//   npm run perf compare -- before.json after.json
//
// The two existing diff tools (`memory-growth-compare`, `memory-bench-compare`)
// read bespoke result shapes and disagree on sign: one reports positive as
// better, the other positive as worse. Neither is reusable here, and the
// disagreement is the reason this file states its convention in the output
// header and applies it to every row.
//
// The invariant worth protecting: a delta that must not be trusted is never
// *computed*. `Delta.absolute === null` means withheld, and every renderer sees
// that in the data rather than having to remember a separate global flag.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  classifyMetric,
  comparabilityMarker,
  describeIncomparability,
  durationsComparable,
  isMachineIndependent,
  type ComparabilityClass,
} from "./lib/comparability";
import { round } from "./lib/stats";
import type { MetricStat, PerfRunSummary, ScenarioAggregate } from "./types";

const USAGE = "usage: npm run perf compare -- <before.json> <after.json>";

/**
 * Below this many iterations a p95 is decided by the top two or three
 * observations. `cold-start` uses the same floor for the same reason.
 */
const EXPLORATORY_P95_RUNS = 20;

/**
 * A fault in the invocation, not in the numbers. Only these exit non-zero: a
 * regression is a reported row, never a failure — this suite does not gate.
 */
export class UsageError extends Error {}

export interface Delta {
  before: number;
  after: number;
  /** null when the delta was withheld — see `withheldReason`. */
  absolute: number | null;
  /** null when withheld, or when a percentage is undefined (`before` is 0 or non-finite). */
  percentChange: number | null;
  /** Why the delta was withheld; null when it was computed. */
  withheldReason: string | null;
}

/** Which `MetricStat` field is the honest second reading for a metric class. */
export type SecondaryKind = "sum" | "mean";

export interface DurationRow {
  id: string;
  name: string;
  runsBefore: number;
  runsAfter: number;
  /** Headline: at these sample counts the median is the descriptive statistic to read. */
  median: Delta;
  /** Detail only, and exploratory below `EXPLORATORY_P95_RUNS` iterations. */
  p95: Delta;
  p95Exploratory: boolean;
  /**
   * A p50 of 0 in a run summary is a degenerate aggregate, not a measurement:
   * `run.ts` substitutes the wall-clock bracket for any non-positive sample, so
   * a current summary cannot reach zero honestly. Old files can, and a zero
   * baseline makes every delta on the row uninterpretable.
   */
  degenerateDuration: boolean;
}

export interface MetricRow {
  scenarioId: string;
  metric: string;
  cls: ComparabilityClass;
  machineIndependent: boolean;
  /** Headline for a count: a mean flattens the single iteration that spiked. */
  max: Delta;
  /**
   * `sum` for tallies and byte sizes, `mean` for levels. Summing per-iteration
   * memory readings or ratios produces a number with no interpretation.
   */
  secondaryKind: SecondaryKind;
  secondary: Delta;
  /** Iterations that reported the metric, per side. */
  countBefore: number;
  countAfter: number;
}

export interface MissingMetric {
  scenarioId: string;
  metric: string;
  side: "before" | "after";
}

export interface MeasurementIssue {
  scenarioId: string;
  side: "before" | "after";
  issue: string;
}

export interface ComparisonReport {
  beforeLabel: string;
  afterLabel: string;
  /** Whether durations, memory and unclassified metrics may be compared at all. */
  machineDependentComparable: boolean;
  /** Populated only when the machine-dependent comparison was refused. */
  incomparabilityReason: string | null;
  durationRows: DurationRow[];
  independentMetricRows: MetricRow[];
  dependentMetricRows: MetricRow[];
  scenariosOnlyInBefore: string[];
  scenariosOnlyInAfter: string[];
  metricsOnlyInOne: MissingMetric[];
  /** Recorded apparatus defects from either run. Surfaced, never summarised away. */
  measurementIssues: MeasurementIssue[];
  warnings: string[];
}

/**
 * `Math.abs(before)` in the denominator so a negative baseline — a heap delta
 * that was itself negative, say — does not invert the reported direction. That
 * makes this a signed normalised change rather than a conventional percentage
 * whenever the baseline is negative, which the report header says outright.
 */
function computeDelta(before: number, after: number): Delta {
  const finite = Number.isFinite(before) && Number.isFinite(after);
  const absolute = finite ? after - before : null;
  return {
    before,
    after,
    absolute,
    percentChange: finite && before !== 0 ? ((after - before) / Math.abs(before)) * 100 : null,
    withheldReason: null,
  };
}

function withhold(delta: Delta, reason: string): Delta {
  return { ...delta, absolute: null, percentChange: null, withheldReason: reason };
}

function secondaryKindFor(cls: ComparabilityClass): SecondaryKind {
  // A sum only means something when the samples are additive. Counts and byte
  // sizes are; a heap reading, a latency and a ratio are levels, not quantities.
  return cls === "count" || cls === "size" ? "sum" : "mean";
}

function metricRow(
  scenarioId: string,
  metric: string,
  before: MetricStat,
  after: MetricStat,
  machineRefusal: string | null
): MetricRow {
  const cls = classifyMetric(metric);
  const machineIndependent = isMachineIndependent(cls);
  const secondaryKind = secondaryKindFor(cls);

  let max = computeDelta(before.max, after.max);
  let secondary = computeDelta(before[secondaryKind], after[secondaryKind]);

  // Both readings are sample-count dependent: a sum shares no denominator, and
  // thirty iterations have more chances to draw a high max than four. Neither
  // survives a change in how many iterations reported the metric.
  if (before.count !== after.count) {
    const reason = `reported iterations differ (${before.count} vs ${after.count})`;
    max = withhold(max, reason);
    secondary = withhold(secondary, reason);
  }
  if (!machineIndependent && machineRefusal) {
    max = withhold(max, machineRefusal);
    secondary = withhold(secondary, machineRefusal);
  }

  return {
    scenarioId,
    metric,
    cls,
    machineIndependent,
    max,
    secondaryKind,
    secondary,
    countBefore: before.count,
    countAfter: after.count,
  };
}

function byId(aggregates: ScenarioAggregate[]): Map<string, ScenarioAggregate> {
  return new Map(aggregates.map((aggregate) => [aggregate.id, aggregate]));
}

export function buildComparison(before: PerfRunSummary, after: PerfRunSummary): ComparisonReport {
  const comparable = durationsComparable(before.environment, after.environment);
  const machineRefusal = comparable
    ? null
    : describeIncomparability(before.environment, after.environment);
  const beforeById = byId(before.aggregates);
  const afterById = byId(after.aggregates);

  const durationRows: DurationRow[] = [];
  const independentMetricRows: MetricRow[] = [];
  const dependentMetricRows: MetricRow[] = [];
  const metricsOnlyInOne: MissingMetric[] = [];
  const measurementIssues: MeasurementIssue[] = [];
  const warnings: string[] = [];

  for (const [id, beforeAggregate] of beforeById) {
    const afterAggregate = afterById.get(id);
    if (!afterAggregate) continue;

    const degenerateDuration = beforeAggregate.p50Ms <= 0 || afterAggregate.p50Ms <= 0;
    const degenerateReason = "a p50 of 0 is a degenerate aggregate, not a measurement";
    let median = computeDelta(beforeAggregate.p50Ms, afterAggregate.p50Ms);
    let p95 = computeDelta(beforeAggregate.p95Ms, afterAggregate.p95Ms);
    if (degenerateDuration) {
      median = withhold(median, degenerateReason);
      p95 = withhold(p95, degenerateReason);
    }
    if (machineRefusal) {
      median = withhold(median, machineRefusal);
      p95 = withhold(p95, machineRefusal);
    }

    durationRows.push({
      id,
      name: afterAggregate.name,
      runsBefore: beforeAggregate.runs,
      runsAfter: afterAggregate.runs,
      median,
      p95,
      p95Exploratory: Math.min(beforeAggregate.runs, afterAggregate.runs) < EXPLORATORY_P95_RUNS,
      degenerateDuration,
    });

    if (beforeAggregate.runs !== afterAggregate.runs) {
      warnings.push(
        `${id}: iteration counts differ (${beforeAggregate.runs} vs ${afterAggregate.runs}) — ` +
          "the two sides sampled different amounts of work"
      );
    }

    for (const [side, aggregate] of [
      ["before", beforeAggregate],
      ["after", afterAggregate],
    ] as const) {
      for (const issue of aggregate.measurementIssues) {
        measurementIssues.push({ scenarioId: id, side, issue });
      }
    }

    const metricNames = new Set([
      ...Object.keys(beforeAggregate.metricStats),
      ...Object.keys(afterAggregate.metricStats),
    ]);
    for (const metric of [...metricNames].sort()) {
      const beforeStat = beforeAggregate.metricStats[metric];
      const afterStat = afterAggregate.metricStats[metric];
      if (!beforeStat || !afterStat) {
        const side = beforeStat ? "before" : "after";
        metricsOnlyInOne.push({ scenarioId: id, metric, side });
        // A count that stopped being emitted is the dead-watcher shape as much
        // as a count that fell to zero, and it is easier to miss.
        if (side === "before" && classifyMetric(metric) === "count") {
          warnings.push(
            `${id}: count \`${metric}\` is no longer emitted — confirm the measurement still ` +
              "runs; an apparatus that stopped counting reads as work removed"
          );
        }
        continue;
      }

      const row = metricRow(id, metric, beforeStat, afterStat, machineRefusal);
      if (row.machineIndependent) independentMetricRows.push(row);
      else dependentMetricRows.push(row);

      // Same trap from the other direction: work removed and a dead watcher
      // produce the identical row, and this table cannot tell them apart.
      if (row.cls === "count" && beforeStat.max > 0 && afterStat.max === 0) {
        warnings.push(
          `${id}: \`${metric}\` fell to zero — confirm the paired correctness reading before ` +
            "calling it an improvement; a dead watcher looks exactly like this"
        );
      }
    }
  }

  if (before.mode !== after.mode) {
    warnings.push(
      `run modes differ (${before.mode} vs ${after.mode}) — iteration counts and scenario ` +
        "selection are mode-dependent, so the two runs did not do the same work"
    );
  }
  if (Date.parse(after.generatedAt) < Date.parse(before.generatedAt)) {
    warnings.push(
      `the "after" file (${after.generatedAt}) was generated before the "before" file ` +
        `(${before.generatedAt}) — check the argument order`
    );
  }
  if (durationRows.length === 0) {
    warnings.push("no scenario appears in both files — there is nothing to compare");
  }

  return {
    beforeLabel: before.label ?? "before",
    afterLabel: after.label ?? "after",
    machineDependentComparable: comparable,
    incomparabilityReason: machineRefusal,
    durationRows,
    independentMetricRows,
    dependentMetricRows,
    scenariosOnlyInBefore: [...beforeById.keys()].filter((id) => !afterById.has(id)),
    scenariosOnlyInAfter: [...afterById.keys()].filter((id) => !beforeById.has(id)),
    metricsOnlyInOne,
    measurementIssues,
    warnings,
  };
}

const WITHHELD = "REFUSED";

function num(value: number): string {
  // Three digits, matching what `run.ts` writes — two would silently collapse
  // distinct sub-millisecond readings into the same cell.
  return Number.isFinite(value) ? String(round(value, 3)) : "n/a";
}

function pair(delta: Delta): string {
  return `${num(delta.before)} → ${num(delta.after)}`;
}

function absolute(delta: Delta): string {
  if (delta.absolute === null) return WITHHELD;
  const rounded = round(delta.absolute, 3);
  return rounded > 0 ? `+${rounded}` : String(rounded);
}

function pct(delta: Delta): string {
  if (delta.withheldReason !== null) return WITHHELD;
  if (delta.percentChange === null) return "n/a";
  const sign = delta.percentChange > 0 ? "+" : "";
  return `${sign}${delta.percentChange.toFixed(1)}%`;
}

function reasons(...deltas: Delta[]): string[] {
  return [...new Set(deltas.map((delta) => delta.withheldReason).filter((r) => r !== null))];
}

function tableRow(cells: string[]): string {
  return `| ${cells.join(" | ")} |`;
}

function environmentLine(role: string, path: string, summary: PerfRunSummary): string {
  const env = summary.environment;
  return (
    `- **${role}** \`${path}\` — label \`${summary.label ?? "(none)"}\`, machine ` +
    `\`${env.machineLabel}\` (${env.platform}/${env.arch}), mode \`${summary.mode}\`, ` +
    `generated ${summary.generatedAt}`
  );
}

function metricTable(heading: string, subtitle: string, rows: MetricRow[]): string[] {
  if (rows.length === 0) return [];

  const lines = [
    "",
    `## ${heading}`,
    "",
    `_${subtitle}_`,
    "",
    "| Scenario | Metric | Class | max (before → after) | Δ max | Δ% max | 2nd reading | Reported N | Notes |",
    "| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- |",
  ];

  for (const row of rows) {
    const secondary = `${row.secondaryKind} ${pair(row.secondary)} (${pct(row.secondary)})`;
    lines.push(
      tableRow([
        row.scenarioId,
        row.metric,
        `${row.cls} ${comparabilityMarker(row.cls)}`,
        pair(row.max),
        absolute(row.max),
        pct(row.max),
        secondary,
        `${row.countBefore} → ${row.countAfter}`,
        reasons(row.max, row.secondary).join("; "),
      ])
    );
  }

  return lines;
}

function durationTable(report: ComparisonReport): string[] {
  if (report.durationRows.length === 0) return [];

  const lines = [
    "",
    "## Scenario duration",
    "",
    `_${comparabilityMarker("duration")} machine-dependent — comparable only against the same machine._`,
    "",
    "| Scenario | N (before → after) | median ms (before → after) | Δ median | Δ% median | p95 ms (before → after) | Δ% p95 | Notes |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |",
  ];

  for (const row of report.durationRows) {
    const notes = reasons(row.median, row.p95);
    if (row.p95Exploratory) {
      notes.push(`p95 exploratory (N < ${EXPLORATORY_P95_RUNS})`);
    }
    lines.push(
      tableRow([
        row.id,
        `${row.runsBefore} → ${row.runsAfter}`,
        pair(row.median),
        absolute(row.median),
        pct(row.median),
        pair(row.p95),
        pct(row.p95),
        notes.join("; "),
      ])
    );
  }

  return lines;
}

function differencesSection(report: ComparisonReport): string[] {
  const { scenariosOnlyInBefore, scenariosOnlyInAfter, metricsOnlyInOne } = report;
  if (
    scenariosOnlyInBefore.length === 0 &&
    scenariosOnlyInAfter.length === 0 &&
    metricsOnlyInOne.length === 0
  ) {
    return [];
  }

  const lines = ["", "## Not compared (present on one side only)", ""];
  if (scenariosOnlyInBefore.length > 0) {
    lines.push(`- Scenarios only in before: ${scenariosOnlyInBefore.join(", ")}`);
  }
  if (scenariosOnlyInAfter.length > 0) {
    lines.push(`- Scenarios only in after: ${scenariosOnlyInAfter.join(", ")}`);
  }
  for (const missing of metricsOnlyInOne) {
    lines.push(`- ${missing.scenarioId}: metric \`${missing.metric}\` only in ${missing.side}`);
  }
  return lines;
}

export function renderComparison(
  report: ComparisonReport,
  before: { path: string; summary: PerfRunSummary },
  after: { path: string; summary: PerfRunSummary }
): string {
  const lines = [
    `# perf compare — ${report.beforeLabel} → ${report.afterLabel}`,
    "",
    environmentLine("before", before.path, before.summary),
    environmentLine("after", after.path, after.summary),
    "",
    "**Sign convention:** every Δ is `after − before` and every Δ% is `(after − before) / |before|`.",
    "A positive number means the measured value went **up** — nothing more. Whether up is good is",
    "metric-specific: fewer git spawns is a win, fewer detected file changes is a broken watcher.",
    "With a negative baseline the `|before|` denominator keeps the direction honest, which makes the",
    "figure a signed normalised change rather than a conventional percentage.",
    `A \`${WITHHELD}\` cell is a delta this tool declined to compute; the row's Notes say why.`,
  ];

  if (report.machineDependentComparable) {
    lines.push(
      "",
      "Machine-dependent rows are compared: both runs come from the same machine, platform and architecture."
    );
  } else {
    lines.push(
      "",
      "## ⚠ Machine-dependent comparison REFUSED",
      "",
      `Reason: ${report.incomparabilityReason}.`,
      "",
      "Durations, memory and unclassified metrics measure the machine as much as the code, so no",
      "delta is computed for them — the raw readings are printed as a record of what each run",
      "measured, and subtracting them by eye is the mistake this refusal exists to prevent. Counts,",
      "sizes and ratios below are unaffected. To compare durations, run before and after on one",
      "machine."
    );
  }

  if (report.measurementIssues.length > 0) {
    lines.push("", "## ⚠ Measurement issues recorded by the runs", "");
    for (const issue of report.measurementIssues) {
      lines.push(`- ${issue.scenarioId} (${issue.side}): ${issue.issue}`);
    }
  }

  if (report.warnings.length > 0) {
    lines.push("", "## Warnings", "");
    for (const warning of report.warnings) lines.push(`- ${warning}`);
  }

  lines.push(
    ...metricTable(
      "Machine-independent metrics",
      `${comparabilityMarker("count")} counts, sizes and ratios — compare freely between any two runs.`,
      report.independentMetricRows
    ),
    ...metricTable(
      "Machine-dependent metrics",
      `${comparabilityMarker("duration")} durations, memory and unclassified metrics — comparable only against the same machine.`,
      report.dependentMetricRows
    ),
    ...durationTable(report),
    ...differencesSection(report)
  );

  lines.push(
    "",
    "---",
    "",
    "- The median is the headline for durations because it is the robust descriptive statistic here.",
    `  p95 is interpolated from the top order statistics, so below ${EXPLORATORY_P95_RUNS} iterations`,
    "  it is decided by the largest two or three observations — read its delta as exploratory.",
    "- `max` is the headline for a metric because a mean flattens the single iteration that spiked.",
    "  The second reading is a `sum` for counts and sizes and a `mean` for levels; both depend on how",
    "  many iterations reported the metric, so both are withheld when those counts differ.",
    "- This is a descriptive comparison of two sets of aggregates. A results file records neither the",
    "  per-iteration samples nor the order they were taken, so no interval or robust test of the",
    "  median is available from it. For a real latency claim, interleave the two arms on one machine",
    "  (`launch-ab` is the model).",
    ""
  );

  return lines.join("\n");
}

function requireNonBlank(value: unknown, field: string, filePath: string, role: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    // Without all three of these `durationsComparable` compares undefined to
    // undefined and answers "same machine" — the one false positive this tool
    // must never produce.
    throw new UsageError(
      `${role} file ${filePath} has no ${field} — regenerate it with a current perf run`
    );
  }
  return value;
}

export function loadSummary(filePath: string, role: string): PerfRunSummary {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (error) {
    throw new UsageError(
      `cannot read ${role} file ${filePath}: ${error instanceof Error ? error.message : error}`
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new UsageError(
      `${role} file ${filePath} is not valid JSON: ${error instanceof Error ? error.message : error}`
    );
  }

  const summary = parsed as Partial<PerfRunSummary>;
  if (!summary || typeof summary !== "object" || !Array.isArray(summary.aggregates)) {
    throw new UsageError(`${role} file ${filePath} is not a perf run summary (no "aggregates")`);
  }

  const environment = summary.environment;
  if (!environment || typeof environment !== "object") {
    throw new UsageError(`${role} file ${filePath} has no environment block`);
  }
  requireNonBlank(environment.machineLabel, "environment.machineLabel", filePath, role);
  requireNonBlank(environment.platform, "environment.platform", filePath, role);
  requireNonBlank(environment.arch, "environment.arch", filePath, role);

  return summary as PerfRunSummary;
}

function main(argv: string[]): number {
  const [beforePath, afterPath, ...extra] = argv;
  if (!beforePath || !afterPath || extra.length > 0) {
    console.error(USAGE);
    return 1;
  }

  let before: PerfRunSummary;
  let after: PerfRunSummary;
  try {
    before = loadSummary(beforePath, "before");
    after = loadSummary(afterPath, "after");
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(`[perf:compare] ${error.message}`);
      console.error(USAGE);
      return 1;
    }
    throw error;
  }

  console.log(
    renderComparison(
      buildComparison(before, after),
      { path: beforePath, summary: before },
      { path: afterPath, summary: after }
    )
  );
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Set the code rather than calling process.exit(), which can cut a piped
  // report off mid-table before stdout drains.
  process.exitCode = main(process.argv.slice(2));
}
