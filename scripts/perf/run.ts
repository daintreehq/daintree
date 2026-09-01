import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadBudgetConfig, getScenarioBudget } from "./lib/budgets";
import {
  BASELINE_FRESHNESS_DAYS,
  checkBaselineCoverage,
  checkBaselineFreshness,
  describeForeignReference,
  readBaselineEntries,
} from "./lib/baselineCoverage";
import { classifyBenchmark } from "./config/benchmarkClasses";
import { evaluateCorrectness, evaluateScenarioBudget, evaluateWorkload } from "./lib/gate";
import { hashHarnessSources } from "./lib/harnessHash";
import { appendJsonLine, appendText, readJson, writeJson, writeText, ensureDir } from "./lib/io";
import { aggregateMetrics, averageMetrics, mean, percentile, round, stdDev } from "./lib/stats";
import { buildMarkdownReport } from "./report/generate";
import {
  assertMatrixCoverage,
  CORRECTNESS_EXEMPT_SCENARIO_IDS,
  getScenariosForMode,
} from "./scenarios";
import type {
  BaselineEntry,
  BaselineMachine,
  BaselineSummary,
  IntegrityResult,
  PerfMode,
  RunPurpose,
  PerfRunSummary,
  PerfScenario,
  PlatformApplicability,
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
  /**
   * Reference-value config. Overridable for the same reason `--baseline` is:
   * without it, nothing outside this repository's own committed budgets can
   * exercise the paths that read them — including the one where a configured
   * metric has stopped being emitted, which is the measurement issue the runner
   * most needs to be provably able to report.
   */
  budgetsPath: string;
  updateBaseline: boolean;
  /** The one scenario this run measures. Always exactly one; see resolveScenarioIds. */
  scenarioIds: string[];
  /** Overrides the per-tier default iteration count for every scenario. */
  iterations?: number;
  /** Overrides each scenario's own warmup count. */
  warmups?: number;
  /** Extra destination for the summary JSON, chosen by the caller. */
  jsonPath?: string;
  label?: string;
  machineLabel?: string;
  /**
   * Exit non-zero when the run produced invalid EVIDENCE — a missing or
   * partially-emitted correctness predicate, a predicate reporting misses, a
   * configured metric that stopped being emitted, a non-finite measurement.
   *
   * Deliberately NOT a performance gate: a valid, correct, slower number still
   * exits 0 under this flag. The distinction is the whole point — the suite's
   * refusal to fail on drift was being read as a refusal to fail on anything,
   * so a run whose oracle had died looked exactly like a clean one.
   */
  enforceIntegrity: boolean;
  /**
   * Keep this run out of the machine's trend history.
   *
   * For a run whose numbers are real but not representative — the profiled
   * rerun `diagnose.ts` drives is the case that prompted it. Its durations are
   * inflated by the instrumentation, and history has no column to say so, so a
   * profiled entry would sit in the trend looking exactly like a regression.
   */
  noHistory: boolean;
  /**
   * What this run is for. `diagnostic` marks numbers that are real but not
   * representative, and is what keeps a profiled rerun structurally out of the
   * trend history rather than relying on the caller to remember a flag.
   */
  purpose: RunPurpose;
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
  "budgets",
  "purpose",
] as const;

const BOOLEAN_FLAGS = ["update-baseline", "enforce-integrity", "no-history"] as const;

const perfDir = path.dirname(fileURLToPath(import.meta.url));
const HISTORY_DIR = path.join(perfDir, "history");
// Anchored to this file, not `process.cwd()`: the provenance probes must
// describe the checkout the measured code came from, and the harness is
// runnable from anywhere.
const REPO_ROOT = path.resolve(perfDir, "..", "..");

/**
 * Ceiling on every provenance shell-out.
 *
 * `git status` refreshes the index, which on a cold FS or a repo another
 * process is holding can take arbitrarily long. Provenance is a label on the
 * results, never a reason to stall or fail a run, so each probe is bounded and
 * every failure degrades to `null` plus a note.
 */
const PROVENANCE_TIMEOUT_MS = 5_000;

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

function defaultBudgetsPath(): string {
  return path.resolve(process.cwd(), "scripts/perf/config/budgets.json");
}

