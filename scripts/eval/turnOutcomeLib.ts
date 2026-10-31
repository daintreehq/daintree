import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AssistantTurnRecord, TurnOutcomeClass } from "../../shared/types/ipc/mcpServer.js";

/**
 * The evaluator's vocabulary, one entry per `TurnOutcomeClass`. The judge
 * prompt lists these descriptions, and a unit test checks the keys against the
 * union in shared/types/ipc/mcpServer.ts, since no typecheck project covers
 * scripts/eval.
 */
export const TURN_OUTCOME_CLASS_DESCRIPTIONS: Readonly<Record<TurnOutcomeClass, string>> = {
  answered: "the turn produced useful output and completed successfully",
  hedged: "the agent expressed uncertainty without producing a concrete answer",
  refused: "the agent declined to act or stated it cannot perform the request",
  "docs-empty": "the agent reported it could not find the requested documentation or results",
  "tier-rejected": "a tool dispatch was blocked because the session tier was not permitted",
  "mcp-not-ready": "the MCP server was not ready at provision time",
  "agent-stuck": "the watchdog fired a waiting→idle timeout — the agent went silent",
  "tool-error": "the most recent tool dispatch resolved with an error",
  "reasoning-loop":
    "the agent called the same tool with the same arguments at least 3 times within the turn",
  "hibernate-resume-stale": "an attempted resume produced no prior conversation",
  unknown: "insufficient information to classify",
};

export const TURN_OUTCOME_CLASS_ORDER = Object.keys(
  TURN_OUTCOME_CLASS_DESCRIPTIONS
) as readonly TurnOutcomeClass[];

export interface EvalOptions {
  storePath?: string;
  budget: number;
  calibrationPath?: string;
  outDir: string;
  dryRun: boolean;
  baselineHours: number;
  model: string;
  help: boolean;
}

export interface CalibrationLabel {
  recordId: string;
  expected: TurnOutcomeClass;
  record?: Partial<AssistantTurnRecord>;
}

export interface ClassDistribution {
  counts: Record<TurnOutcomeClass, number>;
  proportions: Record<TurnOutcomeClass, number>;
  total: number;
}

export interface ClassMetrics {
  precision: number;
  recall: number;
  f1: number;
  support: number;
}

export interface ConfusionMatrix {
  matrix: number[][];
  classOrder: readonly TurnOutcomeClass[];
  perClass: Record<TurnOutcomeClass, ClassMetrics>;
  macroF1: number;
  accuracy: number;
}

export interface SampleMetadata {
  budget: number;
  sampled: number;
  classCountsBefore: Record<TurnOutcomeClass, number>;
  classCountsAfter: Record<TurnOutcomeClass, number>;
  absentClasses: TurnOutcomeClass[];
}

export interface StratifiedSample {
  records: AssistantTurnRecord[];
  metadata: SampleMetadata;
}

export interface EvalReport {
  sampleMetadata: SampleMetadata;
  distribution: ClassDistribution;
  confusionMatrix?: ConfusionMatrix;
  kappa?: number;
  psi?: number;
  psiDrift: boolean;
  baselineHours: number;
  baselineRecords: number;
  warnings: string[];
  calibrationLoaded: boolean;
  calibrationMatched: number;
  calibrationUnmatched: number;
  judgeModel?: string;
  judgeRecords: number;
  judgeFailures: number;
}

export interface LoadedRecords {
  records: AssistantTurnRecord[];
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Store path resolution
// ---------------------------------------------------------------------------

export const PROFILE_DB_FILE = "daintree.db";

/** The packaged app's userData directory; dev builds use `daintree-dev` beside it. */
export function defaultProfileDir(
  platform: NodeJS.Platform = os.platform(),
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir()
): string {
  if (platform === "darwin") {
    return path.join(home, "Library", "Application Support", "Daintree");
  }
  if (platform === "win32") {
    return path.join(env.APPDATA || path.join(home, "AppData", "Roaming"), "Daintree");
  }
  return path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), "Daintree");
}

