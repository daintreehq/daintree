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
  metricAverages: Record<string, number>;
  failedBudget: boolean;
  budgetReason?: string;
  notes: string[];
}

export interface PerfRunSummary {
  generatedAt: string;
  mode: PerfMode;
  nodeVersion: string;
  platform: NodeJS.Platform;
  scenarioCount: number;
  failedScenarios: string[];
  aggregates: ScenarioAggregate[];
}

export interface ScenarioBudget {
  p95Ms?: number;
  maxRegressionPct?: number;
  /**
   * Opt this scenario out of the baseline regression gate until a baseline
   * generated on the CI runner exists for it.
   *
   * `defaultBudget` supplies `maxRegressionPct`, so a new scenario inherits a
   * regression gate it has no baseline for — which fails the whole run in
   * `checkBaselineCoverage`. Committing a locally-generated baseline is not the
   * fix: baselines are runner-specific. Set this instead, then remove it once
   * `perf-update-baselines` has published a baseline containing the scenario.
   * Absolute `p95Ms` and `maxMetricValues` budgets still apply.
   */
  calibrating?: boolean;
  maxMetricValues?: Record<string, number>;
  comparison?: {
    maxPValue: number;
    minEffectSize: number;
  };
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
