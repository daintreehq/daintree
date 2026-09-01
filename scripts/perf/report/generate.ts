import { classifyBenchmark, describeBenchmarkClass } from "../config/benchmarkClasses";
import { classifyMetric, comparabilityMarker } from "../lib/comparability";
import type { ComparabilityClass } from "../lib/comparability";
import { round } from "../lib/stats";
import type { MetricStat, PerfRunSummary, RunEnvironment, ScenarioAggregate } from "../types";

/**
 * A non-finite value is a broken measurement, not an absent one, so it is
 * printed as-is. The previous "n/a" made a NaN read as "this scenario doesn't
 * report that number", which is the reassuring half of the two possible
 * meanings and the wrong one.
 *
 * A fixed two decimals was the other half of that problem: it renders a p-value
 * of 0.004 and a per-iteration rate of 0.001 as "0.00", i.e. as nothing.
 */
function format(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  if (Number.isInteger(value)) return String(value);
  if (Math.abs(value) < 0.001) return value.toExponential(2);
  return String(round(value, 3));
}

/**
 * Every textual cell goes through this. Scenario ids and metric names are as
 * capable of carrying a pipe as scenario notes are, and one unescaped pipe
 * shifts every column to its right — silently reassigning numbers to headings.
 */
function cell(text: string): string {
  return text
    .replace(/\|/g, "\\|")
    .replace(/\s*\r?\n\s*/g, " ")
    .trim();
}

function describeClass(cls: ComparabilityClass): string {
  return `${comparabilityMarker(cls)} ${cls}`;
}

/** The identity `durationsComparable` actually tests: label, platform and arch. */
function machineIdentity(env: RunEnvironment): string {
  return `${env.machineLabel} (${env.platform}/${env.arch})`;
}

function environmentLines(env: RunEnvironment): string[] {
  return [
    `- Machine: ${machineIdentity(env)}`,
    `- CPU: ${env.cpuModel} × ${env.cpuCount}`,
    `- Memory: ${env.totalMemoryMb} MB`,
    `- OS release: ${env.osRelease}`,
  ];
}

function readingGuide(env: RunEnvironment): string[] {
  return [
    "",
    "## Reading these numbers",
    "",
    "Nothing here is a verdict. The suite reports measurements and annotates the ones sitting outside a configured reference value; acting on one is a judgement call.",
    "",
    `- \`${comparabilityMarker("count")}\` machine-independent — \`count\`, \`size\` and \`ratio\`: tallies, byte lengths, and proportions between two of those. Compare these across machines and operating systems: "Windows 34, macOS 0" is a finding. \`max\` compares freely; \`sum\` only against a run of the same scenario at the same iteration count.`,
    `- \`${comparabilityMarker("duration")}\` machine-dependent — \`duration\`, \`memory\`, \`derived-ratio\` and \`unknown\`. Only meaningful against another run on ${machineIdentity(env)}. Against a different machine the difference is mostly the two machines.`,
    `- A percentage is not automatically portable. A \`derived-ratio\` divides one runtime number by another — event-loop utilization, \`memoryGrowthPct\` — which changes the units the machine is baked into rather than removing it. A slower CPU raises utilization for identical work; a different allocator moves a growth percentage with no code change. Those rows carry \`${comparabilityMarker("derived-ratio")}\`, the same marker as a duration, and are read the same way.`,
    "",
    "The median leads the latency table: at the iteration counts this harness runs, a p95 is one of the two largest samples rather than a stable tail estimate. p95 and p99 stay as detail columns.",
  ];
}

/**
 * Non-finite values the report finds for itself.
 *
 * The producer only inspects p95 and metrics that have a configured reference,
 * so a NaN anywhere else arrives carrying no issue at all and would render as a
 * perfectly ordinary row.
 */
