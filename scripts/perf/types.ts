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

/**
 * Whether a scenario's numbers mean anything on a given platform.
 *
 * `supported` — the subject exists here and the number is authoritative.
 * `diagnostic` — it runs and produces a number, but something in the path is
 *   emulated, shimmed, or blind on this platform, so the figure is a signal and
 *   not a measurement. Reported, never compared against another platform.
 * `unsupported` — the subject does not exist here; the scenario is skipped.
 *
 * Absent means `supported` everywhere. Stated explicitly rather than inferred,
 * because the failure this prevents is a Windows count being read as
 * authoritative when the observer that produced it cannot see Windows spawns.
 */
export type PlatformApplicability = "supported" | "diagnostic" | "unsupported";

export interface PerfScenario {
  id: string;
  name: string;
  description: string;
  tier: ScenarioTier;
  modes: readonly PerfMode[];
  warmups?: number;
  iterations?: Partial<Record<PerfMode, number>>;
  /**
   * Metric keys that prove the scenario's subject actually did its work.
   *
   * This is the invariant a count-reporting benchmark cannot be trusted
   * without: a dead subsystem spawns nothing, allocates nothing and finishes
   * instantly, which reads as the best result the harness has ever recorded.
   * Each named metric is a MISS COUNT — it must be emitted on EVERY iteration,
   * including healthy ones, and a healthy run reports 0.
   *
   * Emitting it only on failure defeats the purpose twice over: a scenario that
   * silently stopped running reports no misses at all, and `MetricStat.count`
   * tallies only the iterations that emitted the metric, so one healthy sample
   * among fifteen absent ones still aggregates to `max: 0`.
   *
   * Required for any scenario reporting a count-class metric; enforced by the
   * matrix test rather than by convention.
   */
  correctness?: readonly string[];
  /**
   * Per-platform applicability. Omit when the scenario is authoritative
   * everywhere it runs.
   */
  platforms?: Partial<Record<NodeJS.Platform, PlatformApplicability>>;
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
  /**
   * How far this platform's copy of the number can be trusted. Absent means
   * `supported`. A `diagnostic` reading is a signal, not a measurement, and
   * carrying it into a cross-platform comparison would be presenting an
   * emulated path as an authoritative one.
   */
  applicability?: PlatformApplicability;
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
  /**
   * Versions of the things being measured, not just the thing measuring.
   *
   * A git or Electron upgrade moves subprocess counts and IPC costs on its own.
   * Without these a results file records only that the numbers changed, leaving
   * a real toolchain regression indistinguishable from a code regression.
   */
  electronVersion: string | null;
  gitVersion: string | null;
  /**
   * The commit the measured code was at, so a stored "best" result can be tied
   * back to a checkpoint rather than trusted on its filename.
   */
  sourceSha: string | null;
}

/**
 * How the run was driven, as distinct from where it ran.
 *
 * Two runs on the same machine are still not comparable if they sampled
 * differently. `--warmups 0` leaves cold-start cost in the numbers that a
 * warmed run has already paid, so a before/after pair that differs here reports
 * the difference in protocol as though it were a difference in the code. The
 * measured iteration count alone does not reveal it, which is why this is
 * recorded rather than inferred.
 */
export interface RunProtocol {
  /** `--iterations` override, or null when each scenario used its own default. */
  iterations: number | null;
  /** `--warmups` override, or null when each scenario used its own default. */
  warmups: number | null;
  /** Scenario ids when the run was filtered with `--scenario`, else null. */
  scenarioSelection: string[] | null;
}

export interface PerfRunSummary {
  generatedAt: string;
  mode: PerfMode;
  nodeVersion: string;
  platform: NodeJS.Platform;
  /** Free-text tag for this run, e.g. "before" / "after". */
  label?: string;
  environment: RunEnvironment;
  protocol: RunProtocol;
  scenarioCount: number;
  /** Scenarios outside a reference value. Informational — never a failure. */
  scenariosOutsideReference: string[];
  /**
   * Scenarios not run because they are `unsupported` on this platform.
   *
   * Recorded rather than merely printed, because in the results file a skipped
   * scenario is otherwise indistinguishable from one that was never written:
   * `perf compare` would report it as absent from both sides and say nothing.
   * Naming them is what lets a cross-platform comparison state which rows are
   * missing by design.
   */
  scenariosSkipped: string[];
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
  defaultBudget: ScenarioBudget;
  scenarios: Record<string, ScenarioBudget>;
}

/**
 * Machine identity of the run that measured a baseline entry.
 *
 * Deliberately a projection of {@link RunEnvironment} rather than a second
 * vocabulary for the same thing: `durationsComparable` reads exactly these
 * three fields, so an entry carries what the comparability rules need and
 * nothing they do not.
 */
export type BaselineMachine = Pick<RunEnvironment, "machineLabel" | "platform" | "arch">;

/**
 * One scenario's reference p95, with the provenance needed to read it.
 *
 * A p95 is a `duration`, so it means nothing away from the machine that
 * produced it, and entries now accumulate one scenario at a time across
 * whichever machines the developer measured on. Without a per-entry date and
 * machine, a reference measured on a Windows laptop six months ago is
 * indistinguishable from one measured on this Mac today — and every
 * `outsideReference` annotation computed against it is then a statement about
 * two laptops presented as a statement about the code.
 */
export interface BaselineEntry {
  p95Ms: number;
  /** When the run that produced this p95 ran — NOT when the file was written. */
  measuredAt: string;
  /**
   * Null only for an entry lifted from a pre-provenance file, where the machine
   * was never recorded. Null means unknown, and every reader treats unknown as
   * "not this machine" rather than assuming the convenient answer.
   */
  machine: BaselineMachine | null;
}

export interface BaselineSummary {
  /**
   * When this FILE was last written, and nothing more.
   *
   * `--update-baseline` merges one measured scenario into an existing file, so
   * this carries today's date on a file whose other forty entries are months
   * old. Freshness is per-entry (`BaselineEntry.measuredAt`). The one remaining
   * reader of this field is the legacy promotion in `readBaselineEntries`,
   * where it is the honest measurement date of every entry in a file that the
   * whole-matrix writer produced in a single pass.
   */
  generatedAt: string;
  mode: PerfMode;
  /**
   * Pre-provenance shape: read, never written. The committed baselines are
   * still in it, as is any file written before provenance existed.
   */
  p95ByScenario?: Record<string, number>;
  /** Provenanced entries. What `--update-baseline` writes from now on. */
  scenarios?: Record<string, BaselineEntry>;
}
