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
import type { MetricStat, PerfRunSummary, RunProtocol, ScenarioAggregate } from "./types";

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

/**
 * `--scenario` as a set, since `run.ts` records the ids in the order they were
 * typed while executing them in registry order. `A,B` and `B,A` are one run.
 */
function describeSelection(selection: string[] | null): string {
  return selection === null ? "the whole matrix" : [...selection].sort().join(",");
}

function selectionsDiffer(before: RunProtocol, after: RunProtocol): boolean {
  return describeSelection(before.scenarioSelection) !== describeSelection(after.scenarioSelection);
}

/**
 * Why two runs' machine-dependent figures cannot be compared, or null.
 *
 * Machine is the obvious half. Protocol is the half that is easy to miss: a
 * `--warmups 0` run still carries cold-start cost that a warmed run has already
 * paid, so pairing one against the other reports a difference in how the
 * benchmark was driven as though it were a difference in the code. The measured
 * iteration count does not reveal it — both sides can report the same `runs`.
 */
function refusalReason(before: PerfRunSummary, after: PerfRunSummary): string | null {
  if (!durationsComparable(before.environment, after.environment)) {
    return describeIncomparability(before.environment, after.environment);
  }

  // A summary written before `protocol` existed cannot prove it was driven the
  // same way. Refusing beats guessing: the whole point of this check is that an
  // unnoticed protocol difference is reported as a code difference, and an
  // absent record is exactly the case where it would go unnoticed.
  if (before.protocol === undefined || after.protocol === undefined) {
    return "one run predates protocol recording, so identical sampling cannot be confirmed";
  }

  const describe = (value: number | null, fallback: string) =>
    value === null ? fallback : String(value);

  if (before.protocol.warmups !== after.protocol.warmups) {
    return `different warmup counts (${describe(before.protocol.warmups, "per-scenario default")} vs ${describe(after.protocol.warmups, "per-scenario default")})`;
  }
  if (before.protocol.iterations !== after.protocol.iterations) {
    return `different iteration counts (${describe(before.protocol.iterations, "per-mode default")} vs ${describe(after.protocol.iterations, "per-mode default")})`;
  }

  // A refusal rather than a warning, and the choice is not obvious: scenario
  // A's number against scenario A's number stays a like-for-like reading of the
  // same work, so the case for a warning is real. It loses because the
  // surrounding run is part of the measurement. Every scenario in a run shares
  // one process and one machine — heap occupancy, JIT state, GC pressure, page
  // cache and thermal headroom all arrive at scenario A differently when it
  // runs alone than when it runs fortieth. That is the same class of
  // difference as `--warmups 0`, which is already refused, and it lands on
  // exactly the same rows: counts, sizes and structural ratios survive
  // untouched, so refusing costs nothing that was actually comparable.
  if (selectionsDiffer(before.protocol, after.protocol)) {
    return `different scenario selections (${describeSelection(before.protocol.scenarioSelection)} vs ${describeSelection(after.protocol.scenarioSelection)})`;
  }
  return null;
}

