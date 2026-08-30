import { performance } from "node:perf_hooks";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadBudgetConfig, getScenarioBudget } from "./lib/budgets";
import { checkBaselineCoverage, checkBaselineFreshness } from "./lib/baselineCoverage";
import { evaluateScenarioBudget } from "./lib/gate";
import { appendJsonLine, appendText, readJson, writeJson, writeText, ensureDir } from "./lib/io";
import { aggregateMetrics, averageMetrics, mean, percentile, round, stdDev } from "./lib/stats";
import { buildMarkdownReport } from "./report/generate";
import { assertMatrixCoverage, getScenariosForMode } from "./scenarios";
import type {
  BaselineSummary,
  PerfMode,
  PerfRunSummary,
  PerfScenario,
  RunEnvironment,
  ScenarioAggregate,
  ScenarioContext,
  ScenarioSample,
  ScenarioTier,
} from "./types";

export interface CliOptions {
  mode: PerfMode;
  outDir: string;
  baselinePath: string;
  updateBaseline: boolean;
  /** Explicit scenario subset, or null for the whole matrix for this mode. */
  scenarioIds: string[] | null;
  /** Overrides the per-tier default iteration count for every scenario. */
  iterations?: number;
  /** Overrides each scenario's own warmup count. */
  warmups?: number;
  /** Extra destination for the summary JSON, chosen by the caller. */
  jsonPath?: string;
  label?: string;
  machineLabel?: string;
}

interface RawSample {
  scenarioId: string;
  scenarioName: string;
  iteration: number;
  durationMs: number;
  timestamp: string;
  metrics: Record<string, number>;
  notes?: string;
}

const DEFAULT_ITERATIONS: Record<PerfMode, Record<ScenarioTier, number>> = {
  smoke: { fast: 8, heavy: 4, soak: 1 },
  ci: { fast: 16, heavy: 8, soak: 2 },
  nightly: { fast: 24, heavy: 12, soak: 4 },
  soak: { fast: 10, heavy: 10, soak: 8 },
};

const MODES: ReadonlySet<string> = new Set(["smoke", "ci", "nightly", "soak"]);

const VALUE_FLAGS = [
  "mode",
  "scenario",
  "iterations",
  "warmups",
  "json",
  "label",
  "machine",
  "out-dir",
  "baseline",
] as const;

const BOOLEAN_FLAGS = ["update-baseline"] as const;

const perfDir = path.dirname(fileURLToPath(import.meta.url));
const HISTORY_DIR = path.join(perfDir, "history");

/**
 * A mistyped invocation, not a broken harness. Carried as its own class so the
 * top-level handler can print the one useful line instead of a stack trace.
 */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

function knownFlagList(): string {
  return [...VALUE_FLAGS, ...BOOLEAN_FLAGS]
    .map((flag) => `--${flag}`)
    .sort()
    .join(", ");
}

function defaultOutDir(): string {
  return path.resolve(process.cwd(), ".tmp/perf-results");
}

function defaultBaselinePath(mode: PerfMode): string {
  return path.resolve(process.cwd(), `scripts/perf/config/baseline.${mode}.json`);
}

function parsePositiveInt(flag: string, raw: string, min: number): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min) {
    throw new UsageError(`--${flag} expects an integer >= ${min}, got "${raw}"`);
  }
  return value;
}

/**
 * Strict argument parsing.
 *
 * The previous parser skipped anything it did not recognise, so a typo'd
 * `--secnario` silently ran the entire matrix and looked like it had worked.
 * Every unknown flag, missing value, stray positional, and unknown scenario id
 * throws instead — a mistyped invocation must never look like a clean run.
 */