function parsePurpose(raw: string | undefined): RunPurpose {
  if (raw === undefined) return "benchmark";
  if (raw === "benchmark" || raw === "diagnostic") return raw;
  throw new UsageError(`--purpose expects "benchmark" or "diagnostic", got "${raw}"`);
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

  const iterationsRaw = values.get("iterations");
  const warmupsRaw = values.get("warmups");

  return {
    mode,
    outDir: values.get("out-dir") ?? defaultOutDir(),
    baselinePath: values.get("baseline") ?? defaultBaselinePath(mode),
    budgetsPath: values.get("budgets") ?? defaultBudgetsPath(),
    updateBaseline: flags.has("update-baseline"),
    scenarioIds,
    iterations:
      iterationsRaw === undefined ? undefined : parsePositiveInt("iterations", iterationsRaw, 1),
    warmups: warmupsRaw === undefined ? undefined : parsePositiveInt("warmups", warmupsRaw, 0),
    jsonPath: values.get("json"),
    label: values.get("label"),
    machineLabel: values.get("machine"),
    enforceIntegrity: flags.has("enforce-integrity"),
    noHistory: flags.has("no-history"),
    purpose: parsePurpose(values.get("purpose")),
  };
}

/**
 * Resolve the one scenario this run measures.
 *
 * `--scenario` is REQUIRED, and takes exactly one id. There is deliberately no
 * way to run the matrix: this harness exists for targeted optimisation work,
 * driven a benchmark at a time by `.agents/skills/optimize`, and a
 * whole-matrix run serves no purpose it has. Nothing gates on these numbers,
 * nothing schedules them, and a sweep of 112 scenarios produces a wall of
 * figures nobody reads while taking the machine away from the one measurement
 * somebody actually wanted.
 *
 * It is also the load-bearing half of the optimiser's own comparability check:
 * a scenario measured alone and the same scenario measured beside 111 others
 * ran under different heap, JIT and thermal conditions, and `perf compare`
 * refuses the pair. Making the filter mandatory means every result this harness
 * produces is comparable with every other result for that scenario.
 */
