import fs from "node:fs";
import path from "node:path";
import { readJson, ensureDir, writeJson } from "../perf/lib/io.js";
import {
  TURN_OUTCOME_CLASS_ORDER,
  computeClassDistribution,
  computeConfusionMatrix,
  computeKappa,
  computePSI,
  ensureChronological,
  filterBaselineWindow,
  formatHelp,
  isPsiDrift,
  loadCalibration,
  loadRecords,
  matchCalibration,
  parseArgs,
  resolveStorePath,
  stratifiedSample,
} from "./turnOutcomeLib.js";
import type { AssistantTurnRecord, TurnOutcomeClass } from "../../shared/types/ipc/mcpServer.js";

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    console.log(formatHelp());
    return;
  }

  const warnings: string[] = [];

  // Resolve store path
  const storePath = resolveStorePath(options.storePath);
  if (!fs.existsSync(storePath)) {
    console.error(`Store not found: ${storePath}`);
    console.error("Provide an explicit --store-path or set DAINTREE_USER_DATA.");
    process.exitCode = 1;
    return;
  }

  // Read config
  const config = readJson<Record<string, unknown>>(storePath);
  if (!config) {
    console.error(`Failed to read config from: ${storePath}`);
    process.exitCode = 1;
    return;
  }

  const rawLog = (config as Record<string, unknown>).turnOutcomeLog;
  const { records, warnings: loadWarnings } = loadRecords(rawLog);
  warnings.push(...loadWarnings);

  console.log(`Loaded ${records.length} valid records from store`);
  if (loadWarnings.length > 0) {
    console.log(`  (${loadWarnings.length} records skipped — see report for details)`);
  }

  if (records.length === 0) {
    console.log("No records to evaluate.");
    process.exitCode = 0;
    return;
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

  console.log(`Stratified sample: ${sample.metadata.sampled} records (budget: ${options.budget})`);
  for (const cls of sample.metadata.absentClasses) {
    console.log(`  ${cls}: absent from store`);
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

    console.log(
      `Calibration: ${matched.length} matched, ${unmatched.length} unmatched (of ${labels.length} labels)`
    );
  }

  // Judge
  let judgePredictions: TurnOutcomeClass[] = [];
  let judgeFailures = 0;

  if (!options.dryRun && sample.records.length > 0) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      console.error("OPENAI_API_KEY not set. Use --dry-run to skip API calls.");
      process.exitCode = 1;
      return;
    }

    console.log(`Judge model: ${options.model}`);
    console.log(`Sending ${sample.records.length} records for judge classification...`);

    const result = await runJudge(sample.records, options.model, apiKey);
    judgePredictions = result.predictions;
    judgeFailures = result.failures;

    if (judgeFailures > 0) {
      warnings.push(`Judge failed on ${judgeFailures} records (see report for IDs)`);
    }
    console.log(
      `Judge completed: ${judgePredictions.length} classifications, ${judgeFailures} failures`
    );
  } else if (options.dryRun) {
    console.log("Dry run — skipping judge API calls.");
  }

  // Metrics
  let confusionMatrix = undefined;
  let kappa: number | undefined;

  if (calibrationMatched.length > 0 && judgePredictions.length > 0) {
    // Join on record ID: map judge predictions by ID, then pair with calibration labels
    const judgeById = new Map<string, TurnOutcomeClass>();
    for (let i = 0; i < sample.records.length && i < judgePredictions.length; i++) {
      judgeById.set(sample.records[i].id, judgePredictions[i]);
    }

    const paired: { predicted: TurnOutcomeClass; expected: TurnOutcomeClass }[] = [];
    for (const m of calibrationMatched) {
      const predicted = judgeById.get(m.record.id);
      if (predicted) {
        paired.push({ predicted, expected: m.expected });
      }
    }

    if (paired.length > 0) {
      const judgeSlice = paired.map((p) => p.predicted);
      const expectedSlice = paired.map((p) => p.expected);

      confusionMatrix = computeConfusionMatrix(judgeSlice, expectedSlice);
      kappa = computeKappa(judgeSlice, expectedSlice);

      const ready = kappa >= 0.7 && paired.length >= 20;
      console.log(
        `Cohen's kappa: ${kappa.toFixed(3)}${ready ? " (>= 0.70, READY)" : " (below 0.70 threshold)"}`
      );
      console.log(`Macro F1: ${confusionMatrix.macroF1.toFixed(3)}`);
      console.log(`Accuracy: ${(confusionMatrix.accuracy * 100).toFixed(1)}%`);
      console.log(`  (${paired.length} judge-calibration pairs joined by ID)`);
      if (!ready) {
        process.exitCode = 1;
      }
    } else {
      console.log("No overlapping records between judge predictions and calibration set.");
    }
  }

  const psi = computePSI(recentDist, baselineDist);
  const psiDrift = isPsiDrift(psi);
  if (psiDrift) {
    console.log(`PSI: ${psi.toFixed(4)} (DRIFT detected — exceeds ${0.2} threshold)`);
  } else {
    console.log(`PSI: ${psi.toFixed(4)} (no drift)`);
  }

  if (calibrationMatched.length < 20) {
    warnings.push(
      `Only ${calibrationMatched.length} calibration labels matched. Kappa estimates are unstable with fewer than 20 samples.`
    );
  }

  // Build report
  const ready = kappa !== undefined && kappa >= 0.7 && calibrationMatched.length >= 20;
  const report = {
    sampleMetadata: sample.metadata,
    distribution: sampleDist,
    confusionMatrix: confusionMatrix ?? undefined,
    kappa,
    ready,
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
    judgeRecords: judgePredictions.length,
    judgeFailures,
    judgedAt: options.dryRun ? undefined : new Date().toISOString(),
  };

  // Write report
  ensureDir(options.outDir);
  const reportPath = path.join(options.outDir, "turnOutcome-eval-report.json");
  writeJson(reportPath, report);
  console.log(`Report written to: ${reportPath}`);

  // Console summary
  console.log("\n── Class distribution ──");
  for (const cls of sample.metadata.absentClasses) {
    console.log(`  ${cls}: — (absent)`);
  }
  for (const cls of Object.entries(sampleDist.counts)
    .filter(([, c]) => c > 0)
    .sort((a, b) => b[1] - a[1])) {
    const pct = ((cls[1] / sampleDist.total) * 100).toFixed(1);
    console.log(`  ${cls[0]}: ${cls[1]} (${pct}%)`);
  }

  if (confusionMatrix) {
    console.log("\n── Per-class metrics (vs calibration) ──");
    for (const [cls, m] of Object.entries(confusionMatrix.perClass)) {
      if (m.support > 0) {
        console.log(
          `  ${cls}: P=${m.precision.toFixed(2)} R=${m.recall.toFixed(2)} F1=${m.f1.toFixed(2)} (n=${m.support})`
        );
      }
    }
  }

  if (warnings.length > 0) {
    console.log(`\n── Warnings (${warnings.length}) ──`);
    for (const w of warnings) {
      console.log(`  ! ${w}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Judge batching
// ---------------------------------------------------------------------------

const BATCH_SIZE = 25;
const MAX_CONCURRENCY = 8;

interface JudgeResult {
  predictions: TurnOutcomeClass[];
  failures: number;
}

async function runJudge(
  records: AssistantTurnRecord[],
  model: string,
  apiKey: string
): Promise<JudgeResult> {
  const pLimit = (await import("p-limit")).default;
  const limit = pLimit(MAX_CONCURRENCY);

  const batches: AssistantTurnRecord[][] = [];
  for (let i = 0; i < records.length; i += BATCH_SIZE) {
    batches.push(records.slice(i, i + BATCH_SIZE));
  }

  const results = await Promise.all(
    batches.map((batch) => limit(() => classifyBatch(batch, model, apiKey)))
  );

  const predictions: TurnOutcomeClass[] = [];
  let failures = 0;

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (result.error && result.predictions.length === 0) {
      // Complete batch failure — fill with unknown
      failures += batches[i].length;
      predictions.push(...Array(batches[i].length).fill("unknown" as TurnOutcomeClass));
    } else {
      predictions.push(...result.predictions);
      if (result.error) {
        // Partial failure — some predictions returned
        failures += batches[i].length - result.predictions.length;
      }
    }
  }

  return { predictions, failures };
}

const JUDGE_SCHEMA = {
  type: "object" as const,
  properties: {
    classifications: {
      type: "array" as const,
      items: {
        type: "object" as const,
        properties: {
          id: { type: "string" as const },
          outcome: {
            type: "string" as const,
            enum: [...TURN_OUTCOME_CLASS_ORDER],
          },
          reasoning: { type: "string" as const },
        },
        required: ["id", "outcome", "reasoning"],
        additionalProperties: false,
      },
    },
  },
  required: ["classifications"],
  additionalProperties: false,
};

interface BatchResult {
  predictions: TurnOutcomeClass[];
  error?: string;
}

async function classifyBatch(
  batch: AssistantTurnRecord[],
  model: string,
  apiKey: string
): Promise<BatchResult> {
  const OpenAI = (await import("openai")).default;
  const openai = new OpenAI({ apiKey });

  const recordsCtx = batch
    .map((r) => {
      const fields: string[] = [`id: ${r.id}`, `terminalId: ${r.terminalId ?? "null"}`];
      if (r.trigger) fields.push(`trigger: ${r.trigger}`);
      if (r.state) fields.push(`state: ${r.state}`);
      if (r.previousState) fields.push(`previousState: ${r.previousState}`);
      if (r.detail) fields.push(`detail: ${r.detail}`);
      return fields.join(", ");
    })
    .join("\n");

  const prompt = `You are evaluating the outcome of AI assistant turns. Classify each turn below into exactly one of these categories:

- answered: the turn produced useful output and completed successfully
- hedged: the agent expressed uncertainty without producing a concrete answer
- refused: the agent declined to act or stated it cannot perform the request
- docs-empty: the agent reported it could not find the requested documentation or results
- tier-rejected: a tool dispatch was blocked because the session tier was not permitted
- mcp-not-ready: the MCP server was not ready at provision time
- agent-stuck: the watchdog fired a waiting→idle timeout — the agent went silent
- tool-error: the most recent tool dispatch resolved with an error
- hibernate-resume-stale: an attempted resume produced no prior conversation
- unknown: insufficient information to classify

Classification rules:
- agent-stuck is ONLY when trigger is "timeout" AND state is "idle" AND previousState is "waiting"
- tier-rejected and tool-error typically have trigger "output" with detail indicating the error
- mcp-not-ready typically has no trigger or state fields and detail explains the failure
- hibernate-resume-stale typically has trigger "output"
- If no clear failure signal is present, classify as "answered"

Return a JSON object with a "classifications" array. Each element must have the record "id", your "outcome" classification, and a brief "reasoning".

Records:
${recordsCtx}`;

  try {
    const response = await openai.responses.create({
      model,
      input: prompt,
      text: {
        format: {
          type: "json_schema" as const,
          name: "turnOutcomeJudgment",
          schema: JUDGE_SCHEMA,
          strict: true,
        },
      },
    });

    const content = response.output_text;
    if (!content) {
      return { predictions: [], error: "Empty response from judge" };
    }

    const parsed = JSON.parse(content);
    const classificationList = parsed.classifications;
    if (!Array.isArray(classificationList)) {
      return { predictions: [], error: "Response missing classifications array" };
    }

    // Build a map from id to outcome, then align to batch order
    const outcomeById = new Map<string, TurnOutcomeClass>();
    for (const item of classificationList) {
      if (TURN_OUTCOME_CLASS_ORDER.includes(item.outcome)) {
        outcomeById.set(item.id, item.outcome);
      }
    }

    const predictions = batch.map((r) => outcomeById.get(r.id) ?? "unknown");
    const missing = batch.length - [...outcomeById.values()].length;
    return {
      predictions,
      ...(missing > 0 ? { error: `${missing} records missing from judge response` } : {}),
    };
  } catch (err) {
    return { predictions: [], error: String(err) };
  }
}

main();
