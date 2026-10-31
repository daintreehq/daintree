import path from "node:path";
import { readJson, ensureDir, writeJson } from "../perf/lib/io.js";
import {
  assessReadiness,
  computeClassDistribution,
  computeConfusionMatrix,
  computeKappa,
  computePSI,
  ensureChronological,
  filterBaselineWindow,
  formatHelp,
  isPsiDrift,
  joinCalibrationPairs,
  loadCalibration,
  loadRecords,
  matchCalibration,
  parseArgs,
  resolveStorePath,
  stratifiedSample,
} from "./turnOutcomeLib.js";
import {
  TURN_OUTCOME_RING,
  TurnOutcomeSourceError,
  readTurnOutcomeRing,
} from "./turnOutcomeSource.js";
import type { AssistantTurnRecord, TurnOutcomeClass } from "../../shared/types/ipc/mcpServer.js";

export interface JudgeResult {
  /** Aligned to the judged records; `null` where the judge gave no answer. */
  predictions: Array<TurnOutcomeClass | null>;
  failures: number;
}

export interface RunDeps {
  judge(records: AssistantTurnRecord[], model: string, apiKey: string): Promise<JudgeResult>;
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
  error?: (line: string) => void;
}

/** Runs one evaluation and returns the process exit code. */
export async function runTurnOutcomeEval(argv: string[], deps: RunDeps): Promise<number> {
  const env = deps.env ?? process.env;
  const log = deps.log ?? ((line: string) => console.log(line));
  const error = deps.error ?? ((line: string) => console.error(line));
  const options = parseArgs(argv);

  if (options.help) {
    log(formatHelp());
    return 0;
  }

  const warnings: string[] = [];

  const storePath = resolveStorePath(options.storePath, env);
  let ring: ReturnType<typeof readTurnOutcomeRing>;
  try {
    ring = readTurnOutcomeRing(storePath);
  } catch (err) {
    if (!(err instanceof TurnOutcomeSourceError)) throw err;
    error(err.message);
    if (err.kind === "missing" && !options.storePath) {
      error("Pass --store-path or set DAINTREE_USER_DATA to choose another profile.");
    }
    return 1;
  }

  log(`Source: ${storePath} (audit_rings ring "${TURN_OUTCOME_RING}")`);
  if (ring.rowCount === 0) {
    log(`No turn-outcome records: the "${TURN_OUTCOME_RING}" ring is empty.`);
    return 0;
  }

  const { records, warnings: loadWarnings } = loadRecords(ring.rows);
  const skipped = [...ring.warnings, ...loadWarnings];
  warnings.push(...skipped);

  log(`Loaded ${records.length} valid records from store`);
  if (skipped.length > 0) {
    log(`  (${skipped.length} records skipped — see report for details)`);
  }

  if (records.length === 0) {
    log(`No valid records to evaluate (${ring.rowCount} rows in the ring, all skipped):`);
    for (const w of skipped) log(`  ! ${w}`);
    return 0;
  }

  // Ensure chronological order (store persisted oldest-first; getRecords reverses)
  const chronological = ensureChronological(records);

  // Baseline window — anchor to max record timestamp for stable re-runs
  const { baseline, recent, anchorTimestamp } = filterBaselineWindow(
    chronological,
    options.baselineHours
  );

  if (baseline.length < 20) {
    warnings.push(
      `Baseline window contains only ${baseline.length} records (< 20). PSI may be unreliable.`
    );
  }

  const baselineDist = computeClassDistribution(baseline);

  // Stratified sample from the full record set
  const sample = stratifiedSample(chronological, options.budget);

  log(`Stratified sample: ${sample.metadata.sampled} records (budget: ${options.budget})`);
  for (const cls of sample.metadata.absentClasses) {
    log(`  ${cls}: absent from store`);
  }

  const sampleDist = computeClassDistribution(sample.records);
  const recentDist = computeClassDistribution(recent);

  // Load calibration set
  let calibrationMatched: Array<{
    record: AssistantTurnRecord;
    expected: TurnOutcomeClass;
  }> = [];
  let calibrationUnmatched: string[] = [];
  let calibrationLoaded = false;

  if (options.calibrationPath) {
    calibrationLoaded = true;
    const calRaw = readJson<unknown>(options.calibrationPath);
    const { labels, warnings: calWarnings } = loadCalibration(calRaw);
    warnings.push(...calWarnings);

    const { matched, unmatched } = matchCalibration(labels, chronological);
    calibrationMatched = matched.map((m) => ({
      record: m.record,
      expected: m.label.expected,
    }));
    calibrationUnmatched = unmatched;

    log(
      `Calibration: ${matched.length} matched, ${unmatched.length} unmatched (of ${labels.length} labels)`
    );
  }

  // Judge
  let judgePredictions: Array<TurnOutcomeClass | null> = [];
  let judgeFailures = 0;
  let judgeFailedIds: string[] = [];

  if (!options.dryRun && sample.records.length > 0) {
    const apiKey = env.OPENAI_API_KEY;
    if (!apiKey) {
      error("OPENAI_API_KEY not set. Use --dry-run to skip API calls.");
      return 1;
    }

    log(`Judge model: ${options.model}`);
    log(`Sending ${sample.records.length} records for judge classification...`);

    const result = await deps.judge(sample.records, options.model, apiKey);
    judgePredictions = result.predictions;
    judgeFailures = result.failures;
    judgeFailedIds = sample.records.filter((_, i) => !judgePredictions[i]).map((r) => r.id);

    if (judgeFailures > 0) {
      warnings.push(`Judge failed on ${judgeFailures} records (see report for IDs)`);
    }
    log(
      `Judge completed: ${judgePredictions.length - judgeFailures} classifications, ${judgeFailures} failures`
    );
  } else if (options.dryRun) {
    log("Dry run — skipping judge API calls.");
  }

  // Metrics
  let confusionMatrix = undefined;
  let kappa: number | undefined;

  const paired = joinCalibrationPairs(sample.records, judgePredictions, calibrationMatched);
  if (paired.length > 0) {
    const judgeSlice = paired.map((p) => p.predicted);
    const expectedSlice = paired.map((p) => p.expected);
    confusionMatrix = computeConfusionMatrix(judgeSlice, expectedSlice);
    kappa = computeKappa(judgeSlice, expectedSlice);
    log(`Cohen's kappa: ${kappa.toFixed(3)}`);
    log(`Macro F1: ${confusionMatrix.macroF1.toFixed(3)}`);
    log(`Accuracy: ${(confusionMatrix.accuracy * 100).toFixed(1)}%`);
    log(`  (${paired.length} judge-calibration pairs joined by ID)`);
  }

  const readiness = assessReadiness({
    dryRun: options.dryRun,
    calibrationLoaded,
    pairs: paired.length,
    kappa,
  });
  log(readiness.verdict);
  if (readiness.warning) warnings.push(readiness.warning);

  const psi = computePSI(recentDist, baselineDist);
  const psiDrift = isPsiDrift(psi);
  if (psiDrift) {
    log(`PSI: ${psi.toFixed(4)} (DRIFT detected — exceeds ${0.2} threshold)`);
  } else {
    log(`PSI: ${psi.toFixed(4)} (no drift)`);
  }

  const report = {
    source: storePath,
    sampleMetadata: sample.metadata,
    distribution: sampleDist,
    confusionMatrix: confusionMatrix ?? undefined,
    kappa,
    ready: readiness.ready,
    calibrationPairs: readiness.pairs,
    psi,
    psiDrift,
    baselineHours: options.baselineHours,
    baselineRecords: baseline.length,
    baselineAnchor: new Date(anchorTimestamp).toISOString(),
    warnings,
    calibrationLoaded,
    calibrationMatched: calibrationMatched.length,
    calibrationUnmatched: calibrationUnmatched.length,
    calibrationUnmatchedIds: calibrationUnmatched,
    judgeModel: options.dryRun ? undefined : options.model,
    judgeRecords: judgePredictions.length - judgeFailures,
    judgeFailures,
    judgeFailedIds,
    judgedAt: options.dryRun ? undefined : new Date().toISOString(),
  };

  // Write report
  ensureDir(options.outDir);
  const reportPath = path.join(options.outDir, "turnOutcome-eval-report.json");
  writeJson(reportPath, report);
  log(`Report written to: ${reportPath}`);

  // Console summary
  log("\n── Class distribution ──");
  for (const cls of sample.metadata.absentClasses) {
    log(`  ${cls}: — (absent)`);
  }
  for (const cls of Object.entries(sampleDist.counts)
    .filter(([, c]) => c > 0)
    .sort((a, b) => b[1] - a[1])) {
    const pct = ((cls[1] / sampleDist.total) * 100).toFixed(1);
    log(`  ${cls[0]}: ${cls[1]} (${pct}%)`);
  }

  if (confusionMatrix) {
    log("\n── Per-class metrics (vs calibration) ──");
    for (const [cls, m] of Object.entries(confusionMatrix.perClass)) {
      if (m.support > 0) {
        log(
          `  ${cls}: P=${m.precision.toFixed(2)} R=${m.recall.toFixed(2)} F1=${m.f1.toFixed(2)} (n=${m.support})`
        );
      }
    }
  }

  if (warnings.length > 0) {
    log(`\n── Warnings (${warnings.length}) ──`);
    for (const w of warnings) {
      log(`  ! ${w}`);
    }
  }

  return readiness.exitCode;
}