function nonFiniteFields(aggregate: ScenarioAggregate): string[] {
  const found: string[] = [];
  const latency: Record<string, number> = {
    p50: aggregate.p50Ms,
    p95: aggregate.p95Ms,
    p99: aggregate.p99Ms,
    max: aggregate.maxMs,
    stddev: aggregate.stdDevMs,
  };

  for (const [label, value] of Object.entries(latency)) {
    if (!Number.isFinite(value)) found.push(label);
  }
  for (const [name, stat] of Object.entries(aggregate.metricStats)) {
    if (![stat.mean, stat.max, stat.min, stat.sum].every((value) => Number.isFinite(value))) {
      found.push(name);
    }
  }

  return found;
}

function scenarioIssues(aggregate: ScenarioAggregate): string[] {
  const nonFinite = nonFiniteFields(aggregate);
  return [
    ...aggregate.measurementIssues,
    ...(nonFinite.length > 0 ? [`non-finite value in: ${nonFinite.join(", ")}`] : []),
  ];
}

/**
 * Broken apparatus, not slow code — and deliberately its own section ahead of
 * the tables. A metric that stopped being emitted renders as an empty row,
 * which looks exactly like a clean measurement.
 */
function measurementIssuesSection(aggregates: ScenarioAggregate[]): string[] {
  const affected = aggregates
    .map((aggregate) => ({ aggregate, issues: scenarioIssues(aggregate) }))
    .filter(({ issues }) => issues.length > 0);
  if (affected.length === 0) return [];

  const lines = [
    "",
    "## Measurement issues",
    "",
    "These measurements are broken rather than slow. Every number reported below for these scenarios is suspect until the apparatus is fixed.",
    "",
  ];

  for (const { aggregate, issues } of affected) {
    for (const issue of issues) {
      lines.push(`- **${cell(aggregate.id)}** — ${cell(issue)}`);
    }
  }

  return lines;
}

/**
 * A broken measurement outranks a slow one and must never share a cell value
 * with a clean run — a reader who jumps straight to the table would otherwise
 * see nothing at all wrong with a scenario whose numbers mean nothing.
 */
function annotation(aggregate: ScenarioAggregate): string {
  if (scenarioIssues(aggregate).length > 0) return "measurement issue";
  return aggregate.outsideReference ? "outside reference" : "—";
}

function latencyRow(aggregate: ScenarioAggregate): string {
  const notes = [
    ...(aggregate.referenceNotes ? [aggregate.referenceNotes] : []),
    ...aggregate.notes,
  ].map(cell);

  return [
    cell(aggregate.id),
    String(aggregate.runs),
    format(aggregate.p50Ms),
    format(aggregate.p95Ms),
    format(aggregate.p99Ms),
    format(aggregate.maxMs),
    format(aggregate.stdDevMs),
    annotation(aggregate),
    notes.join("; "),
  ].join(" | ");
}

function latencySection(summary: PerfRunSummary): string[] {
  return [
    "",
    `## Latency \`${comparabilityMarker("duration")}\``,
    "",
    `Wall-clock, so comparable only against another run on ${machineIdentity(summary.environment)}.`,
    "",
    "ID | Runs | median (ms) | p95 (ms) | p99 (ms) | max (ms) | stddev (ms) | Annotation | Notes",
    "--- | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---",
    ...summary.aggregates.map(latencyRow),
    "",
    "A reference value carries no machine of its own, so a duration marked `outside reference` may be describing the machine that recorded the reference rather than a change in the code. Read it against a run of your own on this machine before acting on it.",
  ];
}

function metricRow(aggregate: ScenarioAggregate, name: string, stat: MetricStat): string {
  return [
    cell(aggregate.id),
    cell(name),
    describeClass(classifyMetric(name)),
    format(stat.max),
    format(stat.sum),
    format(stat.mean),
    format(stat.min),
    String(stat.count),
  ].join(" | ");
}