export function parseArgs(argv: string[]): CliOptions {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  const scenarioTokens: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      throw new UsageError(`Unexpected argument "${token}" — every option must be a --flag`);
    }

    const body = token.slice(2);
    const equals = body.indexOf("=");
    const name = equals === -1 ? body : body.slice(0, equals);
    const inlineValue = equals === -1 ? undefined : body.slice(equals + 1);

    if ((BOOLEAN_FLAGS as readonly string[]).includes(name)) {
      if (inlineValue !== undefined) {
        throw new UsageError(`--${name} is a switch and takes no value`);
      }
      flags.add(name);
      continue;
    }

    if (!(VALUE_FLAGS as readonly string[]).includes(name)) {
      throw new UsageError(`Unknown flag --${name}. Known flags: ${knownFlagList()}`);
    }

    let value = inlineValue;
    if (value === undefined) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        throw new UsageError(`--${name} expects a value`);
      }
      value = next;
      i += 1;
    }
    if (value.trim() === "") {
      throw new UsageError(`--${name} expects a value`);
    }

    // Repeatable, unlike every other flag: `--scenario A --scenario B` and
    // `--scenario A,B` both mean the same set.
    if (name === "scenario") {
      scenarioTokens.push(value);
      continue;
    }

    // `index.ts` prepends `--mode <mode>` to whatever the caller typed, so
    // last-wins would let `npm run perf smoke -- --mode nightly` run nightly
    // under a smoke banner. Same class of silent wrong answer as a typo'd flag.
    if (values.has(name)) {
      throw new UsageError(`--${name} given more than once`);
    }

    values.set(name, value);
  }

  const modeRaw = values.get("mode") ?? "smoke";
  if (!MODES.has(modeRaw)) {
    throw new UsageError(`Invalid --mode value: ${modeRaw}. Known modes: ${[...MODES].join(", ")}`);
  }
  const mode = modeRaw as PerfMode;

  const scenarioIds = resolveScenarioIds(scenarioTokens, mode);

  // A baseline is a whole-matrix artifact: writing one from a filtered run
  // replaces every other scenario's reference with nothing, and the file that
  // results is indistinguishable from a complete one.
  if (scenarioIds !== null && flags.has("update-baseline")) {
    throw new UsageError(
      "--update-baseline needs the whole matrix — drop --scenario, or write the filtered run to --json instead"
    );
  }

  const iterationsRaw = values.get("iterations");
  const warmupsRaw = values.get("warmups");

  return {
    mode,
    outDir: values.get("out-dir") ?? defaultOutDir(),
    baselinePath: values.get("baseline") ?? defaultBaselinePath(mode),
    updateBaseline: flags.has("update-baseline"),
    scenarioIds,
    iterations:
      iterationsRaw === undefined ? undefined : parsePositiveInt("iterations", iterationsRaw, 1),
    warmups: warmupsRaw === undefined ? undefined : parsePositiveInt("warmups", warmupsRaw, 0),
    jsonPath: values.get("json"),
    label: values.get("label"),
    machineLabel: values.get("machine"),
  };
}

function resolveScenarioIds(tokens: string[], mode: PerfMode): string[] | null {
  if (tokens.length === 0) return null;

  const requested = tokens
    .flatMap((token) => token.split(","))
    .map((id) => id.trim().toUpperCase())
    .filter((id) => id.length > 0);

  if (requested.length === 0) {
    throw new UsageError("--scenario expects at least one scenario id");
  }

  const available = getScenariosForMode(mode).map((scenario) => scenario.id);
  const availableSet = new Set(available);
  const unknown = requested.filter((id) => !availableSet.has(id));
  if (unknown.length > 0) {
    throw new UsageError(
      `Unknown scenario id(s) for mode ${mode}: ${unknown.join(", ")}. ` +
        `Available: ${[...available].sort().join(", ")}`
    );
  }

  return [...new Set(requested)];
}

/**
 * Identifies the machine a run happened on.
 *
 * Without this a results file cannot be safely diffed against another: latency
 * is only comparable to itself on one machine, and nothing recorded the machine.
 * `--machine` beats `PERF_MACHINE_LABEL`, which beats the hostname, so a laptop
 * can carry a stable name across reboots and one run can be relabelled without
 * touching the environment.
 */
