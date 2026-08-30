import { performance } from "node:perf_hooks";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { loadBudgetConfig, getScenarioBudget } from "./lib/budgets";
import { checkBaselineCoverage, checkBaselineFreshness } from "./lib/baselineCoverage";
import { compareSamples } from "./lib/comparison";
import { evaluateScenarioBudget } from "./lib/gate";
import { appendJsonLine, readJson, writeJson, writeText, ensureDir } from "./lib/io";
import { aggregateMetrics, averageMetrics, mean, percentile, round, stdDev } from "./lib/stats";
import { buildMarkdownReport } from "./report/generate";
import { assertMatrixCoverage, getScenariosForMode } from "./scenarios";
import type {
  BaselineSummary,
  ComparisonAggregate,
  PerfMode,
  PerfRunSummary,
  RunEnvironment,
  ScenarioAggregate,
  ScenarioContext,
  ScenarioSample,
  ScenarioTier,
} from "./types";

interface CliOptions {
  mode: PerfMode;
  outDir: string;
  baselinePath: string;
  updateBaseline: boolean;
  compare: boolean;
  compareBase: string;
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

interface BaselineArmData {
  aggregates: ScenarioAggregate[];
  durationsById: Map<string, number[]>;
}

const DEFAULT_ITERATIONS: Record<PerfMode, Record<ScenarioTier, number>> = {
  smoke: { fast: 8, heavy: 4, soak: 1 },
  ci: { fast: 16, heavy: 8, soak: 2 },
  nightly: { fast: 24, heavy: 12, soak: 4 },
  soak: { fast: 10, heavy: 10, soak: 8 },
};

const MODES: ReadonlySet<string> = new Set(["smoke", "ci", "nightly", "soak"]);

function parseArgs(argv: string[]): CliOptions {
  const args = new Map<string, string>();
  const flags = new Set<string>();

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;

    const key = token.replace(/^--/, "");
    const maybeValue = argv[i + 1];
    if (!maybeValue || maybeValue.startsWith("--")) {
      flags.add(key);
      continue;
    }

    args.set(key, maybeValue);
    i += 1;
  }

  const modeRaw = args.get("mode") ?? "smoke";
  if (!MODES.has(modeRaw)) {
    throw new Error(`Invalid --mode value: ${modeRaw}`);
  }

  const mode = modeRaw as PerfMode;
  const outDir = args.get("out-dir") ?? path.resolve(process.cwd(), ".tmp/perf-results");
  const baselinePath =
    args.get("baseline") ??
    path.resolve(process.cwd(), `scripts/perf/config/baseline.${mode}.json`);

  return {
    mode,
    outDir,
    baselinePath,
    updateBaseline: flags.has("update-baseline"),
    compare: flags.has("compare"),
    compareBase: args.get("compare-base") ?? "origin/develop",
  };
}

/**
 * Identifies the machine a run happened on.
 *
 * Without this a results file cannot be safely diffed against another: latency
 * is only comparable to itself on one machine, and nothing recorded the machine.
 * `PERF_MACHINE_LABEL` wins so a laptop can carry a stable name across reboots;
 * otherwise the hostname, which is distinct enough between a laptop and a runner.
 */