function metricsSection(aggregates: ScenarioAggregate[]): string[] {
  const rows: string[] = [];
  for (const aggregate of aggregates) {
    for (const name of Object.keys(aggregate.metricStats).sort()) {
      rows.push(metricRow(aggregate, name, aggregate.metricStats[name]));
    }
  }

  const heading = ["", "## Metrics", ""];

  if (rows.length === 0) {
    return [...heading, "No scenario reported a metric value."];
  }

  return [
    ...heading,
    "Read **max** and **sum** for counts: a mean flattens the spike that matters — twenty process spawns in one iteration among fifteen quiet ones averages to 1.25. A count falling to zero is only good news alongside evidence the work it counted still happened.",
    "",
    "Scenario | Metric | Comparable | max | sum | mean | min | Samples",
    "--- | --- | --- | ---: | ---: | ---: | ---: | ---:",
    ...rows,
  ];
}

/**
 * What each measured scenario's number is allowed to be claimed to mean.
 *
 * Placed above the tables rather than as a column, because the claim is a
 * sentence and a table cell is where a sentence goes to be skipped. Every run
 * measures one scenario, so this section is two or three lines.
 *
 * The failure it addresses is a specific one: a `mechanism` number quoted in a
 * sentence beginning "Daintree got faster for users". Nothing about the figure
 * itself reveals that the renderer, transport and compositor were absent.
 */
function claimSection(aggregates: ScenarioAggregate[]): string[] {
  const lines = ["", "## What this measures", ""];
  let any = false;

  for (const aggregate of aggregates) {
    const cls = classifyBenchmark(aggregate.id);
    if (!cls) {
      lines.push(
        `- **${cell(aggregate.id)}** — UNCLASSIFIED. No entry in \`config/benchmarkClasses.ts\`, so nothing here states what this number covers. Treat it as diagnostic until one is added.`
      );
      any = true;
      continue;
    }
    lines.push(
      `- **${cell(aggregate.id)}** \`${cls.kind}\` — ${cell(cls.claim)}`,
      `  - Fidelity: ${cell(describeBenchmarkClass(cls))}`
    );
    any = true;
  }

  if (!any) return [];

  lines.push(
    "",
    "`journey` numbers describe an outcome a user experiences. `mechanism` numbers describe shipped code with user-path layers deliberately removed — real, attributable, and not a statement about perceived speed. `diagnostic` numbers are signals: the subject inside the bracket is emulated, shimmed or a floor."
  );
  return lines;
}

/**
 * Evidence quality, stated in the header where the exit code used to be the
 * only signal. A run that reports issues here is not slow; its numbers do not
 * mean anything, whether or not `--enforce-integrity` made it exit non-zero.
 */
function integrityLine(summary: PerfRunSummary): string[] {
  const integrity = summary.integrity;
  if (!integrity) return [];
  const mode = integrity.enforced ? "enforced" : "advisory";
  return [
    integrity.valid
      ? `- Integrity: ok (${mode})`
      : `- Integrity: **${integrity.issues.length} broken measurement(s)** (${mode}) — the numbers below are not slow, they are not results`,
  ];
}

export function buildMarkdownReport(summary: PerfRunSummary): string {
  const outside = summary.scenariosOutsideReference;
  const issueCount = summary.aggregates.reduce(
    (total, aggregate) => total + scenarioIssues(aggregate).length,
    0
  );

  const header = [
    "# Performance Benchmark Report",
    "",
    `- Generated: ${summary.generatedAt}`,
    `- Mode: ${summary.mode}`,
    ...(summary.label ? [`- Label: ${cell(summary.label)}`] : []),
    ...environmentLines(summary.environment),
    `- Node: ${summary.nodeVersion}`,
    `- Scenarios: ${summary.scenarioCount}`,
    `- Outside a reference value: ${outside.length}${outside.length > 0 ? ` (${outside.join(", ")})` : ""}`,
    `- Measurement issues: ${issueCount}`,
    ...integrityLine(summary),
    // The measuring instrument's own identity. Two runs of one scenario on one
    // machine at one iteration count are still not comparable if this differs.
    `- Harness: ${summary.protocol.harnessHash ?? "unknown"}`,
  ];

  return [
    ...header,
    ...claimSection(summary.aggregates),
    ...readingGuide(summary.environment),
    ...measurementIssuesSection(summary.aggregates),
    ...latencySection(summary),
    ...metricsSection(summary.aggregates),
    "",
  ].join("\n");
}