function resolveScenarioIds(tokens: string[], mode: PerfMode): string[] {
  // Deduped BEFORE the count check: `--scenario PERF-105,perf-105` names one
  // scenario twice, which is a typo to absorb, not two scenarios to refuse.
  const requested = [
    ...new Set(
      tokens
        .flatMap((token) => token.split(","))
        .map((id) => id.trim().toUpperCase())
        .filter((id) => id.length > 0)
    ),
  ];

  if (requested.length === 0) {
    const offered = getScenariosForMode(mode).map((scenario) => scenario.id);
    // Truncated on purpose: a hundred ids scrolls the actual message off the
    // screen, which is the opposite of helping.
    const preview = offered.slice(0, 8).join(", ");
    const rest = offered.length > 8 ? `, … and ${offered.length - 8} more` : "";
    throw new UsageError(
      "--scenario is required and takes exactly one id. This harness measures one " +
        `benchmark at a time; there is no whole-matrix run. Mode ${mode} offers ` +
        `${offered.length}: ${preview}${rest}. Full list: scripts/perf/scenarios/index.ts`
    );
  }

  if (requested.length > 1) {
    throw new UsageError(
      `--scenario takes exactly one id, got ${requested.length} (${requested.join(", ")}). ` +
        "Measuring several scenarios in one process makes each one's numbers depend on the " +
        "others' heap and JIT state, and `perf compare` refuses a pair whose selections differ. " +
        "Run them separately."
    );
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

  return requested;
}

/**
 * Identifies the machine a run happened on.
 *
 * Without this a results file cannot be safely diffed against another: latency
 * is only comparable to itself on one machine, and nothing recorded the machine.
 * `--machine` beats `PERF_MACHINE_LABEL`, which beats a HASH of the hostname,
 * so a laptop can carry a stable name across reboots and one run can be
 * relabelled without touching the environment.
 *
 * The default is hashed rather than the hostname itself because these labels
 * are written into `config/baseline.*.json`, which is committed. A hostname is
 * usually a person's name and their machine; the guard that needs this only
 * needs machines to be DISTINCT and STABLE, never named. Anyone who wants a
 * readable label can set one — that is what the two overrides are for.
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

  // Truncated to 8 hex chars: collision risk across one person's handful of
  // machines is negligible, and a full digest would bloat every filename.
  const fingerprint = createHash("sha256").update(os.hostname()).digest("hex").slice(0, 8);
  return `host-${fingerprint}-${process.platform}-${process.arch}`.toLowerCase();
}

/**
 * One bounded `git` invocation, or null.
 *
 * `GIT_OPTIONAL_LOCKS=0` keeps the probe from taking the index lock — a
 * provenance label must never contend with whatever else is using the checkout
 * — and stderr is discarded so a repo-state complaint cannot be mistaken for
 * harness output.
 */
function probeGit(args: string[], notes: string[]): string | null {
  try {
    return execFileSync("git", args, {
      cwd: REPO_ROOT,
      encoding: "utf-8",
      timeout: PROVENANCE_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
    }).trim();
  } catch (error) {
    const detail = error instanceof Error ? error.message.split("\n")[0] : String(error);
    notes.push(`git ${args.join(" ")} failed (${detail})`);
    return null;
  }
}

/**
 * The Electron version this harness measures against.
 *
 * Deliberately NOT `process.versions.electron`: the perf suite runs under plain
 * Node via tsx, so that field is always undefined here and reading it would
 * record "no Electron" for every run. The installed package is the honest
 * answer; the declared range is the fallback, because a range at least narrows
 * the toolchain where inventing an exact version would not.
 */
function probeElectronVersion(notes: string[]): string | null {
  try {
    const installed = readJson<{ version?: string }>(
      path.join(REPO_ROOT, "node_modules", "electron", "package.json")
    );
    const version = installed?.version?.trim();
    if (version) return version;
  } catch (error) {
    notes.push(`could not read the installed Electron version (${String(error)})`);
  }

  try {
    const pkg = readJson<{
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    }>(path.join(REPO_ROOT, "package.json"));
    const declared = (pkg?.devDependencies?.electron ?? pkg?.dependencies?.electron)?.trim();
    if (declared) {
      notes.push(`Electron is not installed; recording the declared range "${declared}"`);
      return declared;
    }
  } catch (error) {
    notes.push(`could not read package.json for the Electron range (${String(error)})`);
  }

  notes.push("could not determine an Electron version");
  return null;
}

/** `git version 2.39.5 (Apple Git-154)` → `2.39.5`. */
function probeGitVersion(notes: string[]): string | null {
  const raw = probeGit(["--version"], notes);
  if (raw === null) return null;

  const match = /(\d+(?:\.\d+)+)/.exec(raw);
  if (!match) {
    notes.push(`unrecognised git --version output, recording it verbatim: "${raw}"`);
    return raw;
  }
  return match[1];
}

/**
 * The commit the measured code was at, suffixed when the tree does not match it.
 *
 * A results file named "after.json" claims a checkpoint; this proves one. The
 * dirty suffix is load-bearing rather than cosmetic — a benchmark of
 * uncommitted work is not a benchmark of the SHA it names, and treating the two
 * as interchangeable is how a stored "best" result gets attributed to a commit
 * that never produced it. A dirty probe that fails is marked as unknown rather
 * than assumed clean, since clean is the reassuring half of the guess.
 */
function probeSourceSha(notes: string[]): string | null {
  const sha = probeGit(["rev-parse", "HEAD"], notes);
  if (sha === null || !/^[0-9a-f]{7,40}$/.test(sha)) {
    if (sha !== null) notes.push(`unrecognised git rev-parse output: "${sha}"`);
    return null;
  }

  const statusNotes: string[] = [];
  const status = probeGit(["status", "--porcelain"], statusNotes);
  if (status === null) {
    notes.push(...statusNotes, "could not determine whether the tree was dirty");
    return `${sha}-dirty-unknown`;
  }

  return status === "" ? sha : `${sha}-dirty`;
}

export function describeEnvironment(machineLabel?: string, notes: string[] = []): RunEnvironment {
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
    electronVersion: probeElectronVersion(notes),
    gitVersion: probeGitVersion(notes),
    sourceSha: probeSourceSha(notes),
  };
}

export function scenarioApplicability(
  scenario: PerfScenario,
  platform: NodeJS.Platform
): PlatformApplicability {
  return scenario.platforms?.[platform] ?? "supported";
}

export interface PlatformPartition {
  runnable: PerfScenario[];
  /** Declared `unsupported` here — never executed, always reported. */
  skipped: PerfScenario[];
  /** Ids that run but whose numbers are signals rather than measurements. */
  diagnostic: Set<string>;
}

/**
 * Splits the selected matrix by what its numbers would actually mean here.
 *
 * The absent case is `supported`, so a scenario that says nothing behaves
 * exactly as it did before this existed. The failure being prevented is the
 * other two staying invisible: an unsupported scenario that simply does not
 * appear in the results reads as a pass, and a diagnostic number read as a
 * measurement is how a Windows count produced by an observer that cannot see
 * Windows spawns ends up in a cross-platform comparison.
 */