function isDirectory(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

function isExistingFile(candidate: string): boolean {
  try {
    return !fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Resolve the daintree.db to read. `--store-path` may name a profile directory
 * or a database file; DAINTREE_USER_DATA names a profile directory, as it does
 * for the app. A path to any other file is returned as-is so the loader can
 * say why it is not a turn-outcome source.
 */
export function resolveStorePath(
  storePath?: string,
  env: NodeJS.ProcessEnv = process.env
): string {
  if (storePath) {
    const resolved = path.resolve(storePath);
    return isDirectory(resolved) ? path.join(resolved, PROFILE_DB_FILE) : resolved;
  }
  const envDir = env.DAINTREE_USER_DATA;
  if (envDir) {
    const resolved = path.resolve(envDir);
    return isExistingFile(resolved) ? resolved : path.join(resolved, PROFILE_DB_FILE);
  }
  return path.join(defaultProfileDir(os.platform(), env), PROFILE_DB_FILE);
}

// ---------------------------------------------------------------------------
// Record loading & validation
// ---------------------------------------------------------------------------

const REQUIRED_RECORD_KEYS = ["id", "timestamp", "outcome"] as const;

export function loadRecords(raw: unknown): LoadedRecords {
  const warnings: string[] = [];
  if (!Array.isArray(raw)) {
    return { records: [], warnings: ["turn-outcome records are not an array"] };
  }

  const records: AssistantTurnRecord[] = [];
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];
    if (!item || typeof item !== "object") {
      warnings.push(`record[${i}]: not an object, skipping`);
      continue;
    }
    const missing = REQUIRED_RECORD_KEYS.filter((k) => !(k in item));
    if (missing.length > 0) {
      warnings.push(`record[${i}]: missing ${missing.join(", ")}, skipping`);
      continue;
    }
    if (typeof (item as Record<string, unknown>).id !== "string") {
      warnings.push(`record[${i}]: id is not a string, skipping`);
      continue;
    }
    if (typeof (item as Record<string, unknown>).timestamp !== "number") {
      warnings.push(`record[${i}]: timestamp is not a number, skipping`);
      continue;
    }
    const ts = (item as Record<string, unknown>).timestamp as number;
    if (!Number.isFinite(ts) || ts < 0) {
      warnings.push(`record[${i}]: timestamp ${String(ts)} is invalid, skipping`);
      continue;
    }
    if (
      !TURN_OUTCOME_CLASS_ORDER.includes(
        (item as Record<string, unknown>).outcome as TurnOutcomeClass
      )
    ) {
      warnings.push(
        `record[${i}]: unknown outcome "${String((item as Record<string, unknown>).outcome)}", skipping`
      );
      continue;
    }
    records.push(item as AssistantTurnRecord);
  }

  return { records, warnings };
}

export function ensureChronological(records: AssistantTurnRecord[]): AssistantTurnRecord[] {
  if (records.length < 2) return records;
  return [...records].sort((a, b) => a.timestamp - b.timestamp);
}

// ---------------------------------------------------------------------------
// Baseline window
// ---------------------------------------------------------------------------

export function filterBaselineWindow(
  records: AssistantTurnRecord[],
  hours: number
): { baseline: AssistantTurnRecord[]; recent: AssistantTurnRecord[]; anchorTimestamp: number } {
  if (records.length === 0) return { baseline: [], recent: [], anchorTimestamp: 0 };

  const maxTs = records.reduce((max, r) => Math.max(max, r.timestamp), 0);
  const cutoff = maxTs - hours * 3600 * 1000;

  const baseline: AssistantTurnRecord[] = [];
  const recent: AssistantTurnRecord[] = [];
  for (const r of records) {
    if (r.timestamp >= cutoff) {
      recent.push(r);
    } else {
      baseline.push(r);
    }
  }
  return { baseline, recent, anchorTimestamp: maxTs };
}

// ---------------------------------------------------------------------------
// Class distribution
// ---------------------------------------------------------------------------

export function computeClassDistribution(records: AssistantTurnRecord[]): ClassDistribution {
  const counts: Record<string, number> = {};
  for (const cls of TURN_OUTCOME_CLASS_ORDER) {
    counts[cls] = 0;
  }
  for (const r of records) {
    counts[r.outcome] = (counts[r.outcome] ?? 0) + 1;
  }
  const total = records.length;
  const proportions: Record<string, number> = {};
  for (const cls of TURN_OUTCOME_CLASS_ORDER) {
    proportions[cls] = total > 0 ? counts[cls] / total : 0;
  }
  return { counts, proportions, total } as ClassDistribution;
}

// ---------------------------------------------------------------------------
// Stratified sampling with rare-class oversampling (without replacement)
// ---------------------------------------------------------------------------

const MIN_PER_CLASS = 2;

export function stratifiedSample(records: AssistantTurnRecord[], budget: number): StratifiedSample {
  const byClass = new Map<TurnOutcomeClass, AssistantTurnRecord[]>();
  for (const cls of TURN_OUTCOME_CLASS_ORDER) {
    byClass.set(cls, []);
  }
  for (const r of records) {
    byClass.get(r.outcome)?.push(r);
  }

  const classCountsBefore: Record<string, number> = {};
  const presentClasses: TurnOutcomeClass[] = [];
  for (const cls of TURN_OUTCOME_CLASS_ORDER) {
    const bucket = byClass.get(cls)!;
    classCountsBefore[cls] = bucket.length;
    if (bucket.length > 0) presentClasses.push(cls);
  }

  if (presentClasses.length === 0) {
    return {
      records: [],
      metadata: {
        budget,
        sampled: 0,
        classCountsBefore,
        classCountsAfter: Object.fromEntries(TURN_OUTCOME_CLASS_ORDER.map((c) => [c, 0])) as Record<
          TurnOutcomeClass,
          number
        >,
        absentClasses: [...TURN_OUTCOME_CLASS_ORDER],
      },
    };
  }

  // Allocate floor per present class, capped at available count
  const selected: AssistantTurnRecord[] = [];
  const used = new Set<string>();
  let remaining = budget;

  const floorAlloc = Math.min(MIN_PER_CLASS, Math.floor(budget / presentClasses.length));
  for (const cls of presentClasses) {
    const bucket = byClass.get(cls)!;
    const take = Math.min(floorAlloc, bucket.length, remaining);
    const picked = pickWithoutReplacement(bucket, take, used);
    selected.push(...picked);
    for (const r of picked) used.add(r.id);
    remaining -= take;
  }

  // Proportional fill for remaining budget
  if (remaining > 0) {
    const remainingByClass = new Map<TurnOutcomeClass, AssistantTurnRecord[]>();
    for (const cls of presentClasses) {
      remainingByClass.set(
        cls,
        byClass.get(cls)!.filter((r) => !used.has(r.id))
      );
    }

    const totalRemaining = [...remainingByClass.values()].reduce((s, b) => s + b.length, 0);
    if (totalRemaining > 0) {
      // Allocation proportional to natural distribution, fill from each class
      const allocations = new Map<TurnOutcomeClass, number>();
      let allocSum = 0;
      for (const cls of presentClasses) {
        const bucketSize = remainingByClass.get(cls)!.length;
        const alloc = Math.round((bucketSize / totalRemaining) * remaining);
        allocations.set(cls, alloc);
        allocSum += alloc;
      }
      // Adjust rounding diff — add/remove from largest class
      const diff = remaining - allocSum;
      if (diff !== 0) {
        const largest = [...allocations.entries()].sort((a, b) => b[1] - a[1])[0][0];
        allocations.set(largest, allocations.get(largest)! + diff);
      }
      // Cap at available, floor at zero
      for (const cls of presentClasses) {
        const alloc = Math.max(
          0,
          Math.min(allocations.get(cls)!, remainingByClass.get(cls)!.length)
        );
        const picked = pickWithoutReplacement(remainingByClass.get(cls)!, alloc, used);
        selected.push(...picked);
        for (const r of picked) used.add(r.id);
      }
    }
  }

  const classCountsAfter: Record<string, number> = {};
  for (const r of selected) {
    classCountsAfter[r.outcome] = (classCountsAfter[r.outcome] ?? 0) + 1;
  }
  for (const cls of TURN_OUTCOME_CLASS_ORDER) {
    classCountsAfter[cls] ??= 0;
  }

  const absentClasses = TURN_OUTCOME_CLASS_ORDER.filter((c) => classCountsBefore[c] === 0);

  return {
    records: selected,
    metadata: {
      budget,
      sampled: selected.length,
      classCountsBefore,
      classCountsAfter: classCountsAfter as Record<TurnOutcomeClass, number>,
      absentClasses: absentClasses as TurnOutcomeClass[],
    },
  };
}

function pickWithoutReplacement(
  bucket: AssistantTurnRecord[],
  count: number,
  used: Set<string>
): AssistantTurnRecord[] {
  const available = bucket.filter((r) => !used.has(r.id));
  const n = Math.min(count, available.length);
  if (n <= 0) return [];
  // Fisher-Yates partial shuffle for the first n elements
  const shuffled = [...available];
  for (let i = 0; i < n; i++) {
    const j = i + Math.floor(Math.random() * (shuffled.length - i));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled.slice(0, n);
}

// ---------------------------------------------------------------------------
// Cohen's kappa
// ---------------------------------------------------------------------------

export function computeKappa(predicted: TurnOutcomeClass[], expected: TurnOutcomeClass[]): number {
  if (predicted.length !== expected.length || predicted.length === 0) return 0;

  const n = predicted.length;
  const classOrder = TURN_OUTCOME_CLASS_ORDER;
  const matrix = new Map<string, number>();

  for (let i = 0; i < n; i++) {
    const key = `${predicted[i]}:${expected[i]}`;
    matrix.set(key, (matrix.get(key) ?? 0) + 1);
  }

  // Observed agreement
  let po = 0;
  for (const cls of classOrder) {
    po += matrix.get(`${cls}:${cls}`) ?? 0;
  }
  po /= n;

  // Expected agreement
  const predCounts = new Map<TurnOutcomeClass, number>();
  const expCounts = new Map<TurnOutcomeClass, number>();
  for (let i = 0; i < n; i++) {
    predCounts.set(predicted[i], (predCounts.get(predicted[i]) ?? 0) + 1);
    expCounts.set(expected[i], (expCounts.get(expected[i]) ?? 0) + 1);
  }

  let pe = 0;
  for (const cls of classOrder) {
    pe += (predCounts.get(cls) ?? 0) * (expCounts.get(cls) ?? 0);
  }
  pe /= n * n;

  if (pe >= 1) return po >= 1 ? 1 : 0;
  return (po - pe) / (1 - pe);
}

// ---------------------------------------------------------------------------
// Confusion matrix
// ---------------------------------------------------------------------------

export function computeConfusionMatrix(
  predicted: TurnOutcomeClass[],
  expected: TurnOutcomeClass[]
): ConfusionMatrix {
  const n = TURN_OUTCOME_CLASS_ORDER.length;
  const matrix: number[][] = Array.from({ length: n }, () => Array(n).fill(0));

  const predIdx = new Map<TurnOutcomeClass, number>();
  const expIdx = new Map<TurnOutcomeClass, number>();
  for (let i = 0; i < n; i++) {
    predIdx.set(TURN_OUTCOME_CLASS_ORDER[i], i);
    expIdx.set(TURN_OUTCOME_CLASS_ORDER[i], i);
  }

  for (let i = 0; i < predicted.length; i++) {
    const p = predIdx.get(predicted[i]) ?? -1;
    const e = expIdx.get(expected[i]) ?? -1;
    if (p >= 0 && e >= 0) matrix[p][e]++;
  }

  const perClass: Record<string, ClassMetrics> = {};
  let macroF1Sum = 0;
  let macroF1Count = 0;
  let totalCorrect = 0;

  for (let i = 0; i < n; i++) {
    const cls = TURN_OUTCOME_CLASS_ORDER[i];
    const tp = matrix[i][i];
    const rowSum = matrix[i].reduce((s, v) => s + v, 0);
    const colSum = matrix.reduce((s, row) => s + row[i], 0);

    const precision = rowSum > 0 ? tp / rowSum : 0;
    const recall = colSum > 0 ? tp / colSum : 0;
    const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;

    perClass[cls] = { precision, recall, f1, support: colSum };
    if (colSum > 0) {
      macroF1Sum += f1;
      macroF1Count++;
    }
    totalCorrect += tp;
  }

  const macroF1 = macroF1Count > 0 ? macroF1Sum / macroF1Count : 0;
  const accuracy = predicted.length > 0 ? totalCorrect / predicted.length : 0;

  return {
    matrix,
    classOrder: TURN_OUTCOME_CLASS_ORDER,
    perClass: perClass as Record<TurnOutcomeClass, ClassMetrics>,
    macroF1,
    accuracy,
  };
}

// ---------------------------------------------------------------------------
// PSI (Population Stability Index)
// ---------------------------------------------------------------------------

const PSI_EPSILON = 0.0001;
const PSI_DRIFT_THRESHOLD = 0.2;

export function computePSI(actual: ClassDistribution, expected: ClassDistribution): number {
  let psi = 0;
  for (const cls of TURN_OUTCOME_CLASS_ORDER) {
    const a = Math.max(actual.proportions[cls], PSI_EPSILON);
    const b = Math.max(expected.proportions[cls], PSI_EPSILON);
    psi += (a - b) * Math.log(a / b);
  }
  return psi;
}

export function isPsiDrift(psi: number): boolean {
  return psi > PSI_DRIFT_THRESHOLD;
}

// ---------------------------------------------------------------------------
// Calibration set loading
// ---------------------------------------------------------------------------

export function loadCalibration(raw: unknown): {
  labels: CalibrationLabel[];
  warnings: string[];
} {
  const warnings: string[] = [];
  if (!Array.isArray(raw)) {
    return { labels: [], warnings: ["calibration file is not an array"] };
  }
  const labels: CalibrationLabel[] = [];
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];
    if (!item || typeof item !== "object") {
      warnings.push(`calibration[${i}]: not an object, skipping`);
      continue;
    }
    const obj = item as Record<string, unknown>;
    if (typeof obj.recordId !== "string") {
      warnings.push(`calibration[${i}]: missing recordId, skipping`);
      continue;
    }
    if (!TURN_OUTCOME_CLASS_ORDER.includes(obj.expected as TurnOutcomeClass)) {
      warnings.push(
        `calibration[${i}]: unknown expected outcome "${String(obj.expected)}", skipping`
      );
      continue;
    }
    labels.push({
      recordId: obj.recordId,
      expected: obj.expected as TurnOutcomeClass,
    });
  }
  return { labels, warnings };
}

