import { performance } from "node:perf_hooks";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { loadBudgetConfig, getScenarioBudget } from "./lib/budgets";
import { compareSamples } from "./lib/comparison";
import { appendJsonLine, readJson, writeJson, writeText, ensureDir } from "./lib/io";
import { mean, percentile, round, stdDev } from "./lib/stats";
import { buildMarkdownReport } from "./report/generate";
import { assertMatrixCoverage, getScenariosForMode } from "./scenarios";
import type {
  BaselineSummary,
  ComparisonAggregate,
  PerfMode,
  PerfRunSummary,
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
const MIN_REGRESSION_BASELINE_MS = 5;

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

  const scenarios = getScenariosForMode(cli.mode);
  if (scenarios.length === 0) {
    throw new Error(`No scenarios configured for mode ${cli.mode}`);
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
      const durationMs = sample.durationMs >= 0 ? sample.durationMs : wallClockMs;

      const metrics = sample.metrics ?? {};
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

  const failedScenarios: string[] = [];
  const aggregates: ScenarioAggregate[] = [];

  for (const [scenarioId, aggregate] of aggregateById.entries()) {
    const p50Ms = percentile(aggregate.durations, 50);
    const p95Ms = percentile(aggregate.durations, 95);
    const p99Ms = percentile(aggregate.durations, 99);
    const maxMs = Math.max(...aggregate.durations);
    const meanMs = mean(aggregate.durations);
    const stdDevMs = stdDev(aggregate.durations);

    const metricAverages: Record<string, number> = {};
    for (const sampleMetrics of aggregate.metrics) {
      for (const [key, value] of Object.entries(sampleMetrics)) {
        metricAverages[key] = (metricAverages[key] ?? 0) + value;
      }
    }
    for (const key of Object.keys(metricAverages)) {
      metricAverages[key] = metricAverages[key] / aggregate.metrics.length;
    }

    const budget = getScenarioBudget(budgetConfig, scenarioId);
    let failedBudget = false;
    const reasons: string[] = [];

    if (budget.p95Ms !== undefined && p95Ms > budget.p95Ms) {
      failedBudget = true;
      reasons.push(`p95 ${round(p95Ms)}ms > budget ${budget.p95Ms}ms`);
    }

    if (budget.maxMetricValues) {
      for (const [metricName, maxValue] of Object.entries(budget.maxMetricValues)) {
        const actual = metricAverages[metricName];
        if (actual !== undefined && actual > maxValue) {
          failedBudget = true;
          reasons.push(`${metricName} ${round(actual)} > max ${maxValue}`);
        }
      }
    }

    const baselineP95 = baseline?.p95ByScenario?.[scenarioId];
    if (
      baselineP95 !== undefined &&
      baselineP95 >= MIN_REGRESSION_BASELINE_MS &&
      budget.maxRegressionPct !== undefined
    ) {
      const regressionPct = ((p95Ms - baselineP95) / baselineP95) * 100;
      if (regressionPct > budget.maxRegressionPct) {
        failedBudget = true;
        reasons.push(
          `regression ${round(regressionPct)}% exceeds ${budget.maxRegressionPct}% baseline gate`
        );
      }
    }

    if (!baseline && budgetConfig.criticalScenarios.includes(scenarioId)) {
      reasons.push("baseline missing - regression gate skipped");
    }

    if (failedBudget) {
      failedScenarios.push(scenarioId);
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
      failedBudget,
      budgetReason: reasons.length > 0 ? reasons.join("; ") : undefined,
      notes: [...new Set(aggregate.notes)].slice(0, 3),
    });
  }

  aggregates.sort((a, b) => a.id.localeCompare(b.id));

  // A/B comparison mode: run baseline arm and compare statistically
  let comparisonAggregates: ComparisonAggregate[] = [];
  if (cli.compare) {
    const mergeBase = getMergeBase(cli.compareBase);
    if (!mergeBase) {
      console.warn("[perf:compare] Could not determine merge-base — skipping comparison");
    } else {
      console.log(`[perf:compare] Baseline ref: ${mergeBase.slice(0, 12)}`);

      const baseOutDir = path.join(cli.outDir, "baseline-arm");
      ensureDir(baseOutDir);

      const baseArmData = await runBaselineArm(mergeBase, cli, baseOutDir);

      comparisonAggregates = computeComparisons(aggregateById, baseArmData, budgetConfig);

      for (const comp of comparisonAggregates) {
        if (comp.comparison.regression) {
          const headAgg = comp.head;
          if (!failedScenarios.includes(headAgg.id)) {
            failedScenarios.push(headAgg.id);
          }
          headAgg.failedBudget = true;
          headAgg.budgetReason =
            (headAgg.budgetReason ?? "")
              ? `${headAgg.budgetReason}; A/B regression (p=${round(comp.comparison.pValue)}, d=${round(comp.comparison.effectSize)})`
              : `A/B regression (p=${round(comp.comparison.pValue)}, d=${round(comp.comparison.effectSize)})`;
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
    scenarioCount: aggregates.length,
    failedScenarios,
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

  const passed = failedScenarios.length === 0;
  const gateMessage = passed ? "PASS" : "FAIL";
  console.log(
    `[perf:${cli.mode}] ${gateMessage} scenarios=${aggregates.length} failed=${failedScenarios.length}`
  );

  for (const aggregate of aggregates) {
    const marker = aggregate.failedBudget ? "x" : "ok";
    const reason = aggregate.budgetReason ? ` (${aggregate.budgetReason})` : "";
    console.log(
      `[${marker}] ${aggregate.id} p95=${aggregate.p95Ms}ms p99=${aggregate.p99Ms}ms${reason}`
    );
  }

  if (!passed) {
    process.exitCode = 1;
  }
}

run().catch((error) => {
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
      failedBudget: false,
      notes: [...new Set(aggregate.notes)].slice(0, 3),
    });
  }

  return aggregates;
}
