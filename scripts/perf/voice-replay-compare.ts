import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  compareRuns,
  renderComparison,
  VOICE_REPLAY_SCHEMA_VERSION,
  type VoiceReplayRun,
} from "../../e2e/helpers/voiceReplayScore";
import { formatErrorMessage } from "../../shared/utils/errorMessage";
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

interface Args {
  save: boolean;
  baseline: string;
  run: string | null;
}

function parseArgs(argv: string[]): Args | "help" {
  const args: Args = { save: false, baseline: BASELINE, run: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--help" || arg === "-h") return "help";
    if (arg === "--save") args.save = true;
    else if (arg === "--baseline") {
      const value = argv[++i];
      if (!value || value.startsWith("-")) throw new Error("--baseline needs a file");
      args.baseline = value;
    } else if (arg.startsWith("-")) throw new Error(`unknown flag ${arg}`);
    else if (args.run === null) args.run = arg;
    else throw new Error(`unexpected argument ${arg}`);
  }
  if (args.save && args.baseline !== BASELINE) {
    throw new Error("--save writes the default baseline; it doesn't take --baseline");
  }
  return args;
}

function main(argv: string[]): number {
  const args = parseArgs(argv);
  if (args === "help") {
    console.log(USAGE);
    return 0;
  }

  if (args.save) {
    const source = args.run ?? newestCompleteRun();
    if (!load(source).complete) {
      console.error(`${source} is a partial run; only a complete run can be the baseline`);
      return 1;
    }
    mkdirSync(path.dirname(BASELINE), { recursive: true });
    copyFileSync(source, BASELINE);
    console.log(
      `baseline: ${path.relative(REPO_ROOT, source)} → ${path.relative(REPO_ROOT, BASELINE)}`
    );
    return 0;
  }

  if (!existsSync(args.baseline)) {
    console.error(
      `no baseline at ${args.baseline}; save one with \`npm run perf voice-replay-compare -- --save\``
    );
    return 1;
  }
  const runFile = args.run ?? newestCompleteRun();
  const baseline = load(args.baseline);
  const run = load(runFile);
  console.log(renderComparison(baseline, run, compareRuns(baseline, run)));
  return 0;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  console.error(formatErrorMessage(error, "voice-replay-compare failed"));
  process.exitCode = 1;
}