export function partitionByPlatform(
  scenarios: PerfScenario[],
  platform: NodeJS.Platform
): PlatformPartition {
  const runnable: PerfScenario[] = [];
  const skipped: PerfScenario[] = [];
  const diagnostic = new Set<string>();

  for (const scenario of scenarios) {
    const applicability = scenarioApplicability(scenario, platform);
    if (applicability === "unsupported") {
      skipped.push(scenario);
      continue;
    }
    if (applicability === "diagnostic") diagnostic.add(scenario.id);
    runnable.push(scenario);
  }

  return { runnable, skipped, diagnostic };
}

/** Prefixed so it is unmistakable in the report's Notes column. */
function diagnosticNote(platform: NodeJS.Platform): string {
  return (
    `DIAGNOSTIC on ${platform}: a signal, not a measurement — something in this path is ` +
    `emulated or blind here, so do not read it as authoritative and do not compare it to ` +
    `another platform`
  );
}

/**
 * Appended to the generated report rather than folded into a table.
 *
 * A skipped scenario has no row to carry an annotation, and its absence from
 * every table is precisely what makes it read as a pass.
 */
export function platformApplicabilitySection(
  skipped: PerfScenario[],
  diagnosticIds: string[],
  platform: NodeJS.Platform
): string {
  if (skipped.length === 0 && diagnosticIds.length === 0) return "";

  const lines = ["", "## Platform applicability", ""];

  if (skipped.length > 0) {
    lines.push(
      `${skipped.length} scenario(s) declare themselves unsupported on \`${platform}\` and were NOT run. They are absent from every table below; that absence is not a pass.`,
      ""
    );
    for (const scenario of skipped) {
      lines.push(`- **${scenario.id}** — ${scenario.name} (skipped: unsupported on ${platform})`);
    }
    lines.push("");
  }

  if (diagnosticIds.length > 0) {
    lines.push(
      `${diagnosticIds.length} scenario(s) are diagnostic on \`${platform}\`: they ran and reported, but the figures are signals rather than measurements. They carry no outside-reference annotation and must not be compared against another platform.`,
      ""
    );
    for (const id of diagnosticIds) {
      lines.push(`- **${id}** — diagnostic on ${platform}`);
    }
    lines.push("");
  }

  return lines.join("\n");
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

  parts.push("--scenario", cli.scenarioIds.join(","));
  if (cli.iterations !== undefined) parts.push("--iterations", String(cli.iterations));
  if (cli.warmups !== undefined) parts.push("--warmups", String(cli.warmups));
  if (cli.label !== undefined) parts.push("--label", quoteArg(cli.label));
  if (cli.machineLabel !== undefined) parts.push("--machine", quoteArg(cli.machineLabel));
  if (cli.jsonPath !== undefined) parts.push("--json", quoteArg(cli.jsonPath));
  if (cli.outDir !== defaultOutDir()) parts.push("--out-dir", quoteArg(cli.outDir));
  if (cli.baselinePath !== defaultBaselinePath(cli.mode)) {
    parts.push("--baseline", quoteArg(cli.baselinePath));
  }
  if (cli.budgetsPath !== defaultBudgetsPath()) {
    parts.push("--budgets", quoteArg(cli.budgetsPath));
  }
  if (cli.updateBaseline) parts.push("--update-baseline");
  if (cli.enforceIntegrity) parts.push("--enforce-integrity");
  if (cli.noHistory) parts.push("--no-history");
  if (cli.purpose !== "benchmark") parts.push("--purpose", cli.purpose);

  // Nothing but the mode survived, so `--` would dangle.
  if (parts.length === optionCount) parts.pop();

  return parts.join(" ");
}

/** Filenames are shared across OSes; a hostname is not a safe path component. */
function sanitizeForFilename(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
}

/**
 * One small UNTRACKED file per mode per machine, merged into on each run.
 *
 * It was tracked, on the theory that `git log -p scripts/perf/history/` would
 * answer "when did this get slower" months later. That is no longer true and
 * the claim is removed rather than left standing: the file runs to thousands of
 * lines, is rewritten by every canonical run, and its name carries a machine
 * label, which in a public repo is somebody's hostname. Read the file directly.
 * It carries p95 and each metric's max and sum, and nothing else; a full
 * summary per run would be too large to read, which is the only thing this file
 * is for.
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

  // Merge, never replace. Every run measures ONE scenario, so writing this file
  // wholesale would leave a history holding a single entry and looking complete
  // — the same shape of lie the baseline writer guards against below. Entries
  // for scenarios this run did not touch are carried through untouched.
  const previous = readJson<{ scenarios?: Record<string, Record<string, number>> }>(historyPath);
  const merged = { ...(previous?.scenarios ?? {}), ...scenarios };

  writeJson(historyPath, {
    generatedAt: summary.generatedAt,
    mode: summary.mode,
    label: summary.label,
    environment: summary.environment,
    scenarios: Object.fromEntries(Object.entries(merged).sort(([a], [b]) => a.localeCompare(b))),
  });

  return historyPath;
}

export interface BaselineMergeInput {
  /** Every reference already in the file, with the provenance it arrived with. */
  existing: Record<string, BaselineEntry>;
  /** Scenarios this run actually measured, and whose numbers are authoritative here. */
  measured: ReadonlyArray<{ id: string; p95Ms: number }>;
  /** This run's timestamp — applied to the measured entries and to nothing else. */
  measuredAt: string;
  /** This run's machine — likewise. */
  machine: BaselineMachine;
}

