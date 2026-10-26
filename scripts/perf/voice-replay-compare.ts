import { copyFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  compareRuns,
  renderComparison,
  VOICE_REPLAY_SCHEMA_VERSION,
  type VoiceReplayRun,
} from "../../e2e/helpers/voiceReplayScore";
import { REPO_ROOT } from "./registry";

const RESULTS_DIR = path.join(REPO_ROOT, ".tmp", "perf-results", "voice-replay");
const BASELINE = path.join(RESULTS_DIR, "baseline.json");

const USAGE = `usage:
  npm run perf voice-replay-compare                     newest complete run vs the baseline
  npm run perf voice-replay-compare -- <run.json>       that run vs the baseline
  npm run perf voice-replay-compare -- <run.json> --baseline <other.json>
  npm run perf voice-replay-compare -- --save [run.json]  make a run (default: newest) the baseline`;

function load(file: string): VoiceReplayRun {
  const run = JSON.parse(readFileSync(file, "utf8")) as VoiceReplayRun;
  if (run.schemaVersion !== VOICE_REPLAY_SCHEMA_VERSION) {
    throw new Error(
      `${file}: schema ${run.schemaVersion}, this script reads ${VOICE_REPLAY_SCHEMA_VERSION}`
    );
  }
  return run;
}

function newestCompleteRun(): string {
  const runs: Array<{ file: string; createdAt: string }> = [];
  for (const name of existsSync(RESULTS_DIR) ? readdirSync(RESULTS_DIR) : []) {
    if (!name.endsWith(".json") || name === path.basename(BASELINE)) continue;
    const file = path.join(RESULTS_DIR, name);
    try {
      const run = load(file);
      if (run.complete) runs.push({ file, createdAt: run.createdAt });
    } catch {
      // An older schema or a damaged file is never the newest usable run.
    }
  }
  const candidates = runs
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((run) => run.file);
  if (candidates.length === 0) {
    throw new Error(
      `no complete run in ${path.relative(REPO_ROOT, RESULTS_DIR)}; run \`npm run perf voice-replay\``
    );
  }
  return candidates[0]!;
}

function main(argv: string[]): number {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(USAGE);
    return 0;
  }
  const baselineFlag = argv.indexOf("--baseline");
  const baselineFile = baselineFlag >= 0 ? argv[baselineFlag + 1] : BASELINE;
  const positional = argv.filter(
    (arg, index) => !arg.startsWith("--") && (baselineFlag < 0 || index !== baselineFlag + 1)
  );
  if (!baselineFile) {
    console.error(USAGE);
    return 1;
  }

  if (argv.includes("--save")) {
    const source = positional[0] ?? newestCompleteRun();
    if (!load(source).complete) {
      console.error(`${source} is a partial run; only a complete run can be the baseline`);
      return 1;
    }
    copyFileSync(source, BASELINE);
    console.log(
      `baseline: ${path.relative(REPO_ROOT, source)} → ${path.relative(REPO_ROOT, BASELINE)}`
    );
    return 0;
  }

  if (!existsSync(baselineFile)) {
    console.error(
      `no baseline at ${baselineFile}; save one with \`npm run perf voice-replay-compare -- --save\``
    );
    return 1;
  }
  const runFile = positional[0] ?? newestCompleteRun();
  const baseline = load(baselineFile);
  const run = load(runFile);
  console.log(renderComparison(baseline, run, compareRuns(baseline, run)));
  return 0;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