export function matchCalibration(
  labels: CalibrationLabel[],
  records: AssistantTurnRecord[]
): {
  matched: Array<{ record: AssistantTurnRecord; label: CalibrationLabel }>;
  unmatched: string[];
} {
  const recordById = new Map<string, AssistantTurnRecord>();
  for (const r of records) {
    recordById.set(r.id, r);
  }
  const matched: Array<{ record: AssistantTurnRecord; label: CalibrationLabel }> = [];
  const unmatched: string[] = [];
  for (const label of labels) {
    const record = recordById.get(label.recordId);
    if (record) {
      matched.push({ record, label });
    } else {
      unmatched.push(label.recordId);
    }
  }
  return { matched, unmatched };
}

/**
 * Pair calibration labels with judge predictions by record id. Only sampled
 * records were judged, so a label whose record sits outside the sample has no
 * pair even though it matched the store.
 */
export function joinCalibrationPairs(
  judged: readonly AssistantTurnRecord[],
  predictions: readonly TurnOutcomeClass[],
  calibration: ReadonlyArray<{ record: AssistantTurnRecord; expected: TurnOutcomeClass }>
): Array<{ predicted: TurnOutcomeClass; expected: TurnOutcomeClass }> {
  const predictedById = new Map<string, TurnOutcomeClass>();
  for (let i = 0; i < judged.length && i < predictions.length; i++) {
    predictedById.set(judged[i].id, predictions[i]);
  }
  const pairs: Array<{ predicted: TurnOutcomeClass; expected: TurnOutcomeClass }> = [];
  for (const entry of calibration) {
    const predicted = predictedById.get(entry.record.id);
    if (predicted) pairs.push({ predicted, expected: entry.expected });
  }
  return pairs;
}