function defaultMachineLabel(override?: string): string {
  const explicit = override?.trim() || process.env.PERF_MACHINE_LABEL?.trim();
  if (explicit) return explicit;

  if (process.env.GITHUB_ACTIONS === "true") {
    // Every hosted job gets a FRESH VM from a pool of varying hardware, so two
    // runs are never the same machine even when they carry the same OS and
    // arch. A label of "gh-linux-x64" would let `durationsComparable` green-light
    // exactly the cross-machine latency comparison this exists to refuse — and
    // silently, since both runs look identical. Folding in the run and job ids
    // makes hosted runs deliberately incomparable to each other; their counts
    // still compare, which is the part that is actually meaningful in CI.
    const runId = process.env.GITHUB_RUN_ID ?? "norun";
    const attempt = process.env.GITHUB_RUN_ATTEMPT ?? "1";
    const job = process.env.GITHUB_JOB ?? "nojob";
    const osName = process.env.RUNNER_OS ?? process.platform;
    return `gh-${osName}-${process.arch}-${job}-${runId}.${attempt}`.toLowerCase();
  }

  return `${os.hostname()}-${process.platform}-${process.arch}`.toLowerCase();
}

function describeEnvironment(machineLabel?: string): RunEnvironment {
  const cpus = os.cpus();
  return {
    machineLabel: defaultMachineLabel(machineLabel),
    platform: process.platform,
    arch: process.arch,
    cpuModel: cpus[0]?.model?.trim() ?? "unknown",
    cpuCount: cpus.length,
    totalMemoryMb: Math.round(os.totalmem() / (1024 * 1024)),
    osRelease: os.release(),
    nodeVersion: process.version,
  };
}

function getIterationCount(
  mode: PerfMode,
  tier: ScenarioTier,
  override?: Partial<Record<PerfMode, number>>
): number {
  const explicit = override?.[mode];
  if (typeof explicit === "number" && explicit > 0) {
    return Math.floor(explicit);
  }

  return DEFAULT_ITERATIONS[mode][tier];
}

function selectScenarios(cli: CliOptions): PerfScenario[] {
  const scenarios = getScenariosForMode(cli.mode);
  if (cli.scenarioIds === null) return scenarios;

  const wanted = new Set(cli.scenarioIds);
  return scenarios.filter((scenario) => wanted.has(scenario.id));
}

/**
 * Anything outside this set gets quoted. Deliberately conservative: the line is
 * printed for a human to copy back into a shell, and a bare `$(…)` or `;` in a
 * label would mean something there that it did not mean here.
 */
const SHELL_SAFE = /^[A-Za-z0-9._:,/=+-]+$/;

function quoteArg(value: string): string {
  return SHELL_SAFE.test(value) ? value : JSON.stringify(value);
}

/**
 * The exact command that reproduces this run.
 *
 * A perf number is only worth anything next to another number taken the same
 * way, so every run ends by handing the reader the invocation that produces its
 * twin — no reconstructing flags from scrollback. Paths are reproduced only
 * when they were overridden, which is why the defaults are recomputed here
 * rather than remembered: `cli` holds resolved paths either way.
 */
function buildRerunCommand(cli: CliOptions): string {
  const parts = ["npm", "run", "perf", cli.mode, "--"];
  const optionCount = parts.length;

  if (cli.scenarioIds !== null) parts.push("--scenario", cli.scenarioIds.join(","));
  if (cli.iterations !== undefined) parts.push("--iterations", String(cli.iterations));
  if (cli.warmups !== undefined) parts.push("--warmups", String(cli.warmups));
  if (cli.label !== undefined) parts.push("--label", quoteArg(cli.label));
  if (cli.machineLabel !== undefined) parts.push("--machine", quoteArg(cli.machineLabel));
  if (cli.jsonPath !== undefined) parts.push("--json", quoteArg(cli.jsonPath));
  if (cli.outDir !== defaultOutDir()) parts.push("--out-dir", quoteArg(cli.outDir));
  if (cli.baselinePath !== defaultBaselinePath(cli.mode)) {
    parts.push("--baseline", quoteArg(cli.baselinePath));
  }
  if (cli.updateBaseline) parts.push("--update-baseline");

  // Nothing but the mode survived, so `--` would dangle.
  if (parts.length === optionCount) parts.pop();

  return parts.join(" ");
}