/**
 * Merge one run's measurements into an existing baseline.
 *
 * The merge itself is old; what is new is that an inherited entry keeps its own
 * date and machine. Stamping the whole file with the current time was the
 * defect: a run measuring one scenario re-dated forty references it never
 * touched, and freshness — which read that one file-wide timestamp — then
 * declared the lot current. An entry only gets today's date and this machine if
 * this run actually measured it.
 *
 * Sorted, because inherited entries and measured ones would otherwise interleave
 * by insertion order and put an unrelated reshuffle in every regeneration diff
 * of a committed file.
 */
export function mergeBaselineEntries(input: BaselineMergeInput): Record<string, BaselineEntry> {
  const merged: Record<string, BaselineEntry> = { ...input.existing };

  for (const { id, p95Ms } of input.measured) {
    merged[id] = { p95Ms, measuredAt: input.measuredAt, machine: input.machine };
  }

  return Object.fromEntries(Object.entries(merged).sort(([a], [b]) => a.localeCompare(b)));
}

/**
 * Everything that makes a run's EVIDENCE untrustworthy, as distinct from slow.
 *
 * Exported and pure so the rule can be asserted directly. Driving it only
 * through a subprocess would leave the empty-result case testable on one
 * platform at a time, since it needs a scenario that declares itself
 * unsupported on the machine running the test.
 */
export function collectIntegrityIssues(
  aggregates: ReadonlyArray<Pick<ScenarioAggregate, "id" | "measurementIssues" | "runs">>,
  skippedCount: number,
  platform: NodeJS.Platform
): string[] {
  const issues = aggregates.flatMap((aggregate) =>
    aggregate.measurementIssues.map((issue) => `${aggregate.id}: ${issue}`)
  );

  // An aggregate that measured zero iterations is the same emptiness as a run
  // with no aggregates, one level down: every per-metric check passes over an
  // empty sample set, and the row renders as an ordinary result. Unreachable
  // today — `--iterations` is validated at 1 or more and the loop always runs
  // once — which is exactly why it is worth stating rather than relying on.
  for (const aggregate of aggregates) {
    if (aggregate.runs <= 0) {
      issues.push(
        `${aggregate.id}: produced ${aggregate.runs} iteration(s) — nothing was measured`
      );
    }
  }

  // A run that measured NOTHING has flawless evidence the way an empty page has
  // no typos. It happens legitimately — every selected scenario can be
  // `unsupported` here, which exits 0 by design — but a caller who asked for
  // enforcement wants "this ran and the evidence is good", and an empty result
  // satisfies every other check above it vacuously.
  if (aggregates.length === 0) {
    issues.push(
      `no scenario produced a measurement (${skippedCount} skipped as unsupported on ` +
        `${platform}) — there is no evidence here to be sound`
    );
  }

  return issues;
}

