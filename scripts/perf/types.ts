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

/**
 * What a benchmark's numbers are allowed to be claimed to mean.
 *
 * `journey` starts at a real user entry point, runs the production process
 * topology, and ends at a correct visible or usable result. `mechanism` measures
 * a real shipped function or service with one or more user-path layers removed
 * on purpose. `diagnostic` means the subject inside the timed bracket is
 * emulated, shimmed, simulated, or a deliberate floor — a signal, never a
 * product claim.
 *
 * The classification table is `config/benchmarkClasses.ts`.
 */
export type BenchmarkKind = "journey" | "mechanism" | "diagnostic";

/**
 * Which layers of the real path a benchmark actually contains.
 *
 * Not a quality score — a `mechanism` benchmark with `renderer: "absent"` is
 * working as designed. It is a compact statement of what the number means, so
 * a reader never has to infer fidelity from a fixture comment.
 */
export interface BenchmarkFidelity {
  entryPoint: "user-event" | "public-api" | "internal-function";
  renderer: "real" | "headless" | "absent";
  electronTransport: "real" | "node-channel" | "stubbed" | "none";
  pty: "real" | "replay" | "fake" | "none";
  processTopology: "packaged" | "e2e-build" | "partial" | "single-process";
  externalDependencies: "hermetic" | "controlled-network" | "uncontrolled";
}

export interface BenchmarkClass {
  kind: BenchmarkKind;
  /** Short family label, e.g. "git pipeline". */
  family: string;
  fidelity: BenchmarkFidelity;
  /** What may be claimed from these numbers, and what is deliberately absent. */
  claim: string;
}

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
   * Floors the fixture's ACHIEVED scale must meet, keyed by metric name.
   *
   * A correctness predicate proves the subject did its work. This proves the
   * subject was given the work to do — a different failure, and the one that
   * produces the most flattering wrong number in the suite. A scenario that
   * asked for twelve background terminals and started nine measures a lighter
   * workload than it claims and reports a better latency for it, with every
   * predicate at zero because the nine it did start behaved perfectly.
   *
   * Each entry is a MINIMUM, checked against the metric's `min` across
   * iterations rather than its mean, because one starved iteration among
   * fifteen healthy ones is exactly the case an average hides. Falling short is
   * a measurement issue, so it is reported loudly and fails under
   * `--enforce-integrity` — never a numeric gate.
   *
   * The floor belongs to the SCENARIO, not the fixture, so a fixture that
   * quietly scaled itself down cannot also lower the bar it is judged against.
   */
  workloadFloors?: Readonly<Record<string, number>>;
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
  /**
   * What layer this number describes — `journey`, `mechanism` or `diagnostic`.
   *
   * Carried on the aggregate rather than looked up by readers, so a summary
   * JSON handed to another tool states its own fidelity. A row without one is a
   * scenario missing from `config/benchmarkClasses.ts`, which the matrix test
   * refuses.
   */
  kind?: BenchmarkKind;
  /** The claim sentence from the classification table, verbatim. */
  claim?: string;
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
  /**
   * Content hash of `scripts/perf/`, or null when it could not be computed.
   *
   * A before/after pair measured under two different harnesses is a comparison
   * of two measuring instruments, not of two implementations — and nothing else
   * in the file reveals it, because the scenario id, machine, iteration count
   * and protocol all match. `.agents/skills/optimize` already hashes this
   * directory into its precommit record; recording it here means an ordinary
   * `perf compare` can say so too.
   */
  harnessHash?: string | null;
  /**
   * Whether the run was invoked with `--enforce-integrity`.
   *
   * Optional for the same reason as `harnessHash`: a summary written before
   * this existed has no answer, and `false` would be an invention rather than a
   * reading. Every run written from now on states it.
   */
  enforceIntegrity?: boolean;
}

/**
 * Whether a run produced usable EVIDENCE, as distinct from good numbers.
 *
 * These are three different questions and the harness answers them separately:
 * integrity ("is this evidence valid?"), correctness ("did the subject do the
 * work?") and performance ("was valid, correct behaviour slow?"). Only the
 * third is the advisory one. A run whose oracle failed is not a slow result; it
 * is not a result, and `--enforce-integrity` is what lets a caller act on that
 * distinction without also arming a numeric gate.
 */
export interface IntegrityResult {
  /** True when `--enforce-integrity` was passed; the exit code only moves then. */
  enforced: boolean;
  valid: boolean;
  /** One entry per broken measurement, prefixed with the scenario id. */
  issues: string[];
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
  /**
   * Whether the evidence in this file is trustworthy, and whether the run was
   * asked to fail on that. Absent from summaries written before it existed.
   */
  integrity?: IntegrityResult;
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