// ---------------------------------------------------------------------------
// Readiness
// ---------------------------------------------------------------------------

export const READY_KAPPA = 0.7;
export const MIN_CALIBRATION_PAIRS = 20;

export interface Readiness {
  ready: boolean;
  /** Calibration labels joined to judge predictions — the only count readiness reads. */
  pairs: number;
  kappa?: number;
  /** Console verdict line. */
  verdict: string;
  /** Small-sample warning, set whenever a judged run has too few pairs. */
  warning?: string;
  exitCode: 0 | 1;
}

/**
 * The single readiness verdict. The console line, the exit code, the report's
 * `ready` and the small-sample warning all come from here, so they cannot
 * disagree. A dry run judges nothing and keeps exiting 0.
 */
export function assessReadiness(input: {
  dryRun: boolean;
  calibrationLoaded: boolean;
  pairs: number;
  kappa?: number;
}): Readiness {
  const { dryRun, calibrationLoaded, pairs, kappa } = input;
  if (dryRun) {
    return {
      ready: false,
      pairs,
      kappa,
      verdict: "Readiness: not assessed (dry run)",
      exitCode: 0,
    };
  }
  const threshold = READY_KAPPA.toFixed(2);
  const warning =
    pairs < MIN_CALIBRATION_PAIRS
      ? `Only ${pairs} calibration labels joined to judge predictions. Kappa estimates are unstable with fewer than ${MIN_CALIBRATION_PAIRS} pairs.`
      : undefined;
  let reason: string;
  if (!calibrationLoaded) {
    reason = "no calibration set given (--calibration-path)";
  } else if (pairs === 0 || kappa === undefined) {
    reason = "no calibration label matches a judged record";
  } else if (pairs < MIN_CALIBRATION_PAIRS) {
    reason = `${pairs} judge-calibration pairs, need at least ${MIN_CALIBRATION_PAIRS}`;
  } else if (kappa < READY_KAPPA) {
    reason = `kappa ${kappa.toFixed(3)} below the ${threshold} threshold`;
  } else {
    return {
      ready: true,
      pairs,
      kappa,
      verdict: `READY: kappa ${kappa.toFixed(3)} >= ${threshold} over ${pairs} judge-calibration pairs`,
      exitCode: 0,
    };
  }
  return { ready: false, pairs, kappa, verdict: `NOT READY: ${reason}`, warning, exitCode: 1 };
}

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