/** Filenames are shared across OSes; a hostname is not a safe path component. */
function sanitizeForFilename(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
}

/**
 * One small tracked file per mode per machine, overwritten each run.
 *
 * `git log -p scripts/perf/history/` is the point — one measurement per line,
 * so a diff names which scenario moved and by how much. It carries p95 and each
 * metric's max and sum, and nothing else; a full summary per run would be too
 * large to read a diff of, which is the only thing this file is for.
 *
 * Metric stats are flattened to `<metric>.max` / `<metric>.sum` scalars rather
 * than nested as an array or a sub-object. Two reasons, same root: an array
 * here is re-wrapped by prettier, so every regenerated file would fail
 * `format:check` the moment it was committed; a sub-object costs four lines per
 * metric. Array-free `JSON.stringify(…, 2)` output is already prettier-clean —
 * `config/baseline.*.json` has always relied on that.
 */
function writeHistory(summary: PerfRunSummary): string {
  const historyPath = path.join(
    HISTORY_DIR,
    `${summary.mode}.${sanitizeForFilename(summary.environment.machineLabel)}.json`
  );

  const scenarios: Record<string, Record<string, number>> = {};
  for (const aggregate of summary.aggregates) {
    // p50 leads, matching what the report and `perf compare` both say: at these
    // iteration counts a p95 is effectively one of the two largest samples, so
    // a history keyed on it records noise as though it were trend. p95 rides
    // along for the tail, and `runs` because a duration is uninterpretable
    // without knowing how many samples produced it.
    const entry: Record<string, number> = {
      p50Ms: aggregate.p50Ms,
      p95Ms: aggregate.p95Ms,
      runs: aggregate.runs,
    };
    for (const [name, stat] of Object.entries(aggregate.metricStats)) {
      entry[`${name}.max`] = stat.max;
      entry[`${name}.sum`] = stat.sum;
      // The metric's OWN denominator, not the scenario's. A metric only some
      // iterations emit has a smaller count, and two histories both reporting
      // `runs: 16` can still hold sums over 1 and 16 samples respectively —
      // which reads as a 16x regression.
      entry[`${name}.count`] = stat.count;
    }
    scenarios[aggregate.id] = entry;
  }

  writeJson(historyPath, {
    generatedAt: summary.generatedAt,
    mode: summary.mode,
    label: summary.label,
    environment: summary.environment,
    scenarios,
  });

  return historyPath;
}

