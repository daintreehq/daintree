import path from "node:path";
import { fileURLToPath } from "node:url";
import { classifyBenchmark } from "../config/benchmarkClasses";
import { REGISTRY } from "../registry";
import { JOURNEYS, type JourneyCoverage } from "./manifest";

/**
 * `npm run perf journeys` — the user-outcome view of the benchmark suite.
 *
 * Reading a coverage column is the point. A suite of 159 green scenarios says
 * nothing about whether the six things users actually notice are measured, and
 * printing the gaps beside the covered rows is what stops "we have a big perf
 * suite" from being mistaken for "we would notice".
 */

const COVERAGE_MARK: Record<JourneyCoverage, string> = {
  full: "covered",
  partial: "PARTIAL",
  gap: "GAP",
};

function commandSummary(command: string): string {
  const entry = REGISTRY[command];
  if (!entry) return `${command} (NOT IN THE REGISTRY — this row points at nothing)`;
  return `npm run perf ${command} — ${entry.summary}`;
}

function main(): void {
  const argv = process.argv.slice(2);
  const unknown = argv.filter((arg) => arg !== "--gaps");
  if (unknown.length > 0) {
    console.error(`[perf:journeys] unknown argument(s): ${unknown.join(", ")}`);
    console.error("Usage: npm run perf journeys [-- --gaps]");
    process.exit(1);
  }
  const gapsOnly = argv.includes("--gaps");

  const rows = gapsOnly ? JOURNEYS.filter((journey) => journey.coverage !== "full") : JOURNEYS;

  console.log("User-outcome benchmarks\n");
  console.log(
    "Each row is something a person does with Daintree. `commands` are what measure it end to " +
      "end today; `linked` are the mechanism scenarios that explain a movement in it.\n"
  );

  for (const journey of rows) {
    console.log(`${journey.id}  [${COVERAGE_MARK[journey.coverage]}]  ${journey.name}`);
    console.log(`  asks:   ${journey.userQuestion}`);
    console.log(`  starts: ${journey.startBoundary}`);
    console.log(`  ends:   ${journey.usableEndBoundary}`);
    if (journey.commands.length === 0) {
      console.log("  runs:   nothing measures this outcome end to end");
    } else {
      for (const command of journey.commands) console.log(`  runs:   ${commandSummary(command)}`);
    }
    console.log(`  note:   ${journey.coverageNote}`);

    const byKind = new Map<string, string[]>();
    for (const id of journey.linkedScenarios) {
      const kind = classifyBenchmark(id)?.kind ?? "unclassified";
      byKind.set(kind, [...(byKind.get(kind) ?? []), id]);
    }
    for (const [kind, ids] of [...byKind.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      console.log(`  linked ${kind}: ${ids.join(", ")}`);
    }
    console.log("");
  }

  const gaps = JOURNEYS.filter((journey) => journey.coverage === "gap");
  const partial = JOURNEYS.filter((journey) => journey.coverage === "partial");
  console.log(
    `${JOURNEYS.length} outcomes: ${JOURNEYS.length - gaps.length - partial.length} covered, ` +
      `${partial.length} partial, ${gaps.length} with nothing measuring them ` +
      `(${gaps.map((journey) => journey.id).join(", ") || "none"}).`
  );
}

// The CLI starts only when this file is the process entrypoint, matching
// `run.ts` and `affected.ts`. An import that dispatched a command would read
// the importer's argv and exit the process on the first token it did not
// recognise.
const isEntrypoint =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isEntrypoint) main();