export function parseArgs(argv: string[]): EvalOptions {
  const args = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === "--help" || token === "-h") {
      return { help: true } as EvalOptions;
    }
    if (!token.startsWith("--")) continue;
    const key = token.replace(/^--/, "");
    const value = argv[i + 1];
    if (value !== undefined && !value.startsWith("--")) {
      args.set(key, value);
      i++;
    } else {
      args.set(key, "true");
    }
  }

  const budget = Number(args.get("budget") ?? "200");
  if (!Number.isFinite(budget) || budget < 10) {
    throw new Error("--budget must be an integer >= 10");
  }

  const baselineHours = Number(args.get("baseline-hours") ?? "24");
  if (!Number.isFinite(baselineHours) || baselineHours < 1) {
    throw new Error("--baseline-hours must be >= 1");
  }

  const dryRun = args.get("dry-run") === "true";
  const storePath = args.get("store-path");
  const calibrationPath = args.get("calibration-path");

  return {
    storePath,
    budget: Math.floor(budget),
    calibrationPath,
    outDir: args.get("out-dir") ?? path.resolve(process.cwd(), ".tmp", "eval"),
    dryRun,
    baselineHours: Math.floor(baselineHours),
    model: args.get("model") ?? "gpt-5-mini",
    help: false,
  };
}

