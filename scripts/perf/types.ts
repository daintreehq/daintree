export type PerfMode = "smoke" | "ci" | "nightly" | "soak";

export type ScenarioTier = "fast" | "heavy" | "soak";

export interface ScenarioContext {
  mode: PerfMode;
  now: () => number;
}

export interface ScenarioSample {
  durationMs: number;
  metrics?: Record<string, number>;
  notes?: string;
}

export interface PerfScenario {
  id: string;
  name: string;
  description: string;
  tier: ScenarioTier;
  modes: readonly PerfMode[];
  warmups?: number;
  iterations?: Partial<Record<PerfMode, number>>;
  run: (context: ScenarioContext) => Promise<ScenarioSample> | ScenarioSample;
}

/**
 * Per-metric spread across a scenario's iterations.
 *
 * The mean alone is misleading for the metric class that matters most here. A
 * count of 20 process spawns in one iteration and 0 in fifteen others reports as
 * a mean of 1.25, which reads as "about one spawn" and hides the storm entirely
 * — the shape of the bug that prompted this harness rework. `max` and `sum` are
 * the honest summaries for a count, so both are recorded and both are reported.
 */
export interface MetricStat {
  mean: number;
  max: number;
  min: number;
  sum: number;
  /** Iterations that actually reported this metric, not the total run count. */
  count: number;
}

export interface ScenarioAggregate {
  id: string;
  name: string;
  description: string;
  tier: ScenarioTier;
  runs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
  meanMs: number;
  stdDevMs: number;
  /** Mean of each metric. Retained for continuity; prefer `metricStats`. */
  metricAverages: Record<string, number>;
  /** Full spread per metric — the numbers to read for counts. */
  metricStats: Record<string, MetricStat>;
  /**
   * The measurement sits outside a configured reference value. An annotation,
   * NOT a failure: the perf suite reports numbers and never fails a run for one.
   */
  outsideReference: boolean;
  referenceNotes?: string;
  /**
   * Defects in the measurement apparatus rather than in the number — a metric
   * with a configured reference that stopped being emitted, for instance.
   * Surfaced loudly, because a silently-absent metric reads as a pass.
   */
  measurementIssues: string[];
  notes: string[];
}

/**
 * Where and on what a run happened.
 *
 * Latency is only comparable to itself on one machine, so a results file that
 * cannot identify its machine cannot be safely diffed against another. `perf
 * compare` refuses to compare durations across differing `machineLabel`s.
 */
export interface RunEnvironment {
  /** Stable machine identifier, e.g. "greg-macbook" or "gh-windows-2022". */
  machineLabel: string;
  platform: NodeJS.Platform;
  arch: string;
  cpuModel: string;
  cpuCount: number;
  totalMemoryMb: number;
  osRelease: string;
  nodeVersion: string;
}

export interface PerfRunSummary {
  generatedAt: string;
  mode: PerfMode;
  nodeVersion: string;
  platform: NodeJS.Platform;
  /** Free-text tag for this run, e.g. "before" / "after". */
  label?: string;
  environment: RunEnvironment;
  scenarioCount: number;
  /** Scenarios outside a reference value. Informational — never a failure. */
  scenariosOutsideReference: string[];
  aggregates: ScenarioAggregate[];
}

export interface ScenarioBudget {
  p95Ms?: number;
  maxRegressionPct?: number;
  /** Ceilings compared against each metric's MAX across the run, not its mean. */
  maxMetricValues?: Record<string, number>;
}

export interface ComparisonSample {
  label: string;
  durations: number[];
}

export interface ComparisonResult {
  headLabel: string;
  baseLabel: string;
  uStatistic: number;
  pValue: number;
  effectSize: number;
  significant: boolean;
  regression: boolean;
}

export interface ComparisonAggregate {
  id: string;
  head: ScenarioAggregate;
  base: ScenarioAggregate;
  comparison: ComparisonResult;
}

export interface PerfBudgetConfig {
  criticalScenarios: string[];
  defaultBudget: ScenarioBudget;
  scenarios: Record<string, ScenarioBudget>;
}

export interface BaselineSummary {
  generatedAt: string;
  mode: PerfMode;
  p95ByScenario: Record<string, number>;
}