async function run(): Promise<number> {
  const cli = parseArgs(process.argv.slice(2));
  assertMatrixCoverage();

  ensureDir(cli.outDir);

  const budgetConfig = loadBudgetConfig(cli.budgetsPath);
  const baseline = readJson<BaselineSummary>(cli.baselinePath);
  const baselineEntries = readBaselineEntries(baseline);

  const selected = selectScenarios(cli);
  if (selected.length === 0) {
    throw new Error(`No scenarios configured for mode ${cli.mode}`);
  }

  // Platform filtering happens after the empty check, not before it: an empty
  // selection is a broken matrix, whereas everything being unsupported here is
  // a legitimate — and reported — outcome that still exits 0.
  const {
    runnable: scenarios,
    skipped: skippedScenarios,
    diagnostic: diagnosticIds,
  } = partitionByPlatform(selected, process.platform);

  // Freshness is checked once the run's scenarios are known, so the reference
  // this run actually reads is named rather than buried in a file-wide count.
  checkBaselineFreshness(
    baseline,
    cli.mode,
    BASELINE_FRESHNESS_DAYS,
    new Date(),
    scenarios.map((scenario) => scenario.id)
  );

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
      correctness: readonly string[] | undefined;
      workloadFloors: Readonly<Record<string, number>> | undefined;
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
        correctness: scenario.correctness,
        workloadFloors: scenario.workloadFloors,
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

  const provenanceNotes: string[] = [];
  // Described before the aggregates are built, not after: deciding whether a
  // stored reference was measured on THIS machine needs the machine identity.
  const environment = describeEnvironment(cli.machineLabel, provenanceNotes);

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
    const baselineEntry = baselineEntries[scenarioId];
    // A reference from another machine is withheld from the drift check rather
    // than fed into it. The value is still real, but the VERDICT it would
    // produce — "this drifted 40% from baseline" — would be a statement about
    // two laptops. The reason is reported in its place, so the row says why it
    // has no verdict instead of quietly having none.
    const foreignReference =
      baselineEntry === undefined ? null : describeForeignReference(baselineEntry, environment);
    const baselineP95 = foreignReference === null ? baselineEntry?.p95Ms : undefined;
    const runs = aggregate.durations.length;

    const { outsideReference, measurementIssues, reasons } = evaluateScenarioBudget({
      scenarioId,
      p95Ms,
      runs,
      metricStats,
      budget,
      baselineP95,

      hasBaselineFile: baseline !== null,
    });

    // Withholding the reference makes the gate report an ABSENT one, which is a
    // different state with a different fix — the entry is present, it just did
    // not come from here. That reason is replaced rather than added to.
    const referenceReasons =
      baselineEntry !== undefined && foreignReference !== null
        ? [
            ...reasons.filter((reason) => !reason.startsWith("no recorded baseline")),
            `reference ${round(baselineEntry.p95Ms)}ms not compared: ${foreignReference}`,
          ]
        : reasons;

    // The predicate check is a measurement issue, never a gate: it says the
    // numbers beside it cannot be trusted, which is a louder statement than
    // "this number is worse" and a different one from `outsideReference`.
    const correctnessIssues = evaluateCorrectness({
      correctness: aggregate.correctness,
      metricStats,
      runs,
      exempt: CORRECTNESS_EXEMPT_SCENARIO_IDS.has(scenarioId),
    });

    // Separate from the predicates on purpose: a predicate says the subject did
    // its work, and this says the subject was GIVEN the work. A scenario that
    // built nine of the twelve terminals it claims reports a better number with
    // every predicate at zero, and nothing else here can see it.
    const workloadIssues = evaluateWorkload({
      floors: aggregate.workloadFloors,
      metricStats,
      runs,
    });

    // A diagnostic number is not authoritative here, so it earns no verdict
    // against a reference value — the reasons are kept, but presenting one as
    // "outside reference" would dress a signal up as a measurement. Its own
    // note says so in the row.
    const isDiagnostic = diagnosticIds.has(scenarioId);
    const reportedOutsideReference = outsideReference && !isDiagnostic;

    if (reportedOutsideReference) {
      scenariosOutsideReference.push(scenarioId);
    }

    // Absent only for a scenario missing from `config/benchmarkClasses.ts`,
    // which the matrix test refuses — so the fallback is a hole in the table
    // rather than an ordinary state. It is left undefined rather than defaulted
    // to `mechanism`: a silent default hands every unclassified scenario the
    // most flattering label available without anyone deciding it should have it.
    const benchmarkClass = classifyBenchmark(scenarioId);

    aggregates.push({
      id: scenarioId,
      name: aggregate.name,
      description: aggregate.description,
      tier: aggregate.tier,
      ...(isDiagnostic ? { applicability: "diagnostic" as const } : {}),
      ...(benchmarkClass ? { kind: benchmarkClass.kind, claim: benchmarkClass.claim } : {}),
      runs,
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
      outsideReference: reportedOutsideReference,
      referenceNotes: referenceReasons.length > 0 ? referenceReasons.join("; ") : undefined,
      measurementIssues: [...measurementIssues, ...correctnessIssues, ...workloadIssues],
      // The diagnostic marker leads, ahead of the scenario's own notes and
      // outside the slice that trims them, so a platform caveat can never be
      // pushed out of the row by three ordinary notes.
      notes: [
        ...(isDiagnostic ? [diagnosticNote(process.platform)] : []),
        ...[...new Set(aggregate.notes)].slice(0, 3),
      ],
    });
  }

  aggregates.sort((a, b) => a.id.localeCompare(b.id));

  const integrityIssues = collectIntegrityIssues(
    aggregates,
    skippedScenarios.length,
    process.platform
  );
  const integrity: IntegrityResult = {
    enforced: cli.enforceIntegrity,
    valid: integrityIssues.length === 0,
    issues: integrityIssues,
  };

  const summary: PerfRunSummary = {
    generatedAt: new Date().toISOString(),
    mode: cli.mode,
    nodeVersion: process.version,
    platform: process.platform,
    label: cli.label,
    environment,
    protocol: {
      iterations: cli.iterations ?? null,
      warmups: cli.warmups ?? null,
      scenarioSelection: cli.scenarioIds,
      // The budgets file is folded in only when it is NOT the default, because
      // the default already lives inside the hashed tree and hashing it twice
      // would change the value for every existing run without changing what it
      // means.
      harnessHash: hashHarnessSources(
        undefined,
        cli.budgetsPath === defaultBudgetsPath() ? [] : [cli.budgetsPath]
      ),
      purpose: cli.purpose,
      // A diagnostic run's instrumentation inflates every timing, and the
      // summary has to carry that where a consumer reading it directly will
      // see it rather than only in a bundle manifest they may never open.
      durationsComparable: cli.purpose === "benchmark",
      enforceIntegrity: cli.enforceIntegrity,
    },
    scenarioCount: aggregates.length,
    scenariosOutsideReference,
    scenariosSkipped: skippedScenarios.map((scenario) => scenario.id),
    integrity,
    aggregates,
  };

  const summaryJsonPath = path.join(cli.outDir, `${timestamp}-${cli.mode}.summary.json`);
  const reportMdPath = path.join(cli.outDir, `${timestamp}-${cli.mode}.report.md`);
  const latestSummaryPath = path.join(cli.outDir, `latest-${cli.mode}.summary.json`);
  const latestReportPath = path.join(cli.outDir, `latest-${cli.mode}.report.md`);
  const sortedDiagnosticIds = aggregates
    .map((aggregate) => aggregate.id)
    .filter((id) => diagnosticIds.has(id));
  const report =
    buildMarkdownReport(summary) +
    platformApplicabilitySection(skippedScenarios, sortedDiagnosticIds, process.platform);

  writeJson(summaryJsonPath, summary);
  writeText(reportMdPath, report);
  writeJson(latestSummaryPath, summary);
  writeText(latestReportPath, report);

  if (cli.jsonPath) {
    writeJson(path.resolve(process.cwd(), cli.jsonPath), summary);
  }

  if (cli.updateBaseline) {
    // A reference is what every later run is read against, so promoting one
    // from a run whose oracle failed does not just record a bad number — it
    // silently re-bases every future comparison on it. A diagnostic p95 is
    // already excluded below for the same reason; this extends the rule to the
    // measurement-issue case, which is the louder of the two.
    const invalidForBaseline = new Set(
      aggregates
        .filter((aggregate) => aggregate.measurementIssues.length > 0)
        .map((aggregate) => aggregate.id)
    );
    if (invalidForBaseline.size > 0) {
      console.warn(
        `[perf:${cli.mode}] NOT updating the baseline for ${[...invalidForBaseline].join(", ")}: ` +
          "the run reported measurement issues, and a reference taken from broken evidence " +
          "re-bases every later comparison on it."
      );
    }

    const mergedScenarios = mergeBaselineEntries({
      existing: baselineEntries,
      // A diagnostic p95 is a signal, not a measurement, so it never becomes a
      // reference; leaving it out of `measured` inherits the prior entry
      // untouched, which is what keeps the value recorded on a platform that
      // CAN measure the scenario. Unsupported scenarios and every scenario this
      // run did not select are inherited by the same route.
      measured: aggregates
        .filter(
          (aggregate) => !diagnosticIds.has(aggregate.id) && !invalidForBaseline.has(aggregate.id)
        )
        .map((aggregate) => ({ id: aggregate.id, p95Ms: aggregate.p95Ms })),
      measuredAt: summary.generatedAt,
      machine: {
        machineLabel: environment.machineLabel,
        platform: environment.platform,
        arch: environment.arch,
      },
    });

    const baselineOut: BaselineSummary = {
      // The file's own write time, and nothing more. Every entry carries the
      // date it was actually measured, so this timestamp no longer stands in
      // for any of them.
      generatedAt: summary.generatedAt,
      mode: cli.mode,
      scenarios: mergedScenarios,
    };
    writeJson(cli.baselinePath, baselineOut);
  }

  // Only a canonical run earns a history entry. A filtered run measured a slice
  // of the matrix and an --iterations/--warmups run measured it differently,
  // and the file has no room to say so — either would silently replace the
  // machine's record with something that reads identically but is not
  // comparable to what came before it.
  // The scenario filter is no longer part of this test: every run is filtered.
  // What still disqualifies a run from the trend record is a sampling override,
  // because a 3-iteration spot check is not comparable with the 8 the mode
  // normally takes — or `--no-history`, which is how a profiled rerun keeps its
  // inflated durations out of a trend that has no column to explain them.
  // `purpose` is the STRUCTURAL half and leads deliberately: a diagnostic run
  // cannot enter the trend even if a caller forgets `--no-history`, because the
  // history file has no column to say a duration was instrumented and an entry
  // there reads exactly like a regression. The sampling-override test and the
  // explicit flag are the other two, both of which a caller has to opt into.
  const isCanonicalRun =
    cli.purpose === "benchmark" &&
    cli.iterations === undefined &&
    cli.warmups === undefined &&
    !cli.noHistory;
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
      `skipped=${skippedScenarios.length} ` +
      `diagnostic=${sortedDiagnosticIds.length} ` +
      `outside-reference=${scenariosOutsideReference.length} ` +
      `measurement-issues=${measurementIssueCount}`
  );

  for (const aggregate of aggregates) {
    const marker = diagnosticIds.has(aggregate.id)
      ? "diagnostic"
      : aggregate.outsideReference
        ? "outside"
        : "ok";
    const reason = aggregate.referenceNotes ? ` (${aggregate.referenceNotes})` : "";
    console.log(
      `[${marker}] ${aggregate.id} p95=${aggregate.p95Ms}ms p99=${aggregate.p99Ms}ms${reason}`
    );
  }

  // A skipped scenario prints nothing above and appears in no table; without
  // this block the only trace of it is a scenario count nobody was counting.
  if (skippedScenarios.length > 0) {
    console.warn(
      `\n[perf:${cli.mode}] SKIPPED — ${skippedScenarios.length} scenario(s) declare themselves ` +
        `unsupported on ${process.platform} and were not run. Their absence from the results ` +
        `is not a pass:`
    );
    for (const scenario of skippedScenarios) {
      console.warn(`  ${scenario.id}: ${scenario.name}`);
    }
    console.warn("");
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

  // A null provenance field is recoverable — the numbers are still numbers —
  // but it must say so out loud, because a results file that cannot name its
  // toolchain or its commit silently loses the ability to be diffed later.
  for (const note of provenanceNotes) {
    console.warn(`[perf:${cli.mode}] provenance: ${note}`);
  }

  const { electronVersion, gitVersion, sourceSha } = summary.environment;
  console.log(
    `[perf:${cli.mode}] provenance electron=${electronVersion ?? "unknown"} ` +
      `git=${gitVersion ?? "unknown"} sha=${sourceSha ?? "unknown"}`
  );

  console.log(`[perf:${cli.mode}] summary: ${summaryJsonPath}`);
  if (cli.jsonPath) console.log(`[perf:${cli.mode}] json: ${cli.jsonPath}`);
  if (historyPath) console.log(`[perf:${cli.mode}] history: ${historyPath}`);
  console.log(`[perf:${cli.mode}] rerun: ${buildRerunCommand(cli)}`);

  // The one place a NUMBER never moves the exit code but EVIDENCE does. Without
  // the flag this is the same loud warning it has always been; with it, a run
  // whose oracle failed stops being indistinguishable from a clean one.
  if (!integrity.enforced) return 0;
  if (integrity.valid) {
    console.log(
      `[perf:${cli.mode}] integrity: ok — every declared predicate was emitted on every ` +
        "iteration and read 0, and every configured metric is still being emitted"
    );
    return 0;
  }
  console.error(
    `\n[perf:${cli.mode}] INTEGRITY FAILURE — ${integrity.issues.length} broken ` +
      "measurement(s) under --enforce-integrity. This is not a slow result; it is not a " +
      "result. Numeric drift is still advisory and did not contribute to this exit code."
  );
  return 1;
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
    // `run` returns 0 unless `--enforce-integrity` was passed AND the evidence
    // is broken. The stance is unchanged for every other caller: a measurement
    // being worse than a reference value is reported and never failed on, so
    // without that flag the only way out with a non-zero code is still a throw.
    .then((code) => exitAfterFlush(code))
    .catch((error) => {
      if (error instanceof UsageError) {
        console.error(`[perf] ${error.message}`);
      } else {
        console.error("[perf] run failed", error);
      }
      return exitAfterFlush(1);
    });
}