export function buildComparison(before: PerfRunSummary, after: PerfRunSummary): ComparisonReport {
  const machineRefusal = refusalReason(before, after);
  const beforeById = byId(before.aggregates);
  const afterById = byId(after.aggregates);

  const durationRows: DurationRow[] = [];
  const independentMetricRows: MetricRow[] = [];
  const dependentMetricRows: MetricRow[] = [];
  const metricsOnlyInOne: MissingMetric[] = [];
  const measurementIssues: MeasurementIssue[] = [];
  const warnings: string[] = [];

  // Collected across BOTH summaries in full, before pairing. Gathering these
  // inside the paired loop dropped every issue belonging to a scenario present
  // in only one run — exactly the scenario a filtered before/after pair
  // produces, and a vanished measurement is the finding least safe to lose.
  for (const [side, summary] of [
    ["before", before],
    ["after", after],
  ] as const) {
    for (const aggregate of summary.aggregates) {
      for (const issue of aggregate.measurementIssues) {
        measurementIssues.push({ scenarioId: aggregate.id, side, issue });
      }
    }
  }

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

  // A toolchain change is a WARNING and never a refusal, and the two halves of
  // that are decided separately.
  //
  // `sourceSha` stays out of `refusalReason` entirely: two runs at two commits
  // is the whole purpose of this tool, so refusing on it would refuse every
  // real before/after pair.
  //
  // A git or Electron upgrade is a genuine confound — it moves subprocess
  // counts and IPC costs with no product change — but the refusal machinery is
  // the wrong instrument for it. Refusal withholds machine-dependent deltas,
  // and a git upgrade lands on `gitSpawns`: a count, which is machine-
  // independent and survives every refusal. A warning reaches the reader
  // whatever class the affected row is in, which is what this confound needs.
  //
  // Only compared when both sides recorded a version. A null means "not
  // recorded", and warning on a missing record would fire against every older
  // file and train the reader to skip the section.
  for (const [field, beforeValue, afterValue] of [
    ["git", before.environment.gitVersion, after.environment.gitVersion],
    ["Electron", before.environment.electronVersion, after.environment.electronVersion],
  ] as const) {
    if (beforeValue && afterValue && beforeValue !== afterValue) {
      warnings.push(
        `${field} version differs (${beforeValue} vs ${afterValue}) — a toolchain upgrade moves ` +
          "subprocess counts and IPC costs on its own, so part of every delta below may not be " +
          "the code"
      );
    }
  }

  // Named unconditionally, because `refusalReason` reports only the first
  // reason it finds: with a machine or warmup mismatch also present, a reader
  // who fixed that one would otherwise meet the selection mismatch for the
  // first time on their second attempt.
  if (
    before.protocol !== undefined &&
    after.protocol !== undefined &&
    selectionsDiffer(before.protocol, after.protocol)
  ) {
    warnings.push(
      `scenario selection differs (${describeSelection(before.protocol.scenarioSelection)} vs ` +
        `${describeSelection(after.protocol.scenarioSelection)}) — a scenario measured alone and ` +
        "the same scenario measured beside the rest of the matrix ran in different process and " +
        "machine conditions, so machine-dependent rows are refused; re-run both sides with the " +
        "same --scenario filter"
    );
  }
  // A benchmark whose subject is emulated, simulated or a deliberate floor
  // produces a number that is reproducible and comparable against itself — so
  // the delta below is real — but it is not a statement about the product. The
  // classification lives on the aggregate, and without saying so here a reader
  // meets "PERF-196 improved 18%" with nothing indicating that PERF-196 is a
  // parser floor which production does not take.
  //
  // Deliberately NOT extended to withholding the row or blocking
  // `--update-baseline`, which was the stronger recommendation. A `diagnostic`
  // KIND is not the same failure as a `diagnostic` PLATFORM: the platform case
  // means the observer is blind here and another machine can measure the thing
  // properly, so promoting its number would record a reading nothing produced.
  // A floor is a floor everywhere, measured the same way every time, and its
  // reference is genuinely useful for catching a parser regression. Removing it
  // would cost a real signal to enforce a label.
  const diagnosticIds = [
    ...new Set(
      [...before.aggregates, ...after.aggregates]
        .filter((aggregate) => aggregate.kind === "diagnostic")
        .map((aggregate) => aggregate.id)
    ),
  ].sort();
  if (diagnosticIds.length > 0) {
    warnings.push(
      `${diagnosticIds.join(", ")} ${diagnosticIds.length === 1 ? "is" : "are"} classified ` +
        "`diagnostic`: the subject inside the timed bracket is emulated, simulated or a " +
        "deliberate floor, so a delta here is a signal about the harness's model of the " +
        "product and not a product-level claim (see scripts/perf/config/benchmarkClasses.ts)"
    );
  }

  // A WARNING rather than a refusal, and the line is drawn deliberately. The
  // hash covers `scripts/perf/**` code and reference values, which genuinely
  // change what the number means — but it also moves for an edit that could not
  // possibly affect this scenario, and refusing every comparison across an
  // unrelated harness change would make the check something people work around.
  // `.agents/skills/optimize` already fails its own gate on this condition when
  // a CLAIM is being made; here the reader is handed the fact and the judgement.
  const beforeHarness = before.protocol?.harnessHash;
  const afterHarness = after.protocol?.harnessHash;
  if (beforeHarness === undefined || afterHarness === undefined) {
    // A summary written before `harnessHash` existed has no field at all, which
    // is the ordinary case for a comparison against a stored baseline — exactly
    // what the field was added for. Staying silent here would fail the check
    // open in the one situation it was meant to speak up in.
    warnings.push(
      "one side predates harness recording, so it cannot be shown that both runs were measured " +
        "by the same instrument"
    );
  } else if (beforeHarness === null || afterHarness === null) {
    warnings.push(
      "one side could not record a harness hash, so it cannot be shown that both runs were " +
        "measured by the same instrument"
    );
  } else if (beforeHarness !== afterHarness) {
    warnings.push(
      `the harness itself differs between the two runs (${beforeHarness} vs ${afterHarness}) — ` +
        "scripts/perf changed, so part of any delta below may be the measuring instrument " +
        "rather than the code; re-measure both sides on one harness before claiming a result"
    );
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
  // A skipped scenario reads as a missing row, which reads as nothing at all.
  // Saying which rows are absent BY DESIGN is what stops a cross-platform
  // reader concluding the other side simply performed better.
  const skippedEitherSide = [
    ...new Set([...(before.scenariosSkipped ?? []), ...(after.scenariosSkipped ?? [])]),
  ].sort();
  if (skippedEitherSide.length > 0) {
    warnings.push(
      `${skippedEitherSide.length} scenario(s) are unsupported on one side and were never run ` +
        `(${skippedEitherSide.join(", ")}) — their absence is by design, not a result`
    );
  }

  // Diagnostic rows ran on an emulated or shimmed path. Comparing one against
  // an authoritative reading of the same id compares two different things.
  const diagnosticEitherSide = [
    ...new Set(
      [...before.aggregates, ...after.aggregates]
        .filter((aggregate) => aggregate.applicability === "diagnostic")
        .map((aggregate) => aggregate.id)
    ),
  ].sort();
  if (diagnosticEitherSide.length > 0) {
    warnings.push(
      `${diagnosticEitherSide.length} scenario(s) are diagnostic on one side ` +
        `(${diagnosticEitherSide.join(", ")}) — a signal, not a measurement; do not read a delta ` +
        "on these as a change in the code"
    );
  }

  if (durationRows.length === 0) {
    warnings.push("no scenario appears in both files — there is nothing to compare");
  }

  return {
    beforeLabel: before.label ?? "before",
    afterLabel: after.label ?? "after",
    machineDependentComparable: machineRefusal === null,
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
      "Durations, memory, runtime-derived ratios and unclassified metrics measure the machine as",
      "much as the code, so no delta is computed for them — the raw readings are printed as a",
      "record of what each run measured, and subtracting them by eye is the mistake this refusal",
      "exists to prevent. Counts, byte sizes and structural ratios below are unaffected. To compare",
      "durations, run before and after on one machine with one protocol."
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
      `${comparabilityMarker("count")} counts, byte sizes and structural ratios — compare freely between any two runs.`,
      report.independentMetricRows
    ),
    ...metricTable(
      "Machine-dependent metrics",
      `${comparabilityMarker("duration")} durations, memory, runtime-derived ratios (\`derived-ratio\`) and unclassified metrics — comparable only against the same machine.`,
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
    "- A percentage is not automatically portable. A `derived-ratio` — an event-loop utilization, a",
    "  `memoryGrowthPct` — divides one runtime number by another, which changes the units the",
    "  machine is baked into rather than removing it, so it sits with the durations.",
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