export function formatHelp(): string {
  return `
turnOutcome — Offline evaluation harness for the turn-outcome classifier

Usage: tsx scripts/eval/turnOutcome.ts [options]

Options:
  --store-path <path>     Daintree profile directory, or its daintree.db
                          (default: $DAINTREE_USER_DATA, else the packaged
                          app's profile; dev builds use a daintree-dev profile)
  --budget <n>            Max records to evaluate (default: 200, min: 10)
  --calibration-path <p>  Path to hand-labeled calibration JSON file
  --out-dir <dir>         Output directory for JSON report (default: .tmp/eval)
  --baseline-hours <h>    Baseline window in hours for PSI drift (default: 24)
  --model <model>         OpenAI model for judge (default: gpt-5-mini)
  --dry-run               Load + sample + print stats, skip API calls
  --help, -h              Show this help

Requires OPENAI_API_KEY env var (unless --dry-run).

The harness reads the mcpTurnOutcomeLog ring from the profile's daintree.db
without writing to the profile, stratifies records by outcome class (floor
allocation + proportional fill, without replacement), sends batches to a
frontier-model judge via OpenAI Responses API with structured JSON output,
then computes Cohen's kappa and a confusion matrix against the optional
calibration set, plus PSI drift against a baseline distribution window.

A judged run is ready when kappa >= 0.70 over at least 20 calibration labels
joined to judge predictions by record id; it exits 1 otherwise.

Calibration file format (JSON array):
  [{"recordId": "...", "expected": "answered"}, ...]
`.trim();
}