function defaultMachineLabel(): string {
  const explicit = process.env.PERF_MACHINE_LABEL?.trim();
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

function describeEnvironment(): RunEnvironment {
  const cpus = os.cpus();
  return {
    machineLabel: defaultMachineLabel(),
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

async function run(): Promise<void> {
  const cli = parseArgs(process.argv.slice(2));
  assertMatrixCoverage();

  ensureDir(cli.outDir);

  const budgetConfig = loadBudgetConfig();
  const baseline = readJson<BaselineSummary>(cli.baselinePath);

  checkBaselineFreshness(baseline, cli.mode);

  const scenarios = getScenariosForMode(cli.mode);
  if (scenarios.length === 0) {
    throw new Error(`No scenarios configured for mode ${cli.mode}`);
  }

  // Regenerating the baseline is exactly how coverage gaps get fixed, so let an
  // --update-baseline run proceed even when entries are missing.
  if (!cli.updateBaseline) {
    const coverageGaps = checkBaselineCoverage(baseline, budgetConfig, scenarios);
    if (coverageGaps.length > 0) {
      const ids = coverageGaps.map((gap) => gap.scenarioId).join(", ");
      console.error(
        `[perf:${cli.mode}] FAIL ${coverageGaps.length} budgeted scenario(s) missing from ` +
          `baseline (${cli.baselinePath}) — regression gate cannot run: ${ids}. ` +
          `Regenerate with --update-baseline.`
      );
      process.exitCode = 1;
      return;
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
    const warmups = Math.max(0, scenario.warmups ?? 1);
    const iterations = getIterationCount(cli.mode, scenario.tier, scenario.iterations);

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
      metricAverages,
      budget,
      baselineP95,
      isCritical: budgetConfig.criticalScenarios.includes(scenarioId),
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
      metricStats: Object.fromEntries(
        Object.entries(metricStats).map(([key, stat]) => [
          key,
          {
            mean: round(stat.mean),
            max: round(stat.max),
            min: round(stat.min),
            sum: round(stat.sum),
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

  // A/B comparison mode: run baseline arm and compare statistically
  let comparisonAggregates: ComparisonAggregate[] = [];
  if (cli.compare) {
    const expectedComparisons = [...aggregateById.keys()].filter(
      (id) => getScenarioBudget(budgetConfig, id).comparison !== undefined
    );
    const failComparison = (reason: string) => {
      console.error(`[perf:compare] FAIL ${reason}`);
      for (const id of expectedComparisons) {
        if (!scenariosOutsideReference.includes(id)) {
          scenariosOutsideReference.push(id);
        }
      }
    };

    const mergeBase = getMergeBase(cli.compareBase);
    if (!mergeBase) {
      console.warn("[perf:compare] Could not determine merge-base — skipping comparison");
      // A requested comparison that can't run is not a pass. Fail closed when any
      // scenario in this run carries a comparison budget.
      if (expectedComparisons.length > 0) {
        failComparison(
          `merge-base unresolved — ${expectedComparisons.length} scenario(s) with comparison budgets left unenforced`
        );
      }
    } else {
      console.log(`[perf:compare] Baseline ref: ${mergeBase.slice(0, 12)}`);

      const baseOutDir = path.join(cli.outDir, "baseline-arm");
      ensureDir(baseOutDir);

      const baseArmData = await runBaselineArm(mergeBase, cli, baseOutDir);

      comparisonAggregates = computeComparisons(aggregateById, baseArmData, budgetConfig);

      if (expectedComparisons.length > 0 && comparisonAggregates.length === 0) {
        failComparison(
          `comparison arm produced no data for ${expectedComparisons.length} scenario(s) with comparison budgets — baseline arm did not run`
        );
      }

      const aggregateByIdForReport = new Map(aggregates.map((agg) => [agg.id, agg]));
      for (const comp of comparisonAggregates) {
        if (comp.comparison.regression) {
          if (!scenariosOutsideReference.includes(comp.head.id)) {
            scenariosOutsideReference.push(comp.head.id);
          }
          // Mutate the aggregate that gets serialized into the summary/report,
          // not comp.head (a detached copy built by computeComparisons).
          const reportAgg = aggregateByIdForReport.get(comp.head.id);
          if (reportAgg) {
            const abReason = `A/B regression (p=${round(comp.comparison.pValue)}, d=${round(comp.comparison.effectSize)})`;
            reportAgg.outsideReference = true;
            reportAgg.referenceNotes = reportAgg.referenceNotes
              ? `${reportAgg.referenceNotes}; ${abReason}`
              : abReason;
          }
        }
      }

      const comparisonJsonPath = path.join(cli.outDir, `${timestamp}-${cli.mode}.comparison.json`);
      writeJson(comparisonJsonPath, comparisonAggregates);
    }
  }

  const summary: PerfRunSummary = {
    generatedAt: new Date().toISOString(),
    mode: cli.mode,
    nodeVersion: process.version,
    platform: process.platform,
    environment: describeEnvironment(),
    scenarioCount: aggregates.length,
    scenariosOutsideReference,
    aggregates,
  };

  const summaryJsonPath = path.join(cli.outDir, `${timestamp}-${cli.mode}.summary.json`);
  const reportMdPath = path.join(cli.outDir, `${timestamp}-${cli.mode}.report.md`);
  const latestSummaryPath = path.join(cli.outDir, `latest-${cli.mode}.summary.json`);
  const latestReportPath = path.join(cli.outDir, `latest-${cli.mode}.report.md`);

  writeJson(summaryJsonPath, summary);
  writeText(reportMdPath, buildMarkdownReport(summary, comparisonAggregates));
  writeJson(latestSummaryPath, summary);
  writeText(latestReportPath, buildMarkdownReport(summary, comparisonAggregates));

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

  const passed = scenariosOutsideReference.length === 0;
  const gateMessage = passed ? "PASS" : "FAIL";
  console.log(
    `[perf:${cli.mode}] ${gateMessage} scenarios=${aggregates.length} failed=${scenariosOutsideReference.length}`
  );

  for (const aggregate of aggregates) {
    const marker = aggregate.outsideReference ? "x" : "ok";
    const reason = aggregate.referenceNotes ? ` (${aggregate.referenceNotes})` : "";
    console.log(
      `[${marker}] ${aggregate.id} p95=${aggregate.p95Ms}ms p99=${aggregate.p99Ms}ms${reason}`
    );
  }

  if (!passed) {
    process.exitCode = 1;
  }
}

run()
  .then(
    // Scenario fixtures can leave live native handles behind (file watchers,
    // long-lived monitor harnesses), which would keep the process alive after
    // all results are written. Drain stdout, then exit explicitly.
    () =>
      new Promise<never>((resolve) => {
        process.stdout.write("", () => resolve(process.exit(process.exitCode ?? 0)));
      })
  )
  .catch((error) => {
    console.error("[perf] run failed", error);
    process.exit(1);
  });

function getMergeBase(compareBase: string): string | null {
  try {
    return execFileSync("git", ["merge-base", "HEAD", compareBase], {
      encoding: "utf-8",
    }).trim();
  } catch {
    return null;
  }
}

async function runBaselineArm(
  _mergeBase: string,
  _cli: CliOptions,
  _baseOutDir: string
): Promise<BaselineArmData> {
  // In a full implementation, this would:
  // 1. Create a detached worktree at mergeBase
  // 2. Build the packaged binary in that worktree
  // 3. Run the same scenarios against the base binary
  // 4. Return the aggregates + raw durations
  //
  // For the initial implementation, we load previously-saved baseline data
  // if available, or skip the comparison arm.
  console.warn(
    "[perf:compare] Baseline arm execution not yet implemented — use --baseline for static comparison"
  );
  return { aggregates: [], durationsById: new Map() };
}

function computeComparisons(
  headAggregateById: Map<
    string,
    {
      name: string;
      description: string;
      tier: ScenarioTier;
      durations: number[];
      metrics: Array<Record<string, number>>;
      notes: string[];
    }
  >,
  baseArmData: BaselineArmData,
  budgetConfig: import("./types").PerfBudgetConfig
): ComparisonAggregate[] {
  const results: ComparisonAggregate[] = [];
  const baseById = new Map(baseArmData.aggregates.map((a) => [a.id, a]));
  const baseDurationsById = baseArmData.durationsById;

  // Build head aggregates from raw durations for comparison
  const headAggregates = buildAggregatesFromMap(headAggregateById);
  const headById = new Map(headAggregates.map((a) => [a.id, a]));

  for (const [scenarioId, headAgg] of headById) {
    const baseAgg = baseById.get(scenarioId);
    if (!baseAgg) continue;

    const budget = getScenarioBudget(budgetConfig, scenarioId);
    if (!budget.comparison) continue;

    const headDurations = headAggregateById.get(scenarioId)?.durations ?? [headAgg.meanMs];
    const baseDurations = baseDurationsById.get(scenarioId) ?? [baseAgg.meanMs];

    const comp = compareSamples(
      { label: "head", durations: headDurations },
      { label: "base", durations: baseDurations },
      budget.comparison.maxPValue,
      budget.comparison.minEffectSize
    );

    results.push({
      id: headAgg.id,
      head: headAgg,
      base: baseAgg,
      comparison: comp,
    });
  }

  return results;
}

function buildAggregatesFromMap(
  aggregateById: Map<
    string,
    {
      name: string;
      description: string;
      tier: ScenarioTier;
      durations: number[];
      metrics: Array<Record<string, number>>;
      notes: string[];
    }
  >
): ScenarioAggregate[] {
  const aggregates: ScenarioAggregate[] = [];

  for (const [scenarioId, aggregate] of aggregateById.entries()) {
    const p50Ms = percentile(aggregate.durations, 50);
    const p95Ms = percentile(aggregate.durations, 95);
    const meanMs = mean(aggregate.durations);
    const stdDevMs = stdDev(aggregate.durations);

    aggregates.push({
      id: scenarioId,
      name: aggregate.name,
      description: aggregate.description,
      tier: aggregate.tier,
      runs: aggregate.durations.length,
      p50Ms: round(p50Ms),
      p95Ms: round(p95Ms),
      p99Ms: round(percentile(aggregate.durations, 99)),
      maxMs: round(Math.max(...aggregate.durations)),
      meanMs: round(meanMs),
      stdDevMs: round(stdDevMs),
      metricAverages: {},
      metricStats: {},
      outsideReference: false,
      measurementIssues: [],
      notes: [...new Set(aggregate.notes)].slice(0, 3),
    });
  }

  return aggregates;
}