async function run(): Promise<void> {
  const cli = parseArgs(process.argv.slice(2));
  assertMatrixCoverage();

  ensureDir(cli.outDir);

  const budgetConfig = loadBudgetConfig();
  const baseline = readJson<BaselineSummary>(cli.baselinePath);

  checkBaselineFreshness(baseline, cli.mode);

  const scenarios = selectScenarios(cli);
  if (scenarios.length === 0) {
    throw new Error(`No scenarios configured for mode ${cli.mode}`);
  }

  // Regenerating the baseline is exactly how coverage gaps get fixed, so an
  // --update-baseline run has nothing to be told. Everywhere else this is a
  // note, not a problem: a scenario with no reference value yet is the normal
  // state for a new scenario or a newly added OS.
  if (!cli.updateBaseline) {
    const coverageGaps = checkBaselineCoverage(baseline, budgetConfig, scenarios);
    if (coverageGaps.length > 0) {
      const ids = coverageGaps.map((gap) => gap.scenarioId).join(", ");
      console.warn(
        `[perf:${cli.mode}] no reference yet for ${coverageGaps.length} scenario(s) ` +
          `(${cli.baselinePath}): ${ids}. Regenerate with --update-baseline.`
      );
    }
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const rawJsonlPath = path.join(cli.outDir, `${timestamp}-${cli.mode}.raw.jsonl`);

  const context: ScenarioContext = {
    mode: cli.mode,
    now: () => performance.now(),
  };

  const aggregateById = new Map<
    string,
    {
      name: string;
      description: string;
      tier: ScenarioTier;
      durations: number[];
      metrics: Array<Record<string, number>>;
      notes: string[];
    }
  >();

  for (const scenario of scenarios) {
    const warmups = cli.warmups ?? Math.max(0, scenario.warmups ?? 1);
    const iterations =
      cli.iterations ?? getIterationCount(cli.mode, scenario.tier, scenario.iterations);

    for (let i = 0; i < warmups; i += 1) {
      await scenario.run(context);
    }

    for (let iteration = 1; iteration <= iterations; iteration += 1) {
      const start = performance.now();
      const sample = (await scenario.run(context)) as ScenarioSample;
      const wallClockMs = performance.now() - start;
      if (!Number.isFinite(sample.durationMs)) {
        throw new Error(
          `Scenario ${scenario.id} returned non-finite durationMs (${sample.durationMs})`
        );
      }
      // A non-positive durationMs is the "harness self-times" sentinel —
      // substitute the wall-clock bracket. This must stay `> 0`, not `>= 0`:
      // ~32 metric-only scenarios (PERF-001, PERF-090, …) hardcode
      // `durationMs: 0` from before fccf058ee, when the harness wall-clocked
      // every scenario unconditionally. Treating that 0 as a real measurement
      // writes a literal-zero p95 into the baseline, which drops the scenario
      // under gate.ts's MIN_REGRESSION_BASELINE_MS floor and silently disables
      // its regression gate. That went unnoticed because no baseline has been
      // regenerated since 2026-02-11 — before the sentinel changed.
      const durationMs = sample.durationMs > 0 ? sample.durationMs : wallClockMs;

      const metrics = sample.metrics ?? {};
      // A non-finite metric is a broken apparatus, not a slow number, so it
      // throws rather than flowing onward. Two concrete reasons: NaN silently
      // poisons every aggregate downstream (max/sum/mean all become NaN), and
      // `JSON.stringify` writes non-finite numbers as `null`, which violates
      // MetricStat's `number` contract and would hand the renderer a field it
      // cannot type-check. Failing here is the stance working as intended —
      // measurements are never gated, but a measurement that isn't a number
      // was never a measurement.
      for (const [metricName, value] of Object.entries(metrics)) {
        if (typeof value !== "number" || !Number.isFinite(value)) {
          throw new Error(
            `Scenario ${scenario.id} iteration ${iteration} emitted a non-finite metric ` +
              `"${metricName}" (${String(value)})`
          );
        }
      }
      const note = sample.notes?.trim();

      appendJsonLine(rawJsonlPath, {
        scenarioId: scenario.id,
        scenarioName: scenario.name,
        iteration,
        durationMs: round(durationMs),
        timestamp: new Date().toISOString(),
        metrics,
        notes: note,
      } satisfies RawSample);

      const existing = aggregateById.get(scenario.id) ?? {
        name: scenario.name,
        description: scenario.description,
        tier: scenario.tier,
        durations: [],
        metrics: [],
        notes: [],
      };

      existing.durations.push(durationMs);
      existing.metrics.push(metrics);
      if (note) {
        existing.notes.push(note);
      }

      aggregateById.set(scenario.id, existing);
    }
  }

  const scenariosOutsideReference: string[] = [];
  const aggregates: ScenarioAggregate[] = [];

  for (const [scenarioId, aggregate] of aggregateById.entries()) {
    const p50Ms = percentile(aggregate.durations, 50);
    const p95Ms = percentile(aggregate.durations, 95);
    const p99Ms = percentile(aggregate.durations, 99);
    const maxMs = Math.max(...aggregate.durations);
    const meanMs = mean(aggregate.durations);
    const stdDevMs = stdDev(aggregate.durations);

    const metricAverages = averageMetrics(aggregate.metrics);
    const metricStats = aggregateMetrics(aggregate.metrics);

    const budget = getScenarioBudget(budgetConfig, scenarioId);
    const baselineP95 = baseline?.p95ByScenario?.[scenarioId];
    const { outsideReference, measurementIssues, reasons } = evaluateScenarioBudget({
      scenarioId,
      p95Ms,
      metricStats,
      budget,
      baselineP95,

      hasBaselineFile: baseline !== null,
    });

    if (outsideReference) {
      scenariosOutsideReference.push(scenarioId);
    }

    aggregates.push({
      id: scenarioId,
      name: aggregate.name,
      description: aggregate.description,
      tier: aggregate.tier,
      runs: aggregate.durations.length,
      p50Ms: round(p50Ms),
      p95Ms: round(p95Ms),
      p99Ms: round(p99Ms),
      maxMs: round(maxMs),
      meanMs: round(meanMs),
      stdDevMs: round(stdDevMs),
      metricAverages: Object.fromEntries(
        Object.entries(metricAverages).map(([key, value]) => [key, round(value)])
      ),
      // Deliberately NOT rounded. Rounding here is lossy at the producer, and
      // the loss is silent: PERF-151's `msPerTargetAt48` samples sit around
      // 4e-4, so three decimal places reported its minimum as a flat `0` — a
      // real measurement rendered as no measurement. Both consumers format for
      // display themselves, and `perf compare` needs the precision to see a
      // small metric move at all.
      metricStats: Object.fromEntries(
        Object.entries(metricStats).map(([key, stat]) => [
          key,
          {
            mean: stat.mean,
            max: stat.max,
            min: stat.min,
            sum: stat.sum,
            count: stat.count,
          },
        ])
      ),
      outsideReference,
      referenceNotes: reasons.length > 0 ? reasons.join("; ") : undefined,
      measurementIssues,
      notes: [...new Set(aggregate.notes)].slice(0, 3),
    });
  }

  aggregates.sort((a, b) => a.id.localeCompare(b.id));

  const summary: PerfRunSummary = {
    generatedAt: new Date().toISOString(),
    mode: cli.mode,
    nodeVersion: process.version,
    platform: process.platform,
    label: cli.label,
    environment: describeEnvironment(cli.machineLabel),
    protocol: {
      iterations: cli.iterations ?? null,
      warmups: cli.warmups ?? null,
      scenarioSelection: cli.scenarioIds,
    },
    scenarioCount: aggregates.length,
    scenariosOutsideReference,
    aggregates,
  };

  const summaryJsonPath = path.join(cli.outDir, `${timestamp}-${cli.mode}.summary.json`);
  const reportMdPath = path.join(cli.outDir, `${timestamp}-${cli.mode}.report.md`);
  const latestSummaryPath = path.join(cli.outDir, `latest-${cli.mode}.summary.json`);
  const latestReportPath = path.join(cli.outDir, `latest-${cli.mode}.report.md`);
  const report = buildMarkdownReport(summary);

  writeJson(summaryJsonPath, summary);
  writeText(reportMdPath, report);
  writeJson(latestSummaryPath, summary);
  writeText(latestReportPath, report);

  if (cli.jsonPath) {
    writeJson(path.resolve(process.cwd(), cli.jsonPath), summary);
  }

  if (cli.updateBaseline) {
    const baselineOut: BaselineSummary = {
      generatedAt: new Date().toISOString(),
      mode: cli.mode,
      p95ByScenario: Object.fromEntries(
        aggregates.map((aggregate) => [aggregate.id, aggregate.p95Ms])
      ),
    };
    writeJson(cli.baselinePath, baselineOut);
  }

  // Only a canonical run earns a history entry. A filtered run measured a slice
  // of the matrix and an --iterations/--warmups run measured it differently,
  // and the file has no room to say so — either would silently replace the
  // machine's record with something that reads identically but is not
  // comparable to what came before it.
  const isCanonicalRun =
    cli.scenarioIds === null && cli.iterations === undefined && cli.warmups === undefined;
  const historyPath = isCanonicalRun ? writeHistory(summary) : null;

  // The step summary is a convenience, not a result. A run whose numbers are
  // already on disk must not fail because Actions handed us an unwritable path.
  const stepSummaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (stepSummaryPath) {
    try {
      appendText(stepSummaryPath, `${report}\n`);
    } catch (error) {
      console.warn(`[perf:${cli.mode}] could not write GITHUB_STEP_SUMMARY: ${String(error)}`);
    }
  }

  const measurementIssueCount = aggregates.reduce(
    (total, aggregate) => total + aggregate.measurementIssues.length,
    0
  );

  console.log(
    `[perf:${cli.mode}] scenarios=${aggregates.length} ` +
      `outside-reference=${scenariosOutsideReference.length} ` +
      `measurement-issues=${measurementIssueCount}`
  );

  for (const aggregate of aggregates) {
    const marker = aggregate.outsideReference ? "outside" : "ok";
    const reason = aggregate.referenceNotes ? ` (${aggregate.referenceNotes})` : "";
    console.log(
      `[${marker}] ${aggregate.id} p95=${aggregate.p95Ms}ms p99=${aggregate.p99Ms}ms${reason}`
    );
  }

  // Printed apart from the rows above, and last, because this is the one class
  // that is not a number being worse: a configured metric that stopped being
  // emitted reads exactly like a pass in every row-level view.
  if (measurementIssueCount > 0) {
    console.warn(
      `\n[perf:${cli.mode}] MEASUREMENT ISSUES — ${measurementIssueCount} broken measurement(s), ` +
        `not slow numbers. Each one is a gate that has silently stopped meaning anything:`
    );
    for (const aggregate of aggregates) {
      for (const issue of aggregate.measurementIssues) {
        console.warn(`  ${aggregate.id}: ${issue}`);
      }
    }
    console.warn("");
  }

  console.log(`[perf:${cli.mode}] summary: ${summaryJsonPath}`);
  if (cli.jsonPath) console.log(`[perf:${cli.mode}] json: ${cli.jsonPath}`);
  if (historyPath) console.log(`[perf:${cli.mode}] history: ${historyPath}`);
  console.log(`[perf:${cli.mode}] rerun: ${buildRerunCommand(cli)}`);
}

// Vitest imports this module for the arg-parser tests, so the harness only
// starts when the file is the process entrypoint.
const isEntrypoint =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

/**
 * Scenario fixtures can leave live native handles behind (file watchers,
 * long-lived monitor harnesses), which would keep the process alive after all
 * results are written, so the exit is explicit. Both streams are drained first:
 * `process.exit` truncates whatever is still queued, and in CI stderr is a pipe
 * — which is exactly where the measurement-issue block goes.
 */
function exitAfterFlush(code: number): Promise<never> {
  return new Promise<never>((resolve) => {
    let pending = 2;
    const done = () => {
      pending -= 1;
      if (pending === 0) resolve(process.exit(code));
    };
    process.stdout.write("", done);
    process.stderr.write("", done);
  });
}

if (isEntrypoint) {
  run()
    // Hardcoded 0, not `process.exitCode`: this is the whole stance in one
    // line. A measurement being worse than a reference value is reported and
    // never failed on, so the only way out with a non-zero code is a throw.
    .then(() => exitAfterFlush(0))
    .catch((error) => {
      if (error instanceof UsageError) {
        console.error(`[perf] ${error.message}`);
      } else {
        console.error("[perf] run failed", error);
      }
      return exitAfterFlush(1);
    });
}
