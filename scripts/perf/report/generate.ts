import type { ComparisonAggregate, PerfRunSummary, ScenarioAggregate } from "../types";

function format(value: number): string {
  return Number.isFinite(value) ? value.toFixed(2) : "n/a";
}

function aggregateLine(aggregate: ScenarioAggregate): string {
  const status = aggregate.outsideReference ? "FAIL" : "PASS";
  const notes = aggregate.notes.length > 0 ? aggregate.notes.join("; ") : "";

  return [
    aggregate.id,
    status,
    format(aggregate.p50Ms),
    format(aggregate.p95Ms),
    format(aggregate.p99Ms),
    format(aggregate.maxMs),
    format(aggregate.stdDevMs),
    notes,
  ].join(" | ");
}

function comparisonSection(comparisons: ComparisonAggregate[]): string[] {
  if (comparisons.length === 0) return [];

  const lines = [
    "",
    "## A/B Comparison",
    "",
    "ID | p-value | Effect size | Verdict",
    "--- | ---: | ---: | ---",
  ];

  for (const comp of comparisons) {
    const verdict = comp.comparison.regression ? "REGRESSION" : "ok";
    lines.push(
      `${comp.id} | ${format(comp.comparison.pValue)} | ${format(comp.comparison.effectSize)} | ${verdict}`
    );
  }

  return lines;
}

export function buildMarkdownReport(
  summary: PerfRunSummary,
  comparisons: ComparisonAggregate[] = []
): string {
  const header = [
    "# Performance Benchmark Report",
    "",
    `- Generated: ${summary.generatedAt}`,
    `- Mode: ${summary.mode}`,
    `- Node: ${summary.nodeVersion}`,
    `- Platform: ${summary.platform}`,
    `- Scenarios: ${summary.scenarioCount}`,
    `- Failed: ${summary.scenariosOutsideReference.length}`,
    "",
    "## Scenario Results",
    "",
    "ID | Status | p50 (ms) | p95 (ms) | p99 (ms) | max (ms) | stddev (ms) | Notes",
    "--- | --- | ---: | ---: | ---: | ---: | ---: | ---",
  ];

  const body = summary.aggregates.map(aggregateLine);

  const failedSection =
    summary.scenariosOutsideReference.length === 0
      ? ["", "## Regression Gate", "", "All scenario budgets passed."]
      : [
          "",
          "## Regression Gate",
          "",
          `Failed scenarios: ${summary.scenariosOutsideReference.join(", ")}`,
        ];

  return [...header, ...body, ...failedSection, ...comparisonSection(comparisons), ""].join("\n");
}
