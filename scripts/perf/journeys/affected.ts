import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { REPO_ROOT } from "../registry";
import { JOURNEYS, type JourneyDefinition } from "./manifest";

/**
 * `npm run perf affected -- --base <ref>` — which outcomes a diff can move.
 *
 * The failure this addresses is choosing the benchmark that is easiest to run
 * rather than the one that covers what changed. Selection is deliberately
 * ADDITIVE: a change touching several paths gets every outcome downstream of it,
 * not the cheapest one, because the whole point of the ownership map is to stop
 * a person measuring the subsystem they were already thinking about.
 */

function parseBase(argv: string[]): string {
  let base = "origin/develop";
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--base") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        console.error("[perf:affected] --base expects a git ref");
        process.exit(1);
      }
      base = value;
      i += 1;
      continue;
    }
    if (token.startsWith("--base=")) {
      base = token.slice("--base=".length);
      continue;
    }
    console.error(`[perf:affected] unknown argument: ${token}`);
    console.error("Usage: npm run perf affected -- --base origin/develop");
    process.exit(1);
  }
  return base;
}

function changedFiles(base: string): string[] {
  try {
    const out = execFileSync("git", ["diff", "--name-only", `${base}...HEAD`], {
      cwd: REPO_ROOT,
      encoding: "utf-8",
      timeout: 15_000,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return out
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  } catch (error) {
    const detail = error instanceof Error ? error.message.split("\n")[0] : String(error);
    console.error(`[perf:affected] could not diff against ${base}: ${detail}`);
    process.exit(1);
  }
}

/**
 * Glob matching for the small subset the manifest uses: a literal path, or a
 * prefix ending in `/**`.
 *
 * A general glob engine is not worth a dependency here, and a half-correct one
 * would silently match too little — which in a selection tool means quietly
 * dropping the benchmark somebody needed. The manifest test enforces that every
 * pattern is one of these two shapes.
 */
export function pathMatches(pattern: string, file: string): boolean {
  if (pattern.endsWith("/**")) return file.startsWith(pattern.slice(0, -2));
  return file === pattern;
}

export function journeysForFiles(
  files: readonly string[],
  journeys: readonly JourneyDefinition[] = JOURNEYS
): Map<JourneyDefinition, string[]> {
  const hits = new Map<JourneyDefinition, string[]>();
  for (const journey of journeys) {
    const matched = files.filter((file) =>
      journey.ownerPaths.some((pattern) => pathMatches(pattern, file))
    );
    if (matched.length > 0) hits.set(journey, matched);
  }
  return hits;
}

function main(): void {
  const base = parseBase(process.argv.slice(2));
  const files = changedFiles(base);

  if (files.length === 0) {
    console.log(`[perf:affected] no files changed against ${base}.`);
    return;
  }

  const hits = journeysForFiles(files);
  console.log(`${files.length} file(s) changed against ${base}.\n`);

  if (hits.size === 0) {
    console.log(
      "No user outcome claims ownership of these paths. That is a real answer for a docs or " +
        "config change, and a stale manifest for anything else — the ownerPaths in " +
        "scripts/perf/journeys/manifest.ts are the thing to fix."
    );
    return;
  }

  const scenarios = new Set<string>();
  for (const [journey, matched] of hits) {
    console.log(`${journey.id}  [${journey.coverage}]  ${journey.name}`);
    console.log(
      `  touched: ${matched.slice(0, 6).join(", ")}${matched.length > 6 ? ` … +${matched.length - 6}` : ""}`
    );
    console.log(
      journey.commands.length > 0
        ? `  measure: ${journey.commands.map((command) => `npm run perf ${command}`).join(" | ")}`
        : `  measure: NOTHING covers this outcome — ${journey.coverageNote}`
    );
    for (const id of journey.linkedScenarios) scenarios.add(id);
    console.log("");
  }

  console.log(
    `Mechanism scenarios that can explain a movement:\n  ${[...scenarios].sort().join(", ")}`
  );
  console.log("\nRun one at a time: npm run perf smoke -- --scenario <id>");
}

// Vitest imports this module for `pathMatches` and `journeysForFiles`, so the
// CLI only starts when the file is the process entrypoint. Without the check,
// importing it runs `main()` inside a test worker: `parseBase` reads that
// worker's argv and exits on the first token it does not recognise, or — worse
// — a `git diff origin/develop...HEAD` fires during module import and takes the
// worker down on a checkout without that ref. Same guard, same reason, as
// `run.ts`.
const isEntrypoint =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isEntrypoint) main();
